import {
	type Connection,
	type ConnectionOptions,
	type ConnectionPool,
	createPool as _nativeCreatePool,
} from '@sap/hana-client';
import { entityKind } from '~/entity.ts';
import { _parseHanaDSN } from './driver.ts';
import { HANA_POOL_ACQUIRE_TIMEOUT, HANA_POOL_CONNECTION_DEAD } from './session.ts';

export { HANA_POOL_ACQUIRE_TIMEOUT, HANA_POOL_CONNECTION_DEAD };

/**
 * Pool lifecycle event names emitted by `SapHanaPool` to the optional
 * `onPoolEvent` hook (zero-overhead when undefined).
 *
 * @stability stable since 1.0.0-beta.5 — additions allowed in minor; renames/removals require major.
 */
export type PoolEventName =
	| 'acquire'
	| 'release'
	| 'acquire-timeout'
	| 'connection-dead'
	| 'release-error'
	| 'destroy';

/**
 * Options for `createPool` / `new SapHanaPool`.
 *
 * @stability stable since 1.0.0-beta.5
 */
export interface HanaPoolOptions {
	connection: ConnectionOptions | string;
	pool?: {
		/**
		 * UNVERIFIED — @sap/hana-client@2.27.19 explicit `createPool` poolParams (SAP doc pp.605-607)
		 * does not document a `min`/pre-warm parameter. Accepted for API stability only; values
		 * other than 0 are silently ignored at the native layer.
		 */
		min?: number;
		/** Maps to native `maxConnectedOrPooled` (SAP doc p.606). Default 10. */
		max?: number;
		/** Maps to native `maxWaitTimeoutIfPoolExhausted` in ms (SAP doc p.607). Default 30000. */
		acquireTimeoutMs?: number;
		/**
		 * Maps to native `maxPooledIdleTime` in **seconds** (SAP doc p.606).
		 * Converted via `Math.ceil(idleTimeoutMs / 1000)`. Default UNSET = native default `0` (no eviction).
		 */
		idleTimeoutMs?: number;
	};
	/**
	 * Optional pool-event observability hook. Wired by SapHanaSession's
	 * transaction()/statement paths to report `release-error` failures inside `finally`.
	 *
	 * The hook is wrapped in try/catch — observability MUST NOT break the pool path.
	 * When undefined, zero overhead is incurred (no-op short-circuit at call site).
	 *
	 * SECURITY: Connection credentials MUST NOT be logged via this hook. Implementations
	 * receive `conn` (an opaque ref) — never `connOpts`.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	onPoolEvent?: (
		event: PoolEventName,
		meta: { err?: Error; conn?: unknown; pooledCount?: number; inUseCount?: number },
	) => void;
}

interface _ResolvedHanaPoolOpts {
	min: number;
	max: number;
	acquireTimeoutMs: number;
	idleTimeoutMs?: number;
}

const _DEFAULTS: _ResolvedHanaPoolOpts = {
	min: 0, // match cap-js + pg/mysql2 lazy-warm convention; native has no pre-warm support
	max: 10, // cap-js + pg/mysql2 typical guidance
	acquireTimeoutMs: 30000, // 30s safer than cap-js's hang-forever null default
	// idleTimeoutMs UNSET — SAP doc p.606 maxPooledIdleTime default 0 = no eviction
};

/**
 * Thin wrapper over `@sap/hana-client` native `ConnectionPool` (SAP doc §4.4.10, pp.595-600).
 *
 * Acquired `Connection`s carry their own `_CONNECT_GATE` slot — method-pinning invariant is preserved
 * across pool checkout/release with zero pool-level wrapping.
 *
 * Release policy: `conn.close(cb)` returns the conn to the pool. The native pool resets
 * uncommitted tx state on release — no explicit force-ROLLBACK needed.
 *
 * Conn-dead detection (via `_normalizeHanaError` in session.ts) covers TWO driver code paths,
 * both with `sqlState === 'HY000'`:
 *  - `code === -20006` — pool-internal stale-conn (native pool "No Connection Available" path).
 *  - `code === -10807` — server-side `ALTER SYSTEM DISCONNECT SESSION` (admin-initiated).
 *
 * Both normalize to `HANA_POOL_CONNECTION_DEAD`.
 *
 * @stability stable since 1.0.0-beta.5 — method surface STABLE within 1.0.x.
 */
export class SapHanaPool {
	static readonly [entityKind]: string = 'SapHanaPool';

	private readonly _pool: ConnectionPool;
	private readonly _resolved: _ResolvedHanaPoolOpts;
	private readonly _onEvent?: HanaPoolOptions['onPoolEvent'];
	private readonly _released: WeakSet<Connection> = new WeakSet();
	private _destroyed = false;

	constructor(opts: HanaPoolOptions) {
		const connOpts = typeof opts.connection === 'string' ? _parseHanaDSN(opts.connection) : opts.connection;
		this._resolved = {
			min: opts.pool?.min ?? _DEFAULTS.min,
			max: opts.pool?.max ?? _DEFAULTS.max,
			acquireTimeoutMs: opts.pool?.acquireTimeoutMs ?? _DEFAULTS.acquireTimeoutMs,
			idleTimeoutMs: opts.pool?.idleTimeoutMs,
		};
		this._onEvent = opts.onPoolEvent;

		// User-facing → native key mapping (per SAP doc pp.605-607).
		const poolParams: Record<string, number | boolean> = {
			maxConnectedOrPooled: this._resolved.max, // SAP doc p.606
			maxWaitTimeoutIfPoolExhausted: this._resolved.acquireTimeoutMs, // SAP doc p.607 — milliseconds
		};
		if (this._resolved.idleTimeoutMs !== undefined) {
			// ms → seconds (SAP doc p.606); sub-second clamps to 1s.
			poolParams['maxPooledIdleTime'] = Math.max(1, Math.ceil(this._resolved.idleTimeoutMs / 1000));
		}
		// min is NOT forwarded — UNVERIFIED native support; accepted for API shape only.

		this._pool = _nativeCreatePool(connOpts, poolParams);
	}

	/**
	 * Acquire a `Connection` from the underlying native pool. Rejects with
	 * `err.code = HANA_POOL_ACQUIRE_TIMEOUT` if the wait exceeds `acquireTimeoutMs`.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	acquire(): Promise<Connection> {
		if (this._destroyed) {
			const err = new Error('SapHanaPool has been destroyed') as Error & { code: string };
			err.code = HANA_POOL_ACQUIRE_TIMEOUT;
			this._emit('acquire-timeout', { err });
			return Promise.reject(err);
		}
		return new Promise<Connection>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				const err = new Error(
					`Pool acquire timeout after ${this._resolved.acquireTimeoutMs}ms`,
				) as Error & { code: string };
				err.code = HANA_POOL_ACQUIRE_TIMEOUT;
				this._emit('acquire-timeout', {
					err,
					pooledCount: this._safeStat(() => this._pool.getPooledCount()),
					inUseCount: this._safeStat(() => this._pool.getInUseCount()),
				});
				reject(err);
			}, this._resolved.acquireTimeoutMs);
			this._pool.getConnection((err, conn) => {
				if (settled) {
					// Late callback after timeout — release the late-arriving conn back to pool.
					if (!err && conn) {
						try {
							conn.close(() => {});
						} catch {
							// ignore — late return cleanup
						}
					}
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (err) {
					reject(err);
					return;
				}
				// conn is guaranteed defined when no error
				const c = conn as Connection;
				this._emit('acquire', {
					conn: c,
					pooledCount: this._safeStat(() => this._pool.getPooledCount()),
					inUseCount: this._safeStat(() => this._pool.getInUseCount()),
				});
				resolve(c);
			});
		});
	}

	/**
	 * Release a `Connection` back to the pool via `conn.close(cb)`. On close-error,
	 * falls back to `conn.disconnect()` (destroy slot) and emits `release-error`.
	 *
	 * Double-release: defensive guard via internal WeakSet — second release no-ops
	 * + emits `release-error` with `err.message === 'double-release'`. Native
	 * @sap/hana-client@2.27.19 behavior on double-release is doc-silent.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	release(conn: Connection): Promise<void> {
		if (this._released.has(conn)) {
			const err = new Error('double-release');
			this._emit('release-error', { err, conn });
			return Promise.resolve();
		}
		this._released.add(conn);
		return new Promise<void>((resolve) => {
			conn.close((err) => {
				if (err) {
					this._emit('release-error', { err, conn });
					try {
						conn.disconnect();
					} catch {
						// destroy-slot fallback — silent; release MUST NOT throw
					}
					resolve();
					return;
				}
				this._emit('release', {
					conn,
					pooledCount: this._safeStat(() => this._pool.getPooledCount()),
					inUseCount: this._safeStat(() => this._pool.getInUseCount()),
				});
				resolve();
			});
		});
	}

	/**
	 * Destroy the pool — invokes native `pool.clear(cb)` (SAP doc §4.4.10.1, p.595).
	 *
	 * Active checkouts are NOT torn down (per SAP doc §4.4.10.1); callers must
	 * release outstanding conns first. After `destroy()` resolves, further `acquire()`
	 * calls reject with `HANA_POOL_ACQUIRE_TIMEOUT`.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	destroy(): Promise<void> {
		this._destroyed = true;
		return new Promise<void>((resolve) => {
			this._pool.clear(() => {
				this._emit('destroy', {});
				resolve();
			});
		});
	}

	/**
	 * Snapshot — may race with concurrent acquire/release; diagnostics only.
	 * Do NOT use for invariant assertions in production code.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	pooledCount(): number {
		return this._safeStat(() => this._pool.getPooledCount()) ?? 0;
	}

	/**
	 * Snapshot — may race with concurrent acquire/release; diagnostics only.
	 * Do NOT use for invariant assertions in production code.
	 *
	 * @stability stable since 1.0.0-beta.5
	 */
	inUseCount(): number {
		return this._safeStat(() => this._pool.getInUseCount()) ?? 0;
	}

	private _emit(
		event: PoolEventName,
		meta: { err?: Error; conn?: unknown; pooledCount?: number; inUseCount?: number },
	): void {
		const hook = this._onEvent;
		if (hook === undefined) return;
		try {
			hook(event, meta);
		} catch {
			// observability MUST NOT break pool path
		}
	}

	private _safeStat(fn: () => number): number | undefined {
		try {
			return fn();
		} catch {
			return undefined;
		}
	}
}
