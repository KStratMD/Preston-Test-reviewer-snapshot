// OwnershipResumeHandler — serialized-Asset feature-specific descriptor pin.
// Task 5 of the 2026-07-27 NetSuite serialized-asset sync plan.
//
// This suite is TEST-ONLY: Prerequisite A already owns the 'upsert'
// WriteOperation, the encrypted decoder, resume dispatch, the registry-key
// comparison, and scanner support. Prerequisite B already made
// ConnectorManager derive registry keys via connectorKeyForSystem() for both
// cache-write and cache-read. Task 4 already shipped SalesforceConnector's
// native upsert override. Nothing here is new production behavior — every
// test below is expected to PASS against already-implemented code, pinning
// the exact queued-write descriptor shape Task 7 will place inline at its
// guardedWrite callsite:
//
//   {
//     targetSystemId: connectorKeyForSystem(config.targetSystem), // 'salesforce'
//     operation: 'upsert',
//     entityType: 'Asset',
//     integrationConfigId: config.id,
//     args: {
//       externalIdField: profile.assetExternalIdField,
//       externalIdValue: unit.inventoryNumberId,
//       data: payload,
//     },
//   }
//
// and the successful resume dispatch:
//
//   await connector.upsert(
//     descriptor.entityType,
//     descriptor.args.externalIdField,
//     descriptor.args.externalIdValue,
//     descriptor.args.data,
//   );
//
// Every descriptor below is round-tripped through the REAL encrypted
// write-descriptor path (encryptDescriptor → JSON.stringify → JSON.parse →
// decryptDescriptor, exactly like ApprovalQueueRepository / the resume
// worker) rather than handed to the handler as a plain object, so each test
// also pins the encrypted round trip (Step 2). No descriptor-builder
// abstraction is introduced — every test constructs the WriteDescriptor
// object literal directly (Step 4 of the brief: the static equivalence gate
// requires the `resume` object literal at the Task 7 callsite, so this file
// must not tempt Task 7 into calling a shared helper instead).
//
// Covers:
//   1. Successful dispatch: config.targetSystem='Salesforce' (arbitrary
//      config spelling) + descriptor.targetSystemId='salesforce' (registry
//      key) + config-object-shape variant, pinning operation/entity
//      literal/registry key/argument names/argument order, and a real
//      resume call count of one.
//   2. FAIL CLOSED: descriptor.targetSystemId carries the raw config
//      spelling ('Salesforce') instead of the required lowercase registry
//      key — decision 13's "configuration system spelling is never stored
//      in that field" invariant, pinned specifically for this feature's
//      target system.
//   3. FAIL CLOSED: integrationConfigId references a (tenant, config) pair
//      that misses for the 'upsert' operation family — the miss-path was
//      only ever exercised against 'create' upstream of this plan.
//   4. A connector whose default (BaseConnector) upsert rejects as
//      unsupported — the resume handler must propagate the rejection, not
//      swallow it.
//   5. Tampered encrypted metadata (targetSystemId mutated post-encryption)
//      — fails closed via WriteDescriptorEncryptionError, dispatch never
//      happens.
//   6. Decision 8: no serial number / inventory ID / External ID value /
//      payload enters any mock representing an operational log or audit
//      surface (a canary technique, mirroring Task 4's
//      BaseConnector.test.ts assertNoCanaryLogged pattern), OR any of
//      console.log/info/warn/error/debug — across both the successful
//      dispatch AND a failure path (the unsupported-upsert rejection). The
//      handler has no injected Logger (verified below); that fact is
//      asserted explicitly so a future injection is a deliberate decision
//      the reviewer sees, not a silent gap in this canary's coverage.
//
// Fix (post-review): the original version of test 6 only inspected
// mock.calls on audit/connMgr/config — it did NOT spy on console.*. A
// reviewer-planted `console.log` interpolating the External-ID/payload
// directly into OwnershipResumeHandler's upsert dispatch branch passed all
// 7 tests undetected. This file now spies on all five console methods
// across both a successful and a failing dispatch.

import 'reflect-metadata';
import { EncryptionService } from '../../../../../src/services/security/EncryptionService';
import {
  encryptDescriptor,
  WriteDescriptorEncryptionError,
} from '../../../../../src/services/governance/writeDescriptorEncryption';
import { OwnershipResumeHandler } from '../../../../../src/services/governance/handlers/OwnershipResumeHandler';
import { connectorKeyForSystem } from '../../../../../src/connectors/connectorIdentity';
import { ValidationError } from '../../../../../src/errors/ConfigurationErrors';
import type { PersistedApproval } from '../../../../../src/services/governance/ApprovalQueueRepository';
import type { WriteDescriptor } from '../../../../../src/governance/sourceOfTruth/guardedWrite';

let testEncryption: EncryptionService;
let prevEncryptionKey: string | undefined;
beforeAll(() => {
  // Save/restore so this suite doesn't leak global state to other suites in
  // the same Jest worker (same discipline as the existing
  // OwnershipResumeHandler.test.ts — Copilot R0 #4 on PR #853).
  prevEncryptionKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
  process.env.AI_CONFIG_ENCRYPTION_KEY = '1'.repeat(64);
  testEncryption = new EncryptionService();
});
afterAll(() => {
  if (prevEncryptionKey === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
  else process.env.AI_CONFIG_ENCRYPTION_KEY = prevEncryptionKey;
});

function mockConnector(upsertImpl?: jest.Mock) {
  return {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
    upsert: upsertImpl ?? jest.fn().mockResolvedValue({ outcome: 'created', id: 'sf-asset-1' }),
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

function mockOwnershipResolver() {
  return {
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
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
    id: 'appr-asset-1',
    tenantId: 'tenant-sf',
    requesterUserId: 'u1',
    operationType: 'ownership_write',
    resourceType: 'Asset',
    resourceId: 'inv-1001',
    riskLevel: 'medium',
    redactedPayload: '{}',
    policyFindings: '[]',
    status: 'approved',
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-28T00:00:00.000Z',
    decidedAt: '2026-07-27T01:00:00.000Z',
    decidedByUserId: 'approver',
    decisionReason: null,
    applyIdempotencyKey: null,
    writeDescriptor: null,
    ...overrides,
  };
}

/**
 * The literal shape Task 7 will place inline at its guardedWrite callsite
 * (brief lines 7-19), with `ownership` filled in the way guardedWrite itself
 * would populate it from `context` — OwnershipResumeHandler consumes
 * already-enqueued descriptors, so this test file must supply that block
 * directly rather than routing through guardedWrite. The governance-entity
 * name for the serialized-asset flow is a Task 7 decision, not pinned here;
 * an arbitrary non-canonical string is used because only the operation /
 * entityType / registry-key / args shape is this task's contract.
 */
function makeSerializedAssetDescriptor(overrides: Partial<WriteDescriptor> = {}): WriteDescriptor {
  return {
    targetSystemId: connectorKeyForSystem('Salesforce'), // 'salesforce'
    operation: 'upsert',
    entityType: 'Asset',
    integrationConfigId: 'cfg-sf-asset',
    args: {
      externalIdField: 'NetSuite_Internal_ID__c',
      externalIdValue: 'INV-1001',
      data: { Serial_Number__c: 'SN-1001', Status__c: 'Active' },
    },
    ownership: {
      entity: 'serialized_asset',
      declaredOwner: 'salesforce',
      callerSystem: 'netsuite',
      targetSystem: 'salesforce',
    },
    ...overrides,
  };
}

async function persistDescriptor(d: WriteDescriptor): Promise<string> {
  const payload = await encryptDescriptor(d, testEncryption);
  return JSON.stringify(payload);
}

/**
 * Spies on every console method a stray debug statement could plausibly use
 * (`console.log`/`.info`/`.warn`/`.error`/`.debug`), mocking each so nothing
 * actually prints during the test run. Returns the spies plus a helper to
 * serialize every captured call across all five for a single `not.toContain`
 * assertion, and a restore function tests MUST call (in a `finally`) so a
 * leaked spy can't bleed into later tests in the same worker.
 */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function spyOnConsole() {
  const spies = CONSOLE_METHODS.map((method) =>
    jest.spyOn(console, method).mockImplementation(() => undefined),
  );
  return {
    spies,
    allCallsSerialized: (): string => JSON.stringify(spies.flatMap((s) => s.mock.calls)),
    restore: (): void => spies.forEach((s) => s.mockRestore()),
  };
}

async function persistTamperedDescriptor(
  d: WriteDescriptor,
  mutate: (p: Record<string, unknown>) => void,
): Promise<string> {
  const payload = await encryptDescriptor(d, testEncryption);
  const mutable = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  mutate(mutable);
  return JSON.stringify(mutable);
}

describe('OwnershipResumeHandler — serialized-Asset queued-write descriptor (Task 5)', () => {
  const salesforceConfig = {
    id: 'cfg-sf-asset',
    sourceSystem: 'netsuite',
    targetSystem: 'Salesforce', // arbitrary config spelling, per decision 13
    authentication: { source: {}, target: { apiKey: 'k' } },
  };

  it(
    "resumes a queued 'Asset' upsert: config.targetSystem='Salesforce' (arbitrary spelling) + " +
      "descriptor.targetSystemId='salesforce' (registry key) — dispatches " +
      'connector.upsert(entityType, externalIdField, externalIdValue, data) with the exact ' +
      'argument order and a real resume call count of one',
    async () => {
      const config = mockConfigService(salesforceConfig);
      const { handler, connector, connMgr } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor();
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      const result = await handler.apply(approval);

      // Registry-key projection (decision 13): retrieval + cache key use the
      // lowercase connector-registry key derived from the config's arbitrary
      // spelling, not the raw 'Salesforce'.
      expect(connMgr.initializeConnectorsForConfig).toHaveBeenCalledWith(salesforceConfig);
      expect(connMgr.getConnector).toHaveBeenCalledWith('salesforce', 'salesforce_cfg-sf-asset');

      // Decision 14: the method name equals resume.operation ('upsert'),
      // argument one equals resume.entityType ('Asset'), and the remaining
      // arguments are the decrypted externalIdField/externalIdValue/data in
      // that exact order — the statically analyzable mutation shape.
      expect(connector.upsert).toHaveBeenCalledWith(
        'Asset',
        'NetSuite_Internal_ID__c',
        'INV-1001',
        { Serial_Number__c: 'SN-1001', Status__c: 'Active' },
      );
      expect(connector.upsert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ outcome: 'created', id: 'sf-asset-1' });
    },
  );

  it(
    'resumes with a SystemConfig object-shape target (config.targetSystem = {type: "Salesforce"}) — ' +
      'dispatch proceeds through the same connector-registry-key projection',
    async () => {
      const objShapeConfig = {
        id: 'cfg-sf-asset',
        sourceSystem: { type: 'netsuite' },
        targetSystem: { type: 'Salesforce' },
        authentication: { source: {}, target: { apiKey: 'k' } },
      };
      const config = mockConfigService(objShapeConfig);
      const { handler, connector, connMgr } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor();
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      await handler.apply(approval);

      expect(connMgr.getConnector).toHaveBeenCalledWith('salesforce', 'salesforce_cfg-sf-asset');
      expect(connector.upsert).toHaveBeenCalledWith(
        'Asset',
        'NetSuite_Internal_ID__c',
        'INV-1001',
        { Serial_Number__c: 'SN-1001', Status__c: 'Active' },
      );
    },
  );

  it(
    "FAIL CLOSED: descriptor.targetSystemId carries the raw config spelling ('Salesforce') " +
      "instead of the required lowercase registry key ('salesforce') — decision 13's " +
      "'configuration system spelling is never stored in that field' invariant",
    async () => {
      const config = mockConfigService(salesforceConfig);
      const { handler, connector, connMgr } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor({ targetSystemId: 'Salesforce' });
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      await expect(handler.apply(approval)).rejects.toThrow(
        /targetSystemId='Salesforce'.*targetSystem\.type='Salesforce'/i,
      );

      expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
      expect(connector.upsert).not.toHaveBeenCalled();
    },
  );

  it(
    'FAIL CLOSED: integrationConfigId references a (tenant, config) pair that misses for the ' +
      "'upsert' operation family — refuses to dispatch with an uninitialized connector",
    async () => {
      const config = mockConfigService(undefined); // tenant/config miss
      const { handler, connector, connMgr } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor({ integrationConfigId: 'cfg-sf-gone' });
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      await expect(handler.apply(approval)).rejects.toThrow(
        /integrationConfigId='cfg-sf-gone'.*returned undefined/i,
      );

      expect(config.getConfigurationForTenant).toHaveBeenCalledWith('tenant-sf', 'cfg-sf-gone');
      expect(connMgr.initializeConnectorsForConfig).not.toHaveBeenCalled();
      expect(connMgr.getConnector).not.toHaveBeenCalled();
      expect(connector.upsert).not.toHaveBeenCalled();
    },
  );

  it(
    "a connector whose default (BaseConnector) upsert rejects as unsupported: the resume " +
      'handler propagates the rejection rather than swallowing it',
    async () => {
      // Mirrors BaseConnector's concrete default: any connector that hasn't
      // overridden upsert (every connector except Salesforce, as of Task 4)
      // throws exactly this ValidationError. The resume dispatch must not
      // catch/mask it — the worker's outer try/catch is the only place this
      // should be observed, recording {applied:false, error}.
      const unsupportedUpsert = jest
        .fn()
        .mockRejectedValue(new ValidationError('Connector does not support upsert', []));
      const config = mockConfigService(salesforceConfig);
      const { handler, connector } = makeHandler({
        connector: mockConnector(unsupportedUpsert),
        config,
      });
      const descriptor = makeSerializedAssetDescriptor();
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      await expect(handler.apply(approval)).rejects.toThrow(/does not support upsert/i);
      expect(connector.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'FAIL CLOSED: tampered encrypted metadata (targetSystemId mutated after encryption) — ' +
      'rejects as WriteDescriptorEncryptionError(metadata_tampered), dispatch never happens',
    async () => {
      const config = mockConfigService(salesforceConfig);
      const { handler, connector } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor();
      const tamperedPayload = await persistTamperedDescriptor(descriptor, (p) => {
        p.targetSystemId = 'hubspot'; // DB-tier mutation of a plaintext field
      });
      const approval = makeApproval({ writeDescriptor: tamperedPayload });

      let caught: unknown;
      try {
        await handler.apply(approval);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WriteDescriptorEncryptionError);
      expect((caught as WriteDescriptorEncryptionError).code).toBe('metadata_tampered');
      expect(connector.upsert).not.toHaveBeenCalled();
    },
  );

  it(
    'decision 8: no serial number, inventory ID, External ID value, or payload enters any ' +
      'operational-log/audit mock surface, OR any console.log/info/warn/error/debug call, ' +
      'across a SUCCESSFUL dispatch',
    async () => {
      const CANARY_SERIAL = 'SECRET-SERIAL-CANARY-9001';
      const CANARY_EXTERNAL_ID = 'SECRET-INV-CANARY-9001';
      const config = mockConfigService(salesforceConfig);
      const { handler, audit, connMgr } = makeHandler({ config });
      const descriptor = makeSerializedAssetDescriptor({
        args: {
          externalIdField: 'NetSuite_Internal_ID__c',
          externalIdValue: CANARY_EXTERNAL_ID,
          data: { Serial_Number__c: CANARY_SERIAL },
        },
      });
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      // OwnershipResumeHandler has no injected Logger — its constructor
      // (src/services/governance/handlers/OwnershipResumeHandler.ts:57-63)
      // takes only ConnectorManager, AuditService, EncryptionService,
      // ConfigurationService, and OwnershipResolver. Asserted explicitly so
      // a future logger injection is a deliberate reviewer decision — and a
      // trigger to add a spy on that logger here — rather than a silent gap
      // in this canary's channel coverage.
      expect((handler as unknown as Record<string, unknown>).logger).toBeUndefined();

      const console_ = spyOnConsole();
      try {
        await handler.apply(approval);

        // The connector mutation call itself legitimately carries the
        // serial/External ID in the outbound payload (decision 8 permits
        // that) — the canary must be absent everywhere else: the
        // audit-service call args, the ConnectorManager retrieval/init call
        // args, the config-lookup call args, AND every console.* call
        // (a reviewer-planted `console.log` in the upsert dispatch branch
        // is exactly the leak this covers — see file-header fix note).
        const otherSurfaceCalls = JSON.stringify([
          ...(audit.logGovernanceCheck as jest.Mock).mock.calls,
          ...(connMgr.getConnector as jest.Mock).mock.calls,
          ...(connMgr.initializeConnectorsForConfig as jest.Mock).mock.calls,
          ...(config.getConfigurationForTenant as jest.Mock).mock.calls,
        ]);
        expect(otherSurfaceCalls).not.toContain(CANARY_SERIAL);
        expect(otherSurfaceCalls).not.toContain(CANARY_EXTERNAL_ID);
        expect(console_.allCallsSerialized()).not.toContain(CANARY_SERIAL);
        expect(console_.allCallsSerialized()).not.toContain(CANARY_EXTERNAL_ID);
      } finally {
        console_.restore();
      }
    },
  );

  it(
    'decision 8: no serial number, inventory ID, External ID value, or payload enters any ' +
      'console.log/info/warn/error/debug call across a FAILING dispatch ' +
      "(connector.upsert itself rejects as unsupported)",
    async () => {
      // The failure path still reaches the same dispatch switch/upsert
      // callsite before rejecting — a leak planted there fires regardless
      // of whether the underlying connector call ultimately succeeds.
      const CANARY_SERIAL = 'SECRET-SERIAL-CANARY-9002';
      const CANARY_EXTERNAL_ID = 'SECRET-INV-CANARY-9002';
      const unsupportedUpsert = jest
        .fn()
        .mockRejectedValue(new ValidationError('Connector does not support upsert', []));
      const config = mockConfigService(salesforceConfig);
      const { handler } = makeHandler({ connector: mockConnector(unsupportedUpsert), config });
      const descriptor = makeSerializedAssetDescriptor({
        args: {
          externalIdField: 'NetSuite_Internal_ID__c',
          externalIdValue: CANARY_EXTERNAL_ID,
          data: { Serial_Number__c: CANARY_SERIAL },
        },
      });
      const approval = makeApproval({ writeDescriptor: await persistDescriptor(descriptor) });

      const console_ = spyOnConsole();
      try {
        await expect(handler.apply(approval)).rejects.toThrow(/does not support upsert/i);
        expect(console_.allCallsSerialized()).not.toContain(CANARY_SERIAL);
        expect(console_.allCallsSerialized()).not.toContain(CANARY_EXTERNAL_ID);
      } finally {
        console_.restore();
      }
    },
  );
});
