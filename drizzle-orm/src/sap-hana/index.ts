export * from './driver.ts';
export * from './session.ts';
// ---------------------------------------------------------------------------
// Phase 3 pool surface (since 1.0.0-beta.5) — explicit named re-exports.
// Symbols documented inline for grep-able surface inventory.
// ---------------------------------------------------------------------------
// SapHanaPool — pool wrapper class
// createPool — factory (re-exported from driver.ts)
// isSapHanaPool — duck-type guard (re-exported from session.ts)
// HanaPoolOptions — pool config interface
// PoolEventName — observability hook event union
// HANA_POOL_ACQUIRE_TIMEOUT — error code constant (re-exported from session.ts)
// HANA_POOL_CONNECTION_DEAD — error code constant (re-exported from session.ts)
export { type HanaPoolOptions, type PoolEventName, SapHanaPool } from './pool.ts';
