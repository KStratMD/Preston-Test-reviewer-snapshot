import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import type { DatabaseService } from '../../../src/database/DatabaseService';
import {
  DEFERRED_SERIALIZED_UNIT_REASONS,
  DeferredSerializedUnitRepository,
  type DeferredSerializedUnitInput,
} from '../../../src/services/serializedAsset/DeferredSerializedUnitRepository';
import { SerializedAssetSweepCursorRepository } from '../../../src/services/serializedAsset/SerializedAssetSweepCursorRepository';
import {
  SerializedAssetSyncService,
  type SerializedAssetSyncInput,
  type SerializedAssetSyncResult,
} from '../../../src/services/serializedAsset/SerializedAssetSyncService';
import type { SerializedAssetMetricsRecorder } from '../../../src/services/serializedAsset/SerializedAssetMetrics';
import {
  OwnershipViolationError,
} from '../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import { ApprovalQueueService } from '../../../src/services/governance/ApprovalQueueService';
import { AuditService } from '../../../src/services/ai/orchestrator/AuditService';
import type { EncryptionService } from '../../../src/services/security/EncryptionService';
import { decryptDescriptor } from '../../../src/services/governance/writeDescriptorEncryption';
import { IntegrationService } from '../../../src/services/IntegrationService';
import {
  createMockOutboundGovernanceService,
  createMockOwnershipResolver,
  createMockApprovalQueueService,
} from '../../governanceTestUtils';
import type { DataRecord, FieldMapping, IntegrationConfig } from '../../../src/types';
import type { SerializedAssetProfileDraftConfig, SerializedUnit } from '../../../src/types/serializedAsset';
import type { IConnector } from '../../../src/interfaces/IConnector';

/**
 * Task 12 (2026-07-27 NetSuite serialized-asset sync plan) — shared durability
 * / tenant-isolation / idempotency / restart-recovery / privacy assertions for
 * the `netsuite_serialized_asset` execution profile, run against BOTH a real
 * SQLite database (`tests/integration/serializedAssetSync.test.ts`) and a real
 * PostgreSQL database (`tests/integration/postgres/serializedAssetSync.postgres.test.ts`).
 *
 * Kept in one file (rather than duplicated per dialect) so the two suites
 * cannot drift — the plan's explicit instruction. Each spec file owns its own
 * `DatabaseService` lifecycle (SQLite in-memory vs. real Postgres) and passes
 * a `getDb()` accessor in here; this module only reads/writes through that
 * accessor, real repository classes, and the real `guardedWrite` chokepoint —
 * no fakes stand in for anything durability-relevant. The only doubles are
 * the NetSuite/Salesforce connectors (I/O-only), the metrics recorder, the
 * logger, and (where a scenario requires a specific ownership decision) the
 * `OwnershipResolver`.
 */

// ---------------------------------------------------------------------------
// Fixed vocabulary
// ---------------------------------------------------------------------------

const ASSET_EXTERNAL_ID_FIELD = 'NetSuite_Inventory_Number_Id__c';
const PRODUCT_EXTERNAL_ID_FIELD = 'NetSuite_Item_Id__c';

/**
 * The privacy canary (decision 8). Deliberately serial-shaped but NOT
 * matching any DLP-registered pattern (no digit-run long enough for a
 * card/SSN/phone match) — a false-positive DLP redaction would make the
 * "canary absent from X" assertions vacuously true instead of load-bearing.
 */
export const CANARY_SERIAL = 'SN-CANARY-9f2b7a1c4e60-do-not-log';

/**
 * A short, still-recognizable prefix of the canary. PostgreSQL's own
 * CHECK-violation "Failing row contains (...)" DETAIL message truncates each
 * individual composite-row attribute's textual representation (confirmed
 * empirically against a live Postgres 15 backend — a JSONB attribute holding
 * several sibling keys plus the 33-character canary is cut off after roughly
 * the first dozen characters of the serial, mid-value, regardless of the
 * other keys' lengths). So even the POSITIVE-CONTROL proof that the
 * documented decision-8 hazard is real can only assert a recognizable
 * FRAGMENT survives intact, not the whole 33-character value — which is
 * still a real leak (a partial serial, alongside the fully-untruncated
 * tenant/configuration/inventory-number columns) that must never reach a log.
 */
export const CANARY_SERIAL_PREFIX = CANARY_SERIAL.slice(0, 10);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fieldMapping(sourceField: string, targetField: string): FieldMapping {
  return { sourceField, targetField, transformationType: 'direct', isRequired: true };
}

export function makeConfig(
  tenantId: string,
  configId: string,
  overrides: Partial<IntegrationConfig> = {},
): IntegrationConfig {
  const executionProfileConfig: SerializedAssetProfileDraftConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: PRODUCT_EXTERNAL_ID_FIELD,
    assetExternalIdField: ASSET_EXTERNAL_ID_FIELD,
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
  };
  return {
    id: configId,
    tenantId,
    name: 'NetSuite Serialized Asset Sync (Task 12 durability)',
    sourceSystem: 'netsuite',
    targetSystem: 'Salesforce', // arbitrary config spelling — decision 13
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [
      fieldMapping('id', ASSET_EXTERNAL_ID_FIELD),
      fieldMapping('inventorynumber', 'SerialNumber'),
      fieldMapping('item.id', 'Product2Id'),
    ],
    transformationRules: [],
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig,
    ...overrides,
  } as IntegrationConfig;
}

export function sourceRecord(inventoryNumberId: string, serial: string, itemId: string): DataRecord {
  return {
    id: inventoryNumberId,
    externalId: '',
    fields: { inventorynumber: serial, item: { id: itemId } },
    metadata: {},
  };
}

export function unit(
  tenantId: string,
  configId: string,
  inventoryNumberId: string,
  serial = 'SN-1',
  itemId = 'item-1',
): SerializedUnit {
  return { tenantId, configurationId: configId, inventoryNumberId, serialNumber: serial, itemId };
}

export function deferredInput(
  tenantId: string,
  configId: string,
  inventoryNumberId: string,
  overrides: Partial<DeferredSerializedUnitInput> = {},
): DeferredSerializedUnitInput {
  return {
    tenantId,
    configurationId: configId,
    inventoryNumberId,
    normalizedPayload: unit(tenantId, configId, inventoryNumberId),
    reason: 'parent_missing',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Doubles — I/O boundary only. Everything durability-relevant is real.
// ---------------------------------------------------------------------------

interface TargetConnectorDouble {
  describeSObject: jest.Mock;
  findProduct2ByExternalId: jest.Mock;
  upsert: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  bulkCreate: jest.Mock;
  bulkUpdate: jest.Mock;
  bulkDelete: jest.Mock;
}

export function makeSourceConnector(records: DataRecord[]): { list: jest.Mock } {
  // Ignores limit/offset and always returns the same fixed set — with
  // records.length < the default batchSize this always looks like a short
  // (final) page, so every run sweeps the whole set and wraps the cursor.
  // Idempotency/restart scenarios below rely on this determinism.
  return { list: jest.fn().mockResolvedValue(records) };
}

/**
 * A source double that honours `limit`/`offset` like a real paging backend
 * (unlike `makeSourceConnector`, which always returns the same fixed array
 * regardless of paging args and therefore always wraps the cursor to 0).
 * Needed wherever a test must produce a TRUNCATED sweep with a non-zero
 * `next_offset` — e.g. proving the cursor's actual value survives restart,
 * rather than merely proving `getNextOffset` returns *a* number (0 is also
 * what a MISSING row returns, so asserting `=== 0` after a wrapped sweep
 * proves nothing about durability).
 */
export function makePagingSourceConnector(all: DataRecord[]): { list: jest.Mock } {
  return {
    list: jest.fn().mockImplementation(async (_entity: string, options: { limit: number; offset?: number }) => {
      const offset = options.offset ?? 0;
      return all.slice(offset, offset + options.limit);
    }),
  };
}

export function makeTargetConnector(
  products: Record<string, { Id: string }[]>,
  upsertImpl?: jest.Mock,
): TargetConnectorDouble {
  return {
    describeSObject: jest.fn().mockResolvedValue({ name: 'Asset', createable: true, updateable: true, queryable: true, fields: [] }),
    findProduct2ByExternalId: jest
      .fn()
      .mockImplementation(async (_field: string, value: string) => products[value] ?? []),
    upsert: upsertImpl ?? jest.fn().mockResolvedValue({ outcome: 'created', id: 'sf-1' }),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
  };
}

export function makeMetrics(): jest.Mocked<SerializedAssetMetricsRecorder> {
  return {
    recordUnitsRead: jest.fn(),
    recordUnitUpserted: jest.fn(),
    recordUnitDeferred: jest.fn(),
    recordUnitQuarantined: jest.fn(),
    recordRetryAttempted: jest.fn(),
    recordDeferredRecovered: jest.fn(),
    recordGovernanceRejection: jest.fn(),
    recordReadinessFailure: jest.fn(),
  };
}

export function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

export function makeResolver(overrides: Partial<{ validateWrite: jest.Mock; detectLoop: jest.Mock }> = {}) {
  return {
    validateWrite: overrides.validateWrite ?? jest.fn().mockResolvedValue({ allowed: true, owner: 'salesforce' }),
    detectLoop: overrides.detectLoop ?? jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

export function makeReadiness(ready = true) {
  return {
    evaluate: jest.fn().mockResolvedValue({
      ready,
      checkedAt: new Date().toISOString(),
      blockers: ready ? [] : [{ code: 'field_not_external_id', message: 'Asset.X is not marked as an External ID' }],
      productExternalIdFields: [],
      assetExternalIdFields: [],
    }),
  };
}

/** Serializes every observed logger/metrics call for a canary scan. */
export function observedArgsDump(
  logger: ReturnType<typeof makeLogger>,
  metrics: jest.Mocked<SerializedAssetMetricsRecorder>,
): string {
  return JSON.stringify([
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
    ...logger.debug.mock.calls,
    ...metrics.recordUnitsRead.mock.calls,
    ...metrics.recordUnitUpserted.mock.calls,
    ...metrics.recordUnitDeferred.mock.calls,
    ...metrics.recordUnitQuarantined.mock.calls,
    ...metrics.recordRetryAttempted.mock.calls,
    ...metrics.recordDeferredRecovered.mock.calls,
    ...metrics.recordGovernanceRejection.mock.calls,
    ...metrics.recordReadinessFailure.mock.calls,
  ]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function defineSerializedAssetSyncDurabilitySuite(
  dialect: 'sqlite' | 'postgres',
  getDb: () => DatabaseService,
): void {
  describe(`SerializedAssetSyncService — durability, isolation, idempotency, restart recovery (Task 12) [${dialect}]`, () => {
    let approvalQueueService: ApprovalQueueService;
    let auditService: AuditService;
    let encryptionService: EncryptionService;

    beforeAll(async () => {
      approvalQueueService = await container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
      auditService = await container.getAsync<AuditService>(TYPES.AuditService);
      encryptionService = container.get<EncryptionService>(TYPES.EncryptionService);
    });

    function repos() {
      const db = getDb();
      return {
        deferredRepo: new DeferredSerializedUnitRepository(db),
        cursorRepo: new SerializedAssetSweepCursorRepository(db),
      };
    }

    /**
     * A timestamp safely in the past relative to real wall-clock time, for
     * any attempt_count up to (but not including) the values that saturate
     * `computeDeferredBackoffMs`'s exponent cap (~17.8h at attempt_count>=11).
     * Seeding a deferred row with this as `now` (or as the service's injected
     * clock) guarantees a subsequent REAL-CLOCK `listDue(..., new Date(), ...)`
     * treats the row as due, without weakening the backoff assertions
     * elsewhere (Task 7's own unit suite pins the backoff formula itself).
     */
    function pastEnoughToBeDue(): Date {
      return new Date(Date.now() - 2 * 60 * 60 * 1000);
    }

    function makeHarness(opts: {
      records?: DataRecord[];
      source?: { list: jest.Mock };
      products?: Record<string, { Id: string }[]>;
      upsertImpl?: jest.Mock;
      resolver?: ReturnType<typeof makeResolver>;
      readiness?: ReturnType<typeof makeReadiness>;
      deferredRepo?: DeferredSerializedUnitRepository;
      cursorRepo?: SerializedAssetSweepCursorRepository;
      withApprovalQueue?: boolean;
      clock?: () => Date;
    } = {}) {
      const { deferredRepo, cursorRepo } = opts.deferredRepo && opts.cursorRepo
        ? { deferredRepo: opts.deferredRepo, cursorRepo: opts.cursorRepo }
        : repos();
      const source = opts.source ?? makeSourceConnector(opts.records ?? []);
      const target = makeTargetConnector(opts.products ?? {}, opts.upsertImpl);
      const metrics = makeMetrics();
      const logger = makeLogger();
      const resolver = opts.resolver ?? makeResolver();
      const readiness = opts.readiness ?? makeReadiness();

      const service = new SerializedAssetSyncService(
        deferredRepo,
        cursorRepo,
        readiness as never,
        metrics,
        {
          ownershipResolver: resolver as never,
          auditService,
          ...(opts.withApprovalQueue !== false ? { approvalQueueService } : {}),
        },
        auditService,
        logger as never,
        opts.clock,
      );

      return { service, source, target, metrics, logger, resolver, readiness, deferredRepo, cursorRepo };
    }

    function run(
      h: ReturnType<typeof makeHarness>,
      config: IntegrationConfig,
      actor: SerializedAssetSyncInput['actor'],
      options: Partial<SerializedAssetSyncInput['options']> = {},
    ): Promise<SerializedAssetSyncResult> {
      return h.service.run({
        config,
        sourceConnector: h.source as unknown as IConnector,
        targetConnector: h.target as unknown as IConnector,
        options: { batchSize: 100, concurrency: 4, dryRun: false, forceDeferredRetry: false, ...options },
        actor,
      });
    }

    function newActor(tenantId: string): SerializedAssetSyncInput['actor'] {
      return { tenantId, userId: `operator-${randomUUID()}`, correlationId: randomUUID() };
    }

    // =========================================================================
    // Group A — DeferredSerializedUnitRepository tenant isolation
    // =========================================================================

    describe('tenant isolation — deferred-work store', () => {
      it('listDue / listForRetry never return another tenant\'s row, even on a colliding (configurationId, inventoryNumberId) pair', async () => {
        const { deferredRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const invId = `inv-${randomUUID()}`;
        const seedTime = pastEnoughToBeDue();
        const readNow = new Date();

        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, invId), seedTime);
        await deferredRepo.upsertDeferred(deferredInput(tenantB, configId, invId), seedTime);

        const dueA = (await deferredRepo.listDue(tenantA, configId, readNow, 100)).units;
        const dueB = (await deferredRepo.listDue(tenantB, configId, readNow, 100)).units;
        expect(dueA).toHaveLength(1);
        expect(dueB).toHaveLength(1);
        expect(dueA[0].tenantId).toBe(tenantA);
        expect(dueB[0].tenantId).toBe(tenantB);

        const retryA = (await deferredRepo.listForRetry(tenantA, configId, 100)).units;
        expect(retryA).toHaveLength(1);
        expect(retryA[0].tenantId).toBe(tenantA);
      });

      it('deleteSucceeded scoped by tenant: the wrong tenant cannot delete another tenant\'s row', async () => {
        const { deferredRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const invId = `inv-${randomUUID()}`;
        const now = new Date();

        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, invId), now);

        const deletedByWrongTenant = await deferredRepo.deleteSucceeded(tenantB, configId, invId);
        expect(deletedByWrongTenant).toBe(false);
        expect(await deferredRepo.countForConfiguration(tenantA, configId)).toBe(1);

        const deletedByOwner = await deferredRepo.deleteSucceeded(tenantA, configId, invId);
        expect(deletedByOwner).toBe(true);
        expect(await deferredRepo.countForConfiguration(tenantA, configId)).toBe(0);
      });

      it('upsertDeferred UPDATE-branch predicate is tenant-scoped: re-deferring tenant A\'s row updates ONLY tenant A\'s row, even though tenant B has a row at the identical (configId, invId)', async () => {
        // This is the scenario that actually exercises the UPDATE branch's
        // tenant_id predicate: BOTH tenants already have a row at the same
        // (configuration_id, inventory_number_id) pair before the
        // UPDATE-triggering call fires. A prior version of this test seeded
        // tenant B's row only AFTER tenant A's update had already happened,
        // which never gave a tenant_id-less UPDATE (`WHERE configuration_id=X
        // AND inventory_number_id=Y`) anything else to corrupt — it would
        // have passed even with the predicate removed. Verified by mutation:
        // deleting `.where('tenant_id', '=', input.tenantId)` from the
        // UPDATE branch made ONLY this rewritten version fail (tenant B's
        // attempt_count got bumped to 2 alongside tenant A's).
        const { deferredRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const invId = `inv-${randomUUID()}`;
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date('2026-01-01T01:00:00.000Z');

        // Both tenants' rows exist FIRST (both attempt_count=1, both INSERTs
        // — neither tenant's row exists yet at this point for the other).
        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, invId), t0);
        await deferredRepo.upsertDeferred(deferredInput(tenantB, configId, invId), t0);

        // NOW tenant A re-defers the SAME unit — its own row already exists,
        // so this hits the UPDATE branch while tenant B's row (identical
        // configId+invId) is ALSO sitting in the table.
        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, invId), t1);

        const [rowA] = (await deferredRepo.listForRetry(tenantA, configId, 10)).units;
        const [rowB] = (await deferredRepo.listForRetry(tenantB, configId, 10)).units;
        expect(rowA.attemptCount).toBe(2); // A's own update took effect
        expect(rowB.attemptCount).toBe(1); // B's row must be untouched by A's UPDATE
        expect(rowA.tenantId).toBe(tenantA);
        expect(rowB.tenantId).toBe(tenantB);
      });

      it('touchAttempt UPDATE-branch predicate is tenant-scoped: touching tenant B\'s row updates ONLY tenant B\'s row, even though tenant A has a row at the identical (configId, invId)', async () => {
        // Same shared-row shape as the upsertDeferred test above — both
        // tenants' rows must already exist at the identical key before the
        // UPDATE fires, or a missing tenant_id predicate has nothing else
        // to corrupt. Verified by mutation against the equivalent removal
        // in `touchAttempt`'s UPDATE.
        const { deferredRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const invId = `inv-${randomUUID()}`;
        const now = new Date();

        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, invId), now);
        await deferredRepo.upsertDeferred(deferredInput(tenantB, configId, invId), now);

        const result = await deferredRepo.touchAttempt(tenantB, configId, invId, now);
        expect(result).toBe(2);

        const [rowA] = (await deferredRepo.listForRetry(tenantA, configId, 10)).units;
        const [rowB] = (await deferredRepo.listForRetry(tenantB, configId, 10)).units;
        expect(rowB.attemptCount).toBe(2); // tenant B's own row was touched
        expect(rowA.attemptCount).toBe(1); // tenant A's row must be untouched

        // The cross-tenant-miss case (touching a key that exists for NO
        // tenant matching the caller) still returns null.
        expect(await deferredRepo.touchAttempt(tenantB, configId, 'inv-does-not-exist', now)).toBeNull();
      });

      it('countForConfiguration is tenant-scoped', async () => {
        const { deferredRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const now = new Date();

        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, 'inv-1'), now);
        await deferredRepo.upsertDeferred(deferredInput(tenantA, configId, 'inv-2'), now);
        await deferredRepo.upsertDeferred(deferredInput(tenantB, configId, 'inv-1'), now);

        expect(await deferredRepo.countForConfiguration(tenantA, configId)).toBe(2);
        expect(await deferredRepo.countForConfiguration(tenantB, configId)).toBe(1);
      });
    });

    // =========================================================================
    // Group B — sweep cursor tenant isolation
    // =========================================================================

    describe('tenant isolation — sweep cursor', () => {
      it('setNextOffset\'s UPDATE branch is tenant-scoped: re-setting tenant A\'s offset never moves tenant B\'s cursor at the identical configurationId', async () => {
        // Shared-row shape (same fix as the deferred-store UPDATE-branch
        // tests above): both tenants' rows must already exist at the
        // IDENTICAL configurationId before the UPDATE-triggering call fires,
        // or a missing tenant_id predicate has nothing else to corrupt.
        // Reviewer canary: A=100, B=5, then A=200 — kills a deleted
        // `.where('tenant_id', …)` on setNextOffset's UPDATE branch, which
        // otherwise left both dialect suites fully green.
        const { cursorRepo } = repos();
        const tenantA = `tenant-a-${randomUUID()}`;
        const tenantB = `tenant-b-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date('2026-01-01T01:00:00.000Z');

        await cursorRepo.setNextOffset(tenantA, configId, 100, t0); // INSERT
        await cursorRepo.setNextOffset(tenantB, configId, 5, t0); // INSERT, same configId

        await cursorRepo.setNextOffset(tenantA, configId, 200, t1); // UPDATE, while B's row co-exists

        expect(await cursorRepo.getNextOffset(tenantA, configId)).toBe(200);
        expect(await cursorRepo.getNextOffset(tenantB, configId)).toBe(5); // untouched by A's update
      });

      it('setNextOffset and getNextOffset are BOTH configurationId-scoped: two configs under one tenant never bleed into each other', async () => {
        // Same shared-row principle applied to the OTHER half of decision
        // 9's (tenant, configuration) scope, which had zero coverage before
        // this test — every prior cursor assertion varied only the tenant
        // against a single shared configId. Two configs under ONE tenant,
        // one INSERT each, then an UPDATE on only one config: if
        // `setNextOffset`'s UPDATE branch dropped its configuration_id
        // predicate, BOTH configs would be bumped to 999. If
        // `getNextOffset` dropped its configuration_id predicate, reading
        // config 2 back would return config 1's row instead (both queries
        // share the same tenant_id-only WHERE with no ORDER BY, so they'd
        // resolve to the same physical row) — 10 !== 20 makes that
        // observable regardless of exactly which row wins.
        const { cursorRepo } = repos();
        const tenantId = `tenant-${randomUUID()}`;
        const configOne = `cfg-one-${randomUUID()}`;
        const configTwo = `cfg-two-${randomUUID()}`;
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date('2026-01-01T01:00:00.000Z');

        await cursorRepo.setNextOffset(tenantId, configOne, 10, t0); // INSERT
        await cursorRepo.setNextOffset(tenantId, configTwo, 20, t0); // INSERT, same tenant

        await cursorRepo.setNextOffset(tenantId, configOne, 999, t1); // UPDATE, config 1 only

        expect(await cursorRepo.getNextOffset(tenantId, configOne)).toBe(999);
        expect(await cursorRepo.getNextOffset(tenantId, configTwo)).toBe(20); // untouched by config 1's update
      });
    });

    // =========================================================================
    // Group C — restart recovery: reconstructing repo/service resumes correctly
    // =========================================================================

    describe('restart recovery', () => {
      it('a deferred row and the sweep cursor survive reconstruction of the repository AND service objects, and a fresh instance resumes correctly', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const actor = newActor(tenantId);
        const config = makeConfig(tenantId, configId);

        // A TRUNCATED sweep (more records than one run's bound) is required
        // to prove the cursor's actual VALUE survives restart. `0` is also
        // what a missing row (or a completed, wrapped sweep) returns from
        // `getNextOffset` — asserting `=== 0` after a short single-record
        // sweep (the prior version of this test) cannot distinguish "the
        // cursor durably persisted 0" from "the row/write never happened at
        // all". PAGE_SIZE=10 over 250 records with the service's fixed
        // MAX_SOURCE_PAGES=20 bound truncates the sweep at exactly offset
        // 200 (20 full pages of 10) — a precise, non-zero, deterministically
        // reproducible value to assert after "restart".
        const PAGE_SIZE = 10;
        const TOTAL_RECORDS = 250;
        const EXPECTED_TRUNCATED_OFFSET = 200;
        const allRecords = Array.from({ length: TOTAL_RECORDS }, (_, i) =>
          i === 0
            ? sourceRecord('inv-1', 'SN-1', 'item-missing') // the one unresolvable unit
            // Distinct namespace from 'inv-1' (NOT `inv-${i}`, which would
            // collide with 'inv-1' at i===1 and get quarantined as a
            // conflicting duplicate instead of cleanly upserting).
            : sourceRecord(`inv-restart-${i}`, `SN-restart-${i}`, 'item-ok'),
        );

        // "Process 1": parent missing for inv-1 -> defers; the sweep
        // truncates (more records exist past the bound) so the cursor
        // advances to a non-zero, non-wrapped position. Uses a clock
        // anchored safely in the past so the deferred row's backoff-derived
        // next_attempt_at is already due by the time "process 2" (below, on
        // the real clock) looks for it — modeling a real restart, where
        // wall-clock time has actually moved on.
        const h1 = makeHarness({
          source: makePagingSourceConnector(allRecords),
          products: { 'item-ok': [{ Id: 'p1' }] },
          clock: pastEnoughToBeDue,
        });
        const result1 = await run(h1, config, actor, { batchSize: PAGE_SIZE });
        expect(result1).toMatchObject({
          mode: 'executed',
          deferred: 1,
          upserted: EXPECTED_TRUNCATED_OFFSET - 1, // every processed record except inv-1
          truncated: true,
        });

        // Simulate a process restart: brand-new repository AND service
        // instances, pointed at the SAME durable database. No in-memory
        // state is carried across — everything below is re-read from disk.
        const { deferredRepo: freshDeferredRepo, cursorRepo: freshCursorRepo } = repos();
        expect(freshDeferredRepo).not.toBe(h1.deferredRepo);
        expect(freshCursorRepo).not.toBe(h1.cursorRepo);

        const dueAfterRestart = (await freshDeferredRepo.listDue(tenantId, configId, new Date(), 10)).units;
        expect(dueAfterRestart).toHaveLength(1);
        expect(dueAfterRestart[0].inventoryNumberId).toBe('inv-1');
        // The load-bearing cursor assertion: the EXACT truncated offset,
        // not merely "a number" — a no-op setNextOffset (never persisting
        // anything) would ALSO make this read 0 (the missing-row default),
        // so only a precise non-zero value proves the write actually
        // survived reconstruction. Verified by mutation: a no-op
        // `setNextOffset` leaves this specific assertion red while every
        // other test in both dialect suites stays green.
        expect(await freshCursorRepo.getNextOffset(tenantId, configId)).toBe(EXPECTED_TRUNCATED_OFFSET);

        // "Process 2": fresh service instance, parent now resolvable ->
        // recovers the deferred row and clears it. Empty fresh source: the
        // deferred-row recovery path is independent of where the sweep
        // itself resumes (already proven above).
        const h2 = makeHarness({
          records: [],
          products: { 'item-missing': [{ Id: 'p1' }] },
          deferredRepo: freshDeferredRepo,
          cursorRepo: freshCursorRepo,
        });
        const result2 = await run(h2, config, newActor(tenantId));
        expect(result2).toMatchObject({ mode: 'executed', upserted: 1, deferredRecovered: 1 });
        expect(await freshDeferredRepo.countForConfiguration(tenantId, configId)).toBe(0);
      });
    });

    // =========================================================================
    // Group D — idempotency across real durable state
    // =========================================================================

    describe('idempotency', () => {
      it('two full sequential runs over an unchanged, fully-resolvable source converge: same units upserted both times, zero deferred residue', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const records = Array.from({ length: 5 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
        const upserted: string[] = [];
        const upsert = jest.fn().mockImplementation(async (_e: string, _f: string, value: string) => {
          upserted.push(value);
          return { outcome: 'created' };
        });
        const h = makeHarness({ records, products: { 'item-1': [{ Id: 'p1' }] }, upsertImpl: upsert });
        const config = makeConfig(tenantId, configId);

        const run1 = await run(h, config, newActor(tenantId));
        const run2 = await run(h, config, newActor(tenantId));

        expect(run1).toMatchObject({ upserted: 5, deferred: 0, truncated: false });
        expect(run2).toMatchObject({ upserted: 5, deferred: 0, truncated: false });
        // Set semantics alone would hide extra writes (e.g. a double-processed
        // unit within one run) behind a correctly-sized unique-id set; the
        // raw call count must also be exactly 2 runs x 5 units.
        expect(upserted).toHaveLength(10);
        expect(new Set(upserted)).toEqual(new Set(['inv-0', 'inv-1', 'inv-2', 'inv-3', 'inv-4']));
        expect(await h.deferredRepo.countForConfiguration(tenantId, configId)).toBe(0);
      });

      it('concurrent runs for the same missing-parent unit converge on exactly ONE durable deferred row (real DB concurrency, not a mocked call count)', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const records = [sourceRecord('inv-concurrent', 'SN-1', 'item-missing')];

        const { deferredRepo, cursorRepo } = repos();
        const hA = makeHarness({ records, deferredRepo, cursorRepo });
        const hB = makeHarness({ records, deferredRepo, cursorRepo });

        await Promise.all([
          run(hA, config, newActor(tenantId)),
          run(hB, config, newActor(tenantId)),
        ]);

        expect(await deferredRepo.countForConfiguration(tenantId, configId)).toBe(1);
        const [row] = (await deferredRepo.listForRetry(tenantId, configId, 10)).units;
        expect(row.inventoryNumberId).toBe('inv-concurrent');
      });

      it('concurrent runs for the same resolvable unit converge: no crash, and the unit ends up NOT deferred', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const records = [sourceRecord('inv-concurrent-2', 'SN-1', 'item-1')];
        const products = { 'item-1': [{ Id: 'p1' }] };

        const { deferredRepo, cursorRepo } = repos();
        const hA = makeHarness({ records, products, deferredRepo, cursorRepo });
        const hB = makeHarness({ records, products, deferredRepo, cursorRepo });

        const [resultA, resultB] = await Promise.all([
          run(hA, config, newActor(tenantId)),
          run(hB, config, newActor(tenantId)),
        ]);

        expect(resultA.failures).toEqual([]);
        expect(resultB.failures).toEqual([]);
        expect(await deferredRepo.countForConfiguration(tenantId, configId)).toBe(0);
      });
    });

    // =========================================================================
    // Group E — mixed outcome exact counts, against real durable stores
    // =========================================================================

    describe('mixed outcomes', () => {
      it('a mixed batch (resolved / missing-parent / ambiguous-parent) returns exact partial counts', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const records = [
          sourceRecord('inv-ok', 'SN-ok', 'item-ok'),
          sourceRecord('inv-missing', 'SN-missing', 'item-missing'),
          sourceRecord('inv-ambiguous', 'SN-ambiguous', 'item-dup'),
        ];
        const products = { 'item-ok': [{ Id: 'p1' }], 'item-dup': [{ Id: 'p2' }, { Id: 'p3' }] };
        const h = makeHarness({ records, products });

        const result = await run(h, config, newActor(tenantId));

        expect(result).toMatchObject({
          mode: 'executed',
          unitsRead: 3,
          upserted: 1,
          deferred: 1,
          quarantined: 1,
          failed: 0,
        });
        expect(await h.deferredRepo.countForConfiguration(tenantId, configId)).toBe(1);
      });
    });

    // =========================================================================
    // Group F — governance rejection preserves deferred work (decision 9)
    // =========================================================================

    describe('governance rejection preserves deferred work', () => {
      it('an ownership rejection (reject_with_alert -> OwnershipViolationError) never deletes the durable deferred row, and the audit trail carries no unit data', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const { deferredRepo, cursorRepo } = repos();
        const invId = 'inv-rejected';
        await deferredRepo.upsertDeferred(
          deferredInput(tenantId, configId, invId, { normalizedPayload: unit(tenantId, configId, invId, CANARY_SERIAL, 'item-1') }),
          pastEnoughToBeDue(),
        );

        const resolver = makeResolver({
          validateWrite: jest.fn().mockRejectedValue(
            new OwnershipViolationError({
              entity: 'serialized_asset',
              declaredOwner: 'salesforce',
              callerSystem: 'netsuite',
              conflictPolicy: 'reject_with_alert',
              correlationId: 'corr-govrej',
            }),
          ),
        });
        const h = makeHarness({ records: [], products: { 'item-1': [{ Id: 'p1' }] }, resolver, deferredRepo, cursorRepo });
        const actor = newActor(tenantId);

        const result = await run(h, config, actor);

        expect(result).toMatchObject({ mode: 'executed', upserted: 0, governanceRejections: 1 });
        expect(await deferredRepo.countForConfiguration(tenantId, configId)).toBe(1);

        // Real audit rows for this run's correlationId must never carry the canary.
        const db = getDb().getDatabase();
        const auditRows = await sql<Record<string, unknown>>`
          SELECT * FROM audit_logs WHERE resource_id = ${actor.correlationId}
        `.execute(db);
        expect(auditRows.rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(auditRows.rows)).not.toContain(CANARY_SERIAL);
      });
    });

    // =========================================================================
    // Group G — ApprovalQueueService.enqueue exercised WITH a real payload
    // for this exact descriptor shape (Task 7 review follow-up)
    // =========================================================================

    describe('ApprovalQueueService.enqueue on the serialized-asset descriptor', () => {
      it('a queue_required ownership decision enqueues a real, correctly-shaped, encrypted approval row and leaves deferred state untouched', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const resolver = makeResolver({
          validateWrite: jest.fn().mockResolvedValue({ allowed: false, reason: 'queue_required', declaredOwner: 'salesforce' }),
        });
        const h = makeHarness({
          records: [sourceRecord('inv-queued', CANARY_SERIAL, 'item-1')],
          products: { 'item-1': [{ Id: 'p1' }] },
          resolver,
        });
        const actor = newActor(tenantId);

        // Must NOT throw out of the run — a queue_required decision is a
        // governance rejection the service absorbs per unit, not a crash.
        const result = await run(h, config, actor);
        expect(result).toMatchObject({ mode: 'executed', upserted: 0, governanceRejections: 1, failed: 1 });
        expect(h.target.upsert).not.toHaveBeenCalled();

        // Exactly one approval row was durably enqueued for this write.
        const pending = await approvalQueueService.listPending(tenantId, { operationType: 'ownership_write' });
        expect(pending).toHaveLength(1);
        const approval = pending[0];
        expect(approval.resourceType).toBe('serialized_asset');
        expect(approval.writeDescriptor).not.toBeNull();
        expect(approval.writeDescriptor as string).not.toContain(CANARY_SERIAL);

        // Decrypt and verify the descriptor is EXACTLY the shape decisions
        // 13/14 require: connector-registry key, 'upsert', 'Asset', and the
        // real payload (which legitimately carries the serial — decision 8's
        // one permitted container, now encrypted at rest).
        const decrypted = await decryptDescriptor(JSON.parse(approval.writeDescriptor as string), encryptionService);
        expect(decrypted.targetSystemId).toBe('salesforce');
        expect(decrypted.operation).toBe('upsert');
        expect(decrypted.entityType).toBe('Asset');
        const args = decrypted.args as { externalIdField: string; externalIdValue: string; data: Record<string, unknown> };
        expect(args.externalIdField).toBe(ASSET_EXTERNAL_ID_FIELD);
        expect(args.externalIdValue).toBe('inv-queued');
        expect(args.data.SerialNumber).toBe(CANARY_SERIAL);

        // The queued unit ALSO leaves a durable deferred row. The approval row
        // is the operator's decision surface; the deferred row is the record
        // that the unit is still owed to Salesforce. Without it, a run whose
        // write was refused left nothing durable while the sweep cursor had
        // already advanced past this window — the unit would not be
        // reconsidered until the sweep wrapped the whole source. A refusal
        // means "not yet", never "discard" (see the writeUnit catch).
        expect(await h.deferredRepo.countForConfiguration(tenantId, configId)).toBe(1);
      });
    });

    // =========================================================================
    // Group H — decision 8 privacy canary sweep across every branch
    // =========================================================================

    describe('privacy canary — decision 8', () => {
      it('the canary never reaches a log, a metric label, the returned result, or the deferred reason column, across success/defer/quarantine branches', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-${randomUUID()}`;
        const config = makeConfig(tenantId, configId);
        const { deferredRepo, cursorRepo } = repos();

        // Pre-seed an attempts-exhausted row directly (bypassing 24 real
        // deferral round-trips) so the quarantine branch is exercised too.
        const exhaustedInv = 'inv-exhausted';
        await deferredRepo.upsertDeferred(
          deferredInput(tenantId, configId, exhaustedInv, {
            normalizedPayload: unit(tenantId, configId, exhaustedInv, CANARY_SERIAL, 'item-1'),
          }),
          new Date(),
        );
        // Force attempt_count to the ceiling AND next_attempt_at safely into
        // the past (independent of computeDeferredBackoffMs's ~17.8h cap at
        // this attempt count) so the run below's real-clock listDue() picks
        // this row up as due — otherwise the attempts_exhausted quarantine
        // branch would never be reached and this test would prove nothing
        // about it.
        await sql`
          UPDATE deferred_serialized_units
          SET attempt_count = 24, next_attempt_at = ${new Date(0).toISOString()}
          WHERE tenant_id = ${tenantId} AND configuration_id = ${configId} AND inventory_number_id = ${exhaustedInv}
        `.execute(getDb().getDatabase());

        const upsert = jest.fn().mockImplementation(async (_e: string, _f: string, value: string) => {
          if (value === 'inv-write-failed') throw new Error(`Salesforce rejected ${CANARY_SERIAL}`);
          return { outcome: 'created' };
        });
        const h = makeHarness({
          records: [
            sourceRecord('inv-ok', CANARY_SERIAL, 'item-1'),
            sourceRecord('inv-missing', CANARY_SERIAL, 'item-missing'),
            sourceRecord('inv-ambiguous', CANARY_SERIAL, 'item-dup'),
            sourceRecord('inv-write-failed', CANARY_SERIAL, 'item-1'),
            { id: 'inv-invalid', externalId: '', fields: { item: { id: 'item-1' } }, metadata: {} }, // missing inventorynumber
          ],
          products: { 'item-1': [{ Id: 'p1' }], 'item-dup': [{ Id: 'p2' }, { Id: 'p3' }] },
          upsertImpl: upsert,
          deferredRepo,
          cursorRepo,
        });
        const actor = newActor(tenantId);

        const result = await run(h, config, actor);

        expect(result.upserted).toBe(1);
        // parent_missing (inv-missing) + write_failed (inv-write-failed): a
        // failed write now leaves a durable row too, so the swept window can be
        // consumed without losing the unit.
        expect(result.deferred).toBe(2);
        expect(result.quarantined).toBe(3); // ambiguous_parent + invalid_shape + attempts_exhausted

        // 1) logger + metrics doubles
        const observed = observedArgsDump(h.logger, h.metrics);
        expect(observed).not.toContain(CANARY_SERIAL);

        // 2) the returned result object itself
        expect(JSON.stringify(result)).not.toContain(CANARY_SERIAL);

        // 3) real audit_logs rows written during this run
        const db = getDb().getDatabase();
        const auditRows = await sql<Record<string, unknown>>`
          SELECT * FROM audit_logs WHERE resource_id = ${actor.correlationId}
        `.execute(db);
        expect(auditRows.rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(auditRows.rows)).not.toContain(CANARY_SERIAL);

        // 4) the deferred rows' non-payload columns (reason is a closed
        // enum so it structurally cannot carry the canary; verify anyway).
        const deferredRows = await sql<{ reason: string; normalized_payload: unknown }>`
          SELECT reason, normalized_payload FROM deferred_serialized_units
          WHERE tenant_id = ${tenantId} AND configuration_id = ${configId}
        `.execute(db);
        // Asserted against the exported vocabulary rather than a hand-copied
        // list: a list copied here goes stale the moment a reason is added, and
        // the failure then reads as a privacy regression instead of drift.
        for (const row of deferredRows.rows) {
          expect(DEFERRED_SERIALIZED_UNIT_REASONS).toContain(row.reason);
        }
      });
    });

    // =========================================================================
    // Group I — standard IntegrationService config bypasses every
    // specialized dependency (brief step 8)
    // =========================================================================

    describe('standard configuration bypass', () => {
      it('a standard (non-specialized) config never invokes SerializedAssetSyncService.run and leaves zero rows in either durable specialized table', async () => {
        const tenantId = `tenant-${randomUUID()}`;
        const configId = `cfg-std-${randomUUID()}`;
        const standardConfig: IntegrationConfig = {
          id: configId,
          tenantId,
          name: 'Standard Customer Sync',
          sourceSystem: 'netsuite',
          targetSystem: 'salesforce',
          sourceEntity: 'customer',
          targetEntity: 'account',
          syncDirection: 'source_to_target',
          syncMode: 'manual',
          isActive: true,
          fieldMappings: [],
          transformationRules: [],
        } as IntegrationConfig;

        const { deferredRepo, cursorRepo } = repos();
        const realSerializedAssetSyncService = new SerializedAssetSyncService(
          deferredRepo,
          cursorRepo,
          makeReadiness() as never,
          makeMetrics(),
          { ownershipResolver: createMockOwnershipResolver() as never, auditService: auditService },
          auditService,
        );
        const runSpy = jest.spyOn(realSerializedAssetSyncService, 'run');

        const logger = makeLogger();
        const configServiceStub = {
          getConfiguration: jest.fn(),
          getConfigurationForTenant: jest.fn().mockReturnValue(standardConfig),
        };
        const observabilityStub = {
          createScope: jest.fn().mockReturnValue({
            logger,
            metrics: {
              incrementActiveIntegrations: jest.fn(),
              decrementActiveIntegrations: jest.fn(),
              recordIntegrationRun: jest.fn(),
            },
          }),
        };
        const connectorManagerStub = {
          getConnector: jest.fn().mockResolvedValue(makeTargetConnector({})),
        };

        const integrationService = new IntegrationService(
          logger as never,
          { transform: jest.fn().mockResolvedValue({ success: true, transformedData: {}, errors: [], warnings: [] }) } as never,
          configServiceStub as never,
          {} as never,
          observabilityStub as never,
          createMockOutboundGovernanceService() as never,
          createMockOwnershipResolver() as never,
          auditService,
          createMockApprovalQueueService() as never,
          connectorManagerStub as never,
          realSerializedAssetSyncService,
        );

        // The standard path will likely fail downstream (no real connector
        // wiring) — that's fine and expected; the only load-bearing
        // assertion is that dispatch never reaches the specialized service
        // or its durable tables.
        await integrationService.runIntegrationForTenant(tenantId, configId).catch(() => undefined);

        expect(runSpy).not.toHaveBeenCalled();
        expect(await deferredRepo.countForConfiguration(tenantId, configId)).toBe(0);
        const cursorRows = await sql<{ tenant_id: string }>`
          SELECT tenant_id FROM serialized_asset_sweep_cursors
          WHERE tenant_id = ${tenantId} AND configuration_id = ${configId}
        `.execute(getDb().getDatabase());
        expect(cursorRows.rows).toHaveLength(0);
      });
    });
  });
}
