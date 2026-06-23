// OwnershipResumeHandler — PR 13b Stage B + PR 13c-2 (queue lift).
//
// Registered as the default handler for operationType='ownership_write'
// in the ApprovalResumeRegistry. After an operator approves a queue_for_human
// write, the resume worker calls `apply(approval)` which:
//   1. Parses + decrypts the WriteDescriptor from approval.writeDescriptor.
//   2. Re-runs detectLoop for SourceSystem callers — approval may have
//      arrived minutes/hours after enqueue and a reciprocal lineage chain
//      may have formed in the interim.
//   3. If the descriptor carries an integrationConfigId, resolves the per-
//      tenant IntegrationConfig and re-initializes the target connector
//      (auth, base URL). This closes the R16#2 gap from PR 13b — the prior
//      dead-code path resolved an uninitialized connector instance.
//   4. Dispatches the original write (create / update / delete / bulk*).
//   5. Emits a resume-time audit row with resumeFromQueue=true.
//
// `apply()` throws on:
//   - missing / unparseable writeDescriptor
//   - decryption failure (version mismatch, tamper, shape) — typed
//     WriteDescriptorEncryptionError
//   - loop detection on resume (LoopDetectedError)
//   - operation outside the six IConnector mutating methods
// ApprovalResumeWorker catches those and returns {applied: false, error}.

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { ApprovalResumeHandler } from '../ApprovalResumeWorker';
import type { PersistedApproval, ApprovalOperationType } from '../ApprovalQueueRepository';
import type { ConnectorManager } from '../../integration/ConnectorManager';
import type { AuditService } from '../../ai/orchestrator/AuditService';
import type { WriteDescriptor } from '../../../governance/sourceOfTruth/guardedWrite';
import type { IConnector } from '../../../interfaces/IConnector';
import type { DataRecord } from '../../../types';
import type { EncryptionService } from '../../security/EncryptionService';
import type { ConfigurationService } from '../../ConfigurationService';
import type { OwnershipResolver } from '../../../governance/sourceOfTruth/OwnershipResolver';
import {
  isSourceSystem,
  isCanonicalEntity,
  type SourceSystem,
} from '../../../governance/sourceOfTruth/SourceOfTruthManifest';
import { connectorRecordTypeFor } from '../../../governance/sourceOfTruth/connectorRecordType';
import { LoopDetectedError } from '../../../governance/sourceOfTruth/ConflictResolutionPolicy';
import { decryptDescriptor } from '../writeDescriptorEncryption';

@injectable()
export class OwnershipResumeHandler implements ApprovalResumeHandler {
  readonly operationType: ApprovalOperationType = 'ownership_write';
  /**
   * Sentinel value — OwnershipResumeHandler is registered via setDefault()
   * rather than register(), so this field is never used as a dispatch key.
   * The '*' makes it visually distinct from real resourceType strings.
   */
  readonly resourceType = '*';

  constructor(
    @inject(TYPES.ConnectorManager) private readonly connectorManager: ConnectorManager,
    @inject(TYPES.AuditService) private readonly auditService: AuditService,
    @inject(TYPES.EncryptionService) private readonly encryptionService: EncryptionService,
    @inject(TYPES.ConfigurationService) private readonly configService: ConfigurationService,
    @inject(TYPES.OwnershipResolver) private readonly ownershipResolver: OwnershipResolver,
  ) {}

  /**
   * Re-invoke the original ownership-gated write using the stored WriteDescriptor.
   *
   * Called by ApprovalResumeWorker.resume() after an operator approves an
   * ownership_write row. Throws on precondition failures — the worker's outer
   * try/catch handles those and returns { applied: false, error }.
   */
  async apply(approval: PersistedApproval): Promise<unknown> {
    if (!approval.writeDescriptor) {
      throw new Error(
        `OwnershipResumeHandler: approval ${approval.id} is missing writeDescriptor — cannot resume write`,
      );
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(approval.writeDescriptor);
    } catch {
      throw new Error(
        `OwnershipResumeHandler: approval ${approval.id} has unparseable writeDescriptor JSON`,
      );
    }

    // Decryption errors (unknown version, shape invalid, tamper, decrypt
    // failed) propagate as WriteDescriptorEncryptionError so the worker's
    // outer catch records the approval as `{applied:false, error:<msg>}` —
    // the worker stringifies the thrown error's `.message` field (see
    // `ApprovalResumeWorker.resume`'s `applyErr instanceof Error ? applyErr.message : String(applyErr)`),
    // not its `.code`. Downstream log classifiers consume the message; the
    // typed `.code` is preserved on the thrown error object itself for
    // callers that `instanceof`-discriminate. Mapping `.code` to the
    // return-shape's `error` field is a worker-level concern tracked
    // separately. The split between JSON.parse and decryptDescriptor keeps
    // the typed error visible (vs wrapping the parse in a try/catch that
    // swallows it). Copilot R2 on PR #853 caught the prior comment claim.
    const descriptor: WriteDescriptor = await decryptDescriptor(parsedPayload, this.encryptionService);

    // PR 13c-2 Task 4: re-run detectLoop. The descriptor was enqueued
    // potentially minutes or hours ago; a reciprocal lineage chain may
    // have formed in the interim. Mirror guardedWrite.ts:374's gate —
    // only wired for SourceSystem callers since lineage events are keyed
    // by SourceSystem; operator_action and other CallerSystem-only
    // values cannot be in a reciprocal-write chain by construction.
    const callerForLoop = descriptor.ownership.callerSystem;
    if (isSourceSystem(callerForLoop)) {
      const entity = descriptor.ownership.entity;
      const targetSystem: SourceSystem = descriptor.ownership.targetSystem;
      const loopCheck = await this.ownershipResolver.detectLoop({
        tenantId: approval.tenantId,
        entity,
        // Mirror guardedWrite.ts:383's no-canonical fallback. The lineage
        // table stores whatever the source-side targetWrite call emitted;
        // we pass the same form here so the detector sees a matching key.
        entityType: isCanonicalEntity(entity)
          ? connectorRecordTypeFor(entity, targetSystem)
          : entity,
        // guardedWrite enqueues with `resourceId: context.recordId ?? 'new'`
        // (the 'new' sentinel groups create-without-id queued rows in the
        // operator UI). guardedWrite's own detectLoop call uses
        // `context.recordId ?? ''` instead — the empty string mirrors the
        // shape `lineage_events` stores for create operations. Normalize
        // the 'new' sentinel back to '' here so resume-time loop detection
        // queries the same key the source-time detectLoop would have used.
        // Copilot R0 #2 on PR #853.
        entityId: approval.resourceId === 'new' ? '' : (approval.resourceId ?? ''),
        targetSystem,
        callerSystem: callerForLoop,
        correlationId: approval.id,
      });
      if (loopCheck.loopDetected) {
        try {
          await this.auditService.logGovernanceCheck({
            tenantId: approval.tenantId,
            sessionId: approval.id,
            checkType: 'loop_detection',
            approved: false,
            riskLevel: 'high',
            flags: ['loop_detected', 'resume_from_queue'],
            ownership: {
              entity,
              declaredOwner: descriptor.ownership.declaredOwner,
              callerSystem: descriptor.ownership.callerSystem,
              targetSystem,
              operation: descriptor.operation,
              loopBreakingCondition: loopCheck.breakingCondition,
              resumeFromQueue: true,
            },
          });
        } catch {
          // Loop-audit is best-effort. The throw below is the load-bearing
          // failure mode — we'd rather lose the audit row than dispatch
          // a write that's already known to participate in a reciprocal
          // chain.
        }
        throw new LoopDetectedError({
          entity,
          callerSystem: callerForLoop,
          targetSystem,
          breakingCondition: loopCheck.breakingCondition!,
          correlationId: approval.id,
        });
      }
    }

    // PR 13c-2 Task 3 step 6: if descriptor carries an integrationConfigId,
    // re-initialize the target connector via initializeConnectorsForConfig
    // so the resume dispatch consumes an instance with the same auth + base
    // URL as the original (pre-queue) write would have used.
    //
    // Codex review on PR #853 (additional finding): when `integrationConfigId`
    // is present but `ConfigurationService.getConfiguration()` misses,
    // FAIL CLOSED instead of silently falling back to
    // `getConnector(targetSystemId, targetSystemId)`. The legacy fallback
    // would consume an uninitialized (or wrong-tenant cached) connector,
    // possibly dispatching the approved write with wrong credentials —
    // exactly the failure mode `integrationConfigId` was added to prevent.
    // The ApprovalResumeWorker catches this throw and emits an ERROR-level
    // log tagged `surface: 'apply_failed'`. NOTE — Codex R6 on PR #853:
    // the worker's `claimForApply` CAS has already set
    // `apply_idempotency_key` by the time we reach this branch, so a
    // bare retry by the worker returns `skipped: 'already_claimed'`. The
    // operator cannot "just re-approve" this row through the standard UI;
    // recovery requires the unshipped Tier-C admin endpoint documented in
    // `ApprovalResumeWorker.ts` (spec §11 follow-up) to reset the claim,
    // OR manual rejection of this row and a fresh enqueue via the source
    // write path. Operators triage these via the `apply_failed` log
    // surface tag. The legacy-fallback shape (no integrationConfigId)
    // only applies when the descriptor was persisted before this PR
    // (older approvals) or in tests that don't supply one.
    let connector: IConnector;
    if (descriptor.integrationConfigId) {
      const config = this.configService.getConfigurationForTenant(
        approval.tenantId,
        descriptor.integrationConfigId,
      );
      if (!config) {
        throw new Error(
          `OwnershipResumeHandler: approval ${approval.id} references integrationConfigId='${descriptor.integrationConfigId}' but ConfigurationService.getConfigurationForTenant() returned undefined. ` +
            `The config was deleted (or never registered for this tenant) between enqueue and resume — refusing to dispatch with an uninitialized connector. ` +
            `Recovery: restore the tenant-bound config AND reset the failed approval claim via the admin endpoint, or reject this row through the operator UI and re-enqueue from the source write path.`,
        );
      }
      // Copilot R1 on PR #853: validate that the config's target system type
      // matches the descriptor's `targetSystemId` before dispatch. The
      // config's `initializeConnectorsForConfig` reaches into the connector
      // with `config.targetSystem`-derived auth, but the subsequent
      // `getConnector(descriptor.targetSystemId, ...)` looks up by the
      // descriptor's key. If those diverge (config changed, wrong id, or
      // a tampered descriptor row), we'd initialize one connector and
      // dispatch through a different (uninitialized or wrong-tenant)
      // instance with the operator's authorization — exactly the failure
      // mode `integrationConfigId` was added to prevent. Fail-closed on
      // mismatch so the operator can investigate.
      const configTargetSystemType =
        typeof config.targetSystem === 'string'
          ? config.targetSystem
          : config.targetSystem?.type;
      if (!configTargetSystemType || configTargetSystemType !== descriptor.targetSystemId) {
        throw new Error(
          `OwnershipResumeHandler: approval ${approval.id} descriptor.targetSystemId='${descriptor.targetSystemId}' but the resolved IntegrationConfig (id='${descriptor.integrationConfigId}') targetSystem.type='${String(configTargetSystemType)}'. ` +
            `Refusing to dispatch with a connector initialized for a different target system. ` +
            `Either the descriptor or the config has drifted — investigate via the audit chain. Recovery requires Tier-C admin claim reset OR rejection + re-enqueue (the standard operator approve flow returns 'already_claimed').`,
        );
      }
      await this.connectorManager.initializeConnectorsForConfig(config);
      // initializeConnectorsForConfig populates the connector cache at
      // key `${targetSystemType}_${targetSystemType}_${config.id}` via its
      // inner getConnector(targetSystemType, `${targetSystemType}_${config.id}`)
      // call. Re-use that same form here so we retrieve the same
      // initialized instance.
      connector = await this.connectorManager.getConnector(
        configTargetSystemType,
        `${configTargetSystemType}_${config.id}`,
      );
    } else {
      // Descriptors persisted before PR 13c-2 don't carry integrationConfigId,
      // and unit tests that exercise dispatch without per-tenant init also
      // omit it. The legacy form returns an instance without re-initializing
      // — same shape as PR 13b's dead-code path.
      connector = await this.connectorManager.getConnector(
        descriptor.targetSystemId,
        descriptor.targetSystemId,
      );
    }

    const result = await this.dispatch(connector, descriptor);

    // Copilot R17 on PR #851: the resume audit row is best-effort. The
    // connector mutation has already succeeded by this point, so an
    // audit-persistence failure must NOT propagate as an "approval not
    // applied" outcome. The ApprovalResumeWorker's outer try/catch would
    // otherwise record this approval as failed and the operator might
    // re-approve, triggering a DUPLICATE external write. Match the
    // best-effort pattern used in guardedWrite's outcome audit and the
    // rejection-audit at guardedWrite.ts:182-186. Audit-row completeness
    // is valuable but not load-bearing for write correctness.
    //
    // Codex R6 on PR #853 (tenant-boundary forensic trail): when the
    // resume consumed a specific IntegrationConfig, append a structured
    // flag `integration_config:${configId}` so the (approvalId, tenantId,
    // configId) tuple is queryable from audit alone. If a future cross-
    // tenant replay surfaces, this row is the forensic anchor — the
    // approval's `tenantId` paired with the config the connector was
    // initialized from. Verbose but cheap; flags are freeform strings.
    const auditFlags: string[] = ['resume_from_queue'];
    if (descriptor.integrationConfigId) {
      auditFlags.push(`integration_config:${descriptor.integrationConfigId}`);
    }
    try {
      await this.auditService.logGovernanceCheck({
        tenantId: approval.tenantId,
        sessionId: approval.id,
        checkType: 'ownership',
        approved: true,
        riskLevel: 'medium',
        flags: auditFlags,
        ownership: {
          entity: descriptor.ownership.entity,
          declaredOwner: descriptor.ownership.declaredOwner,
          callerSystem: descriptor.ownership.callerSystem,
          // Codex R6 P2 on PR #851: use the canonical SourceSystem captured at
          // enqueue time. `descriptor.targetSystemId` is the connector-registry
          // key (e.g. 'businesscentral') — NOT the manifest vocabulary
          // ('business_central'). Persisting `ownership.targetSystem` at
          // enqueue time lets the resume handler audit the manifest-correct value.
          targetSystem: descriptor.ownership.targetSystem,
          operation: descriptor.operation,
          resumeFromQueue: true,
        },
      });
    } catch {
      // Intentional: resume-audit is best-effort. Returning the
      // dispatch result is the load-bearing failure mode here — losing
      // the audit row is preferable to retrying a successful external
      // mutation.
    }

    return result;
  }

  private async dispatch(connector: IConnector, d: WriteDescriptor): Promise<unknown> {
    // d.args is `unknown` (the descriptor is decrypted from storage). Cast it
    // per-operation to the concrete shape the matching IConnector method
    // expects — the operation discriminant guarantees which shape applies.
    switch (d.operation) {
      case 'create':
        return connector.create(d.entityType, d.args as DataRecord);
      case 'update': {
        const u = d.args as { id: string; data: Partial<DataRecord> };
        return connector.update(d.entityType, u.id, u.data);
      }
      case 'delete':
        return connector.delete(d.entityType, (d.args as { id: string }).id);
      case 'bulkCreate':
        return connector.bulkCreate(d.entityType, d.args as DataRecord[]);
      case 'bulkUpdate':
        return connector.bulkUpdate(d.entityType, d.args as Partial<DataRecord>[]);
      case 'bulkDelete':
        return connector.bulkDelete(d.entityType, d.args as string[]);
      default: {
        // TypeScript exhaustiveness guard — d.operation is narrowed to `never` here.
        const exhaustive: never = d.operation;
        throw new Error(
          `OwnershipResumeHandler: unknown operation '${String(exhaustive)}' in writeDescriptor`,
        );
      }
    }
  }
}
