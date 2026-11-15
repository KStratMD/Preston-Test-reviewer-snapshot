import '../../setupEnv'; // Must be first to configure environment
import { runSuiteCentralNetSuiteSync } from '../../../../src/integrations/SuiteCentralNetSuiteSync';
import { guardedWrite } from '../../../../src/governance/sourceOfTruth/guardedWrite';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';
import type { IntegrationService } from '../../../../src/services/IntegrationService';
import type { DataRecord } from '../../../../src/types';
import { suiteCentralToNetSuiteCustomerMappings } from '../../../../src/mappings/customerMappings';

// PR 13b (#851) routes every NetSuite mutation in this flow through
// guardedWrite, and the canonical manifest declares `customer` owned by
// netsuite with reject_with_alert — so the mapping/CRUD mechanics this suite
// pins are only reachable under an allow decision. Stub guardedWrite as a
// pass-through spy: ownership-blocking semantics are covered by
// tests/integration/guardedWrite.endToEnd.test.ts; here we keep the original
// mapping + CRUD assertions AND pin that writes still route through the
// chokepoint.
jest.mock('../../../../src/governance/sourceOfTruth/guardedWrite', () => ({
  ...jest.requireActual('../../../../src/governance/sourceOfTruth/guardedWrite'),
  guardedWrite: jest.fn(
    async (op: import('../../../../src/governance/sourceOfTruth/guardedWrite').GuardedWriteArgs<unknown>) => op.do(),
  ),
}));

// Track mock instances
const suiteCentralMockInstances: any[] = [];
const netSuiteMockInstances: any[] = [];

// Mock connectors at module level
jest.mock('../../../../src/connectors/SuiteCentralConnector', () => ({
  SuiteCentralConnector: jest.fn().mockImplementation(() => {
    // Pre-populate with test data that matches what the test expects
    const initialRecords: DataRecord[] = [
      {
        id: 'sc-1',
        fields: {
          name: 'Central Supplies',
          email: 'info@central.com',
          phone: '+1-555-1000',
        },
      },
      {
        id: 'sc-2',
        fields: {
          name: 'Global Industries',
          email: 'sales@global.com',
          phone: '+1-555-2000',
        },
      },
    ];
    const store: DataRecord[] = [...initialRecords];
    const instance = {
      initialize: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation(async (_entity: string, record: DataRecord) => {
        store.push(record);
        return record;
      }),
      list: jest.fn().mockImplementation(async (_entity: string) => [...store]),
    };
    suiteCentralMockInstances.push(instance);
    return instance;
  }),
}));

jest.mock('../../../../src/connectors/NetSuiteConnector', () => ({
  NetSuiteConnector: jest.fn().mockImplementation(() => {
    const instance = {
      initialize: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation(async (_entity: string, record: DataRecord) => {
        if ((record.fields as any).name === 'Global Industries') {
          throw new Error('NS create failed');
        }
        return { ...record, id: `NS_${record.id}` } as DataRecord;
      }),
      read: jest.fn().mockImplementation(async (_entity: string, id: string) => ({ id, fields: {} })),
      update: jest.fn().mockImplementation(async (_entity: string, _id: string, rec: DataRecord) => rec),
      delete: jest.fn().mockResolvedValue(true),
    };
    netSuiteMockInstances.push(instance);
    return instance;
  }),
}));

describe('SuiteCentralNetSuiteSync', () => {
  beforeEach(() => {
    suiteCentralMockInstances.length = 0;
    netSuiteMockInstances.length = 0;
    jest.clearAllMocks();
  });

  it('maps fields, performs CRUD, and handles errors', async () => {
    const integrationService = { recordSyncResult: jest.fn() } as unknown as IntegrationService;
    const result = await runSuiteCentralNetSuiteSync(integrationService);

    // Get the mock instances created during the test
    const suiteCentralMock = suiteCentralMockInstances[0];
    const netSuiteMock = netSuiteMockInstances[0];

    expect(suiteCentralMock).toBeDefined();
    expect(netSuiteMock).toBeDefined();

    expect(suiteCentralToNetSuiteCustomerMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceField: 'name', targetField: 'name' }),
      ]),
    );

    // SuiteCentral only lists records (doesn't create in this flow)
    expect(suiteCentralMock.list).toHaveBeenCalledTimes(1);

    // NetSuite: 2 create attempts, but only 1 succeeds (Global Industries fails)
    // Only successful records proceed through read, update, delete
    expect(netSuiteMock.create).toHaveBeenCalledTimes(2);
    expect(netSuiteMock.read).toHaveBeenCalledTimes(1); // Only for successful record
    expect(netSuiteMock.update).toHaveBeenCalledTimes(1); // Only for successful record
    expect(netSuiteMock.delete).toHaveBeenCalledTimes(1); // Only for successful record

    // Verify NetSuite received the transformed records
    expect(netSuiteMock.create).toHaveBeenNthCalledWith(
      1,
      'customers',
      expect.objectContaining({
        fields: expect.objectContaining({
          name: 'Central Supplies',
          email: 'info@central.com',
        }),
      }),
    );
    expect(netSuiteMock.create).toHaveBeenNthCalledWith(
      2,
      'customers',
      expect.objectContaining({
        fields: expect.objectContaining({
          name: 'Global Industries',
          email: 'sales@global.com',
        }),
      }),
    );

    // The flow still routes every NetSuite mutation through the guardedWrite
    // chokepoint: record 1 (success) → create+update+delete, record 2 →
    // create (throws inside the guarded op). Reads are intentionally
    // unguarded.
    const guarded = jest.mocked(guardedWrite);
    expect(guarded).toHaveBeenCalledTimes(4);
    for (const [op] of guarded.mock.calls) {
      expect(op.context).toMatchObject({
        tenantId: SYSTEM_IDENTITY.tenantId,
        requesterUserId: SYSTEM_IDENTITY.userId,
        callerSystem: 'squire',
        targetSystem: 'netsuite',
        entity: 'customer',
      });
    }
    // Operation sequence pins which mutations are guarded, in order.
    expect(guarded.mock.calls.map(([op]) => op.context.operation)).toEqual([
      'create',
      'update',
      'delete',
      'create',
    ]);

    // Verify sync result - one record fails (Global Industries), one succeeds
    expect(result).toMatchObject({
      integrationId: 'suitecentral-netsuite',
      recordsProcessed: 2,
      recordsSuccessful: 1,
      recordsFailed: 1,
      status: 'partial',
      success: false,
      errors: ['NS create failed'],
    });
  });
});

