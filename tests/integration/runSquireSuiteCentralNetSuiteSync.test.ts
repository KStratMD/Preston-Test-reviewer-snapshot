import './setupEnv'; // Must be first to configure environment
import { runSquireSuiteCentralNetSuiteSync } from '../../src/integrations/SquireSuiteCentralNetSuiteSync';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { SuiteCentralConnector } from '../../src/connectors/SuiteCentralConnector';
import type { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import type { IntegrationService } from '../../src/services/IntegrationService';
import type { DataRecord } from '../../src/types';

let squireConnectorMock: any;
let suiteCentralConnectorMock: any;
let netSuiteConnectorMock: any;

// PR 13b (#851) routes the NetSuite stage's mutations through guardedWrite
// (via runSuiteCentralNetSuiteSync), and the canonical manifest declares
// `customer` owned by netsuite with reject_with_alert — so this two-stage
// aggregation flow is only reachable under an allow decision. Stub
// guardedWrite as a pass-through: ownership-blocking semantics are covered
// by tests/integration/guardedWrite.endToEnd.test.ts.
jest.mock('../../src/governance/sourceOfTruth/guardedWrite', () => ({
  ...jest.requireActual('../../src/governance/sourceOfTruth/guardedWrite'),
  guardedWrite: jest.fn(
    async (op: import('../../src/governance/sourceOfTruth/guardedWrite').GuardedWriteArgs<unknown>) => op.do(),
  ),
}));

jest.mock('../../src/connectors/SquireConnector', () => ({
  SquireConnector: jest.fn().mockImplementation(() => squireConnectorMock),
}));

jest.mock('../../src/connectors/SuiteCentralConnector', () => ({
  SuiteCentralConnector: jest.fn().mockImplementation(() => suiteCentralConnectorMock),
}));

jest.mock('../../src/connectors/NetSuiteConnector', () => ({
  NetSuiteConnector: jest.fn().mockImplementation(() => netSuiteConnectorMock),
}));

describe('runSquireSuiteCentralNetSuiteSync integration', () => {
  let suiteCentralMock: {
    initialize: jest.Mock;
    create: jest.Mock;
    list: jest.Mock;
  };
  let netSuiteMock: {
    initialize: jest.Mock;
    create: jest.Mock;
    read: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let squireMock: {
    initialize: jest.Mock;
    list: jest.Mock;
  };

  beforeEach(() => {
    container.snapshot();
    const store: DataRecord[] = [];

    suiteCentralMock = {
      initialize: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation(async (_entity: string, record: DataRecord) => {
        store.push(record);
        return record;
      }),
      list: jest.fn().mockImplementation(async (_entity: string) => store),
    };

    netSuiteMock = {
      initialize: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation(async (_entity: string, record: DataRecord) => {
        if ((record.fields as any).name === 'Global Technology Partners') {
          throw new Error('NS create failed');
        }
        return { ...record, id: `NS_${record.id ?? record.externalId}` } as DataRecord;
      }),
      read: jest.fn().mockResolvedValue({ id: 'mock', fields: {} }),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(true),
    };

    squireMock = {
      initialize: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([
        {
          id: 'SQ_CUST_001',
          companyName: 'Acme Manufacturing Inc',
          contactEmail: 'procurement@acme.com',
          primaryPhone: '555-123-0001',
          mailingAddress: '123 Industrial Parkway, Seattle, WA 98101',
        },
        {
          id: 'SQ_CUST_002',
          companyName: 'Global Technology Partners',
          contactEmail: 'ops@globaltech.com',
          primaryPhone: '555-123-0002',
          mailingAddress: '400 Innovation Way, San Jose, CA 95134',
        },
        {
          id: 'SQ_CUST_003',
          companyName: 'Northwind Traders',
          contactEmail: 'finance@northwind.com',
          primaryPhone: '555-123-0003',
          mailingAddress: '200 Market Street, Portland, OR 97201',
        },
      ]),
    };

    suiteCentralConnectorMock = suiteCentralMock;
    netSuiteConnectorMock = netSuiteMock;
    squireConnectorMock = squireMock;

    container
      .rebind<SuiteCentralConnector>(TYPES.SuiteCentralConnector)
      .toConstantValue(suiteCentralMock as unknown as SuiteCentralConnector);
    container
      .rebind<NetSuiteConnector>(TYPES.NetSuiteConnector)
      .toConstantValue(netSuiteMock as unknown as NetSuiteConnector);
    container
      .rebind<any>(TYPES.SquireConnector)
      .toConstantValue(squireMock);
  });

  afterEach(() => {
    container.restore();
    jest.clearAllMocks();
  });

  it('passes records through both stages and aggregates results', async () => {
    const integrationService = { recordSyncResult: jest.fn() } as unknown as IntegrationService;

    const result = await runSquireSuiteCentralNetSuiteSync(integrationService);

    expect(suiteCentralMock.initialize).toHaveBeenCalledTimes(1);
    expect(suiteCentralMock.create).toHaveBeenCalledTimes(3);
    expect(suiteCentralMock.list).toHaveBeenCalledTimes(1);

    expect(netSuiteMock.create).toHaveBeenCalledTimes(3);

    expect(suiteCentralMock.create).toHaveBeenNthCalledWith(
      1,
      'customers',
      expect.objectContaining({
        externalId: 'SQ_CUST_001',
        fields: {
          name: 'Acme Manufacturing Inc',
          email: 'procurement@acme.com',
          phone: '555-123-0001',
          address: '123 Industrial Parkway, Seattle, WA 98101',
        },
      }),
    );

    expect(netSuiteMock.create).toHaveBeenNthCalledWith(
      1,
      'customers',
      expect.objectContaining({
        fields: {
          name: 'Acme Manufacturing Inc',
          email: 'procurement@acme.com',
          phone: '555-123-0001',
        },
      }),
    );

    expect(result).toMatchObject({
      integrationId: 'squire-suitecentral-netsuite',
      status: 'partial',
      success: false,
      recordsProcessed: 6,
      recordsSuccessful: 5,
      recordsFailed: 1,
      errors: ['NS create failed'],
    });
  });
});

