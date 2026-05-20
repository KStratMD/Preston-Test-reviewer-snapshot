import { runSquireSuiteCentralSync } from './SquireSuiteCentralSync';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SquireConnector } from '../connectors/SquireConnector';
import type { SuiteCentralConnector } from '../connectors/SuiteCentralConnector';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { IntegrationService } from '../services/IntegrationService';
import type { DataRecord } from '../types';
import { squireToSuiteCentralCustomerMappings } from '../mappings/customerMappings';

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
      return {};
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
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