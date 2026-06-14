import { createHash } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { LineageQueryService } from '../../services/lineage/LineageQueryService';
import {
  SOURCE_OF_TRUTH_MANIFEST,
  type CanonicalEntity,
  type CallerSystem,
  type ConflictPolicy,
  type OwnershipDeclaration,
  type SourceSystem,
} from './SourceOfTruthManifest';
import {
  OwnershipViolationError,
  PolicyNotYetImplementedError,
} from './ConflictResolutionPolicy';
import { ownershipDemoTenantStatus } from '../../config/runtimeFlags';
import { assertSafeFieldPath } from './fieldLevelPayload';

// Canonical write-operation union, shared across the source-of-truth surface
// (guardedWrite re-exports this; AuditService imports it) so the set can't drift
// between independent copies (Copilot review).
export type WriteOperation = 'create' | 'update' | 'delete' | 'bulkCreate' | 'bulkUpdate' | 'bulkDelete';

/**
 * Hash an identifier (recordId or entityId) to a short, non-reversible
 * token before logging. Ownership-resolver logs are emitted BEFORE the
 * DLP scan, so a raw id (which may itself be PII — email, phone,
 * customer-name composite, etc.) would leak into Logger output.
 * Operators can still correlate decisions by correlationId; the
 * `rid:` prefix marks the token as a redacted identifier. Copilot R5
 * (recordId) + R7 (entityId) on PR 13.
 */
function hashId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return `rid:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

export type OwnershipDecision =
  | { allowed: true; owner: SourceSystem; reason?: 'no_policy_declared' }
  | {
      allowed: true;
      owner: SourceSystem;
      reason: 'demo_tenant_override';
      declaredOwner: SourceSystem;
      policy: 'reject_with_alert';
    }
  | {
      allowed: true;
      owner: SourceSystem;
      reason: 'field_level_merge';
      policy: 'merge_field_level';
      declaredOwner: SourceSystem;
      allowedFieldPaths: string[];
      blockedFieldPaths: string[];
    }
  | {
      allowed: false;
      reason: 'field_level_merge_blocked';
      policy: 'merge_field_level';
      declaredOwner: SourceSystem;
      allowedFieldPaths: string[];
      blockedFieldPaths: string[];
    }
  | {
      allowed: false;
      reason: 'non_owner_write';
      policy: 'source_wins';
      declaredOwner: SourceSystem;
    }
  | { allowed: false; reason: 'queue_required'; declaredOwner: SourceSystem };

const IMPLEMENTED_POLICIES: ReadonlySet<ConflictPolicy> = new Set([
  'source_wins',
  'target_wins',
  'reject_with_alert',
  'queue_for_human',
  'merge_field_level',
]);

/**
 * OwnershipResolver — PR 13 source-of-truth policy enforcement.
 *
 * `validateWrite` is the policy decision point. Its primary chokepoint is
 * guardedWrite, which wraps every guarded mutation — FlowExecutor pre-flight is
 * one consumer, but direct-write call sites in routes/services also flow through
 * guardedWrite. It validates that the caller system is allowed to write a given
 * canonical entity. Five policies implemented:
 *   - source_wins        → non-owner returns {allowed: false, reason: 'non_owner_write'};
 *                          guardedWrite throws OwnershipBlockedError (or honors
 *                          operator override → caughtViolation flow)
 *   - target_wins        → non-owner returns {allowed: true}; the write proceeds
 *   - reject_with_alert  → non-owner throws OwnershipViolationError
 *   - queue_for_human    → non-owner returns {allowed: false, reason: 'queue_required'};
 *                          guardedWrite persists an encrypted write descriptor via
 *                          the approval-queue service and throws
 *                          OwnershipPendingApprovalError (route layer maps to 202 +
 *                          pollUrl). Live as of PR 13c-2 Task 3 (the earlier
 *                          QueueForHumanNotYetSafeError fail-closed stub is retired).
 *                          queue_for_human is in IMPLEMENTED_POLICIES above so a
 *                          manifest entry declaring it passes the implemented-policy
 *                          gate rather than the deferred PolicyNotYetImplementedError.
 *   - merge_field_level  → owner writes proceed; non-owner updates are allowed
 *                          only for caller-owned field paths, with structured
 *                          allowed/blocked field lists for guardedWrite's
 *                          approved-payload filtering path.
 *
 * detectLoop queries the new findReciprocalChainSeeds repo method (added in
 * Task 4) for reciprocal write hazards within the manifest's knownLoops
 * windowMs. Spec: docs/superpowers/specs/2026-05-24-pr-13-source-of-truth-manifest-design.md
 */
@injectable()
export class OwnershipResolver {
  private readonly manifest: OwnershipDeclaration[] = SOURCE_OF_TRUTH_MANIFEST;

  constructor(
    @inject(TYPES.LineageQueryService) private readonly lineage: LineageQueryService,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  ownerFor(entity: CanonicalEntity, fieldPath?: string): SourceSystem {
    const declaration = this.lookupOrThrow(entity);
    if (fieldPath !== undefined) {
      const override = declaration.fieldOverrides?.find((f) => f.fieldPath === fieldPath);
      if (override) return override.owner;
    }
    return declaration.owner;
  }

  async validateWrite(input: {
    tenantId: string;
    /**
     * Canonical-entity name preferred; arbitrary connector record types
     * (e.g. 'contacts', 'Customer', 'records') are accepted because
     * integration configs and sync operations supply the connector-side
     * record name. When no manifest declaration matches the entity, the
     * resolver returns `{ allowed: true, owner: targetSystem,
     * reason: 'no_policy_declared' }` so the write proceeds with an audit
     * flag rather than throwing a "no manifest declaration" Error before
     * the connector write runs. Copilot R1 (PR 13b) cluster-B finding.
     */
    entity: CanonicalEntity | string;
    targetSystem: SourceSystem;
    callerSystem: CallerSystem;
    correlationId: string;
    recordId?: string;
    operation?: WriteOperation;
    fieldPaths?: readonly string[];
  }): Promise<OwnershipDecision> {
    const declaration = this.lookupOptional(input.entity);
    if (declaration === null) {
      this.logger.info('OwnershipResolver: entity has no manifest declaration; passing through with no policy', {
        tenantId: input.tenantId,
        entity: input.entity,
        recordIdHash: hashId(input.recordId),
        callerSystem: input.callerSystem,
        targetSystem: input.targetSystem,
        correlationId: input.correlationId,
      });
      return { allowed: true, owner: input.targetSystem, reason: 'no_policy_declared' };
    }
    const fieldPaths = input.fieldPaths?.map((fieldPath) => {
      assertSafeFieldPath(fieldPath);
      return fieldPath;
    });
    const effectiveOwner = this.effectiveOwnerForNonMergePolicy(declaration, fieldPaths);

    if (declaration.conflictPolicy !== 'merge_field_level' && input.callerSystem === effectiveOwner) {
      return { allowed: true, owner: effectiveOwner };
    }

    // Reject any path that depends on a deferred policy. Defense-in-depth
    // for the CI gate; the gate should have failed before this runtime
    // check ever fires.
    if (!IMPLEMENTED_POLICIES.has(declaration.conflictPolicy)) {
      throw new PolicyNotYetImplementedError(declaration.conflictPolicy);
    }

    switch (declaration.conflictPolicy) {
      case 'merge_field_level': {
        if (input.callerSystem === declaration.owner) {
          return { allowed: true, owner: declaration.owner };
        }

        if (input.operation !== 'update') {
          this.logger.warn('OwnershipResolver: non-owner write blocked by merge_field_level non-update operation', {
            tenantId: input.tenantId,
            entity: input.entity,
            recordIdHash: hashId(input.recordId),
            declaredOwner: declaration.owner,
            callerSystem: input.callerSystem,
            operation: input.operation,
            correlationId: input.correlationId,
          });
          return {
            allowed: false,
            reason: 'field_level_merge_blocked',
            policy: 'merge_field_level',
            declaredOwner: declaration.owner,
            allowedFieldPaths: [],
            blockedFieldPaths: fieldPaths ?? [],
          };
        }

        if (fieldPaths === undefined || fieldPaths.length === 0) {
          this.logger.warn('OwnershipResolver: non-owner write blocked by merge_field_level missing field paths', {
            tenantId: input.tenantId,
            entity: input.entity,
            recordIdHash: hashId(input.recordId),
            declaredOwner: declaration.owner,
            callerSystem: input.callerSystem,
            correlationId: input.correlationId,
          });
          return {
            allowed: false,
            reason: 'field_level_merge_blocked',
            policy: 'merge_field_level',
            declaredOwner: declaration.owner,
            allowedFieldPaths: [],
            blockedFieldPaths: [],
          };
        }

        const allowedFieldPaths: string[] = [];
        const blockedFieldPaths: string[] = [];
        for (const fieldPath of fieldPaths) {
          const fieldOwner = this.ownerForFromDeclaration(declaration, fieldPath);
          if (input.callerSystem === fieldOwner) {
            allowedFieldPaths.push(fieldPath);
          } else {
            blockedFieldPaths.push(fieldPath);
          }
        }

        if (allowedFieldPaths.length === 0) {
          this.logger.warn('OwnershipResolver: non-owner write blocked by merge_field_level field ownership', {
            tenantId: input.tenantId,
            entity: input.entity,
            recordIdHash: hashId(input.recordId),
            declaredOwner: declaration.owner,
            callerSystem: input.callerSystem,
            blockedFieldPaths,
            correlationId: input.correlationId,
          });
          return {
            allowed: false,
            reason: 'field_level_merge_blocked',
            policy: 'merge_field_level',
            declaredOwner: declaration.owner,
            allowedFieldPaths,
            blockedFieldPaths,
          };
        }

        this.logger.info('OwnershipResolver: non-owner update allowed by merge_field_level policy', {
          tenantId: input.tenantId,
          entity: input.entity,
          recordIdHash: hashId(input.recordId),
          declaredOwner: declaration.owner,
          callerSystem: input.callerSystem,
          allowedFieldPaths,
          blockedFieldPaths,
          correlationId: input.correlationId,
        });
        return {
          allowed: true,
          owner: input.callerSystem as SourceSystem,
          reason: 'field_level_merge',
          policy: 'merge_field_level',
          declaredOwner: declaration.owner,
          allowedFieldPaths,
          blockedFieldPaths,
        };
      }
      case 'source_wins': {
        this.logger.warn('OwnershipResolver: non-owner write blocked by source_wins policy', {
          tenantId: input.tenantId,
          entity: input.entity,
          recordIdHash: hashId(input.recordId),
          declaredOwner: effectiveOwner,
          callerSystem: input.callerSystem,
          correlationId: input.correlationId,
        });
        return {
          allowed: false,
          reason: 'non_owner_write',
          policy: 'source_wins',
          declaredOwner: effectiveOwner,
        };
      }
      case 'target_wins': {
        this.logger.info('OwnershipResolver: non-owner write allowed by target_wins policy', {
          tenantId: input.tenantId,
          entity: input.entity,
          recordIdHash: hashId(input.recordId),
          declaredOwner: effectiveOwner,
          callerSystem: input.callerSystem,
          targetSystem: input.targetSystem,
          correlationId: input.correlationId,
        });
        // Per spec: target_wins attributes the write to the target system
        // (the manifest owner has explicitly ceded conflict resolution to
        // the target side). Callers + audit logs should see the effective
        // owner of the resulting write, not the manifest's declared owner.
        return { allowed: true, owner: input.targetSystem };
      }
      case 'reject_with_alert': {
        // Demo-tenant override: a tenant explicitly designated via
        // OWNERSHIP_DEMO_TENANT_ID may perform non-owner writes under
        // reject_with_alert (and ONLY reject_with_alert — the other policies'
        // semantics are untouched). TENANT-scoped by design, not flow-scoped:
        // any write path running as the designated tenant is covered, because
        // the designated tenant is a demo sandbox identity (Codex review on
        // PR #897 — accepted risk; see ownershipDemoTenantStatus docs).
        // Allowed-with-flag rather than silent: guardedWrite records
        // 'ownership_demo_tenant_override' on the audit rows, and the warn
        // below makes the bypass visible in logs. The helper never returns
        // the SYSTEM tenant, so background/system writes cannot be
        // blanket-whitelisted, and production requires the
        // OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION double opt-in (fail
        // closed). Read per-call (no caching).
        const demoStatus = ownershipDemoTenantStatus();
        if (demoStatus.active && input.tenantId === demoStatus.tenantId) {
          this.logger.warn('OwnershipResolver: non-owner write allowed by demo-tenant override (reject_with_alert bypassed for OWNERSHIP_DEMO_TENANT_ID)', {
            tenantId: input.tenantId,
            entity: input.entity,
            recordIdHash: hashId(input.recordId),
            declaredOwner: effectiveOwner,
            callerSystem: input.callerSystem,
            targetSystem: input.targetSystem,
            correlationId: input.correlationId,
          });
          return {
            allowed: true,
            owner: effectiveOwner,
            reason: 'demo_tenant_override',
            declaredOwner: effectiveOwner,
            policy: 'reject_with_alert',
          };
        }
        this.logger.error('OwnershipResolver: non-owner write rejected by reject_with_alert policy', new Error('OwnershipViolation'), {
          tenantId: input.tenantId,
          entity: input.entity,
          recordIdHash: hashId(input.recordId),
          declaredOwner: effectiveOwner,
          callerSystem: input.callerSystem,
          correlationId: input.correlationId,
          // Operator hint: when OWNERSHIP_DEMO_TENANT_ID is configured but
          // inactive (e.g. production without the second opt-in), surface why
          // a write the operator expected to bypass got rejected anyway.
          ...(demoStatus.active === false && demoStatus.reason !== 'unset'
            ? { demoOverrideStatus: demoStatus.reason }
            : {}),
        });
        throw new OwnershipViolationError({
          entity: input.entity,
          declaredOwner: effectiveOwner,
          callerSystem: input.callerSystem,
          conflictPolicy: 'reject_with_alert',
          fieldPath: fieldPaths?.length === 1 ? fieldPaths[0] : undefined,
          correlationId: input.correlationId,
        });
      }
      case 'queue_for_human': {
        this.logger.info('OwnershipResolver: non-owner write queued for human approval', {
          tenantId: input.tenantId,
          entity: input.entity,
          recordIdHash: hashId(input.recordId),
          declaredOwner: effectiveOwner,
          callerSystem: input.callerSystem,
          correlationId: input.correlationId,
        });
        return {
          allowed: false,
          reason: 'queue_required',
          declaredOwner: effectiveOwner,
        };
      }
    }

    // Exhaustiveness — unreachable if IMPLEMENTED_POLICIES stays in sync
    // with the switch arms above. Defensive throw so TS narrows away.
    throw new PolicyNotYetImplementedError(declaration.conflictPolicy);
  }

  async detectLoop(input: {
    tenantId: string;
    /**
     * Same widening rationale as validateWrite: a non-manifest entity is
     * treated as "no known loops" rather than throwing. The detector only
     * has loop signatures for manifest-declared entities anyway, so
     * returning `{ loopDetected: false }` for unknown entities is the
     * semantic identity (no information was available, so no hazard
     * could be detected).
     */
    entity: CanonicalEntity | string;
    /**
     * The connector-side record type as emitted into lineage_events by
     * FlowExecutor (e.g. 'Contact', 'PayoutBatch'). Distinct from
     * `entity` (the canonical key for manifest lookup) because the
     * lineage table stores the display-form recordType the IConnector
     * accepts, not the SourceOfTruth canonical name. Callers MUST pass
     * the same string the upstream `lineage.targetWrite({entityType, …})`
     * site emits, or this query will not match any chain.
     * Copilot R3 finding: without this parameter, detectLoop queried
     * with the canonical entity name and never matched real chains.
     */
    entityType: string;
    entityId: string;
    targetSystem: SourceSystem;
    callerSystem: SourceSystem;
    correlationId: string;
  }): Promise<{ loopDetected: boolean; breakingCondition?: string }> {
    const declaration = this.lookupOptional(input.entity);
    if (declaration === null) return { loopDetected: false };
    // Copilot R12 on PR #851: `knownLoops[i].counterpart` is the OTHER system
    // in the reciprocal pair (vs the entity's owner). A loop can fire from
    // either direction:
    //   - Forward write (owner → counterpart): caller=owner, target=counterpart.
    //     `counterpart === target` matches.
    //   - Return write (counterpart → owner): caller=counterpart, target=owner.
    //     `counterpart === caller` matches — previously the filter missed this.
    // Concrete example: `payment` (owner=stripe, counterpart=netsuite) — the
    // documented stripe↔netsuite loop. The return write (netsuite→stripe)
    // was silently skipped because only `target` was checked.
    const relevantLoops = (declaration.knownLoops ?? []).filter(
      (l) => l.counterpart === input.targetSystem || l.counterpart === input.callerSystem,
    );
    if (relevantLoops.length === 0) return { loopDetected: false };

    // Use the widest window across all matching loops so a missed hazard
    // in the narrower window is still caught.
    const maxWindow = Math.max(...relevantLoops.map((l) => l.windowMs));
    const chains = await this.lineage.findRecentReciprocalActivity({
      tenantId: input.tenantId,
      callerSystem: input.callerSystem,
      targetSystem: input.targetSystem,
      entityType: input.entityType,
      entityId: input.entityId,
      withinMs: maxWindow,
    });

    if (chains.length === 0) return { loopDetected: false };

    const firstLoop = relevantLoops[0];
    this.logger.warn('OwnershipResolver.detectLoop: reciprocal-write hazard detected', {
      tenantId: input.tenantId,
      entity: input.entity,
      entityType: input.entityType,
      entityIdHash: hashId(input.entityId),
      callerSystem: input.callerSystem,
      targetSystem: input.targetSystem,
      breakingCondition: firstLoop.breakingCondition,
      matchingChains: chains.length,
      correlationId: input.correlationId,
    });
    return { loopDetected: true, breakingCondition: firstLoop.breakingCondition };
  }

  private lookupOrThrow(entity: CanonicalEntity): OwnershipDeclaration {
    const found = this.manifest.find((d) => d.entity === entity);
    if (!found) {
      throw new Error(`OwnershipResolver: entity '${entity}' has no manifest declaration`);
    }
    return found;
  }

  private lookupOptional(entity: string): OwnershipDeclaration | null {
    return this.manifest.find((d) => d.entity === entity) ?? null;
  }

  private ownerForFromDeclaration(
    declaration: OwnershipDeclaration,
    fieldPath?: string,
  ): SourceSystem {
    if (fieldPath !== undefined) {
      const override = declaration.fieldOverrides?.find((f) => f.fieldPath === fieldPath);
      if (override) return override.owner;
    }
    return declaration.owner;
  }

  private effectiveOwnerForNonMergePolicy(
    declaration: OwnershipDeclaration,
    fieldPaths: readonly string[] | undefined,
  ): SourceSystem {
    if (fieldPaths?.length === 1) {
      return this.ownerForFromDeclaration(declaration, fieldPaths[0]);
    }
    return declaration.owner;
  }
}
