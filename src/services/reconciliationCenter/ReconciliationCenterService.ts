import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type {
  ReconciliationExceptionSeverity,
  ReconciliationExceptionView,
  ReconciliationScheduleTick,
  NewReconciliationScheduleInput,
  ReconciliationScheduleView,
  UpdateReconciliationScheduleInput,
} from './ReconciliationCenterTypes';
import { ReconciliationExceptionRepository } from './ReconciliationExceptionRepository';
import { ReconciliationScheduleRepository, ReconciliationScheduleNotFoundError } from './ReconciliationScheduleRepository';
import { ReconcilerRegistry } from './reconcilers/Reconciler';
import type { ReconciliationDiscrepancy } from './invoiceComparison';
import type { Logger } from '../../utils/Logger';

export interface PaymentDiscrepancyInput {
  tenantId: string;
  sourceSystem: string;
  targetSystem: string;
  discrepancies: {
    transactionId: string;
    type: string;
    severity: ReconciliationExceptionSeverity;
    processorAmount?: number;
    businessCentralAmount?: number;
    description: string;
    suggestedAction: string;
  }[];
}

export interface ResolveExceptionInput {
  tenantId: string;
  exceptionId: string;
  actorUserId: string;
  note: string;
}

@injectable()
export class ReconciliationCenterService {
  /**
   * A `running` run row older than this is treated as orphaned (process crashed
   * after the claim) and reclaimed to `failed` by runDueSchedules' step-0 sweep.
   * 2h is comfortably above the 1h default scheduler interval and any realistic
   * invoice-list reconciliation. Hardcoded (YAGNI — no config plumbing until a
   * real need appears).
   */
  static readonly STALE_RUN_THRESHOLD_MS = 2 * 60 * 60 * 1000;

  constructor(
    @inject(TYPES.ReconciliationExceptionRepository)
    private readonly repo: ReconciliationExceptionRepository,
    @inject(TYPES.ReconciliationScheduleRepository)
    private readonly scheduleRepo: ReconciliationScheduleRepository,
    @inject(TYPES.ReconcilerRegistry)
    private readonly registry: ReconcilerRegistry,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  async ingestPaymentDiscrepancies(input: PaymentDiscrepancyInput): Promise<string[]> {
    const ids: string[] = [];
    for (const d of input.discrepancies) {
      const amountDelta =
        d.processorAmount !== undefined && d.businessCentralAmount !== undefined
          ? d.processorAmount - d.businessCentralAmount
          : null;
      ids.push(
        await this.repo.createException({
          tenantId: input.tenantId,
          sourceSystem: input.sourceSystem,
          targetSystem: input.targetSystem,
          sourceRecordId: d.transactionId,
          exceptionType: d.type,
          severity: d.severity,
          amountDelta,
          description: d.description,
          suggestedAction: d.suggestedAction,
        }),
      );
    }
    return ids;
  }

  listOpen(tenantId: string): Promise<ReconciliationExceptionView[]> {
    return this.repo.listExceptions({ tenantId, status: 'open' });
  }

  async resolveException(input: ResolveExceptionInput): Promise<void> {
    await this.repo.updateStatus({
      tenantId: input.tenantId,
      exceptionId: input.exceptionId,
      status: 'resolved',
      actorUserId: input.actorUserId,
      resolutionNote: input.note,
    });
  }

  /**
   * Create an operator-defined reconciliation schedule. Validates that
   * `handlerKey` is a registered reconciler BEFORE persisting (throws
   * UnknownReconcilerError, which the route maps to 400) so a schedule can never
   * be created pointing at a handler that dispatch would reject. Also performs
   * static config-content validation (throws ReconcilerConfigError, mapped to 400
   * invalid_config) so an invalid config reference never briefly exists as a row.
   * Shape/trim validation (name, cadence, integrationConfigId) is the route's job.
   */
  async createSchedule(input: NewReconciliationScheduleInput): Promise<ReconciliationScheduleView> {
    const reconciler = this.registry.get(input.handlerKey); // throws UnknownReconcilerError on unknown key
    // Static config-content validation BEFORE persisting: an invalid config
    // reference never briefly exists as a row. Throws ReconcilerConfigError.
    reconciler.validateConfig({ tenantId: input.tenantId, integrationConfigId: input.integrationConfigId });
    return this.scheduleRepo.createSchedule(input);
  }

  /** Tenant-scoped list of reconciliation schedules. */
  listSchedules(tenantId: string): Promise<ReconciliationScheduleView[]> {
    return this.scheduleRepo.listSchedules(tenantId);
  }

  /**
   * Tenant-scoped partial update. Enforces the **"active implies a valid config"**
   * invariant: static config validation re-runs whenever the config reference
   * changes OR the schedule is being (re)activated (`active: true`), using the
   * EXISTING row's handler_key (handlerKey is immutable) and the effective config
   * (`patch.integrationConfigId ?? existing.integrationConfigId`). This closes the
   * migration-056 sentinel bypass: a deactivated `__unconfigured__` row cannot be
   * flipped back to active without supplying a real, valid config — `validateConfig`
   * rejects the sentinel (`config_not_found`) before the row becomes runnable.
   * Throws ReconciliationScheduleNotFoundError if the schedule is absent,
   * ReconcilerConfigError if the effective config fails validation.
   */
  async updateSchedule(tenantId: string, id: string, patch: UpdateReconciliationScheduleInput): Promise<ReconciliationScheduleView> {
    const existing = await this.scheduleRepo.getScheduleById(tenantId, id);
    if (!existing) throw new ReconciliationScheduleNotFoundError(tenantId, id);
    const effectiveConfigId = patch.integrationConfigId ?? existing.integrationConfigId;
    const configChanged = patch.integrationConfigId !== undefined && patch.integrationConfigId !== existing.integrationConfigId;
    const activating = patch.active === true;
    if (configChanged || activating) {
      this.registry.get(existing.handlerKey).validateConfig({ tenantId, integrationConfigId: effectiveConfigId });
    }
    return this.scheduleRepo.updateSchedule(tenantId, id, patch);
  }

  /**
   * Tenant-scoped hard delete. Unlike updateSchedule (which reads first to validate),
   * this delegates straight to the repo; the repo throws ReconciliationScheduleNotFoundError
   * if no row matched, and that error propagates unchanged.
   */
  async deleteSchedule(tenantId: string, id: string): Promise<void> {
    return this.scheduleRepo.deleteSchedule(tenantId, id);
  }

  /**
   * Scheduler hook. Reads due schedules, atomically claims each (multi-replica
   * safe), runs the registered reconciler, persists coalesced exceptions, and
   * marks the run completed/failed. The claim advances next_run_at before any
   * work, so a reconciler throw cannot hot-loop. The reconciler-run phase and
   * the run-status-persist phase are kept separate so a failure persisting the
   * run status (completeRun/failRun throwing on a DB outage) is isolated per
   * schedule and never aborts the sweep for the remaining schedules.
   *
   * Before the claim loop, a step-0 TTL sweep reclaims orphaned `running` run
   * rows (crashed between claim and persist); reclaim failure is logged but never
   * prevents due schedules from running this tick.
   */
  async runDueSchedules(now: Date): Promise<ReconciliationScheduleTick> {
    // Step 0: reclaim orphaned `running` run rows (crash between claim and
    // complete/fail). Isolated in its own try/catch — a reclaim DB error logs and
    // continues into the claim loop, mirroring the per-schedule persist-failure
    // isolation below; a failed reclaim must NEVER prevent due schedules from
    // running this tick.
    let staleRunsReclaimed = 0;
    try {
      const cutoff = new Date(now.getTime() - ReconciliationCenterService.STALE_RUN_THRESHOLD_MS);
      staleRunsReclaimed = await this.scheduleRepo.reclaimStaleRuns(cutoff);
    } catch (reclaimErr: unknown) {
      this.logger.error(
        '[ReconciliationCenterService] stale-run reclaim failed; continuing to claim loop',
        reclaimErr instanceof Error ? reclaimErr : new Error(String(reclaimErr)),
        { errorMessage: reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr) },
      );
    }

    const candidates = await this.scheduleRepo.listDueSchedules(now);
    let schedulesRun = 0;
    let exceptionsCreated = 0;

    for (const schedule of candidates) {
      const claim = await this.scheduleRepo.claimDueScheduleAndCreateRun({
        tenantId: schedule.tenant_id,
        scheduleId: schedule.id,
        expectedNextRunAt: schedule.next_run_at,
        now,
        cadence: schedule.cadence,
      });
      if (claim === null) continue; // another replica won, or no longer due
      schedulesRun += 1;

      let created = 0;
      let runError: string | null = null;
      try {
        const reconciler = this.registry.get(schedule.handler_key);
        const discrepancies = await reconciler.run({
          tenantId: schedule.tenant_id,
          integrationConfigId: schedule.integration_config_id,
        });
        created = await this.ingestDiscrepancies(schedule.tenant_id, discrepancies);
        exceptionsCreated += created;
      } catch (err: unknown) {
        runError = err instanceof Error ? err.message : String(err);
      }

      try {
        if (runError === null) {
          await this.scheduleRepo.completeRun({
            tenantId: schedule.tenant_id,
            runId: claim.runId,
            exceptionsCreated: created,
          });
        } else {
          await this.scheduleRepo.failRun({ tenantId: schedule.tenant_id, runId: claim.runId, errorMessage: runError });
        }
      } catch (persistErr: unknown) {
        // Persisting the run status failed (e.g. DB outage). The run row is left
        // in 'running' — the documented stale-run residual gap — but we log and
        // continue so one schedule's DB failure cannot abort the rest of the sweep.
        this.logger.error(
          '[ReconciliationCenterService] failed to persist run status; run row left running',
          persistErr instanceof Error ? persistErr : new Error(String(persistErr)),
          {
            tenantId: schedule.tenant_id,
            runId: claim.runId,
            intendedStatus: runError === null ? 'completed' : 'failed',
          },
        );
      }
    }

    return { schedulesRun, exceptionsCreated, staleRunsReclaimed };
  }

  /** Persist discrepancies as exceptions, skipping any already open (coalesce). Returns count inserted. */
  private async ingestDiscrepancies(tenantId: string, discrepancies: ReconciliationDiscrepancy[]): Promise<number> {
    let created = 0;
    for (const d of discrepancies) {
      const alreadyOpen = await this.repo.existsOpenException({
        tenantId,
        sourceSystem: d.sourceSystem,
        targetSystem: d.targetSystem,
        sourceRecordId: d.sourceRecordId,
        exceptionType: d.exceptionType,
      });
      if (alreadyOpen) continue;
      await this.repo.createException({
        tenantId,
        sourceSystem: d.sourceSystem,
        targetSystem: d.targetSystem,
        sourceRecordId: d.sourceRecordId,
        exceptionType: d.exceptionType,
        severity: d.severity,
        amountDelta: d.amountDelta,
        currency: d.currency,
        description: d.description,
        suggestedAction: d.suggestedAction,
      });
      created += 1;
    }
    return created;
  }
}
