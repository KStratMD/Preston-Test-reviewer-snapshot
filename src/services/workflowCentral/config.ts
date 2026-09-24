// recentTerminalHydrationDays — env-clamped knob (D16). Reads
// WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS, clamps to [1, 90],
// defaults to 7 if unset or non-numeric.

const ENV_NAME = 'WORKFLOW_CENTRAL_RECENT_TERMINAL_HYDRATION_DAYS';
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

export const recentTerminalHydrationDays: number = (() => {
  const raw = process.env[ENV_NAME];
  if (raw === undefined) return DEFAULT_DAYS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed));
})();

// ---------------------------------------------------------------------------
// Activity-log query bounds (PR-OP-3b). Shared between the route's query-shape
// defenses and the repository's bounded-int validator. Defined here (not on
// the repository) so the route can import them without pulling in the
// repository module — keeps the HTTP layer decoupled from the data layer.
// Copilot R4 thread.
// ---------------------------------------------------------------------------
export const ACTIVITY_LOG_MIN_LIMIT = 1;
export const ACTIVITY_LOG_MAX_LIMIT = 100;
export const ACTIVITY_LOG_DEFAULT_LIMIT = 10;
