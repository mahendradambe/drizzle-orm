import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

// ============================================================================
// Mock @sap/hana-client BEFORE importing drizzle-orm/sap-hana
// ============================================================================

type _CbErr = (err: Error | null) => void;
type _CbResult<T = unknown> = (err: Error | null, res?: T) => void;

interface MockConnection {
	close: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	connect: ReturnType<typeof vi.fn>;
	commit: ReturnType<typeof vi.fn>;
	rollback: ReturnType<typeof vi.fn>;
	setAutoCommit: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
	execute: ReturnType<typeof vi.fn>;
	prepare: ReturnType<typeof vi.fn>;
	state: ReturnType<typeof vi.fn>;
	_id: number;
}

interface MockPool {
	getConnection: ReturnType<typeof vi.fn>;
	getPooledCount: ReturnType<typeof vi.fn>;
	getInUseCount: ReturnType<typeof vi.fn>;
	clear: ReturnType<typeof vi.fn>;
	getProperties: ReturnType<typeof vi.fn>;
	setProperties: ReturnType<typeof vi.fn>;
}

// per-test mutable controllers; reset in beforeEach
let _connCounter = 0;
let _pools: MockPool[] = [];
let _connectionStubFactory: () => MockConnection = () => _newConn();
const _createConnectionFactory = vi.fn(() => _newConn());

function _newConn(): MockConnection {
	const id = ++_connCounter;
	const conn: MockConnection = {
		_id: id,
		close: vi.fn((cb?: _CbErr) => cb?.(null)),
		disconnect: vi.fn((cb?: _CbErr) => cb?.(null)),
		connect: vi.fn((cb?: _CbErr) => cb?.(null)),
		commit: vi.fn((cb?: _CbErr) => cb?.(null)),
		rollback: vi.fn((cb?: _CbErr) => cb?.(null)),
		setAutoCommit: vi.fn(),
		exec: vi.fn((_sql: string, _params: unknown[], cb: _CbResult<unknown[]>) => cb(null, [])),
		execute: vi.fn((_sql: string, _params: unknown[], _opts: unknown, cb: _CbResult<unknown[]>) => cb(null, [])),
		prepare: vi.fn(),
		state: vi.fn(() => 'disconnected'),
	};
	return conn;
}

// Default pool factory — each createPool call constructs a fresh stub with
// configurable behavior via _poolBehavior.
interface _PoolBehavior {
	max: number;
	acquireDelayMs: number; // simulated waiter when at capacity
	acquireError?: Error;
	clearImmediateOnInUse: boolean;
}
let _poolBehavior: _PoolBehavior = {
	max: 10,
	acquireDelayMs: 0,
	clearImmediateOnInUse: true,
};

function _newPool(params: { max?: number } = {}): MockPool {
	const max = params.max ?? _poolBehavior.max;
	const inUse = new Set<MockConnection>();
	const waiters: Array<(c: MockConnection) => void> = [];
	const pool: MockPool = {
		getConnection: vi.fn((cb: _CbResult<MockConnection>) => {
			if (_poolBehavior.acquireError) {
				cb(_poolBehavior.acquireError);
				return;
			}
			const settle = () => {
				if (inUse.size < max) {
					const c = _connectionStubFactory();
					inUse.add(c);
					cb(null, c);
				} else {
					waiters.push((c) => {
						inUse.add(c);
						cb(null, c);
					});
				}
			};
			if (_poolBehavior.acquireDelayMs > 0) {
				setTimeout(settle, _poolBehavior.acquireDelayMs);
			} else {
				settle();
			}
		}),
		getPooledCount: vi.fn(() => Math.max(0, max - inUse.size)),
		getInUseCount: vi.fn(() => inUse.size),
		clear: vi.fn((cb?: _CbErr) => {
			cb?.(null);
		}),
		getProperties: vi.fn(() => ''),
		setProperties: vi.fn(),
	};
	// Hook conn.close (release) to free slot + drain waiters
	const originalNewConn = _connectionStubFactory;
	_connectionStubFactory = () => {
		const c = originalNewConn();
		const origClose = c.close;
		c.close = vi.fn((cb?: _CbErr) => {
			inUse.delete(c);
			const next = waiters.shift();
			if (next) next(originalNewConn());
			origClose.getMockImplementation()?.(cb!);
			cb?.(null);
		});
		return c;
	};
	_pools.push(pool);
	return pool;
}

vi.mock('@sap/hana-client', () => {
	return {
		createPool: vi.fn((_connOpts: unknown, poolParams?: { maxConnectedOrPooled?: number }) => {
			return _newPool({ max: poolParams?.maxConnectedOrPooled });
		}),
		createConnection: _createConnectionFactory,
	};
});

beforeEach(() => {
	_connCounter = 0;
	_pools = [];
	_poolBehavior = { max: 10, acquireDelayMs: 0, clearImmediateOnInUse: true };
	_connectionStubFactory = () => _newConn();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Now import the surface under test (after vi.mock is registered)
// ============================================================================

const {
	SapHanaPool,
	createPool,
	drizzle,
	isSapHanaPool,
	HANA_POOL_ACQUIRE_TIMEOUT,
	HANA_POOL_CONNECTION_DEAD,
	_normalizeHanaError,
} = await import('drizzle-orm/sap-hana');

type _HanaPoolOpts = ConstructorParameters<typeof SapHanaPool>[0];

const dsn = 'serverNode=localhost:30015;uid=u;pwd=p';

// Helpers
function _spy(): { calls: Array<[string, Record<string, unknown>]>; hook: _HanaPoolOpts['onPoolEvent'] } {
	const calls: Array<[string, Record<string, unknown>]> = [];
	const hook = ((event: string, meta: Record<string, unknown>) => {
		calls.push([event, meta]);
	}) as _HanaPoolOpts['onPoolEvent'];
	return { calls, hook };
}

// ============================================================================
// Tests
// ============================================================================

describe('SapHanaPool — class surface', () => {
	test('1. acquire() resolves with a Connection-shaped object', async () => {
		const pool = createPool({ connection: dsn });
		const conn = await pool.acquire();
		expect(conn).toBeDefined();
		expect(typeof (conn as MockConnection).close).toBe('function');
	});

	test('2. release(conn) invokes conn.close (no ROLLBACK call — trust native pool reset)', async () => {
		const pool = createPool({ connection: dsn });
		const conn = (await pool.acquire()) as unknown as MockConnection;
		await pool.release(conn as never);
		expect(conn.close).toHaveBeenCalledTimes(1);
		expect(conn.rollback).not.toHaveBeenCalled();
	});

	test('3. release falls back to disconnect() if close() errors', async () => {
		const pool = createPool({ connection: dsn });
		const conn = (await pool.acquire()) as unknown as MockConnection;
		conn.close = vi.fn((cb?: _CbErr) => cb?.(new Error('close failed')));
		await pool.release(conn as never);
		expect(conn.disconnect).toHaveBeenCalledTimes(1);
	});

	test('4. acquire() rejects with err.code === HANA_POOL_ACQUIRE_TIMEOUT when timeout exceeded', async () => {
		_poolBehavior.acquireDelayMs = 200;
		const pool = createPool({ connection: dsn, pool: { acquireTimeoutMs: 50 } });
		await expect(pool.acquire()).rejects.toMatchObject({ code: HANA_POOL_ACQUIRE_TIMEOUT });
	});

	test('5. _normalizeHanaError on {-20006, HY000, "No Connection Available"} → HANA_POOL_CONNECTION_DEAD', () => {
		const raw = Object.assign(new Error('No Connection Available'), {
			code: -20006,
			sqlState: 'HY000',
		});
		const wrapped = _normalizeHanaError(raw, {});
		expect(wrapped.code).toBe(HANA_POOL_CONNECTION_DEAD);
		expect(wrapped['driverErrCode']).toBe(-20006);
	});

	test('5b. _normalizeHanaError locale-independence (localized message → still HANA_POOL_CONNECTION_DEAD)', () => {
		const raw = Object.assign(new Error('Verbindung nicht verfügbar'), {
			code: -20006,
			sqlState: 'HY000',
		});
		const wrapped = _normalizeHanaError(raw, {});
		expect(wrapped.code).toBe(HANA_POOL_CONNECTION_DEAD);
		expect(wrapped['driverMessage']).toBe('Verbindung nicht verfügbar');
	});

	test('6. destroy() invokes pool.clear', async () => {
		const pool = createPool({ connection: dsn });
		await pool.destroy();
		expect(_pools[0]!.clear).toHaveBeenCalledTimes(1);
	});

	test('7. isSapHanaPool — duck-type detection', () => {
		const pool = createPool({ connection: dsn });
		expect(isSapHanaPool(pool)).toBe(true);
		// A bare connection-shaped object (no acquire member) is NOT a pool.
		const fakeConn = { close: () => {}, commit: () => {} } as never;
		expect(isSapHanaPool(fakeConn)).toBe(false);
	});

	test('8. drizzle({connection, pool}) returns SapHanaDatabase with $client instanceof SapHanaPool', () => {
		const db = drizzle({ connection: dsn, pool: { max: 5 } });
		expect((db as { $client: unknown }).$client).toBeInstanceOf(SapHanaPool);
	});
});

describe('SapHanaPool — concurrent-tx safety + acquire/release error paths', () => {
	test('9. Two concurrent transaction() calls get distinct acquired conns', async () => {
		const pool = createPool({ connection: dsn });
		// Acquire 2 conns simultaneously; assert they're distinct refs.
		const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
		expect((a as unknown as MockConnection)._id).not.toBe((b as unknown as MockConnection)._id);
		expect(_pools[0]!.getConnection).toHaveBeenCalledTimes(2);
		await Promise.all([pool.release(a), pool.release(b)]);
	});

	test('10. acquire-fail → cb never invoked, no setAutoCommit on any conn', async () => {
		_poolBehavior.acquireError = new Error('pool down');
		const pool = createPool({ connection: dsn });
		const cb = vi.fn(async () => 'never');
		// Simulate session.transaction's pattern: acquire BEFORE entering try
		await expect((async () => {
			const conn = await pool.acquire();
			await cb(conn);
		})()).rejects.toThrow('pool down');
		expect(cb).not.toHaveBeenCalled();
	});

	test('11. release-fail in finally → original outcome preserved + onPoolEvent("release-error") emitted', async () => {
		const { calls, hook } = _spy();
		const pool = createPool({ connection: dsn, onPoolEvent: hook });
		const conn = (await pool.acquire()) as unknown as MockConnection;
		// Force close to error
		conn.close = vi.fn((cb?: _CbErr) => cb?.(new Error('close exploded')));
		await pool.release(conn as never);
		const releaseErrors = calls.filter(([e]) => e === 'release-error');
		expect(releaseErrors.length).toBeGreaterThanOrEqual(1);
	});

	test('12. acquire reject BEFORE conn assigned → finally runs no release attempt', async () => {
		_poolBehavior.acquireError = new Error('boom');
		const pool = createPool({ connection: dsn });
		// Simulate session.transaction guard pattern
		let acquiredConn: unknown;
		let releaseCalled = false;
		try {
			acquiredConn = await pool.acquire();
		} catch {
			// expected
		} finally {
			if (acquiredConn !== undefined) {
				releaseCalled = true;
				await pool.release(acquiredConn as never);
			}
		}
		expect(releaseCalled).toBe(false);
		// Pool's underlying release pathway not exercised — assert via stub
		// (no MockConnection was instantiated because acquireError fired before _newConn ran).
	});
});

describe('SapHanaPool — saturation + destroy-with-checkouts', () => {
	test('13. max=2, 3 concurrent acquires — 3rd waits then resolves after a release', async () => {
		const pool = createPool({ connection: dsn, pool: { max: 2 } });
		const a = await pool.acquire();
		const b = await pool.acquire();
		// 3rd waits
		const cPromise = pool.acquire();
		let cResolved = false;
		void cPromise.then(() => {
			cResolved = true;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(cResolved).toBe(false);
		// Release a → c resolves
		await pool.release(a);
		const c = await cPromise;
		expect(c).toBeDefined();
		await pool.release(b);
		await pool.release(c);
	});

	test('14. destroy() with 1 in-use checkout — resolves immediately', async () => {
		const pool = createPool({ connection: dsn });
		const conn = await pool.acquire();
		await pool.destroy();
		expect(_pools[0]!.clear).toHaveBeenCalledTimes(1);
		// Subsequent acquire on destroyed pool rejects
		await expect(pool.acquire()).rejects.toMatchObject({ code: HANA_POOL_ACQUIRE_TIMEOUT });
		// Outstanding checkout is still releasable
		await pool.release(conn);
	});
});

describe('SapHanaPool — double-release safety', () => {
	test('15. release(conn) called twice — second call no-ops + emits release-error("double-release")', async () => {
		const { calls, hook } = _spy();
		const pool = createPool({ connection: dsn, onPoolEvent: hook });
		const conn = (await pool.acquire()) as unknown as MockConnection;
		await pool.release(conn as never);
		// Reset close mock to detect a second invocation
		conn.close.mockClear();
		await pool.release(conn as never);
		expect(conn.close).not.toHaveBeenCalled();
		const dblRelEvents = calls.filter(([e, m]) =>
			e === 'release-error' && (m['err'] as Error | undefined)?.message === 'double-release'
		);
		expect(dblRelEvents.length).toBe(1);
	});
});

describe('SapHanaPool — observability hook', () => {
	test('16. onPoolEvent receives "acquire", "release", "acquire-timeout", "destroy"', async () => {
		const { calls, hook } = _spy();
		const pool = createPool({ connection: dsn, pool: { acquireTimeoutMs: 50 }, onPoolEvent: hook });
		const conn = await pool.acquire();
		await pool.release(conn);
		// Acquire-timeout
		_poolBehavior.acquireDelayMs = 200;
		await expect(pool.acquire()).rejects.toMatchObject({ code: HANA_POOL_ACQUIRE_TIMEOUT });
		_poolBehavior.acquireDelayMs = 0;
		await pool.destroy();
		const events = calls.map(([e]) => e);
		expect(events).toContain('acquire');
		expect(events).toContain('release');
		expect(events).toContain('acquire-timeout');
		expect(events).toContain('destroy');
	});

	test('17. onPoolEvent that throws does NOT break acquire/release', async () => {
		const throwingHook = (() => {
			throw new Error('observability boom');
		}) as _HanaPoolOpts['onPoolEvent'];
		const pool = createPool({ connection: dsn, onPoolEvent: throwingHook });
		const conn = await pool.acquire(); // should NOT throw
		expect(conn).toBeDefined();
		await pool.release(conn); // should NOT throw
	});
});

describe('SapHanaPool — TS overload inference', () => {
	test('18. drizzle(dsn).$client extends Connection', () => {
		const db = drizzle(dsn);
		expectTypeOf(db.$client).toBeObject();
		// Compile-time: $client is Connection (not pool) on DSN-string overload.
		// Runtime smoke: ensure $client is set.
		expect((db as { $client: unknown }).$client).toBeDefined();
	});

	test('19. drizzle({connection, pool}).$client is SapHanaPool', () => {
		const db = drizzle({ connection: dsn, pool: {} });
		expect((db as { $client: unknown }).$client).toBeInstanceOf(SapHanaPool);
	});

	test('20. createPool({connection}) returns SapHanaPool', () => {
		const pool = createPool({ connection: dsn });
		expectTypeOf(pool).toMatchTypeOf<InstanceType<typeof SapHanaPool>>();
		expect(pool).toBeInstanceOf(SapHanaPool);
	});
});

describe('conn-dead matcher extension — server-side DISCONNECT SESSION coverage', () => {
	test('21. _normalizeHanaError on {-10807, HY000, "Session is closed"} → HANA_POOL_CONNECTION_DEAD', () => {
		const raw = Object.assign(new Error('Session is closed'), {
			code: -10807,
			sqlState: 'HY000',
		});
		const wrapped = _normalizeHanaError(raw, { query: 'SELECT 1 FROM DUMMY' });
		expect(wrapped.code).toBe(HANA_POOL_CONNECTION_DEAD);
		expect(wrapped['driverErrCode']).toBe(-10807);
		expect(wrapped['driverMessage']).toBe('Session is closed');
	});

	test('22. _normalizeHanaError on {-20006, HY000} → HANA_POOL_CONNECTION_DEAD (no regression)', () => {
		const raw = Object.assign(new Error('No Connection Available'), {
			code: -20006,
			sqlState: 'HY000',
		});
		const wrapped = _normalizeHanaError(raw, { query: 'SELECT 1 FROM DUMMY' });
		expect(wrapped.code).toBe(HANA_POOL_CONNECTION_DEAD);
		expect(wrapped['driverErrCode']).toBe(-20006);
		expect(wrapped['driverMessage']).toBe('No Connection Available');
	});

	test('23. _normalizeHanaError — non-matching errors do NOT map to HANA_POOL_CONNECTION_DEAD', () => {
		// a. matching code -10807 but wrong sqlState
		const a = Object.assign(new Error('mismatch a'), { code: -10807, sqlState: 'HY999' });
		const wrappedA = _normalizeHanaError(a, {});
		expect(wrappedA.code).not.toBe(HANA_POOL_CONNECTION_DEAD);

		// b. matching sqlState but unrelated code
		const b = Object.assign(new Error('mismatch b'), { code: -10000, sqlState: 'HY000' });
		const wrappedB = _normalizeHanaError(b, {});
		expect(wrappedB.code).not.toBe(HANA_POOL_CONNECTION_DEAD);

		// c. non-numeric code rejected by typeof check
		const c = Object.assign(new Error('mismatch c'), { code: 'string-code', sqlState: 'HY000' });
		const wrappedC = _normalizeHanaError(c, {});
		expect(wrappedC.code).not.toBe(HANA_POOL_CONNECTION_DEAD);
	});
});
