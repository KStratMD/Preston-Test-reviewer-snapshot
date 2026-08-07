import 'reflect-metadata';
import {
  SerializedAssetSyncService,
  SerializedAssetRunNotReadyError,
  SerializedAssetRunStageError,
  SerializedAssetRunRefusedError,
  type SerializedAssetDeferredStore,
  type SerializedAssetSyncInput,
  type SerializedAssetSyncResult,
} from '../../../../src/services/serializedAsset/SerializedAssetSyncService';
import type { SerializedAssetMetricsRecorder } from '../../../../src/services/serializedAsset/SerializedAssetMetrics';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import {
  LoopDetectedError,
  OwnershipViolationError,
} from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import { OwnershipPendingApprovalError } from '../../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type {
  DeferredSerializedUnit,
  DeferredSerializedUnitInput,
  DeferredSerializedUnitPage,
  UndecodableDeferredRow,
} from '../../../../src/services/serializedAsset/DeferredSerializedUnitRepository';
import type { DataRecord, FieldMapping, IntegrationConfig } from '../../../../src/types';
import type {
  SerializedAssetProfileDraftConfig,
  SerializedUnit,
} from '../../../../src/types/serializedAsset';
import type { IConnector } from '../../../../src/interfaces/IConnector';

/**
 * Task 7 (2026-07-27 NetSuite serialized-asset sync plan) — bounded
 * orchestration, deduplication, defer/retry, governed write, privacy.
 *
 * The real `guardedWrite` is used throughout (never mocked): the ownership
 * resolver / audit service are the only doubles, so every write in this suite
 * genuinely crosses the governance chokepoint. Only the connector, the
 * deferred-work repository, the readiness evaluator, the metrics recorder and
 * the logger are doubles.
 *
 * Decision 8 is the load-bearing constraint here and is asserted by canary:
 * a serial number / inventory-number id planted in the source data must never
 * appear in a logger argument, a metric label, an audit-surface argument, a
 * thrown error message, a returned result, or a persisted deferral reason —
 * across the success path AND every failure branch.
 */

const TENANT = 'tenant-sa';
const CONFIG_ID = 'cfg-sa-1';
const RUN_NOW = new Date('2026-07-27T12:00:00.000Z');

const ASSET_EXTERNAL_ID_FIELD = 'NetSuite_Inventory_Number_Id__c';
const PRODUCT_EXTERNAL_ID_FIELD = 'NetSuite_Item_Id__c';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fieldMapping(sourceField: string, targetField: string): FieldMapping {
  return { sourceField, targetField, transformationType: 'direct', isRequired: true };
}

function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  const executionProfileConfig: SerializedAssetProfileDraftConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: PRODUCT_EXTERNAL_ID_FIELD,
    assetExternalIdField: ASSET_EXTERNAL_ID_FIELD,
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
  };
  return {
    id: CONFIG_ID,
    tenantId: TENANT,
    name: 'NetSuite Serialized Asset Sync',
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

function sourceRecord(inventoryNumberId: string, serial: string, itemId: string): DataRecord {
  return {
    id: inventoryNumberId,
    externalId: '',
    fields: { inventorynumber: serial, item: { id: itemId } },
    metadata: {},
  };
}

function deferredRow(
  inventoryNumberId: string,
  serial: string,
  itemId: string,
  reason: DeferredSerializedUnit['reason'] = 'parent_missing',
): DeferredSerializedUnit {
  const normalizedPayload: SerializedUnit = {
    tenantId: TENANT,
    configurationId: CONFIG_ID,
    inventoryNumberId,
    serialNumber: serial,
    itemId,
  };
  return {
    tenantId: TENANT,
    configurationId: CONFIG_ID,
    inventoryNumberId,
    normalizedPayload,
    reason,
    attemptCount: 1,
    nextAttemptAt: '2026-07-27T11:00:00.000Z',
    firstDeferredAt: '2026-07-27T10:00:00.000Z',
    lastAttemptAt: '2026-07-27T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface SourceConnectorDouble {
  list: jest.Mock;
}

function makeSourceConnector(records: DataRecord[]): SourceConnectorDouble {
  return { list: jest.fn().mockResolvedValue(records) };
}

/**
 * A source double that honours `limit`/`offset`, i.e. behaves like a real
 * paging backend. `makeSourceConnector` returns the same array for every call,
 * which only exercises the single-page path.
 */
function makePagingSourceConnector(all: DataRecord[]): SourceConnectorDouble {
  return {
    list: jest.fn().mockImplementation(async (_entity: string, options: { limit: number; offset?: number }) => {
      const offset = options.offset ?? 0;
      return all.slice(offset, offset + options.limit);
    }),
  };
}

/**
 * A source double implementing the connector's `listPage`, so `hasMore` is the
 * authoritative exhaustion signal. `serverPageCap` simulates a service that
 * returns fewer rows than the requested `limit` while still having more —
 * exactly the case the short-page heuristic gets WRONG.
 */
function makeListPageSourceConnector(
  all: DataRecord[],
  opts: { serverPageCap?: number } = {},
): SourceConnectorDouble & { listPage: jest.Mock } {
  const listPage = jest.fn().mockImplementation(
    async (_entity: string, options: { limit: number; offset?: number }) => {
      const offset = options.offset ?? 0;
      const size = Math.min(options.limit, opts.serverPageCap ?? options.limit);
      const records = all.slice(offset, offset + size);
      return { records, hasMore: offset + records.length < all.length, totalResults: all.length };
    },
  );
  return {
    list: jest.fn().mockImplementation(async (entity: string, options: { limit: number; offset?: number }) =>
      (await listPage(entity, options)).records,
    ),
    listPage,
  };
}

interface CursorStoreDouble {
  getNextOffset: jest.Mock;
  setNextOffset: jest.Mock;
}

function makeCursorStore(initialOffset = 0): CursorStoreDouble {
  let offset = initialOffset;
  return {
    getNextOffset: jest.fn().mockImplementation(async () => offset),
    setNextOffset: jest.fn().mockImplementation(async (_t: string, _c: string, next: number) => {
      offset = next;
    }),
  };
}

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

/** `products` maps an itemId to the rows `findProduct2ByExternalId` returns. */
function makeTargetConnector(
  products: Record<string, { Id: string }[]>,
  upsertImpl?: jest.Mock,
): TargetConnectorDouble {
  return {
    describeSObject: jest.fn().mockResolvedValue({ name: 'Asset', fields: [] }),
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

interface DeferredStoreDouble extends SerializedAssetDeferredStore {
  upsertDeferred: jest.Mock;
  listDue: jest.Mock;
  listForRetry: jest.Mock;
  deleteSucceeded: jest.Mock;
  touchAttempt: jest.Mock;
}

/** Both listings return a page of decoded units plus the corrupt rows they saw. */
function deferredPage(
  units: DeferredSerializedUnit[] = [],
  undecodable: UndecodableDeferredRow[] = [],
): DeferredSerializedUnitPage {
  return { units, undecodable };
}

function makeDeferredStore(rows: DeferredSerializedUnit[] = []): DeferredStoreDouble {
  return {
    upsertDeferred: jest.fn().mockResolvedValue(undefined),
    listDue: jest.fn().mockResolvedValue(deferredPage(rows)),
    listForRetry: jest.fn().mockResolvedValue(deferredPage(rows)),
    deleteSucceeded: jest.fn().mockResolvedValue(true),
    touchAttempt: jest.fn().mockResolvedValue(2),
  };
}

function makeMetrics(): jest.Mocked<SerializedAssetMetricsRecorder> {
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

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeAudit() {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue('audit-1'),
    logDataAccess: jest.fn().mockResolvedValue('audit-2'),
  };
}

function makeResolver(overrides: Partial<{ validateWrite: jest.Mock; detectLoop: jest.Mock }> = {}) {
  return {
    validateWrite: overrides.validateWrite
      ?? jest.fn().mockResolvedValue({ allowed: true, owner: 'salesforce' }),
    detectLoop: overrides.detectLoop ?? jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

function makeReadiness(ready = true) {
  return {
    evaluate: jest.fn().mockResolvedValue({
      ready,
      checkedAt: RUN_NOW.toISOString(),
      blockers: ready ? [] : [{ code: 'field_not_external_id', message: 'Asset.X is not marked as an External ID' }],
      productExternalIdFields: [],
      assetExternalIdFields: [],
    }),
  };
}

interface Harness {
  service: SerializedAssetSyncService;
  source: SourceConnectorDouble;
  target: TargetConnectorDouble;
  store: DeferredStoreDouble;
  metrics: jest.Mocked<SerializedAssetMetricsRecorder>;
  logger: ReturnType<typeof makeLogger>;
  audit: ReturnType<typeof makeAudit>;
  resolver: ReturnType<typeof makeResolver>;
  readiness: ReturnType<typeof makeReadiness>;
  cursor: CursorStoreDouble;
  run: (options?: Partial<SerializedAssetSyncInput['options']>, config?: IntegrationConfig) => Promise<SerializedAssetSyncResult>;
}

function makeHarness(
  overrides: {
    records?: DataRecord[];
    products?: Record<string, { Id: string }[]>;
    deferred?: DeferredSerializedUnit[];
    upsertImpl?: jest.Mock;
    source?: SourceConnectorDouble;
    store?: DeferredStoreDouble;
    resolver?: ReturnType<typeof makeResolver>;
    readiness?: ReturnType<typeof makeReadiness>;
    cursor?: CursorStoreDouble;
  } = {},
): Harness {
  const source = overrides.source ?? makeSourceConnector(overrides.records ?? []);
  const target = makeTargetConnector(overrides.products ?? {}, overrides.upsertImpl);
  const store = overrides.store ?? makeDeferredStore(overrides.deferred ?? []);
  const metrics = makeMetrics();
  const logger = makeLogger();
  const audit = makeAudit();
  const resolver = overrides.resolver ?? makeResolver();
  const readiness = overrides.readiness ?? makeReadiness();
  const cursor = overrides.cursor ?? makeCursorStore();

  const service = new SerializedAssetSyncService(
    store,
    cursor as never,
    readiness as never,
    metrics,
    { ownershipResolver: resolver as never, auditService: audit as never },
    audit as never,
    logger as never,
    () => RUN_NOW,
  );

  return {
    service,
    source,
    target,
    store,
    metrics,
    logger,
    audit,
    resolver,
    readiness,
    cursor,
    run: (options = {}, config = makeConfig()) =>
      service.run({
        config,
        sourceConnector: source as unknown as IConnector,
        targetConnector: target as unknown as IConnector,
        options: {
          batchSize: 100,
          concurrency: 4,
          dryRun: false,
          forceDeferredRetry: false,
          ...options,
        },
        actor: { tenantId: TENANT, userId: 'operator-1', correlationId: 'corr-1' },
      }),
  };
}

/** Serializes every argument every double was called with, for canary scans. */
function allObservedArgs(h: Harness): string {
  return JSON.stringify([
    ...h.logger.info.mock.calls,
    ...h.logger.warn.mock.calls,
    ...h.logger.error.mock.calls,
    ...h.logger.debug.mock.calls,
    ...h.audit.logGovernanceCheck.mock.calls,
    ...h.audit.logDataAccess.mock.calls,
    ...h.metrics.recordUnitsRead.mock.calls,
    ...h.metrics.recordUnitUpserted.mock.calls,
    ...h.metrics.recordUnitDeferred.mock.calls,
    ...h.metrics.recordUnitQuarantined.mock.calls,
    ...h.metrics.recordRetryAttempted.mock.calls,
    ...h.metrics.recordDeferredRecovered.mock.calls,
    ...h.metrics.recordGovernanceRejection.mock.calls,
    ...h.metrics.recordReadinessFailure.mock.calls,
  ]);
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function spyOnConsole() {
  const spies = CONSOLE_METHODS.map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  return {
    serialized: (): string => JSON.stringify(spies.flatMap((s) => s.mock.calls)),
    restore: (): void => spies.forEach((s) => s.mockRestore()),
  };
}

// ---------------------------------------------------------------------------
// Step 1 — orchestration
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — orchestration', () => {
  it('all-resolved success: every unit upserts through IConnector.upsert with the pinned argument order', async () => {
    const h = makeHarness({
      records: [
        sourceRecord('inv-1', 'SN-1', 'item-1'),
        sourceRecord('inv-2', 'SN-2', 'item-2'),
        sourceRecord('inv-3', 'SN-3', 'item-1'),
      ],
      products: { 'item-1': [{ Id: 'p1' }], 'item-2': [{ Id: 'p2' }] },
    });

    const result = await h.run();

    expect(result).toMatchObject({
      mode: 'executed',
      unitsRead: 3,
      upserted: 3,
      deferred: 0,
      quarantined: 0,
      failed: 0,
    });
    expect(h.target.upsert).toHaveBeenCalledTimes(3);
    expect(h.target.upsert).toHaveBeenCalledWith('Asset', ASSET_EXTERNAL_ID_FIELD, 'inv-1', {
      [ASSET_EXTERNAL_ID_FIELD]: 'inv-1',
      SerialNumber: 'SN-1',
      Product2Id: 'p1',
    });
    // The specialized path never reaches for a non-upsert mutation (decision 4:
    // a read-then-create sequence is prohibited).
    expect(h.target.create).not.toHaveBeenCalled();
    expect(h.target.update).not.toHaveBeenCalled();
    expect(h.target.bulkCreate).not.toHaveBeenCalled();
  });

  it('missing-parent partial: resolvable units upsert, unresolvable units defer with parent_missing', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1'), sourceRecord('inv-2', 'SN-2', 'item-missing')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', upserted: 1, deferred: 1, failed: 0 });
    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    expect(h.store.upsertDeferred).toHaveBeenCalledTimes(1);
    expect(h.store.upsertDeferred).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        configurationId: CONFIG_ID,
        inventoryNumberId: 'inv-2',
        reason: 'parent_missing',
      }),
      RUN_NOW,
    );
    expect(h.metrics.recordUnitDeferred).toHaveBeenCalledWith('parent_missing');
  });

  it('ambiguous parent quarantines the unit through a sanitized audit event and never upserts', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-dup')],
      products: { 'item-dup': [{ Id: 'p1' }, { Id: 'p2' }] },
    });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', upserted: 0, quarantined: 1, deferred: 0 });
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(h.store.upsertDeferred).not.toHaveBeenCalled();
    expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('ambiguous_parent');
    expect(h.audit.logDataAccess).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, sessionId: 'corr-1' }),
    );
  });

  it('invalid shape (missing required source field) is quarantined before any connector call', async () => {
    const bad: DataRecord = { id: 'inv-9', externalId: '', fields: { item: { id: 'item-1' } }, metadata: {} };
    const h = makeHarness({
      records: [bad, sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', upserted: 1, quarantined: 1 });
    expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('invalid_shape');
    expect(h.target.findProduct2ByExternalId).toHaveBeenCalledTimes(1);
  });

  it('identical duplicate source rows collapse to exactly one upsert', async () => {
    const h = makeHarness({
      records: [
        sourceRecord('inv-1', 'SN-1', 'item-1'),
        sourceRecord('inv-1', 'SN-1', 'item-1'),
        sourceRecord('inv-1', 'SN-1', 'item-1'),
      ],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    const result = await h.run();

    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: 'executed', upserted: 1, quarantined: 0, duplicatesCollapsed: 2 });
  });

  it('conflicting duplicates (same inventory number, different projection) quarantine the whole group', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1'), sourceRecord('inv-1', 'SN-DIFFERENT', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    const result = await h.run();

    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', upserted: 0, quarantined: 2 });
    expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('conflicting_duplicate');
  });

  it('a transient dependency failure during Product2 resolution defers rather than failing the unit', async () => {
    const h = makeHarness({ records: [sourceRecord('inv-1', 'SN-1', 'item-1')] });
    h.target.findProduct2ByExternalId.mockRejectedValue(new Error('socket hang up'));

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', deferred: 1, upserted: 0, failed: 0 });
    expect(h.store.upsertDeferred).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'transient_dependency_failure' }),
      RUN_NOW,
    );
  });

  it('connection-wide source failure fails the run with a fixed-message stage error and writes nothing', async () => {
    const source = makeSourceConnector([]);
    source.list.mockRejectedValue(new Error('ECONNREFUSED netsuite'));
    const h = makeHarness({ source });

    await expect(h.run()).rejects.toBeInstanceOf(SerializedAssetRunStageError);
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(h.store.upsertDeferred).not.toHaveBeenCalled();
    expect(h.store.deleteSucceeded).not.toHaveBeenCalled();
  });

  it('record failures are independent: one failing upsert does not stop the others', async () => {
    const upsert = jest.fn().mockImplementation(async (_e: string, _f: string, value: string) => {
      if (value === 'inv-2') throw new Error('Salesforce row lock');
      return { outcome: 'updated' };
    });
    const h = makeHarness({
      records: [
        sourceRecord('inv-1', 'SN-1', 'item-1'),
        sourceRecord('inv-2', 'SN-2', 'item-1'),
        sourceRecord('inv-3', 'SN-3', 'item-1'),
      ],
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', upserted: 2, failed: 1 });
    expect(h.target.upsert).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — idempotency
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — idempotency', () => {
  it('within a single run, deduplication by inventoryNumberId yields exactly one upsert call', async () => {
    const h = makeHarness({
      records: Array.from({ length: 5 }, () => sourceRecord('inv-1', 'SN-1', 'item-1')),
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    expect(h.target.upsert).toHaveBeenCalledTimes(1);
  });

  it('a deferred row for a unit also present in the fresh listing is attempted once, not twice', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      deferred: [deferredRow('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    expect(h.store.deleteSucceeded).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-1');
  });

  it(
    'across two concurrent runs the guarantee is convergence, not call count: exactly one Asset ' +
      'and exactly one deferred row remain',
    async () => {
      // Convergent in-memory fakes. Deliberately NOT asserting upsert call
      // count: there is no lease or row lock in this design, so two overlapping
      // executions may each issue an upsert for the same unit. Asserting a
      // single invocation would be flaky rather than protective.
      const assets = new Map<string, Record<string, unknown>>();
      const deferredRows = new Map<string, DeferredSerializedUnitInput>();

      const upsert = jest.fn().mockImplementation(
        async (_entity: string, _field: string, value: string, data: Record<string, unknown>) => {
          assets.set(value, data);
          return { outcome: 'created' };
        },
      );
      const store: DeferredStoreDouble = {
        upsertDeferred: jest.fn().mockImplementation(async (input: DeferredSerializedUnitInput) => {
          deferredRows.set(
            `${input.tenantId}::${input.configurationId}::${input.inventoryNumberId}`,
            input,
          );
        }),
        listDue: jest.fn().mockResolvedValue(deferredPage()),
        listForRetry: jest.fn().mockResolvedValue(deferredPage()),
        deleteSucceeded: jest.fn().mockImplementation(async (t: string, c: string, i: string) =>
          deferredRows.delete(`${t}::${c}::${i}`),
        ),
      };

      const records = [sourceRecord('inv-1', 'SN-1', 'item-1'), sourceRecord('inv-2', 'SN-2', 'item-missing')];
      const products = { 'item-1': [{ Id: 'p1' }] };
      const a = makeHarness({ records, products, store, upsertImpl: upsert });
      const b = makeHarness({ records, products, store, upsertImpl: upsert });

      await Promise.all([a.run(), b.run()]);

      expect(assets.size).toBe(1);
      expect([...assets.keys()]).toEqual(['inv-1']);
      expect(deferredRows.size).toBe(1);
      expect([...deferredRows.keys()]).toEqual([`${TENANT}::${CONFIG_ID}::inv-2`]);
    },
  );

  it('a concurrent unique-violation on the deferral write is absorbed by a single retry', async () => {
    const store = makeDeferredStore();
    store.upsertDeferred
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
      .mockResolvedValueOnce(undefined);
    const h = makeHarness({ records: [sourceRecord('inv-1', 'SN-1', 'item-missing')], store });

    const result = await h.run();

    expect(store.upsertDeferred).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ mode: 'executed', deferred: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Step 3 — governance
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — governance', () => {
  it('every Asset mutation crosses guardedWrite: ownership is validated and audited per unit', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    expect(h.resolver.validateWrite).toHaveBeenCalledTimes(1);
    expect(h.resolver.validateWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        targetSystem: 'salesforce',
        callerSystem: 'netsuite',
        operation: 'upsert',
      }),
    );
    // guardedWrite emits a decision row and an outcome row per allowed write.
    expect(h.audit.logGovernanceCheck).toHaveBeenCalledTimes(2);
    expect(h.resolver.detectLoop).toHaveBeenCalledTimes(1);
  });

  it('the mutation is issued through IConnector.upsert, the method that carries validateOutboundWrite', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    // SalesforceConnector.upsert is the only Asset write path and it calls
    // validateOutboundWrite internally (Task 4). Asserting the service never
    // reaches for another mutation method is what keeps that guarantee.
    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    for (const method of ['create', 'update', 'delete', 'bulkCreate', 'bulkUpdate', 'bulkDelete'] as const) {
      expect(h.target[method]).not.toHaveBeenCalled();
    }
  });

  it('an ownership rejection never deletes deferred state', async () => {
    const resolver = makeResolver({
      validateWrite: jest.fn().mockRejectedValue(
        new OwnershipViolationError({
          entity: 'serialized_asset',
          declaredOwner: 'salesforce',
          callerSystem: 'netsuite',
          conflictPolicy: 'reject_with_alert',
          correlationId: 'corr-1',
        }),
      ),
    });
    const h = makeHarness({
      records: [],
      deferred: [deferredRow('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
      resolver,
    });

    const result = await h.run();

    expect(h.store.deleteSucceeded).not.toHaveBeenCalled();
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', upserted: 0, governanceRejections: 1 });
    expect(h.metrics.recordGovernanceRejection).toHaveBeenCalledWith('blocked');
  });

  it('a queued (pending-approval) write is counted as a governance rejection and leaves deferred state alone', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('should never be dispatched'));
    const h = makeHarness({
      records: [],
      deferred: [deferredRow('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });
    h.resolver.validateWrite.mockResolvedValue({
      allowed: false,
      reason: 'queue_required',
      declaredOwner: 'salesforce',
    });
    // No approvalQueueService dep is injected, so guardedWrite throws before
    // enqueueing; either way the contract under test is that the service does
    // not delete the deferred row.
    const result = await h.run();

    expect(h.store.deleteSucceeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', upserted: 0 });
  });

  it('a loop-detection block is recorded under its own metric outcome', async () => {
    const resolver = makeResolver({
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: true, breakingCondition: 'echo suppression' }),
    });
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
      resolver,
    });

    const result = await h.run();

    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(h.metrics.recordGovernanceRejection).toHaveBeenCalledWith('loop_detected');
    expect(result).toMatchObject({ governanceRejections: 1 });
  });
});

// ---------------------------------------------------------------------------
// Step 3b — dry run
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — dryRun', () => {
  it('issues no upsert and no repository write at all, while reads still happen', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1'), sourceRecord('inv-2', 'SN-2', 'item-missing')],
      products: { 'item-1': [{ Id: 'p1' }] },
      deferred: [deferredRow('inv-3', 'SN-3', 'item-1')],
    });

    const result = await h.run({ dryRun: true });

    // reads
    expect(h.source.list).toHaveBeenCalledTimes(1);
    expect(h.store.listDue).toHaveBeenCalledTimes(1);
    expect(h.target.findProduct2ByExternalId).toHaveBeenCalled();
    // no mutation anywhere — connector OR repository
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(h.store.upsertDeferred).not.toHaveBeenCalled();
    expect(h.store.deleteSucceeded).not.toHaveBeenCalled();
    // distinct preview shape
    expect(result.mode).toBe('previewed');
    expect(result).toMatchObject({ mode: 'previewed', wouldUpsert: 2, wouldDefer: 1 });
    expect(result).not.toHaveProperty('upserted');
    expect(result).not.toHaveProperty('deferred');
  });

  it('never advances backoff state: no attempt increment and no next_attempt_at movement', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-missing')],
      deferred: [deferredRow('inv-1', 'SN-1', 'item-missing')],
    });

    await h.run({ dryRun: true });

    // upsertDeferred is the ONLY writer of attempt_count / next_attempt_at.
    expect(h.store.upsertDeferred).not.toHaveBeenCalled();
    expect(h.metrics.recordUnitDeferred).toHaveBeenCalledWith('previewed');
  });

  it('never consumes deferred work: a resolvable deferred unit is previewed, not deleted', async () => {
    const h = makeHarness({
      records: [],
      deferred: [deferredRow('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    const result = await h.run({ dryRun: true });

    expect(h.store.deleteSucceeded).not.toHaveBeenCalled();
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'previewed', wouldUpsert: 1, wouldRecoverDeferred: 1 });
  });
});

// ---------------------------------------------------------------------------
// Deferred retry authorization
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — deferred retry', () => {
  it('an ordinary run honors next_attempt_at via listDue and never calls listForRetry', async () => {
    const h = makeHarness({ records: [] });

    await h.run({ forceDeferredRetry: false });

    expect(h.store.listDue).toHaveBeenCalledWith(TENANT, CONFIG_ID, RUN_NOW, 100);
    expect(h.store.listForRetry).not.toHaveBeenCalled();
  });

  it('an authorized forced retry uses listForRetry and never calls listDue', async () => {
    const h = makeHarness({ records: [] });

    await h.run({ forceDeferredRetry: true });

    expect(h.store.listForRetry).toHaveBeenCalledWith(TENANT, CONFIG_ID, 100);
    expect(h.store.listDue).not.toHaveBeenCalled();
    expect(h.metrics.recordRetryAttempted).not.toHaveBeenCalled(); // no rows returned
  });

  it('a recovered deferred unit deletes its row only after a confirmed upsert', async () => {
    const callOrder: string[] = [];
    const upsert = jest.fn().mockImplementation(async () => {
      callOrder.push('upsert');
      return { outcome: 'updated' };
    });
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-1')]);
    store.deleteSucceeded.mockImplementation(async () => {
      callOrder.push('delete');
      return true;
    });
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] }, upsertImpl: upsert });

    const result = await h.run();

    expect(callOrder).toEqual(['upsert', 'delete']);
    expect(result).toMatchObject({ mode: 'executed', upserted: 1, deferredRecovered: 1, retriesAttempted: 1 });
    expect(h.metrics.recordRetryAttempted).toHaveBeenCalledWith('due');
    expect(h.metrics.recordDeferredRecovered).toHaveBeenCalledWith('deleted');
  });

  it('a deferred row belonging to another tenant is refused, never processed', async () => {
    const foreign = deferredRow('inv-x', 'SN-X', 'item-1');
    const store = makeDeferredStore([{ ...foreign, tenantId: 'tenant-other' }]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run();

    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', upserted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Source paging (review finding I3)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — source listing pagination', () => {
  it('REVIEWER PROBE: units past the first page are synced, not stranded forever', async () => {
    // Before the fix, `list({ limit: batchSize })` with no offset meant the same
    // first batchSize rows were re-upserted every run and everything past that
    // window NEVER reached Salesforce.
    const all = Array.from({ length: 250 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 100 });

    expect(h.target.upsert).toHaveBeenCalledTimes(250);
    expect(result).toMatchObject({ mode: 'executed', unitsRead: 250, upserted: 250, truncated: false });
    // 3 full/partial pages: 100, 100, 50 (a short page ends the sweep).
    expect(source.list).toHaveBeenCalledTimes(3);
  });

  it('pages with a stable deterministic ordering and an advancing offset', async () => {
    const all = Array.from({ length: 30 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    await h.run({ batchSize: 10 });

    const offsets = source.list.mock.calls.map((c) => (c[1] as { offset: number }).offset);
    expect(offsets).toEqual([0, 10, 20, 30]);
    for (const call of source.list.mock.calls) {
      const options = call[1] as { sortBy?: string; sortOrder?: string; limit: number };
      expect(options.limit).toBe(10);
      expect(options.sortBy).toBeDefined();
      expect(options.sortOrder).toBe('asc');
    }
  });

  it('an exactly-full final page ends the sweep with one empty probe, not an infinite loop', async () => {
    const all = Array.from({ length: 20 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10 });

    expect(source.list).toHaveBeenCalledTimes(3); // 10, 10, then empty
    expect(result).toMatchObject({ upserted: 20, truncated: false });
  });

  it('REVIEWER PROBE: when the page cap truncates the sweep it is REPORTED, never silent', async () => {
    const all = Array.from({ length: 5000 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 100 });

    expect(result).toMatchObject({ mode: 'executed', truncated: true });
    // Bounded: the run does not attempt all 5000 in one sweep.
    expect(h.target.upsert.mock.calls.length).toBeLessThan(5000);
    expect(h.target.upsert.mock.calls.length).toBeGreaterThan(0);
    // Truncation is a RESULT signal, never a silent cap swallowed into a log.
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('reports truncated: false when the whole source fits inside the cap', async () => {
    const all = Array.from({ length: 5 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 100 });

    expect(result).toMatchObject({ truncated: false, upserted: 5 });
    expect(source.list).toHaveBeenCalledTimes(1);
  });

  it('a dry run pages and reports truncation the same way', async () => {
    const all = Array.from({ length: 25 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10, dryRun: true });

    expect(result).toMatchObject({ mode: 'previewed', wouldUpsert: 25, truncated: false });
    expect(h.target.upsert).not.toHaveBeenCalled();
  });

  it('an unstable page boundary that repeats a row cannot double-upsert it', async () => {
    // Real backends can shift rows between pages. Deduplication runs over the
    // WHOLE accumulated record set, so a repeat collapses instead of writing twice.
    const source: SourceConnectorDouble = {
      list: jest.fn().mockImplementation(async (_e: string, options: { limit: number; offset?: number }) => {
        const offset = options.offset ?? 0;
        if (offset === 0) return [sourceRecord('inv-1', 'SN-1', 'item-1'), sourceRecord('inv-2', 'SN-2', 'item-1')];
        if (offset === 2) return [sourceRecord('inv-2', 'SN-2', 'item-1')]; // repeated
        return [];
      }),
    };
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 2 });

    expect(h.target.upsert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ upserted: 2, duplicatesCollapsed: 1 });
  });

  it('a failure on a LATER page still fails the run with the fixed-message stage error', async () => {
    const source: SourceConnectorDouble = {
      list: jest.fn().mockImplementation(async (_e: string, options: { limit: number; offset?: number }) => {
        if ((options.offset ?? 0) === 0) {
          return Array.from({ length: 2 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
        }
        throw new Error('NetSuite paging failed');
      }),
    };
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    await expect(h.run({ batchSize: 2 })).rejects.toBeInstanceOf(SerializedAssetRunStageError);
    expect(h.target.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Durable sweep progress across runs (review round 2, IMPORTANT 1)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — durable sweep progress', () => {
  it('REVIEWER PROBE-C: successive runs cover DIFFERENT ids; every row is eventually synced', async () => {
    // Before the fix, sweepSource always restarted at offset 0: run 1 and run 2
    // upserted the IDENTICAL first window and everything past the sweep bound
    // was never reached by ANY run.
    const total = 5000;
    const all = Array.from({ length: total }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore();
    const seen = new Set<string>();
    const upsert = jest.fn().mockImplementation(async (_e: string, _f: string, value: string) => {
      seen.add(value);
      return { outcome: 'created' };
    });
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] }, upsertImpl: upsert });

    const firstRun = await h.run({ batchSize: 100 });
    const afterFirst = new Set(seen);
    expect(firstRun).toMatchObject({ truncated: true });
    expect(afterFirst.size).toBeGreaterThan(0);
    expect(afterFirst.size).toBeLessThan(total);

    const secondRun = await h.run({ batchSize: 100 });
    // The second run must make PROGRESS, not repeat the first window.
    const newlySeen = [...seen].filter((id) => !afterFirst.has(id));
    expect(newlySeen.length).toBeGreaterThan(0);
    expect(secondRun).toMatchObject({ truncated: true });

    // Keep running: every id must eventually be synced.
    for (let i = 0; i < 10 && seen.size < total; i += 1) {
      await h.run({ batchSize: 100 });
    }
    expect(seen.size).toBe(total);
  });

  it('the cursor advances to where the sweep stopped and wraps to 0 once the source is exhausted', async () => {
    const all = Array.from({ length: 30 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore();
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] } });

    // 30 rows at pageSize 10 fits inside the bound, so this sweep completes and wraps.
    const result = await h.run({ batchSize: 10 });

    expect(result).toMatchObject({ truncated: false, upserted: 30 });
    expect(cursor.setNextOffset).toHaveBeenCalledWith(TENANT, CONFIG_ID, 0, RUN_NOW);
  });

  it('a fresh configuration starts at the beginning', async () => {
    const all = Array.from({ length: 5 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore(0);
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] } });

    await h.run({ batchSize: 10 });

    expect(cursor.getNextOffset).toHaveBeenCalledWith(TENANT, CONFIG_ID);
    expect((source.list.mock.calls[0][1] as { offset: number }).offset).toBe(0);
  });

  it('resumes from the stored offset rather than restarting', async () => {
    const all = Array.from({ length: 30 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore(20);
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] } });

    await h.run({ batchSize: 10 });

    expect((source.list.mock.calls[0][1] as { offset: number }).offset).toBe(20);
    expect(h.target.upsert).toHaveBeenCalledWith('Asset', ASSET_EXTERNAL_ID_FIELD, 'inv-20', expect.anything());
    expect(h.target.upsert).not.toHaveBeenCalledWith('Asset', ASSET_EXTERNAL_ID_FIELD, 'inv-0', expect.anything());
  });

  it('a stored offset past the end of a shrunken source restarts from the beginning in the SAME run', async () => {
    const all = Array.from({ length: 5 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore(400); // source shrank underneath us
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10 });

    // A wasted no-op run would be a silent stall; the sweep wraps immediately.
    expect(result).toMatchObject({ upserted: 5, truncated: false });
    expect(cursor.setNextOffset).toHaveBeenCalledWith(TENANT, CONFIG_ID, 0, RUN_NOW);
  });

  it('a dry run READS the cursor but never writes it', async () => {
    const all = Array.from({ length: 30 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all);
    const cursor = makeCursorStore(10);
    const h = makeHarness({ source, cursor, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10, dryRun: true });

    // Reading makes the preview meaningful (it previews what the next REAL run
    // would do); writing would change what that run sees — a durable mutation.
    expect(cursor.getNextOffset).toHaveBeenCalled();
    expect(cursor.setNextOffset).not.toHaveBeenCalled();
    expect(result.mode).toBe('previewed');
  });

  it('the cursor is tenant + configuration scoped on every access', async () => {
    const h = makeHarness({ records: [], products: {} });

    await h.run();

    for (const call of h.cursor.getNextOffset.mock.calls) {
      expect(call.slice(0, 2)).toEqual([TENANT, CONFIG_ID]);
    }
    for (const call of h.cursor.setNextOffset.mock.calls) {
      expect(call.slice(0, 2)).toEqual([TENANT, CONFIG_ID]);
    }
  });
});

// ---------------------------------------------------------------------------
// hasMore as the authoritative exhaustion signal (review round 2, IMPORTANT 2)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — exhaustion signal', () => {
  it('REVIEWER PROBE: a server page cap below the requested limit does NOT end the sweep early', async () => {
    // The short-page heuristic gets this wrong: the service returns 5 rows for a
    // requested limit of 10 while hasMore is true. Trusting the short page would
    // stop the sweep and report `truncated: false` — a silent partial sync.
    const all = Array.from({ length: 20 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makeListPageSourceConnector(all, { serverPageCap: 5 });
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10 });

    expect(result).toMatchObject({ upserted: 20, truncated: false });
    expect(source.listPage).toHaveBeenCalled();
  });

  it('uses hasMore === false as the authoritative end even on a full page', async () => {
    const all = Array.from({ length: 10 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makeListPageSourceConnector(all);
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10 });

    // An exactly-full final page with hasMore:false needs NO extra empty probe.
    expect(source.listPage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ upserted: 10, truncated: false });
  });

  it('falls back to the short-page heuristic for a connector without listPage', async () => {
    const all = Array.from({ length: 25 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1'));
    const source = makePagingSourceConnector(all); // list() only
    const h = makeHarness({ source, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ batchSize: 10 });

    expect(result).toMatchObject({ upserted: 25, truncated: false });
    expect(source.list).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Product2 resolution memoization (review escalation of concern 6)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — Product2 lookup memoization', () => {
  it('REVIEWER PROBE: N units sharing an itemId issue exactly ONE Product2 lookup', async () => {
    const h = makeHarness({
      records: Array.from({ length: 50 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-shared')),
      products: { 'item-shared': [{ Id: 'p1' }] },
    });

    const result = await h.run();

    expect(h.target.findProduct2ByExternalId).toHaveBeenCalledTimes(1);
    expect(h.target.upsert).toHaveBeenCalledTimes(50);
    expect(result).toMatchObject({ upserted: 50 });
  });

  it('distinct itemIds each get their own lookup', async () => {
    const h = makeHarness({
      records: [
        sourceRecord('inv-1', 'SN-1', 'item-a'),
        sourceRecord('inv-2', 'SN-2', 'item-a'),
        sourceRecord('inv-3', 'SN-3', 'item-b'),
      ],
      products: { 'item-a': [{ Id: 'pa' }], 'item-b': [{ Id: 'pb' }] },
    });

    await h.run();

    expect(h.target.findProduct2ByExternalId).toHaveBeenCalledTimes(2);
  });

  it('the cache is run-scoped: a second run re-resolves rather than reusing stale state', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-a')],
      products: { 'item-a': [{ Id: 'pa' }] },
    });

    await h.run();
    await h.run();

    expect(h.target.findProduct2ByExternalId).toHaveBeenCalledTimes(2);
  });

  it('a lookup outage is not amplified: every sharing unit defers off ONE failed call', async () => {
    const h = makeHarness({
      records: Array.from({ length: 20 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-shared')),
    });
    h.target.findProduct2ByExternalId.mockRejectedValue(new Error('socket hang up'));

    const result = await h.run();

    expect(h.target.findProduct2ByExternalId).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: 'executed', deferred: 20, upserted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Retry-state advancement on terminal non-success outcomes (review finding I2)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — deferred retry-state advancement', () => {
  it('REVIEWER PROBE: an ambiguous parent on a DEFERRED unit advances its backoff', async () => {
    // Before the fix this produced `quarantined: 1` with ZERO store writes, so
    // next_attempt_at stayed in the past and listDue re-returned the row on
    // every subsequent run forever.
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-dup')]);
    const h = makeHarness({ records: [], store, products: { 'item-dup': [{ Id: 'p1' }, { Id: 'p2' }] } });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', quarantined: 1 });
    expect(store.touchAttempt).toHaveBeenCalledTimes(1);
    expect(store.touchAttempt).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-1', RUN_NOW);
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
  });

  it('REVIEWER PROBE: a DEFERRED unit whose upsert FAILS advances its backoff', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('Salesforce 503'));
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-1')]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] }, upsertImpl: upsert });

    const result = await h.run();

    expect(result).toMatchObject({ mode: 'executed', failed: 1, upserted: 0 });
    expect(store.touchAttempt).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-1', RUN_NOW);
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
  });

  it('a governance refusal on a deferred unit backs it off without deleting or changing its reason', async () => {
    const resolver = makeResolver({
      validateWrite: jest.fn().mockRejectedValue(
        new OwnershipViolationError({
          entity: 'serialized_asset',
          declaredOwner: 'salesforce',
          callerSystem: 'netsuite',
          conflictPolicy: 'reject_with_alert',
          correlationId: 'corr-1',
        }),
      ),
    });
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-1')]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] }, resolver });

    await h.run();

    expect(store.touchAttempt).toHaveBeenCalledTimes(1);
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
    // touchAttempt cannot change `reason` — upsertDeferred is the only writer
    // that could, and it must not be used for a non-deferral outcome.
    expect(store.upsertDeferred).not.toHaveBeenCalled();
  });

  // Codex merge-readiness review. This test previously asserted the OPPOSITE —
  // that a fresh unit's write failure "does not touch the store at all" — which
  // encoded a durability hole as if it were the contract. The sweep cursor is
  // persisted BEFORE the window is processed, so a fresh unit that failed to
  // write and left no deferred row was owed to Salesforce with no record of it
  // anywhere, and would not be reconsidered until the sweep wrapped the whole
  // source. If NetSuite dropped the unit before then, its Asset was never
  // created.
  it('a NON-deferred unit whose write fails is DEFERRED, so the debt survives the run', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('Salesforce 503'));
    const store = makeDeferredStore([]);
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      store,
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    await h.run();

    expect(store.upsertDeferred).toHaveBeenCalledTimes(1);
    expect(store.upsertDeferred).toHaveBeenCalledWith(
      expect.objectContaining({ inventoryNumberId: 'inv-1', reason: 'write_failed' }),
      expect.any(Date),
    );
    // touchAttempt is for rows that ALREADY existed; this one is new.
    expect(store.touchAttempt).not.toHaveBeenCalled();
  });

  it('the deferred row created by a failed write carries no serial number', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('Salesforce 503'));
    const store = makeDeferredStore([]);
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-SECRET-123', 'item-1')],
      store,
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    await h.run();

    // `reason` is a closed enum and the identifier is the inventory-number id,
    // never the serial. (The normalized payload legitimately holds the unit —
    // that column is the one decision-8 permits — so only the reason/id pair is
    // asserted here.)
    const [input] = (store.upsertDeferred as jest.Mock).mock.calls[0];
    expect(input.reason).toBe('write_failed');
    expect(input.inventoryNumberId).toBe('inv-1');
    expect(JSON.stringify({ r: input.reason, i: input.inventoryNumberId })).not.toContain('SN-SECRET-123');
  });

  it('an already-deferred unit that fails again backs off instead of re-inserting', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('Salesforce 503'));
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-1')]);
    const h = makeHarness({
      records: [],
      store,
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    await h.run();

    expect(store.touchAttempt).toHaveBeenCalledTimes(1);
    expect(store.upsertDeferred).not.toHaveBeenCalled();
  });

  it('a re-deferral still goes through upsertDeferred (which bumps the attempt itself), never double-bumping', async () => {
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-missing')]);
    const h = makeHarness({ records: [], store });

    await h.run();

    expect(store.upsertDeferred).toHaveBeenCalledTimes(1);
    expect(store.touchAttempt).not.toHaveBeenCalled();
  });

  it('a row at the attempt ceiling is abandoned: never dispatched, backed off once, and reported', async () => {
    const exhausted = { ...deferredRow('inv-1', 'SN-1', 'item-1'), attemptCount: 25 };
    const store = makeDeferredStore([exhausted]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run();

    // No API budget is consumed for a permanently-broken unit.
    expect(h.target.findProduct2ByExternalId).not.toHaveBeenCalled();
    expect(h.target.upsert).not.toHaveBeenCalled();
    // ...but its schedule still moves so listDue stops returning it every run.
    expect(store.touchAttempt).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-1', RUN_NOW);
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', quarantined: 1, retriesAttempted: 0 });
    expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('attempts_exhausted');
    expect((result as { failures: { category: string }[] }).failures).toEqual([
      expect.objectContaining({ category: 'attempts_exhausted' }),
    ]);
  });

  it('a row one attempt below the ceiling is still processed normally', async () => {
    const nearly = { ...deferredRow('inv-1', 'SN-1', 'item-1'), attemptCount: 23 };
    const store = makeDeferredStore([nearly]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run();

    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: 'executed', upserted: 1, quarantined: 0 });
  });

  it('REVIEWER PROBE-E: a FORCED retry dispatches a row past the attempt ceiling', async () => {
    // Decision 11's authenticated early-retry endpoint (Task 9) is the design's
    // ONLY operator remedy for a stuck unit. With the ceiling applied before the
    // due/forced distinction, that remedy was blocked and un-sticking a unit
    // would have needed a manual DB edit.
    const exhausted = { ...deferredRow('inv-1', 'SN-1', 'item-1'), attemptCount: 25 };
    const store = makeDeferredStore([exhausted]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ forceDeferredRetry: true });

    expect(store.listForRetry).toHaveBeenCalled();
    expect(h.target.upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: 'executed', upserted: 1, quarantined: 0, retriesAttempted: 1 });
    expect(h.metrics.recordRetryAttempted).toHaveBeenCalledWith('forced');
    expect(store.deleteSucceeded).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-1');
  });

  it('an ORDINARY run still refuses the same past-the-ceiling row', async () => {
    const exhausted = { ...deferredRow('inv-1', 'SN-1', 'item-1'), attemptCount: 25 };
    const store = makeDeferredStore([exhausted]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ forceDeferredRetry: false });

    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'executed', quarantined: 1, upserted: 0 });
    expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('attempts_exhausted');
  });

  // A corrupt durable row can never be dispatched, so no per-unit outcome path
  // can ever report it. Before the listings reported them, they were dropped
  // inside the repository and the run's counts said a clean zero — the backlog
  // held work no run would ever drain and nothing said so.
  describe('undecodable deferred rows', () => {
    const corrupt: UndecodableDeferredRow = {
      tenantId: TENANT,
      configurationId: CONFIG_ID,
      inventoryNumberId: 'inv-CORRUPT',
      attemptCount: 3,
    };

    function storeReporting(undecodable: UndecodableDeferredRow[], units: DeferredSerializedUnit[] = []) {
      const store = makeDeferredStore();
      store.listDue.mockResolvedValue(deferredPage(units, undecodable));
      store.listForRetry.mockResolvedValue(deferredPage(units, undecodable));
      return store;
    }

    it('quarantines the row, backs it off, and never dispatches it', async () => {
      const store = storeReporting([corrupt]);
      const h = makeHarness({ records: [], store });

      const result = await h.run();

      expect(h.target.findProduct2ByExternalId).not.toHaveBeenCalled();
      expect(h.target.upsert).not.toHaveBeenCalled();
      // Backed off, never deleted: the row is the only evidence of the corruption.
      expect(store.touchAttempt).toHaveBeenCalledWith(TENANT, CONFIG_ID, 'inv-CORRUPT', RUN_NOW);
      expect(store.deleteSucceeded).not.toHaveBeenCalled();
      expect(result).toMatchObject({ mode: 'executed', quarantined: 1, retriesAttempted: 0, upserted: 0 });
      expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('undecodable_payload');
      expect((result as { failures: { category: string }[] }).failures).toEqual([
        expect.objectContaining({ category: 'undecodable_payload' }),
      ]);
      expect(h.audit.logDataAccess).toHaveBeenCalledWith(
        expect.objectContaining({ dataType: 'serialized_asset_quarantine:undecodable_payload' }),
      );
    });

    it('reports the row by one-way digest only — never its raw key', async () => {
      const store = storeReporting([corrupt]);
      const h = makeHarness({ records: [], store });

      const result = await h.run();

      const [failure] = (result as { failures: { unitRef?: string }[] }).failures;
      expect(failure.unitRef).toMatch(/^[0-9a-f]{64}$/);
      expect(allObservedArgs(h)).not.toContain('inv-CORRUPT');
      expect(JSON.stringify(result)).not.toContain('inv-CORRUPT');
    });

    it('the healthy rows on the same page are still processed', async () => {
      const store = storeReporting([corrupt], [deferredRow('inv-1', 'SN-1', 'item-1')]);
      const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

      const result = await h.run();

      expect(h.target.upsert).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ mode: 'executed', upserted: 1, quarantined: 1 });
    });

    // The reason the back-off moved out of the repository: a read cannot know
    // the run mode, so it advanced retry state even during a preview.
    it('dryRun reports the row but advances no retry state and writes no audit row', async () => {
      const store = storeReporting([corrupt]);
      const h = makeHarness({ records: [], store });

      const result = await h.run({ dryRun: true });

      expect(result).toMatchObject({ mode: 'previewed', quarantined: 1 });
      expect(store.touchAttempt).not.toHaveBeenCalled();
      expect(store.upsertDeferred).not.toHaveBeenCalled();
      expect(h.audit.logDataAccess).not.toHaveBeenCalled();
    });

    it('a forced retry reports corrupt rows too — listForRetry is the operator remedy', async () => {
      const store = storeReporting([corrupt]);
      const h = makeHarness({ records: [], store });

      const result = await h.run({ forceDeferredRetry: true });

      expect(store.listForRetry).toHaveBeenCalled();
      expect(result).toMatchObject({ mode: 'executed', quarantined: 1 });
      expect(h.metrics.recordUnitQuarantined).toHaveBeenCalledWith('undecodable_payload');
    });

    it('a touchAttempt failure on a corrupt row never fails the run', async () => {
      const store = storeReporting([corrupt]);
      store.touchAttempt.mockRejectedValue(new Error('driver exploded'));
      const h = makeHarness({ records: [], store });

      const result = await h.run();

      expect(result).toMatchObject({ mode: 'executed', quarantined: 1 });
    });
  });

  it('dryRun never advances retry state via the ambiguous-parent path on a deferred unit', async () => {
    // This is one of only TWO paths that actually reach advanceDeferredAttempt
    // under dryRun. The upsert-failure path returns before writeUnit is ever
    // called, so it cannot exercise the guard.
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-dup')]);
    const h = makeHarness({ records: [], store, products: { 'item-dup': [{ Id: 'p1' }, { Id: 'p2' }] } });

    const result = await h.run({ dryRun: true });

    expect(result).toMatchObject({ mode: 'previewed', quarantined: 1 });
    expect(store.touchAttempt).not.toHaveBeenCalled();
    expect(store.upsertDeferred).not.toHaveBeenCalled();
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
  });

  it('dryRun never advances retry state via the attempts-exhausted path', async () => {
    // The second of the two paths that reach advanceDeferredAttempt under dryRun.
    const exhausted = { ...deferredRow('inv-1', 'SN-1', 'item-1'), attemptCount: 25 };
    const store = makeDeferredStore([exhausted]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] } });

    const result = await h.run({ dryRun: true });

    expect(result).toMatchObject({ mode: 'previewed', quarantined: 1 });
    expect(store.touchAttempt).not.toHaveBeenCalled();
  });

  it('dryRun never advances retry state on a failed upsert', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('Salesforce 503'));
    const store = makeDeferredStore([deferredRow('inv-1', 'SN-1', 'item-1')]);
    const h = makeHarness({ records: [], store, products: { 'item-1': [{ Id: 'p1' }] }, upsertImpl: upsert });

    await h.run({ dryRun: true });

    expect(store.touchAttempt).not.toHaveBeenCalled();
    expect(store.upsertDeferred).not.toHaveBeenCalled();
    expect(store.deleteSucceeded).not.toHaveBeenCalled();
  });

  it('a touchAttempt failure never fails the unit, and never logs the driver error', async () => {
    const CANARY = 'SECRET-SERIAL-CANARY-7100';
    const store = makeDeferredStore([deferredRow('inv-1', CANARY, 'item-dup')]);
    store.touchAttempt.mockRejectedValue(
      new Error(`DETAIL: Key (...) normalized_payload={"serialNumber":"${CANARY}"}`),
    );
    const h = makeHarness({ records: [], store, products: { 'item-dup': [{ Id: 'p1' }, { Id: 'p2' }] } });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      expect(result).toMatchObject({ mode: 'executed', quarantined: 1 });
      expect(allObservedArgs(h)).not.toContain(CANARY);
      expect(console_.serialized()).not.toContain(CANARY);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    } finally {
      console_.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Readiness re-check
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — runtime readiness re-check', () => {
  it('refuses the run when live readiness fails, before listing or writing anything', async () => {
    const h = makeHarness({ records: [sourceRecord('inv-1', 'SN-1', 'item-1')], readiness: makeReadiness(false) });

    await expect(h.run()).rejects.toBeInstanceOf(SerializedAssetRunNotReadyError);
    expect(h.source.list).not.toHaveBeenCalled();
    expect(h.target.upsert).not.toHaveBeenCalled();
    expect(h.metrics.recordReadinessFailure).toHaveBeenCalledWith('not_ready');
  });

  it('propagates an undeterminable readiness result as ServiceUnavailableAppError (503 contract)', async () => {
    const readiness = makeReadiness();
    readiness.evaluate.mockRejectedValue(new ServiceUnavailableAppError('tenant capability setting unavailable'));
    const h = makeHarness({ records: [], readiness });

    await expect(h.run()).rejects.toBeInstanceOf(ServiceUnavailableAppError);
    expect(h.metrics.recordReadinessFailure).toHaveBeenCalledWith('undeterminable');
  });

  it('REVIEWER PROBE: readiness inspects the SAME connector instance the write goes through', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    expect(h.readiness.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONFIG_ID }),
      { targetConnector: h.target },
    );
    // Identity, not shape: the gate protects decision 4's uniqueness assumption
    // for the write path, so it must be handed the very object `upsert` is
    // called on — a second connector resolved from the same references would
    // prove nothing if the two ever diverged.
    const passed = h.readiness.evaluate.mock.calls[0][1] as { targetConnector: unknown };
    expect(passed.targetConnector).toBe(h.target);
    expect(h.target.upsert).toHaveBeenCalledTimes(1);
  });

  it('evaluates readiness exactly once per run, no matter how many units the batch carries', async () => {
    const h = makeHarness({
      records: Array.from({ length: 12 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1')),
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();

    expect(h.readiness.evaluate).toHaveBeenCalledTimes(1);
    expect(h.target.upsert).toHaveBeenCalledTimes(12);
  });

  it('does not cache readiness across runs — a schema drift observed on the second run stops it', async () => {
    const h = makeHarness({
      records: [sourceRecord('inv-1', 'SN-1', 'item-1')],
      products: { 'item-1': [{ Id: 'p1' }] },
    });

    await h.run();
    h.readiness.evaluate.mockResolvedValue({
      ready: false,
      checkedAt: RUN_NOW.toISOString(),
      blockers: [{ code: 'field_not_unique', message: 'Asset.X is not unique' }],
      productExternalIdFields: [],
      assetExternalIdFields: [],
    });

    await expect(h.run()).rejects.toBeInstanceOf(SerializedAssetRunNotReadyError);
    expect(h.readiness.evaluate).toHaveBeenCalledTimes(2);
  });

  it('refuses a run whose actor tenant disagrees with the configuration tenant', async () => {
    const h = makeHarness({ records: [] });

    await expect(
      h.service.run({
        config: makeConfig({ tenantId: 'tenant-other' }),
        sourceConnector: h.source as unknown as IConnector,
        targetConnector: h.target as unknown as IConnector,
        options: { batchSize: 10, concurrency: 2, dryRun: false, forceDeferredRetry: false },
        actor: { tenantId: TENANT, userId: 'u', correlationId: 'c' },
      }),
    ).rejects.toBeInstanceOf(SerializedAssetRunRefusedError);
    expect(h.readiness.evaluate).not.toHaveBeenCalled();
  });

  it('refuses a target connector that lacks the Salesforce serialized-asset read capabilities', async () => {
    const h = makeHarness({ records: [] });
    const crippled = { ...h.target, describeSObject: undefined, findProduct2ByExternalId: undefined };

    await expect(
      h.service.run({
        config: makeConfig(),
        sourceConnector: h.source as unknown as IConnector,
        targetConnector: crippled as unknown as IConnector,
        options: { batchSize: 10, concurrency: 2, dryRun: false, forceDeferredRetry: false },
        actor: { tenantId: TENANT, userId: 'u', correlationId: 'c' },
      }),
    ).rejects.toThrow(/serialized-asset read capabilities/i);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — privacy canaries (decision 8)
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — decision 8 privacy canaries', () => {
  const SERIAL = 'SECRET-SERIAL-CANARY-7001';
  const INVENTORY = 'SECRET-INV-CANARY-7001';
  const ITEM = 'SECRET-ITEM-CANARY-7001';

  function assertNoCanary(h: Harness, extra: string[] = []): void {
    const observed = allObservedArgs(h);
    for (const canary of [SERIAL, INVENTORY, ITEM]) {
      expect(observed).not.toContain(canary);
      for (const blob of extra) {
        expect(blob).not.toContain(canary);
      }
    }
  }

  it('success path: no serial, inventory id, or item id reaches a logger, metric, or audit surface', async () => {
    const h = makeHarness({
      records: [sourceRecord(INVENTORY, SERIAL, ITEM)],
      products: { [ITEM]: [{ Id: 'p1' }] },
    });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      // The outbound connector payload legitimately carries the serial
      // (decision 8's one permitted exception) — nothing else may.
      expect(h.target.upsert).toHaveBeenCalledTimes(1);
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('deferral path: the persisted reason and every diagnostic stay canary-free', async () => {
    const h = makeHarness({ records: [sourceRecord(INVENTORY, SERIAL, ITEM)] });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      // The normalized payload column is the design-approved exception; the
      // reason column is a closed enum and must never carry unit data.
      const call = h.store.upsertDeferred.mock.calls[0][0] as DeferredSerializedUnitInput;
      expect(call.reason).toBe('parent_missing');
      expect(JSON.stringify(call.reason)).not.toContain(SERIAL);
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('invalid-shape path: neither the record hash pairing nor the audit event leaks unit data', async () => {
    const bad: DataRecord = {
      id: INVENTORY,
      externalId: '',
      fields: { item: { id: ITEM } }, // no serial → missing_required_field
      metadata: {},
    };
    const h = makeHarness({ records: [bad] });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('ambiguous and conflicting-duplicate quarantines stay canary-free', async () => {
    const h = makeHarness({
      records: [sourceRecord(INVENTORY, SERIAL, ITEM), sourceRecord(`${INVENTORY}-b`, SERIAL, ITEM)],
      products: { [ITEM]: [{ Id: 'p1' }, { Id: 'p2' }] },
    });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('write-failure path: a connector error echoing the serial never reaches a log or the result', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error(`Salesforce rejected ${SERIAL} for ${INVENTORY}`));
    const h = makeHarness({
      records: [sourceRecord(INVENTORY, SERIAL, ITEM)],
      products: { [ITEM]: [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      expect(result).toMatchObject({ failed: 1 });
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('deferral-persistence failure: a driver error echoing the whole row never reaches a log', async () => {
    const store = makeDeferredStore();
    // Mirrors the Postgres CHECK/unique violation DETAIL, which embeds the
    // entire failing row — including normalized_payload with the serial.
    store.upsertDeferred.mockRejectedValue(
      new Error(`duplicate key ... DETAIL: Key (...)=(${INVENTORY}) ... normalized_payload={"serialNumber":"${SERIAL}"}`),
    );
    const h = makeHarness({ records: [sourceRecord(INVENTORY, SERIAL, ITEM)], store });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      expect(store.upsertDeferred).toHaveBeenCalledTimes(2); // one retry, then give up
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('connection-wide failure: the thrown run error carries no unit data', async () => {
    const source = makeSourceConnector([]);
    source.list.mockRejectedValue(new Error(`NetSuite rejected batch containing ${SERIAL}`));
    const h = makeHarness({ source });

    const console_ = spyOnConsole();
    let caught: unknown;
    try {
      await h.run();
    } catch (error) {
      caught = error;
    } finally {
      console_.restore();
    }

    expect(caught).toBeInstanceOf(SerializedAssetRunStageError);
    expect((caught as Error).message).not.toContain(SERIAL);
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(SERIAL);
    assertNoCanary(h, [console_.serialized()]);
  });

  it('governance-rejection path stays canary-free', async () => {
    const resolver = makeResolver({
      validateWrite: jest.fn().mockRejectedValue(
        new OwnershipViolationError({
          entity: 'serialized_asset',
          declaredOwner: 'salesforce',
          callerSystem: 'netsuite',
          conflictPolicy: 'reject_with_alert',
          correlationId: 'corr-1',
        }),
      ),
    });
    const h = makeHarness({
      records: [sourceRecord(INVENTORY, SERIAL, ITEM)],
      products: { [ITEM]: [{ Id: 'p1' }] },
      resolver,
    });

    const console_ = spyOnConsole();
    try {
      const result = await h.run();
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });

  it('dry-run path stays canary-free', async () => {
    const h = makeHarness({
      records: [sourceRecord(INVENTORY, SERIAL, ITEM)],
      products: { [ITEM]: [{ Id: 'p1' }] },
    });

    const console_ = spyOnConsole();
    try {
      const result = await h.run({ dryRun: true });
      assertNoCanary(h, [console_.serialized(), JSON.stringify(result)]);
    } finally {
      console_.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded execution
// ---------------------------------------------------------------------------

describe('SerializedAssetSyncService.run — bounded execution', () => {
  it('clamps a hostile batch size and concurrency instead of trusting the caller', async () => {
    const h = makeHarness({ records: [] });

    await h.run({ batchSize: 10_000_000, concurrency: -5 });

    const listLimit = (h.source.list.mock.calls[0][1] as { limit: number }).limit;
    expect(listLimit).toBeLessThanOrEqual(1000);
    expect(listLimit).toBeGreaterThan(0);
    expect(h.store.listDue).toHaveBeenCalledWith(TENANT, CONFIG_ID, RUN_NOW, listLimit);
  });

  it('never exceeds the configured concurrency while processing units', async () => {
    let inFlight = 0;
    let peak = 0;
    const upsert = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { outcome: 'created' };
    });
    const h = makeHarness({
      records: Array.from({ length: 10 }, (_, i) => sourceRecord(`inv-${i}`, `SN-${i}`, 'item-1')),
      products: { 'item-1': [{ Id: 'p1' }] },
      upsertImpl: upsert,
    });

    await h.run({ concurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
    expect(upsert).toHaveBeenCalledTimes(10);
  });

  it('rejects a configuration that is not a ready netsuite_serialized_asset profile', async () => {
    const h = makeHarness({ records: [] });
    const broken = makeConfig({ executionProfile: 'standard' });

    await expect(h.run({}, broken)).rejects.toThrow(/netsuite_serialized_asset/i);
    expect(h.readiness.evaluate).not.toHaveBeenCalled();
  });
});
