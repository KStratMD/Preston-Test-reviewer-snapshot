// Boot-time guard: refuse to start when `approvalMode === 'queue'` but the
// `governance_approvals` table is unreachable (PR 3B).
//
// Without the guard, a misconfigured deploy (mode flipped to 'queue' but the
// migration hasn't run yet on this DB) would silently drop high-risk PII
// writes mid-request — the route catch would call enqueue, enqueue would
// throw a DB error, and the request would return a generic 500 with no
// approval row created. That's a worse failure mode than refusing to boot.
//
// Block-mode deploys do NOT need the table — the existing PR 2A hard-block
// path is unaffected. The guard short-circuits when approvalMode is 'block'.

import type { DatabaseService } from '../../database/DatabaseService';
import type { Logger } from '../../utils/Logger';
import type { ApprovalMode } from './OutboundGovernanceService';

export class ApprovalQueueUnreachableError extends Error {
  readonly code = 'approval_queue_unreachable';
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ApprovalQueueUnreachableError';
  }
}

/**
 * Smoke-probe the `governance_approvals` table when running in queue mode.
 *
 * Throws `ApprovalQueueUnreachableError` when the probe fails — `Server.start()`
 * should let the throw bubble up so the process exits with a non-zero code
 * (rather than catching + warning, which would leave the server running with
 * mode='queue' and a broken queue).
 */
export async function assertApprovalQueueReachableIfNeeded(
  config: { approvalMode: ApprovalMode },
  db: DatabaseService,
  logger: Logger,
): Promise<void> {
  if (config.approvalMode !== 'queue') {
    logger.info('approvalModeStartupGuard skipped (approvalMode !== queue)', {
      approvalMode: config.approvalMode,
    });
    return;
  }

  try {
    // SELECT id LIMIT 1 is the cheapest reachability probe: it proves the
    // table exists and the DB connection works without forcing a row count
    // (count* may scan the whole table even with LIMIT 1 — Copilot R1).
    // executeTakeFirst returns undefined on an empty table, which is a
    // valid "reachable but empty" signal — boot continues.
    await db
      .getDatabase()
      .selectFrom('governance_approvals')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    logger.info('approvalModeStartupGuard: governance_approvals reachable; boot continuing');
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    const message =
      `approvalMode === 'queue' but governance_approvals table is unreachable: ` +
      `${cause.message}. Refusing to boot — apply migration 045 or revert approvalMode to 'block'.`;
    logger.error('approvalModeStartupGuard: refusing to boot', cause, {
      approvalMode: config.approvalMode,
    });
    throw new ApprovalQueueUnreachableError(message, cause);
  }
}
