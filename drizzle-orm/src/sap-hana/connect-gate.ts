import type { SapHanaClient } from './session.ts';
import { _normalizeHanaError } from './session.ts';

// Module-private slot on the Connection holding the in-flight or resolved
// connect promise. Symbol ensures no collision with @sap/hana-client internals
// and prevents external code from observing/mutating the gate state.
export const _CONNECT_GATE: unique symbol = Symbol('drizzle.hana.connectGate');

/**
 * Lazily await `client.connect()` exactly once per Connection. Idempotent on
 * subsequent calls (returns the cached promise). The `drizzle.mock()` client
 * has no `connect` method — returns a resolved promise so the mock path is
 * a no-op. If the underlying client is already connected (state === 'connected')
 * OR if the driver reports "Already Connected" on connect attempt, treats as
 * success.
 *
 * Callers MUST insert `await _ensureConnected(client)` at every entry point
 * where a driver method could be invoked first (see session.ts:
 * SapHanaPreparedQuery.execute / executeRqbV2 / all, SapHanaSession.executeBatch,
 * SapHanaSession.transaction). A Proxy wrapping the driver client is not
 * viable: `@sap/hana-client` pins commit/rollback/prepare/etc. as
 * non-configurable + non-writable own data properties post-connect, which
 * the engine-enforced Proxy SameValue invariant prevents wrapping.
 */
export function _ensureConnected(client: SapHanaClient): Promise<void> {
	const target = client;
	const existing = (target as unknown as Record<symbol, unknown>)[_CONNECT_GATE];
	if (existing && typeof (existing as Promise<void>).then === 'function') {
		return existing as Promise<void>;
	}
	if (typeof (target as unknown as { connect?: unknown }).connect !== 'function') {
		const p = Promise.resolve();
		_storeGate(target, p);
		return p;
	}
	// Idempotent for explicit clients the caller already connected:
	// Connection.state() returns 'connected' | 'disconnected'. Calling connect()
	// on an already-connected client throws "Already Connected" (errCode -20004).
	const stateFn = (target as unknown as { state?: () => string }).state;
	if (typeof stateFn === 'function') {
		try {
			if (stateFn.call(target) === 'connected') {
				const cached = Promise.resolve();
				_storeGate(target, cached);
				return cached;
			}
		} catch {
			// state() unsupported / threw — fall through to connect() attempt
		}
	}
	const p = new Promise<void>((resolve, reject) => {
		// Type narrowing post type-widening of SapHanaClient (= Connection | SapHanaPool):
		// the fast-path at line ~31 already returns when `connect` is not a function, so
		// at this point `target` always has a callable `connect` member at runtime.
		(target as { connect: (cb: (err: Error | null) => void) => void }).connect((err) => {
			// Race condition: state() check passed but caller connected between checks.
			// Treat "Already Connected" as success rather than propagating.
			if (err && (err as { code?: number }).code === -20004) {
				resolve();
				return;
			}
			if (err) {
				reject(_normalizeHanaError(err, { query: '<sap-hana-client>.connect()' }));
			} else {
				resolve();
			}
		});
	});
	_storeGate(target, p);
	return p;
}

function _storeGate(target: SapHanaClient, p: Promise<void>): void {
	try {
		Object.defineProperty(target, _CONNECT_GATE, {
			value: p,
			enumerable: false,
			configurable: false,
			writable: false,
		});
	} catch {
		// Defensive: defineProperty can fail if target is non-extensible. Cache
		// on the symbol via direct assign as fallback (works on plain objects).
		(target as unknown as Record<symbol, unknown>)[_CONNECT_GATE] = p;
	}
}
