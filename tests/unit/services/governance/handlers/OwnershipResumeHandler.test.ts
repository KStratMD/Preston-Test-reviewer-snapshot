// OwnershipResumeHandler unit tests (PR 13b Stage B + PR 13c-2).
//
// Covers:
//   1. operationType sentinel ('ownership_write') and resourceType sentinel ('*').
//   2. create dispatch — passes decrypted args directly to connector.create.
//   3. update dispatch — unpacks { id, data } and calls connector.update(entityType, id, data).
//   4. Missing writeDescriptor throws (worker catches, returns {applied:false,error}).
//   5. Unknown operation in descriptor throws.
//   6. resumeFromQueue=true is present in the logGovernanceCheck ownership payload.
//   7. PR 13c-2 Task 4: detectLoop runs before dispatch for SourceSystem callers and
//      throws LoopDetectedError when a reciprocal lineage formed post-enqueue.
//   8. PR 13c-2 Task 4: detectLoop is SKIPPED for non-SourceSystem callers
//      (operator_action et al — not in the lineage graph).
//   9. PR 13c-2 Task 3 step 6: integrationConfigId triggers
//      initializeConnectorsForConfig before dispatch.

import 'reflect-metadata';
import { createHash } from 'crypto';
import { EncryptionService } from '../../../../../src/services/security/EncryptionService';
import { encryptDescriptor } from '../../../../../src/services/governance/writeDescriptorEncryption';
import { OwnershipResumeHandler } from '../../../../../src/services/governance/handlers/OwnershipResumeHandler';
import type { PersistedApproval } from '../../../../../src/services/governance/ApprovalQueueRepository';
import type { WriteDescriptor } from '../../../../../src/governance/sourceOfTruth/guardedWrite';
import { LoopDetectedError } from '../../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';

let testEncryption: EncryptionService;
let prevEncryptionKey: string | undefined;
beforeAll(() => {
  // Save/restore the env var so this suite doesn't leak global state to
  // other tests in the same Jest worker. Copilot R0 #4 on PR #853.
  prevEncryptionKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
  process.env.AI_CONFIG_ENCRYPTION_KEY = '0'.repeat(64);
  testEncryption = new EncryptionService();
});
afterAll(() => {
  if (prevEncryptionKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
  else process.env.AI_CONFIG_ENCRYPTION_KEY = prevEncryptionKey;
});

function mockConnector() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'new-rec' }),
    update: jest.fn().mockResolvedValue({ id: 'upd-rec' }),
    // `IConnector.delete()` returns Promise<boolean>; every real connector
    // honors that. Resolving an object here would let the handler's
    // delete-result handling drift from the contract without any test noticing.
    delete: jest.fn().mockResolvedValue(true),
    bulkCreate: jest.fn().mockResolvedValue([]),
    bulkUpdate: jest.fn().mockResolvedValue([]),
    bulkDelete: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({ outcome: 'created', id: 'up-rec' }),
  };
}

function mockConnectorManager(connector: ReturnType<typeof mockConnector>) {
  return {
    getConnector: jest.fn().mockResolvedValue(connector),
    initializeConnectorsForConfig: jest.fn().mockResolvedValue(undefined),
  };
}

function mockAuditService() {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue('audit-id-1'),
  };
}

function mockConfigService(returnValue: unknown = undefined) {
  return {
    getConfiguration: jest.fn().mockReturnValue(returnValue),
    getConfigurationForTenant: jest.fn().mockReturnValue(returnValue),
  };
}

function mockOwnershipResolver(loopDetected = false, breakingCondition?: string) {
  return {
    detectLoop: jest.fn().mockResolvedValue({ loopDetected, breakingCondition }),
    validateWrite: jest.fn(),
  };
}

function makeHandler(
  overrides: {
    connector?: ReturnType<typeof mockConnector>;
    audit?: ReturnType<typeof mockAuditService>;
    config?: ReturnType<typeof mockConfigService>;
    resolver?: ReturnType<typeof mockOwnershipResolver>;
  } = {},
) {
  const connector = overrides.connector ?? mockConnector();
  const connMgr = mockConnectorManager(connector);
  const audit = overrides.audit ?? mockAuditService();
  const config = overrides.config ?? mockConfigService();
  const resolver = overrides.resolver ?? mockOwnershipResolver();
  const handler = new OwnershipResumeHandler(
    connMgr as any,
    audit as any,
    testEncryption,
    config as any,
    resolver as any,
  );
  return { handler, connector, connMgr, audit, config, resolver };
}

function makeApproval(overrides: Partial<PersistedApproval> = {}): PersistedApproval {
  return {
    id: 'appr-1',
    tenantId: 't1',
    requesterUserId: 'u1',
    operationType: 'ownership_write',
    resourceType: 'customer',
    resourceId: 'rec-42',
    riskLevel: 'medium',
    redactedPayload: '{}',
    policyFindings: '[]',
    status: 'approved',
    createdAt: '2026-05-20T00:00:00.000Z',
    expiresAt: '2026-05-21T00:00:00.000Z',
    decidedAt: '2026-05-20T01:00:00.000Z',
    decidedByUserId: 'approver',
    decisionReason: null,
    applyIdempotencyKey: null,
    writeDescriptor: null,
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<WriteDescriptor> = {}): WriteDescriptor {
  return {
    targetSystemId: 'hubspot',
    operation: 'create',
    entityType: 'Contact',
    args: { firstName: 'Ada' },
    ownership: {
      entity: 'customer',
      declaredOwner: 'hubspot',
      callerSystem: 'netsuite',
      targetSystem: 'hubspot',
    },
    ...overrides,
  };
}

async function persistDescriptor(d: WriteDescriptor): Promise<string> {
  const payload = await encryptDescriptor(d, testEncryption);
  return JSON.stringify(payload);
}

describe('OwnershipResumeHandler', () => {
  it('has the correct operationType and resourceType sentinel', () => {
    const { handler } = makeHandler();
    expect(handler.operationType).toBe('ownership_write');
    expect(handler.resourceType).toBe('*');
  });

  it('dispatches create: passes decrypted args directly to connector.create', async () => {
    const { handler, connector, connMgr } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'create',
      entityType: 'Contact',
      args: { firstName: 'Ada', email: 'ada@test.com' },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connMgr.getConnector).toHaveBeenCalledWith('hubspot', 'hubspot');
    expect(connector.create).toHaveBeenCalledWith('Contact', { firstName: 'Ada', email: 'ada@test.com' });
    expect(result).toEqual({ id: 'new-rec' });
  });

  it('dispatches update: unpacks { id, data } and calls connector.update(entityType, id, data)', async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'update',
      entityType: 'Contact',
      args: { id: 'rec-99', data: { firstName: 'Ada Updated' } },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connector.update).toHaveBeenCalledWith('Contact', 'rec-99', { firstName: 'Ada Updated' });
    expect(result).toEqual({ id: 'upd-rec' });
  });

  it('throws when writeDescriptor is null (missing)', async () => {
    const { handler, connector } = makeHandler();
    const approval = makeApproval({ writeDescriptor: null });

    await expect(handler.apply(approval)).rejects.toThrow(/missing writeDescriptor/i);
    expect(connector.create).not.toHaveBeenCalled();
  });

  it('throws when writeDescriptor is unparseable JSON', async () => {
    const { handler, connector } = makeHandler();
    const approval = makeApproval({ writeDescriptor: '{not valid json' });

    await expect(handler.apply(approval)).rejects.toThrow(/unparseable writeDescriptor JSON/i);
    expect(connector.create).not.toHaveBeenCalled();
  });

  it('dispatches delete: calls connector.delete(entityType, id)', async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'delete',
      entityType: 'Contact',
      args: { id: 'rec-del-1' },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connector.delete).toHaveBeenCalledWith('Contact', 'rec-del-1');
    expect(result).toBe(true);
  });

  it('dispatches bulkCreate: calls connector.bulkCreate(entityType, records)', async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'bulkCreate',
      entityType: 'Contact',
      args: [{ firstName: 'Ada' }, { firstName: 'Bea' }],
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connector.bulkCreate).toHaveBeenCalledWith('Contact', [{ firstName: 'Ada' }, { firstName: 'Bea' }]);
  });

  it('dispatches bulkUpdate: calls connector.bulkUpdate(entityType, records)', async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'bulkUpdate',
      entityType: 'Contact',
      args: [{ id: 'rec-1', firstName: 'Ada Updated' }],
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connector.bulkUpdate).toHaveBeenCalledWith('Contact', [{ id: 'rec-1', firstName: 'Ada Updated' }]);
  });

  it('dispatches bulkDelete: calls connector.bulkDelete(entityType, ids)', async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'bulkDelete',
      entityType: 'Contact',
      args: ['rec-1', 'rec-2'],
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connector.bulkDelete).toHaveBeenCalledWith('Contact', ['rec-1', 'rec-2']);
  });

  it('throws on unknown operation in writeDescriptor', async () => {
    // 'upsert' is now a handled WriteOperation (Prerequisite PR A) — use a
    // genuinely bogus operation string to exercise the exhaustiveness guard.
    const { handler } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'archive' as any,
      entityType: 'Contact',
      args: {},
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await expect(handler.apply(approval)).rejects.toThrow(/unknown operation.*archive/i);
  });

  it('emits logGovernanceCheck with resumeFromQueue=true', async () => {
    const { handler, audit } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'create',
      ownership: {
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
        targetSystem: 'hubspot',
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(audit.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkType: 'ownership',
        approved: true,
        ownership: expect.objectContaining({
          resumeFromQueue: true,
          entity: 'customer',
          declaredOwner: 'hubspot',
          callerSystem: 'netsuite',
        }),
      }),
    );
  });

  // ── PR 13c-2 Task 4: detectLoop on resume ────────────────────────

  it('detectLoop: throws LoopDetectedError when a reciprocal lineage formed after enqueue (SourceSystem caller)', async () => {
    const resolver = mockOwnershipResolver(true, 'last 24h: 3 reciprocal writes');
    const { handler, connector, audit } = makeHandler({ resolver });
    const descriptor = makeDescriptor({
      ownership: {
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
        targetSystem: 'hubspot',
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await expect(handler.apply(approval)).rejects.toBeInstanceOf(LoopDetectedError);
    expect(resolver.detectLoop).toHaveBeenCalledTimes(1);
    // Dispatch must NEVER happen on a loop-detected resume.
    expect(connector.create).not.toHaveBeenCalled();
    // Loop audit row fires with the loop_detected + resume_from_queue flags.
    expect(audit.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkType: 'loop_detection',
        approved: false,
        flags: expect.arrayContaining(['loop_detected', 'resume_from_queue']),
      }),
    );
  });

  it("detectLoop: normalizes resourceId='new' sentinel to empty string for the entityId arg (matches guardedWrite source-time shape)", async () => {
    // guardedWrite enqueues queue_required rows with `resourceId: context.recordId ?? 'new'`
    // so create-without-id rows group under 'new' in the operator UI. The
    // resume handler must un-translate that sentinel before calling detectLoop,
    // because guardedWrite's source-time detectLoop uses `context.recordId ?? ''`.
    // Without the normalization, create-without-id queue+resume cycles would
    // query a different lineage key than the original write. Copilot R0 #2 on PR #853.
    const resolver = mockOwnershipResolver();
    const { handler } = makeHandler({ resolver });
    const descriptor = makeDescriptor();
    const approval = makeApproval({
      writeDescriptor: await persistDescriptor(descriptor),
      resourceId: 'new',
    });

    await handler.apply(approval);

    expect(resolver.detectLoop).toHaveBeenCalledTimes(1);
    expect(resolver.detectLoop).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: '' }),
    );
  });

  it('detectLoop: SKIPPED for non-SourceSystem callers (operator_action)', async () => {
    const resolver = mockOwnershipResolver();
    const { handler, connector } = makeHandler({ resolver });
    const descriptor = makeDescriptor({
      ownership: {
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'operator_action',
        targetSystem: 'hubspot',
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(resolver.detectLoop).not.toHaveBeenCalled();
    expect(connector.create).toHaveBeenCalledTimes(1);
  });

  // ── PR 13c-2 Task 3 step 6: integrationConfigId → initializeConnectorsForConfig ───

  it('integrationConfigId: resolves config + calls initializeConnectorsForConfig before dispatch', async () => {
    const fakeConfig = {
      id: 'cfg-1',
      sourceSystem: 'netsuite',
      targetSystem: 'hubspot',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(fakeConfig);
    const { handler, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({
      integrationConfigId: 'cfg-1',
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(config.getConfigurationForTenant).toHaveBeenCalledWith('t1', 'cfg-1');
    expect(config.getConfiguration).not.toHaveBeenCalled();
    expect(connMgr.initializeConnectorsForConfig).toHaveBeenCalledWith(fakeConfig);
    // Subsequent getConnector uses the per-config systemId form (matches the
    // cache key initializeConnectorsForConfig populates internally).
    expect(connMgr.getConnector).toHaveBeenCalledWith('hubspot', 'hubspot_cfg-1');
  });

  // Copilot round 3 on PR-A: connectorKeyForSystem THROWS on a system it
  // cannot project, which a stored config can hit after a legacy or renamed
  // spelling. Its own message names only the offending string, so a bare
  // escape would leave an operator without the approval or config id needed to
  // find the row — strictly harder to triage than the adjacent mismatch error.
  it('integrationConfigId: an unprojectable targetSystem still names the approval and config', async () => {
    const config = mockConfigService({
      id: 'cfg-legacy',
      sourceSystem: 'netsuite',
      targetSystem: 'totally-unknown-system',
      authentication: { source: {}, target: {} },
    });
    const { handler, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-legacy' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const err = await handler.apply(approval).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('appr-1');                    // the approval
    expect(message).toContain('cfg-legacy');                // the config
    // Refused before touching a connector.
    expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
  });

  // Codex R4 on PR-A: the message above must NOT carry the offending value.
  // `targetSystem` is operator-authored free text that only has to be truthy to
  // be stored, and an UNPROJECTABLE one is by definition outside the closed
  // vocabulary — so it can be anything a misconfiguration put there. This
  // message is persisted verbatim to `governance_approvals.apply_error`, logged
  // at ERROR, and returned to the caller, so echoing it would durably leak a
  // pasted credential / account number / serial.
  it('integrationConfigId: an unprojectable targetSystem is fingerprinted, never echoed', async () => {
    const secretish = 'AKIA-NOT-A-SYSTEM-9f3c1d';
    const config = mockConfigService({
      id: 'cfg-legacy',
      sourceSystem: 'netsuite',
      targetSystem: secretish,
      authentication: { source: {}, target: {} },
    });
    const { handler } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-legacy' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const err = (await handler.apply(approval).catch((e: unknown) => e)) as Error;

    // The value appears nowhere in the message — not directly, and not via the
    // wrapped helper's own message (which names the lowercased spelling).
    expect(err.message).not.toContain(secretish);
    expect(err.message).not.toContain(secretish.toLowerCase());
    // ...nor via `cause`: the whole Error is handed to the logger, and error
    // serializers walk the cause chain.
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();

    // What IS emitted: a stable, non-reversible correlator, so two failures on
    // the same bad value are recognizably the same and two on different values
    // are recognizably different.
    const expected = `sys:${createHash('sha256').update(secretish).digest('hex').slice(0, 12)}`;
    expect(err.message).toContain(expected);

    const other = mockConfigService({
      id: 'cfg-legacy',
      sourceSystem: 'netsuite',
      targetSystem: 'a-different-bad-value',
      authentication: { source: {}, target: {} },
    });
    const second = makeHandler({ config: other });
    const otherErr = (await second.handler
      .apply(makeApproval({ writeDescriptor: await persistDescriptor(descriptor) }))
      .catch((e: unknown) => e)) as Error;
    expect(otherErr.message).not.toContain(expected);
  });

  // Codex R6 on PR #853: when the resume consumes a specific
  // IntegrationConfig, the audit row carries an `integration_config:${id}`
  // forensic flag so the (approvalId, tenantId, configId) triple is
  // queryable from the audit log alone. This is the forensic anchor for
  // cross-tenant replay investigations (the deeper fix — tenant-scoped
  // ConfigurationService — is deferred to PR 13c-3).
  it('integrationConfigId: emits integration_config:${id} forensic flag on the audit row', async () => {
    const fakeConfig = {
      id: 'cfg-forensic',
      sourceSystem: 'netsuite',
      targetSystem: 'hubspot',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(fakeConfig);
    const { handler, audit } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-forensic' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(audit.logGovernanceCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: expect.arrayContaining(['resume_from_queue', 'integration_config:cfg-forensic']),
      }),
    );
  });

  it('integrationConfigId absent: forensic flag is NOT emitted', async () => {
    const { handler, audit } = makeHandler();
    const descriptor = makeDescriptor({ integrationConfigId: undefined });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    const call = (audit.logGovernanceCheck as jest.Mock).mock.calls[0]?.[0] as
      | { flags: string[] }
      | undefined;
    expect(call).toBeDefined();
    expect(call!.flags).toEqual(['resume_from_queue']);
  });

  it('integrationConfigId absent: falls back to legacy getConnector(targetSystemId, targetSystemId) without initialize', async () => {
    const { handler, connMgr } = makeHandler();
    const descriptor = makeDescriptor({ integrationConfigId: undefined });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
    expect(connMgr.getConnector).toHaveBeenCalledWith('hubspot', 'hubspot');
  });

  it('integrationConfigId: FAIL CLOSED when config.targetSystem.type diverges from descriptor.targetSystemId', async () => {
    // Copilot R1 on PR #853: config's targetSystem must match the
    // descriptor's targetSystemId. Mismatch means we'd initialize one
    // connector and dispatch through a different (uninitialized or
    // wrong-tenant) instance with the operator's authorization.
    const driftedConfig = {
      id: 'cfg-1',
      sourceSystem: 'netsuite',
      // descriptor below uses targetSystemId='hubspot' — config says 'shopify'
      targetSystem: 'shopify',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(driftedConfig);
    const { handler, connector, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({
      integrationConfigId: 'cfg-1',
      targetSystemId: 'hubspot', // diverges from config.targetSystem
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await expect(handler.apply(approval)).rejects.toThrow(
      /targetSystemId='hubspot'.*targetSystem\.type='shopify'/i,
    );
    // Dispatch must NEVER happen on a config-target drift.
    expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
    expect(connector.create).not.toHaveBeenCalled();
  });

  it('integrationConfigId: accepts SystemConfig object shape (config.targetSystem = {type:"hubspot"})', async () => {
    // The IntegrationConfig union supports either a string OR a
    // {type: string} object for source/targetSystem. Both must work.
    const objShapeConfig = {
      id: 'cfg-1',
      sourceSystem: { type: 'netsuite' },
      targetSystem: { type: 'hubspot' },
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(objShapeConfig);
    const { handler, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-1' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connMgr.initializeConnectorsForConfig).toHaveBeenCalledWith(objShapeConfig);
    expect(connMgr.getConnector).toHaveBeenCalledWith('hubspot', 'hubspot_cfg-1');
  });

  // ── Prerequisite PR A (2026-07-27 serialized-asset plan), Step A1 ────────
  // Repairs the target-system contradiction: the resolved IntegrationConfig
  // can store `targetSystem` in ARBITRARY spelling (e.g. 'Salesforce') while
  // the queued WriteDescriptor.targetSystemId always carries the lowercase
  // connector-registry key ('salesforce') per guardedWrite's contract
  // (decision 13). Comparing those two forms RAW previously rejected every
  // valid non-identical-spelling pair.

  it('target-system comparison: config.targetSystem="Salesforce" (arbitrary spelling) matches descriptor.targetSystemId="salesforce" (registry key) — dispatch proceeds', async () => {
    const fakeConfig = {
      id: 'cfg-sf',
      sourceSystem: 'netsuite',
      targetSystem: 'Salesforce',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(fakeConfig);
    const { handler, connector, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({
      targetSystemId: 'salesforce',
      integrationConfigId: 'cfg-sf',
      ownership: {
        entity: 'customer',
        declaredOwner: 'salesforce',
        callerSystem: 'netsuite',
        targetSystem: 'salesforce',
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connMgr.initializeConnectorsForConfig).toHaveBeenCalledWith(fakeConfig);
    // Prerequisite PR B: retrieval now uses the connector-REGISTRY key
    // (connectorKeyForSystem's projection), matching what ConnectorManager's
    // own initializeConnectorsForConfig derives internally — NOT the raw
    // config spelling ('Salesforce'). 'salesforce' happens to be identical
    // lowercased, so this is a same-value assertion for this pairing; the
    // manifest-spelled business_central case below is where the projection
    // actually changes the key.
    expect(connMgr.getConnector).toHaveBeenCalledWith('salesforce', 'salesforce_cfg-sf');
    expect(connector.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'new-rec' });
  });

  it('target-system comparison: config.targetSystem="business_central" (manifest spelling) matches descriptor.targetSystemId="businesscentral" (registry key), AND retrieval uses the SAME connector-registry key ConnectorManager derives internally (closes the Prereq A/B cache-key gap — a mocked getConnector previously masked this)', async () => {
    const fakeConfig = {
      id: 'cfg-bc',
      sourceSystem: 'netsuite',
      targetSystem: 'business_central',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(fakeConfig);
    const { handler, connector, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({
      targetSystemId: 'businesscentral',
      integrationConfigId: 'cfg-bc',
      ownership: {
        entity: 'vendor',
        declaredOwner: 'business_central',
        callerSystem: 'netsuite',
        targetSystem: 'business_central',
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connMgr.initializeConnectorsForConfig).toHaveBeenCalledWith(fakeConfig);
    // The mocked ConnectorManager returns a canned connector regardless of the
    // key it's called with, so asserting only "dispatch proceeds" (as the
    // original version of this test did) does NOT prove retrieval used a key
    // consistent with what a REAL ConnectorManager would cache under. Pin the
    // actual call args: retrieval MUST use the connector-registry key
    // ('businesscentral'), not the raw manifest spelling ('business_central')
    // — a real ConnectorManager keys/creates connectors by
    // connectorKeyForSystem() (Prerequisite PR B), and 'business_central'
    // alone is not a valid registry key (createConnector's .toLowerCase()
    // cannot resolve it, so it would throw "Unsupported system type"). The
    // true end-to-end proof against a REAL ConnectorManager instance lives in
    // ConnectorManager.credentials.test.ts.
    expect(connMgr.getConnector).toHaveBeenCalledWith('businesscentral', 'businesscentral_cfg-bc');
    expect(connector.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'new-rec' });
  });

  it('target-system comparison: hubspot (identical registry-key spelling) remains covered — dispatch proceeds', async () => {
    // hubspot is spelled identically in both the SourceOfTruth manifest and
    // the connector registry, so this pairing already worked under the raw
    // comparison. Pinned here so a future regression in connectorKeyForSystem
    // can't silently break the identical-spelling case while "fixing" the
    // divergent-spelling ones above.
    const fakeConfig = {
      id: 'cfg-hs',
      sourceSystem: 'netsuite',
      targetSystem: 'hubspot',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(fakeConfig);
    const { handler, connector } = makeHandler({ config });
    const descriptor = makeDescriptor({ targetSystemId: 'hubspot', integrationConfigId: 'cfg-hs' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await handler.apply(approval);

    expect(connector.create).toHaveBeenCalled();
  });

  it('target-system comparison: genuine drift (config="shopify", descriptor="hubspot") still FAILS CLOSED', async () => {
    // Regression guard for the existing drift test below (kept passing by
    // the new comparison — a real mismatch must still throw).
    const driftedConfig = {
      id: 'cfg-drift',
      sourceSystem: 'netsuite',
      targetSystem: 'shopify',
      authentication: { source: {}, target: { apiKey: 'k' } },
    };
    const config = mockConfigService(driftedConfig);
    const { handler, connector } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-drift', targetSystemId: 'hubspot' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await expect(handler.apply(approval)).rejects.toThrow(
      /targetSystemId='hubspot'.*targetSystem\.type='shopify'/i,
    );
    expect(connector.create).not.toHaveBeenCalled();
  });

  // ── Prerequisite PR A Step A3: 'upsert' operation dispatch ───────────────

  it("dispatches upsert: unpacks { externalIdField, externalIdValue, data } and calls connector.upsert(entityType, externalIdField, externalIdValue, data)", async () => {
    const { handler, connector } = makeHandler();
    const descriptor = makeDescriptor({
      operation: 'upsert',
      entityType: 'Asset',
      args: {
        externalIdField: 'NetSuite_Internal_ID__c',
        externalIdValue: 'inv-1234',
        data: { Serial_Number__c: 'SN-1' },
      },
    });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    const result = await handler.apply(approval);

    expect(connector.upsert).toHaveBeenCalledWith(
      'Asset',
      'NetSuite_Internal_ID__c',
      'inv-1234',
      { Serial_Number__c: 'SN-1' },
    );
    expect(result).toEqual({ outcome: 'created', id: 'up-rec' });
  });

  it('integrationConfigId present but config lookup MISSES: FAIL CLOSED — throws and does NOT dispatch', async () => {
    // Codex review on PR #853: silent fallback to the legacy getConnector
    // shape would dispatch with an uninitialized connector (or a
    // wrong-tenant cached instance) — defeats the reason
    // integrationConfigId was persisted. Worker catches the throw and
    // records apply_failed; operator can restore the config and re-approve.
    const config = mockConfigService(undefined); // miss
    const { handler, connector, connMgr } = makeHandler({ config });
    const descriptor = makeDescriptor({ integrationConfigId: 'cfg-stale' });
    const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

    await expect(handler.apply(approval)).rejects.toThrow(/integrationConfigId='cfg-stale'.*returned undefined/i);

    expect(config.getConfigurationForTenant).toHaveBeenCalledWith('t1', 'cfg-stale');
    expect(config.getConfiguration).not.toHaveBeenCalled();
    expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
    // Dispatch must NEVER happen on a missing-config resume.
    expect(connector.create).not.toHaveBeenCalled();
    // No getConnector call either — we threw before any dispatch path.
    expect(connMgr.getConnector).not.toHaveBeenCalled();
  });
});
