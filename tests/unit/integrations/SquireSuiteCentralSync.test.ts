import { runSquireSuiteCentralSync } from '../../../src/integrations/SquireSuiteCentralSync';
import { TransformationFailedError } from '../../../src/services/TransformationEngine';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import type { DataRecord } from '../../../src/types';
import { squireToSuiteCentralCustomerMappings } from '../../../src/mappings/customerMappings';
import {
  createMockOwnershipResolver,
  createMockAuditService,
  createMockApprovalQueueService,
} from '../../governanceTestUtils';

describe('SquireSuiteCentralSync', () => {
  let mockSquire: any;
  let mockSuiteCentral: any;
  let mockTransformer: any;
  let mockIntegrationService: any;

  beforeEach(() => {
    // Create mock connectors with proper method signatures
    mockSquire = {
      initialize: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    mockSuiteCentral = {
      initialize: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    mockTransformer = {
      transformRecord: jest.fn(),
    };

    mockIntegrationService = {
      recordSyncResult: jest.fn(),
      getSyncHistory: jest.fn(),
      getSyncStatus: jest.fn(),
    };

    // Mock container resolution
    jest.spyOn(container, 'get').mockImplementation((token) => {
      if (token === TYPES.SquireConnector) return mockSquire;
      if (token === TYPES.SuiteCentralConnector) return mockSuiteCentral;
      if (token === TYPES.TransformationEngine) return mockTransformer;
      if (token === TYPES.AuditService) return createMockAuditService();
      return {};
    });
    // PR 13b Stage A3: SquireSuiteCentralSync now resolves the guardedWrite
    // governance trio. OwnershipResolver + ApprovalQueueService are
    // async-bound, so the test must mock getAsync alongside get.
    jest.spyOn(container, 'getAsync').mockImplementation(async (token) => {
      if (token === TYPES.OwnershipResolver) return createMockOwnershipResolver();
      if (token === TYPES.ApprovalQueueService) return createMockApprovalQueueService();
      return {};
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('counts a record whose transformation fails closed as failed and never writes it (Task A2)', async () => {
    // TransformationEngine.transformRecord() now throws TransformationFailedError
    // instead of returning partial fields. The sync's per-record catch must
    // turn that into one counted failure and skip THAT record's guarded write.
    const customers = [1, 2, 3].map((n) => ({
      id: `cust-${n}`,
      fields: { companyName: `Company ${n}`, contactEmail: `c${n}@example.com` },
    })) as unknown as DataRecord[];
    mockSquire.list.mockResolvedValue(customers);
    mockTransformer.transformRecord.mockImplementation(async (source: any) => {
      if (source.id === 'cust-2') {
        throw new TransformationFailedError([
          { field: 'parts', message: "transformationType 'split' is declared but not executable (mapping companyName)", severity: 'error' },
        ]);
      }
      return { externalId: source.id, name: source.fields?.companyName };
    });
    mockSuiteCentral.create.mockResolvedValue({} as DataRecord);

    const result = await runSquireSuiteCentralSync(mockIntegrationService);

    expect(mockSuiteCentral.create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'partial', recordsProcessed: 3, recordsSuccessful: 2, recordsFailed: 1 });
    expect(result.errors).toEqual([expect.stringMatching(/declared but not executable/)]);
  });
  it('maps Squire customer fields to SuiteCentral schema', async () => {
    // Mock Squire customer data in the correct format
    const squireCustomers: DataRecord[] = [
      {
        id: 'SQ_CUST_001',
        fields: {
          companyName: 'Acme Manufacturing Inc',
          contactEmail: 'procurement@acme.com',
          primaryPhone: '555-123-0001',
          mailingAddress: '123 Industrial Parkway, Seattle, WA 98101'
        }
      },
      {
        id: 'SQ_CUST_002',
        fields: {
          companyName: 'Globex Corporation',
          contactEmail: 'orders@globex.com',
          primaryPhone: '555-456-0002',
          mailingAddress: '456 Business Blvd, New York, NY 10001'
        }
      },
      {
        id: 'SQ_CUST_003',
        fields: {
          companyName: 'Initech Solutions',
          contactEmail: 'purchasing@initech.com',
          primaryPhone: '555-789-0003',
          mailingAddress: '789 Tech Street, Austin, TX 73301'
        }
      }
    ];

    mockSquire.list.mockResolvedValue(squireCustomers);
    
    // Mock transformation to return expected fields
    mockTransformer.transformRecord.mockImplementation(async (source: any) => {
      // Return the transformed data as expected by the sync function
      return {
        externalId: source.id,
        name: source.fields?.companyName,
        email: source.fields?.contactEmail,
        phone: source.fields?.primaryPhone,
        address: source.fields?.mailingAddress
      };
    });

    mockSuiteCentral.create.mockResolvedValue({} as DataRecord);

    // Run the sync
    const result = await runSquireSuiteCentralSync(mockIntegrationService);

    // Verify the mappings structure
    expect(squireToSuiteCentralCustomerMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceField: 'id', targetField: 'externalId' }),
      ]),
    );

    // Verify that the sync was attempted
    expect(mockSquire.list).toHaveBeenCalledWith('customers');
    expect(mockSuiteCentral.create).toHaveBeenCalledTimes(3);
    
    // Verify the result has the expected structure
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('recordsProcessed', 3);
    expect(result).toHaveProperty('recordsSuccessful', 3);
  });
});