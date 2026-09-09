// Activity-log delivery helper (PR-OP-3b).
//
// Best-effort write side: catches every error, increments the
// `workflow_central_activity_log_delivery_failures_total` counter, and WARNs
// via the supplied logger. NEVER rethrows — the activity-log feed is a
// presentation-layer surface, not a compliance trail; failures must never
// roll back the operator action that produced them.
//
// Why a free function instead of a method on `WorkflowCentralRepository`:
// the repo intentionally has no `prom-client` dependency. The metric module
// is the only consumer of `prom-client`; keeping it isolated lets the repo
// stay test-friendly without prom-client mocks.

import type { Logger } from '../../utils/Logger';
import { workflowCentralActivityLogDeliveryFailures } from './metrics';
import type { WorkflowCentralRepository } from './WorkflowCentralRepository';
import type { NewActivityLogRow } from './types';

/**
 * Insert an activity-log row. On failure, WARN + counter; never throws.
 * The counter's `action` label carries the activity-row `action` value
 * (outcome-shaped — e.g. `instance_cancelled`, `task_completed`), NOT the
 * audit-action shape (`cancel_instance`). Keep activity + audit counters
 * separate so dashboards can distinguish the two failure modes.
 */
export async function safeActivityLog(args: {
  repo: WorkflowCentralRepository;
  logger: Logger;
  row: NewActivityLogRow;
}): Promise<void> {
  try {
    await args.repo.insertActivityLog(args.row);
  } catch (err) {
    // Telemetry block is itself wrapped — a closed logger transport or an
    // unregistered counter would otherwise re-throw into the verb's
    // response path, violating the "never bubble" contract this helper
    // exists to enforce. Codex R1 P2 BLOCKING.
    try {
      args.logger.warn(
        'activity log write failed for workflow-central action (operator action durable; activity-feed gap)',
        {
          action: args.row.action,
          instance_id: args.row.instanceId,
          tenant_id: args.row.tenantId,
          error: err instanceof Error ? err.message : String(err),
          error_class: err instanceof Error ? err.constructor.name : 'unknown',
        },
      );
    } catch {
      // Logger failure is itself non-fatal — swallow.
    }
    try {
      workflowCentralActivityLogDeliveryFailures.inc({
        action: args.row.action,
        outcome: 'thrown',
      });
    } catch {
      // Counter failure (unregistered, label cardinality, etc.) is non-fatal.
    }
  }
}
