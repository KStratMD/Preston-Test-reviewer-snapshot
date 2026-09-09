/**
 * Sentinel integration_config_id assigned to legacy NULL-config schedules during
 * the migration-056 backfill. Such rows are also deactivated (active=false), so
 * they never run; if reactivated they fail-clean at dispatch (config_not_found).
 *
 * The migration intentionally hard-codes this literal LOCALLY (migrations must not
 * import runtime modules, which can change — migration immutability). This runtime
 * copy is the canonical anchor: the migration-056 test pins the migration's literal
 * backfill behavior and the drift test pins this constant's value, so the two cannot
 * silently diverge. (No runtime code consumes it yet; it exists for that drift pin
 * and for any future recognition of dormant backfilled rows.)
 */
export const UNCONFIGURED_INTEGRATION_CONFIG_ID = '__unconfigured__';
