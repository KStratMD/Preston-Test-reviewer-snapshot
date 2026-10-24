import 'reflect-metadata';
import { OwnershipResolver } from '../../../../src/governance/sourceOfTruth/OwnershipResolver';
import {
  OwnershipViolationError,
} from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type {
  CanonicalEntity,
  SourceSystem,
  OwnershipDeclaration,
} from '../../../../src/governance/sourceOfTruth/SourceOfTruthManifest';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as import('../../../../src/utils/Logger').Logger;
}

function stubLineageQuery() {
  return {
    findRecentReciprocalActivity: jest.fn(async () => []),
  } as unknown as import('../../../../src/services/lineage/LineageQueryService').LineageQueryService;
}

// Helper — synthetic manifest so tests exercise every policy in isolation
// without depending on the production manifest's specific ownership choices.
function makeResolver(manifest: OwnershipDeclaration[]): OwnershipResolver {
  const resolver = new OwnershipResolver(stubLineageQuery(), silentLogger());
  // Test-only seam: replace the internal manifest reference.
  (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifest;
  return resolver;
}

describe('OwnershipResolver', () => {
  describe('ownerFor', () => {
    it('returns the entity-level owner when no fieldPath supplied', () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      expect(r.ownerFor('customer')).toBe<SourceSystem>('netsuite');
    });

    it('returns the field-override owner when fieldPath matches', () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      expect(r.ownerFor('customer', 'salesPipelineStage')).toBe<SourceSystem>('salesforce');
    });

    it('falls back to entity owner when fieldPath has no override', () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      expect(r.ownerFor('customer', 'name')).toBe<SourceSystem>('netsuite');
    });
  });

  describe('validateWrite', () => {
    const ctx = {
      tenantId: 't-1',
      entity: 'customer' as CanonicalEntity,
      targetSystem: 'netsuite' as SourceSystem,
      correlationId: 'corr-1',
    };

    it('owner write → {allowed: true, owner}', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({ ...ctx, callerSystem: 'netsuite' });
      expect(decision).toEqual({ allowed: true, owner: 'netsuite' });
    });

    it('non-owner with source_wins → {allowed: false, reason, policy, declaredOwner}', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          conflictPolicy: 'source_wins',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({ ...ctx, callerSystem: 'salesforce' });
      expect(decision).toEqual({
        allowed: false,
        reason: 'non_owner_write',
        policy: 'source_wins',
        declaredOwner: 'netsuite',
      });
    });

    it('non-owner with target_wins → {allowed: true, owner: targetSystem}', async () => {
      // Use a manifest where the declared owner ('hubspot') is distinct
      // from the targetSystem ('netsuite') so the assertion proves the
      // target-attribution semantics rather than just any system winning
      // because all values coincide. Copilot R4 (PR 13): prior fixture
      // conflated declared owner with targetSystem.
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'hubspot',
          consumers: ['salesforce', 'netsuite'],
          conflictPolicy: 'target_wins',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        targetSystem: 'netsuite',
        callerSystem: 'salesforce',
      });
      expect(decision).toEqual({ allowed: true, owner: 'netsuite' });
    });

    it('non-owner with reject_with_alert → throws OwnershipViolationError', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      await expect(
        r.validateWrite({ ...ctx, callerSystem: 'salesforce' })
      ).rejects.toThrow(OwnershipViolationError);

      // Re-execute to inspect the .detail field
      try {
        await r.validateWrite({ ...ctx, callerSystem: 'salesforce' });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(OwnershipViolationError);
        const e = err as OwnershipViolationError;
        expect(e.detail).toEqual({
          entity: 'customer',
          declaredOwner: 'netsuite',
          callerSystem: 'salesforce',
          conflictPolicy: 'reject_with_alert',
          correlationId: 'corr-1',
        });
      }
    });

    it('merge_field_level owner write → full allow', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'netsuite',
        operation: 'update',
        fieldPaths: ['name'],
      });
      expect(decision).toEqual({ allowed: true, owner: 'netsuite' });
    });

    it('merge_field_level non-owner update with caller-owned fields → structured allow', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        operation: 'update',
        fieldPaths: ['salesPipelineStage'],
      });
      expect(decision).toEqual({
        allowed: true,
        owner: 'salesforce',
        reason: 'field_level_merge',
        policy: 'merge_field_level',
        declaredOwner: 'netsuite',
        allowedFieldPaths: ['salesPipelineStage'],
        blockedFieldPaths: [],
      });
    });

    it('merge_field_level non-owner update with mixed fields → allow plus blocked list', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        operation: 'update',
        fieldPaths: ['salesPipelineStage', 'name'],
      });
      expect(decision).toEqual({
        allowed: true,
        owner: 'salesforce',
        reason: 'field_level_merge',
        policy: 'merge_field_level',
        declaredOwner: 'netsuite',
        allowedFieldPaths: ['salesPipelineStage'],
        blockedFieldPaths: ['name'],
      });
    });

    it('merge_field_level non-owner update with no caller-owned fields → field_level_merge_blocked', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'marketingConsent.email', owner: 'hubspot', rationale: 'test' },
          ],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        operation: 'update',
        fieldPaths: ['name', 'marketingConsent.email'],
      });
      expect(decision).toEqual({
        allowed: false,
        reason: 'field_level_merge_blocked',
        policy: 'merge_field_level',
        declaredOwner: 'netsuite',
        allowedFieldPaths: [],
        blockedFieldPaths: ['name', 'marketingConsent.email'],
      });
    });

    it('merge_field_level non-owner create/delete and missing field paths fail closed', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);

      await expect(r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        operation: 'create',
        fieldPaths: ['salesPipelineStage'],
      })).resolves.toMatchObject({
        allowed: false,
        reason: 'field_level_merge_blocked',
        blockedFieldPaths: ['salesPipelineStage'],
      });

      await expect(r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        operation: 'update',
        fieldPaths: [],
      })).resolves.toMatchObject({
        allowed: false,
        reason: 'field_level_merge_blocked',
        blockedFieldPaths: [],
      });
    });

    it('merge_field_level operator_action without override owns no fields', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'merge_field_level',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'operator_action',
        operation: 'update',
        fieldPaths: ['salesPipelineStage'],
      });
      expect(decision).toMatchObject({
        allowed: false,
        reason: 'field_level_merge_blocked',
        blockedFieldPaths: ['salesPipelineStage'],
      });
    });

    it('queue_for_human policy → {allowed: false, reason: "queue_required", declaredOwner}', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'queue_for_human',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({ ...ctx, callerSystem: 'salesforce' });
      expect(decision).toEqual({ allowed: false, reason: 'queue_required', declaredOwner: 'netsuite' });
    });

    it('field-override owner: caller is field owner → {allowed: true}', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          fieldOverrides: [
            { fieldPath: 'salesPipelineStage', owner: 'salesforce', rationale: 'test' },
          ],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        ...ctx,
        callerSystem: 'salesforce',
        fieldPaths: ['salesPipelineStage'],
      });
      expect(decision).toEqual({ allowed: true, owner: 'salesforce' });
    });
  });

  describe('detectLoop', () => {
    function manifestWithLoop(): OwnershipDeclaration[] {
      return [
        {
          entity: 'payout_batch',
          owner: 'squire',
          consumers: ['netsuite'],
          conflictPolicy: 'source_wins',
          conflictPolicyRationale: 'test',
          knownLoops: [
            { counterpart: 'netsuite', windowMs: 60_000, breakingCondition: 'audit_logs.action != "sync_back_from_erp"' },
          ],
        },
      ];
    }
    function manifestNoLoop(): OwnershipDeclaration[] {
      return [
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ];
    }

    it('entity with no knownLoops → {loopDetected: false} (no lineage query)', async () => {
      const lineage = stubLineageQuery();
      const resolver = new OwnershipResolver(lineage, silentLogger());
      (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifestNoLoop();
      const result = await resolver.detectLoop({
        tenantId: 't', entity: 'customer', entityType: 'Customer', entityId: 'c-1',
        targetSystem: 'netsuite', callerSystem: 'salesforce', correlationId: 'corr',
      });
      expect(result).toEqual({ loopDetected: false });
      expect((lineage.findRecentReciprocalActivity as jest.Mock)).not.toHaveBeenCalled();
    });

    it('reciprocal write inside window → {loopDetected: true, breakingCondition}', async () => {
      const lineage = stubLineageQuery();
      (lineage.findRecentReciprocalActivity as jest.Mock).mockResolvedValue([
        { chainId: 'chain-X', occurredAt: new Date().toISOString() },
      ]);
      const resolver = new OwnershipResolver(lineage, silentLogger());
      (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifestWithLoop();
      const result = await resolver.detectLoop({
        tenantId: 't', entity: 'payout_batch', entityType: 'PayoutBatch', entityId: 'pb-1',
        targetSystem: 'netsuite', callerSystem: 'squire', correlationId: 'corr',
      });
      expect(result).toEqual({
        loopDetected: true,
        breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      });
    });

    it('no reciprocal write inside window → {loopDetected: false}', async () => {
      const lineage = stubLineageQuery();
      (lineage.findRecentReciprocalActivity as jest.Mock).mockResolvedValue([]);
      const resolver = new OwnershipResolver(lineage, silentLogger());
      (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifestWithLoop();
      const result = await resolver.detectLoop({
        tenantId: 't', entity: 'payout_batch', entityType: 'PayoutBatch', entityId: 'pb-1',
        targetSystem: 'netsuite', callerSystem: 'squire', correlationId: 'corr',
      });
      expect(result).toEqual({ loopDetected: false });
    });

    it('targetSystem does not match any knownLoops.counterpart → no query + false', async () => {
      const lineage = stubLineageQuery();
      const resolver = new OwnershipResolver(lineage, silentLogger());
      (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifestWithLoop();
      const result = await resolver.detectLoop({
        tenantId: 't', entity: 'payout_batch', entityType: 'PayoutBatch', entityId: 'pb-1',
        targetSystem: 'business_central', callerSystem: 'squire', correlationId: 'corr',
      });
      expect(result).toEqual({ loopDetected: false });
      expect((lineage.findRecentReciprocalActivity as jest.Mock)).not.toHaveBeenCalled();
    });

    // Copilot R1 (PR 13b) cluster-B widening — detectLoop accepts a non-
    // canonical entity (e.g. raw connector record type 'contacts') and
    // resolves to `loopDetected: false` instead of throwing the
    // "no manifest declaration" Error. The lineage query is intentionally
    // skipped — the manifest is the only source of loop signatures, so
    // an unknown entity carries no hazard signature to check against.
    it('entity not in manifest → {loopDetected: false} without throwing', async () => {
      const lineage = stubLineageQuery();
      const resolver = new OwnershipResolver(lineage, silentLogger());
      (resolver as unknown as { manifest: OwnershipDeclaration[] }).manifest = manifestWithLoop();
      const result = await resolver.detectLoop({
        tenantId: 't',
        entity: 'contacts', // plural / connector-side, NOT in manifest
        entityType: 'Contact',
        entityId: 'c-1',
        targetSystem: 'netsuite',
        callerSystem: 'squire',
        correlationId: 'corr',
      });
      expect(result).toEqual({ loopDetected: false });
      expect((lineage.findRecentReciprocalActivity as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  // Demo-tenant override: when OWNERSHIP_DEMO_TENANT_ID names the write's
  // tenant, a non-owner write under reject_with_alert is allowed with the
  // distinct reason 'demo_tenant_override' (guardedWrite turns it into the
  // 'ownership_demo_tenant_override' audit flag) instead of throwing.
  // Narrow by design: reject_with_alert only — source_wins / queue_for_human /
  // merge_field_level semantics are untouched, and the SYSTEM tenant
  // ('__system__') can never be designated as the demo tenant.
  describe('validateWrite (demo-tenant override)', () => {
    const DEMO_TENANT = 'demo-tenant-1';
    const rejectManifest: OwnershipDeclaration[] = [
      {
        entity: 'customer',
        owner: 'netsuite',
        consumers: ['squire'],
        conflictPolicy: 'reject_with_alert',
        conflictPolicyRationale: 'test',
      },
    ];
    const baseInput = {
      entity: 'customer' as CanonicalEntity,
      targetSystem: 'netsuite' as SourceSystem,
      callerSystem: 'squire' as SourceSystem,
      correlationId: 'corr-demo',
    };
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.OWNERSHIP_DEMO_TENANT_ID;
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.OWNERSHIP_DEMO_TENANT_ID;
      } else {
        process.env.OWNERSHIP_DEMO_TENANT_ID = savedEnv;
      }
    });

    it('matching tenant under reject_with_alert → allowed with demo_tenant_override reason', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
      const r = makeResolver(rejectManifest);
      const decision = await r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT });
      expect(decision).toEqual({
        allowed: true,
        owner: 'netsuite',
        reason: 'demo_tenant_override',
        declaredOwner: 'netsuite',
        policy: 'reject_with_alert',
      });
    });

    it('override is logged loudly (warn) with tenant + policy context', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
      const logger = silentLogger();
      const r = new OwnershipResolver(stubLineageQuery(), logger);
      (r as unknown as { manifest: OwnershipDeclaration[] }).manifest = rejectManifest;
      await r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('demo-tenant override'),
        expect.objectContaining({ tenantId: DEMO_TENANT, callerSystem: 'squire' }),
      );
    });

    it('non-matching tenant still throws OwnershipViolationError', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
      const r = makeResolver(rejectManifest);
      await expect(
        r.validateWrite({ ...baseInput, tenantId: 'some-other-tenant' }),
      ).rejects.toThrow(OwnershipViolationError);
    });

    it('env unset → throws (override defaults closed)', async () => {
      delete process.env.OWNERSHIP_DEMO_TENANT_ID;
      const r = makeResolver(rejectManifest);
      await expect(
        r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT }),
      ).rejects.toThrow(OwnershipViolationError);
    });

    it('SYSTEM tenant can never be the demo tenant (env set to __system__ is ignored)', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = SYSTEM_IDENTITY.tenantId;
      const r = makeResolver(rejectManifest);
      await expect(
        r.validateWrite({ ...baseInput, tenantId: SYSTEM_IDENTITY.tenantId }),
      ).rejects.toThrow(OwnershipViolationError);
    });

    it('whitespace-only env value is ignored', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = '   ';
      const r = makeResolver(rejectManifest);
      await expect(
        r.validateWrite({ ...baseInput, tenantId: '   ' }),
      ).rejects.toThrow(OwnershipViolationError);
    });

    it('production: blocked without the second opt-in (fail closed)', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedAllow = process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION;
      try {
        process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
        process.env.NODE_ENV = 'production';
        delete process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION;
        const r = makeResolver(rejectManifest);
        await expect(
          r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT }),
        ).rejects.toThrow(OwnershipViolationError);
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
        if (savedAllow === undefined) delete process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION;
        else process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION = savedAllow;
      }
    });

    it('production: active with the explicit second opt-in', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedAllow = process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION;
      try {
        process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
        process.env.NODE_ENV = 'production';
        process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION = '1';
        const r = makeResolver(rejectManifest);
        const decision = await r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT });
        expect(decision).toMatchObject({ allowed: true, reason: 'demo_tenant_override' });
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
        if (savedAllow === undefined) delete process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION;
        else process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION = savedAllow;
      }
    });

    it('production-blocked rejections carry the demoOverrideStatus hint in the error log', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      try {
        process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
        process.env.NODE_ENV = 'production';
        const logger = silentLogger();
        const r = new OwnershipResolver(stubLineageQuery(), logger);
        (r as unknown as { manifest: OwnershipDeclaration[] }).manifest = rejectManifest;
        await expect(
          r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT }),
        ).rejects.toThrow(OwnershipViolationError);
        expect(logger.error).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Error),
          expect.objectContaining({ demoOverrideStatus: 'production_blocked' }),
        );
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
      }
    });

    it('does NOT apply to source_wins (policy untouched for matching tenant)', async () => {
      process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['squire'],
          conflictPolicy: 'source_wins',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({ ...baseInput, tenantId: DEMO_TENANT });
      expect(decision).toEqual({
        allowed: false,
        reason: 'non_owner_write',
        policy: 'source_wins',
        declaredOwner: 'netsuite',
      });
    });
  });

  // Copilot R1 (PR 13b) cluster-B — validateWrite no-policy-declared branch.
  // The 9 callsites flagged by Copilot (IntegrationService / IntegrationExecutor /
  // SyncCentralOrchestrator / SyncErrorAssist*) pass connector-side record types
  // (e.g. 'contacts', 'Customer', 'records') that aren't in SOURCE_OF_TRUTH_MANIFEST.
  // Previously these would throw an "OwnershipResolver: entity '<x>' has no manifest
  // declaration" Error BEFORE the connector write ran. The resolver now treats
  // unknown entities as "no policy → allow with audit flag".
  describe('validateWrite (no-policy-declared widening)', () => {
    it('entity not in manifest → {allowed: true, owner: targetSystem, reason: "no_policy_declared"}', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        tenantId: 't-1',
        entity: 'contacts', // plural connector record type, NOT in manifest
        targetSystem: 'hubspot',
        callerSystem: 'salesforce',
        correlationId: 'corr-X',
      });
      expect(decision).toEqual({
        allowed: true,
        owner: 'hubspot',
        reason: 'no_policy_declared',
      });
    });

    it('non-canonical CamelCase record name (e.g. "Customer") → allow + no_policy_declared', async () => {
      // The manifest entry uses lowercase 'customer'; the connector-side
      // string 'Customer' is a distinct key per the manifest lookup's strict
      // equality semantics (no case-insensitive matching by design).
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: [],
          conflictPolicy: 'reject_with_alert',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        tenantId: 't-1',
        entity: 'Customer',
        targetSystem: 'salesforce',
        callerSystem: 'netsuite',
        correlationId: 'corr-Y',
      });
      expect(decision.allowed).toBe(true);
      // allowed shape's `owner` is the targetSystem AND `reason` flags the no-policy path
      expect(decision).toMatchObject({ allowed: true, owner: 'salesforce', reason: 'no_policy_declared' });
    });

    it('canonical entity still produces ownership decision without the no_policy flag', async () => {
      const r = makeResolver([
        {
          entity: 'customer',
          owner: 'netsuite',
          consumers: ['salesforce'],
          conflictPolicy: 'source_wins',
          conflictPolicyRationale: 'test',
        },
      ]);
      const decision = await r.validateWrite({
        tenantId: 't-1',
        entity: 'customer', // canonical — must use the manifest path
        targetSystem: 'netsuite',
        callerSystem: 'salesforce',
        correlationId: 'corr-Z',
      });
      // source_wins on non-owner → blocked; reason field is 'non_owner_write',
      // NOT 'no_policy_declared'. Defensive against false-positive widening.
      expect(decision).toEqual({
        allowed: false,
        reason: 'non_owner_write',
        policy: 'source_wins',
        declaredOwner: 'netsuite',
      });
    });
  });
});
