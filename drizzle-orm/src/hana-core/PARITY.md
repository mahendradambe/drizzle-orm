# SAP HANA dialect — Parity with pg/mysql/sqlite cores

## TL;DR (executive summary)

The SAP HANA dialect mirrors the module layout of `pg-core`, `mysql-core`, and `sqlite-core` across 6 subsystems totalling 71 source files (29 column builders + 11 query builders + 19 hana-core top-level + 2 utils + 6 driver-layer + 4 integration tests).
The public API surface is SemVer-locked at `1.0.0-beta.6`.
Type-safe column builders cover HANA-native semantics only — `ALPHANUM`, `SHORTTEXT`, `SECONDDATE`, `SMALLDECIMAL`, `TINYINT`, `VARBINARY`, `TEXT`, `BLOB`, `NCLOB`.
The driver layer wraps `@sap/hana-client@2.27.19` with the vendor's native `ConnectionPool` and lazy auto-connect via a private `_CONNECT_GATE` slot.
Divergence from sibling dialects is restricted to HANA-specific surface area — pool wiring, isolation-level handling, and HANA-only column types — and each divergence is enumerated below.

## Subsystem parity at-a-glance

| Subsystem | File count | Status |
|---|---|---|
| hana-core/columns | 29 | Parity match — HANA-native types only (uuid dropped; text re-added with HANA-LOB semantics; explicit dataType discriminator tokens) |
| hana-core/query-builders | 11 | Parity match — all 11 builders direct-match pg/mysql/sqlite shapes; `buildBatchInsertQuery` is HANA-specific for multi-row INSERT |
| hana-core (top-level) | 19 | Parity match — module structure mirrors pg-core / mysql-core / sqlite-core; HANA-specific `executeBatch` abstract on session |
| hana-core/utils | 2 | Parity match — generic utility re-exports follow sibling-core convention; no HANA-specific divergence |
| sap-hana (driver) | 6 | HANA-specific divergence justified — driver-layer wires `@sap/hana-client@2.27.19` with native `ConnectionPool` wrap + lazy auto-connect symbol-slot |
| integration-tests/hana | 4 | Parity match — monolith test layout matches mssql/mssql.test.ts; mock-only-CI unit test + release-gate probe suites HANA-specific |

## Carry-over decisions (binding)

- **HANA column-type policy** — HANA-native types only.
  Rationale: uuid dropped; text re-added with HANA-LOB semantics, not a pg-core `VARCHAR` alias.

- **`dataType` discriminator policy** — each HANA-native type carries an explicit token.
  Rationale: tokens take the form `'string text'` / `'buffer varbinary'` / `'object seconddate'` for unambiguous downstream branching.

- **`READ UNCOMMITTED` isolation** — pre-driver hard-reject with stable error code `HANA_ISOLATION_READ_UNCOMMITTED_UNSUPPORTED`.
  Rationale: HANA does not support `READ UNCOMMITTED`; `REPEATABLE READ` is silently promoted to `SERIALIZABLE` per the SAP HANA SQL Reference, documented on `HanaTransactionConfig`.

- **pg/mysql re-throw parity in `transaction()`** — all errors are re-thrown unconditionally.
  Rationale: matches the `pg-core` and `mysql2` sibling convention; rolling back without re-throw silently swallows errors.

- **`_normalizeHanaError`** — single canonical normaliser for HANA driver errors.
  Rationale: underscore-prefix marks module-private internal convention; one normalisation path keeps error shape stable across call sites.

- **`drizzle(dsn)` lazy auto-connect** — `_CONNECT_GATE` symbol slot wired through `_ensureConnected`.
  Rationale: the `@sap/hana-client` constructor pins `commit` / `rollback` / `prepare` as non-configurable + non-writable post-connect, and the engine's SameValue invariant blocks Proxy wrapping — symbol-slot is the only safe extension point.

- **Pool implementation** — wraps the `@sap/hana-client` native `ConnectionPool` directly.
  Rationale: a custom pool leaks transaction state; the vendor's pool resets `tx` state on `release()` and a hand-rolled pool does not.

- **`SapHanaClient` union widening** — widened to `Connection | SapHanaPool`, duck-typed via `isSapHanaPool`.
  Rationale: the hybrid surface mirrors sibling `.release()` and adds the HANA-specific `.acquire()`.

- **Two normalised pool error codes** — `HANA_POOL_ACQUIRE_TIMEOUT` and `HANA_POOL_CONNECTION_DEAD`.
  Rationale: caller-dispatchable observability surfaces; string-locked for stability across patch releases.

- **Conn-dead detection** — primary signal `(numericCode in {-20006, -10807}) && sqlState === 'HY000'`.
  Rationale: locale-independent code-based predicate; the secondary English driver message is captured to `wrapped.driverMessage` without participating in detection.

## Authoritative source

HANA SQL semantics anchor: **SAP HANA SQL Reference** (canonical SAP-published reference for HANA SQL syntax, isolation-level behaviour, and data-type definitions including `ALPHANUM`, `SHORTTEXT`, `SECONDDATE`, `SMALLDECIMAL`, `TINYINT`, `VARBINARY`, and `M_TRANSACTIONS.ISOLATION_LEVEL`). Driver wiring reference: **cap-js/cds-dbs `HANAService.js`** (SAP-aligned canonical reference for `@sap/hana-client` connection lifecycle, pool semantics, and error normalisation). Sibling-dialect parity baseline: the `pg-core`, `mysql-core`, and `sqlite-core` modules in the `drizzle-team/drizzle-orm` upstream.

## Sha-lock footer

Last sync:
- advisory sha = 95b3bf03aa2628f98b0d156ff39484fb57d64f24afdc984adec6e9bf9934c213
- git_head = 7651309a1b15c4924ec89b76d54e585fbd6ac9b8
- date = 2026-06-03T10:11:03Z
