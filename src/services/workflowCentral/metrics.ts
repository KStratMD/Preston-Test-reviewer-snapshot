// Prometheus metrics for the workflowCentral subsystem.
//
// Pattern matches existing prom-client usage in the codebase (see
// `src/services/SuiteCentralMetrics.ts` and
// `src/services/syncErrorAssist/SyncErrorAssistMetrics.ts`): construct against
// the default `register` exported by `prom-client`, so the metrics surface on
// `GET /metrics` without additional wiring.

import { Counter, Gauge, register } from 'prom-client';

// D15: audit delivery is best-effort; this counter surfaces the gap when
// safeAudit fails after a successful instance-state TX commit.
export const workflowCentralAuditDeliveryFailures = new Counter({
  name: 'workflow_central_audit_delivery_failures_total',
  help: 'safeAudit failures after a successful instance-state TX commit',
  labelNames: ['action', 'outcome'],
  registers: [register],
});

// PR-OP-3b: activity-log delivery is best-effort (mirrors safeAudit's contract).
// Surfaces the gap when the activity-log insert fails after a successful
// operator action TX commit. The `action` label carries the activity-row
// action value the caller is trying to insert (e.g. `instance_cancelled`,
// `task_completed`) — outcome-shaped, not operation-shaped. This is
// distinct from the audit-delivery counter, whose `action` carries the
// audit action minus the `workflow_central.` prefix (e.g. `cancel_instance`).
// Kept separate so dashboards can distinguish "audit row missing" from
// "activity row missing" — they are independent durable surfaces.
export const workflowCentralActivityLogDeliveryFailures = new Counter({
  name: 'workflow_central_activity_log_delivery_failures_total',
  help: 'activity-log write failures after a successful operator action TX commit',
  labelNames: ['action', 'outcome'],
  registers: [register],
});

export const workflowCentralInstanceActiveCount = new Gauge({
  name: 'workflow_central_instance_active_count',
  help:
    'Count of non-terminal workflow_central_instances rows held in the engine '
    + 'in-memory cache (excludes completed/cancelled/failed — even when those '
    + 'rows are hydrated as recent-terminal within the hydration window). '
    + 'Emitted by WorkflowEngineService.hydrate() and after every '
    + 'refreshCacheFromCommit() write.',
  registers: [register],
});

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

// Filter helper for the active-count gauge (excludes terminal statuses even
// if those rows are cached as recent-terminal within the hydration window).
export function countActiveInstances(rows: { status: string }[]): number {
  return rows.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;
}
