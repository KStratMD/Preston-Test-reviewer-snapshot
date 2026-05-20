import '../../setupEnv'; // Must be first to configure environment
import { runSuiteCentralNetSuiteSync } from '../../../../src/integrations/SuiteCentralNetSuiteSync';
import type { IntegrationService } from '../../../../src/services/IntegrationService';
import type { DataRecord } from '../../../../src/types';
import { suiteCentralToNetSuiteCustomerMappings } from '../../../../src/mappings/customerMappings';

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

