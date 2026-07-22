import { ConnectorCredentialService, CredentialTestResult, ConnectorCredentialWithDecrypted } from '../../../src/services/ConnectorCredentialService';
import { CredentialEncryption } from '../../../src/utils/CredentialEncryption';

// Mock CredentialEncryption
jest.mock('../../../src/utils/CredentialEncryption', () => ({
  CredentialEncryption: {
    encrypt: jest.fn((data) => JSON.stringify({ encrypted: true, data })),
    decrypt: jest.fn((data) => {
      const parsed = JSON.parse(data);
      return parsed.data;
    }),
    isKeyConfigured: jest.fn(() => true)
  }
}));

describe('ConnectorCredentialService', () => {
  let service: ConnectorCredentialService;
  let mockDbService: any;
  let mockLogger: any;
  let mockDb: any;
  let mockQueryBuilder: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock query builder with chainable methods
    mockQueryBuilder = {
      selectFrom: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      selectAll: jest.fn().mockReturnThis(),
      insertInto: jest.fn().mockReturnThis(),
      updateTable: jest.fn().mockReturnThis(),
      deleteFrom: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      returningAll: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(null),
      executeTakeFirstOrThrow: jest.fn().mockResolvedValue({})
    };

    mockDb = {
      selectFrom: jest.fn(() => mockQueryBuilder),
      insertInto: jest.fn(() => mockQueryBuilder),
      updateTable: jest.fn(() => mockQueryBuilder),
      deleteFrom: jest.fn(() => mockQueryBuilder)
    };

    mockDbService = {
      getDatabase: jest.fn(() => mockDb)
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    service = new ConnectorCredentialService(mockDbService, mockLogger);
  });

  describe('constructor', () => {
    it('should initialize with database service', () => {
      expect(service).toBeDefined();
      expect(mockDbService.getDatabase).toHaveBeenCalled();
    });
  });

  describe('storeCredentials', () => {
    const userId = 1;
    const connectorId = 'salesforce';
    const connectorName = 'Salesforce CRM';
    const credentials = { apiKey: 'test-key', secret: 'test-secret' };
    const credentialType = 'oauth2';

    it('should store new credentials successfully', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        connector_name: connectorName,
        environment: 'production',
        credential_type: credentialType,
        encrypted_credentials: 'encrypted-data',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null); // No existing record
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(storedRecord);

      const result = await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType
      );

      expect(result).toBeDefined();
      expect(CredentialEncryption.encrypt).toHaveBeenCalledWith(credentials);
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credentials');
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should update existing credentials', async () => {
      const existingRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'Old Name',
        environment: 'production',
        credential_type: 'api_key',
        encrypted_credentials: 'old-encrypted',
        is_active: true
      };

      const updatedRecord = {
        ...existingRecord,
        connector_name: connectorName,
        credential_type: credentialType,
        encrypted_credentials: 'new-encrypted'
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(existingRecord);
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(updatedRecord);

      const result = await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType
      );

      expect(result).toBeDefined();
      expect(mockDb.updateTable).toHaveBeenCalledWith('connector_credentials');
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Updated credentials'));
    });

    it('should throw error if encryption key not configured', async () => {
      (CredentialEncryption.isKeyConfigured as jest.Mock).mockReturnValue(false);

      await expect(
        service.storeCredentials(userId, connectorId, connectorName, credentials, credentialType)
      ).rejects.toThrow('ENCRYPTION_KEY not configured');

      // Reset mock
      (CredentialEncryption.isKeyConfigured as jest.Mock).mockReturnValue(true);
    });

    it('should store credentials with organization ID', async () => {
      const organizationId = 100;
      const storedRecord = {
        id: 1,
        user_id: userId,
        organization_id: organizationId,
        connector_id: connectorId
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(storedRecord);

      await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType,
        'production',
        organizationId
      );

      expect(mockQueryBuilder.values).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: organizationId })
      );
    });

    it('should store credentials with custom environment', async () => {
      const environment = 'sandbox';
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        environment
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue(storedRecord);

      await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType,
        environment
      );

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('environment', '=', environment);
    });

    it('should log audit trail on store', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue({ id: 1 });

      await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType
      );

      // Audit log insert should be called
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });

    it('should handle store error and log audit', async () => {
      const error = new Error('Database error');
      mockQueryBuilder.executeTakeFirst.mockRejectedValue(error);

      await expect(
        service.storeCredentials(userId, connectorId, connectorName, credentials, credentialType)
      ).rejects.toThrow('Database error');

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should redact credentials in audit logs', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      mockQueryBuilder.executeTakeFirstOrThrow.mockResolvedValue({ id: 1 });

      await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        credentials,
        credentialType
      );

      // Check that audit log values don't contain actual credentials
      const insertCalls = mockQueryBuilder.values.mock.calls;
      const auditCall = insertCalls.find(
        (call: any[]) => call[0]?.action === 'create' && call[0]?.new_values
      );

      if (auditCall) {
        expect(auditCall[0].new_values.credentials).toBe('[REDACTED]');
      }
    });
  });

  describe('getCredentials', () => {
    const userId = 1;
    const connectorId = 'netsuite';

    it('should retrieve and decrypt credentials', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite',
        environment: 'production',
        encrypted_credentials: JSON.stringify({ encrypted: true, data: { apiKey: 'secret' } }),
        credential_type: 'oauth1',
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      const result = await service.getCredentials(userId, connectorId);

      expect(result).toBeDefined();
      expect(result?.credentials).toBeDefined();
      expect(CredentialEncryption.decrypt).toHaveBeenCalled();
    });

    it('should return null if credentials not found', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      const result = await service.getCredentials(userId, connectorId);

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('No credentials found'));
    });

    it('should update last_used_at on access', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.getCredentials(userId, connectorId);

      expect(mockDb.updateTable).toHaveBeenCalledWith('connector_credentials');
      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ last_used_at: expect.any(Date) })
      );
    });

    it('should log access to audit trail', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.getCredentials(userId, connectorId);

      // Audit log insert should be called
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });

    it('should retrieve credentials for specific environment', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        environment: 'sandbox',
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.getCredentials(userId, connectorId, 'sandbox');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('environment', '=', 'sandbox');
    });

    it('should only return active credentials', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.getCredentials(userId, connectorId);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('is_active', '=', true);
    });

    it('should exclude encrypted_credentials from returned object', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: { apiKey: 'test' } }),
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      const result = await service.getCredentials(userId, connectorId);

      expect(result).not.toHaveProperty('encrypted_credentials');
      expect(result).toHaveProperty('credentials');
    });

    it('should handle decryption errors', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: 'invalid-data',
        is_active: true,
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);
      (CredentialEncryption.decrypt as jest.Mock).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      await expect(service.getCredentials(userId, connectorId)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();

      // Reset mock
      (CredentialEncryption.decrypt as jest.Mock).mockImplementation((data) => {
        const parsed = JSON.parse(data);
        return parsed.data;
      });
    });
  });

  describe('listCredentials', () => {
    const userId = 1;

    it('should list all active credentials for user', async () => {
      const credentials = [
        { id: 1, connector_id: 'salesforce', environment: 'production' },
        { id: 2, connector_id: 'netsuite', environment: 'production' }
      ];

      mockQueryBuilder.execute.mockResolvedValue(credentials);

      const result = await service.listCredentials(userId);

      expect(result).toHaveLength(2);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('user_id', '=', userId);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('is_active', '=', true);
    });

    it('should list all credentials including inactive', async () => {
      const credentials = [
        { id: 1, connector_id: 'salesforce', is_active: true },
        { id: 2, connector_id: 'netsuite', is_active: false }
      ];

      mockQueryBuilder.execute.mockResolvedValue(credentials);

      const result = await service.listCredentials(userId, false);

      expect(result).toHaveLength(2);
    });

    it('should order results by connector_id and environment', async () => {
      mockQueryBuilder.execute.mockResolvedValue([]);

      await service.listCredentials(userId);

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('connector_id', 'asc');
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('environment', 'asc');
    });

    it('should not include encrypted_credentials in list', async () => {
      mockQueryBuilder.execute.mockResolvedValue([]);

      await service.listCredentials(userId);

      const selectCalls = mockQueryBuilder.select.mock.calls;
      if (selectCalls.length > 0) {
        const selectedFields = selectCalls[0][0];
        expect(selectedFields).not.toContain('encrypted_credentials');
      }
    });

    it('should handle empty result', async () => {
      mockQueryBuilder.execute.mockResolvedValue([]);

      const result = await service.listCredentials(userId);

      expect(result).toEqual([]);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Listed 0 credentials'));
    });
  });

  describe('deleteCredentials', () => {
    const userId = 1;
    const connectorId = 'hubspot';

    it('should delete existing credentials', async () => {
      const existingRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'HubSpot',
        credential_type: 'api_key',
        environment: 'production',
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(existingRecord);

      const result = await service.deleteCredentials(userId, connectorId);

      expect(result).toBe(true);
      expect(mockDb.deleteFrom).toHaveBeenCalledWith('connector_credentials');
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Deleted credentials'));
    });

    it('should return false if credentials not found', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      const result = await service.deleteCredentials(userId, connectorId);

      expect(result).toBe(false);
      expect(mockDb.deleteFrom).not.toHaveBeenCalled();
    });

    it('should log deletion to audit trail', async () => {
      const existingRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'HubSpot',
        credential_type: 'api_key',
        environment: 'production',
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(existingRecord);

      await service.deleteCredentials(userId, connectorId);

      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });

    it('should delete credentials for specific environment', async () => {
      const existingRecord = {
        id: 1,
        connector_id: connectorId,
        environment: 'sandbox',
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(existingRecord);

      await service.deleteCredentials(userId, connectorId, 'sandbox');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('environment', '=', 'sandbox');
    });

    it('should handle delete error', async () => {
      const existingRecord = { id: 1, organization_id: null };
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(existingRecord);
      mockQueryBuilder.execute.mockRejectedValue(new Error('Delete failed'));

      await expect(service.deleteCredentials(userId, connectorId)).rejects.toThrow('Delete failed');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('testCredentials', () => {
    const userId = 1;
    const connectorId = 'shipstation';

    it('should test credentials successfully', async () => {
      const storedRecord = {
        id: 1,
        user_id: userId,
        connector_id: connectorId,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: { apiKey: 'valid' } }),
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      const result = await service.testCredentials(userId, connectorId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('valid');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return failure if credentials not found', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      const result = await service.testCredentials(userId, connectorId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No credentials found');
    });

    it('should update last_tested_at on success', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: { apiKey: 'test' } }),
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.testCredentials(userId, connectorId);

      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          last_tested_at: expect.any(Date),
          last_test_status: 'success',
          last_test_error: null
        })
      );
    });

    it('should update last_test_error on failure', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: 'invalid',
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);
      (CredentialEncryption.decrypt as jest.Mock).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const result = await service.testCredentials(userId, connectorId);

      expect(result.success).toBe(false);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          last_test_status: 'failed',
          last_test_error: expect.any(String)
        })
      );

      // Reset mock
      (CredentialEncryption.decrypt as jest.Mock).mockImplementation((data) => {
        const parsed = JSON.parse(data);
        return parsed.data;
      });
    });

    it('should log test to audit trail', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.testCredentials(userId, connectorId);

      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });

    it('should test credentials for specific environment', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        environment: 'sandbox',
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);

      await service.testCredentials(userId, connectorId, 'sandbox');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('environment', '=', 'sandbox');
    });

    it('should fail if decrypted credentials are empty', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        organization_id: null
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(storedRecord);
      (CredentialEncryption.decrypt as jest.Mock).mockReturnValue({});

      const result = await service.testCredentials(userId, connectorId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('empty');

      // Reset mock
      (CredentialEncryption.decrypt as jest.Mock).mockImplementation((data) => {
        const parsed = JSON.parse(data);
        return parsed.data;
      });
    });
  });

  describe('getConnectorMetadata', () => {
    it('should return connector metadata', async () => {
      const metadata = {
        connector_id: 'salesforce',
        connector_name: 'Salesforce',
        description: 'CRM connector',
        is_active: true
      };

      mockQueryBuilder.executeTakeFirst.mockResolvedValue(metadata);

      const result = await service.getConnectorMetadata('salesforce');

      expect(result).toEqual(metadata);
      expect(mockDb.selectFrom).toHaveBeenCalledWith('connector_metadata');
    });

    it('should return null if metadata not found', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      const result = await service.getConnectorMetadata('unknown');

      expect(result).toBeNull();
    });

    it('should only return active connectors', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.getConnectorMetadata('salesforce');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('is_active', '=', true);
    });

    it('should handle database error', async () => {
      mockQueryBuilder.executeTakeFirst.mockRejectedValue(new Error('DB error'));

      await expect(service.getConnectorMetadata('salesforce')).rejects.toThrow('DB error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('listConnectors', () => {
    it('should list all active connectors', async () => {
      const connectors = [
        { connector_id: 'salesforce', connector_name: 'Salesforce', is_active: true },
        { connector_id: 'netsuite', connector_name: 'NetSuite', is_active: true }
      ];

      mockQueryBuilder.execute.mockResolvedValue(connectors);

      const result = await service.listConnectors();

      expect(result).toHaveLength(2);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('is_active', '=', true);
    });

    it('should list all connectors including inactive', async () => {
      const connectors = [
        { connector_id: 'salesforce', is_active: true },
        { connector_id: 'legacy', is_active: false }
      ];

      mockQueryBuilder.execute.mockResolvedValue(connectors);

      const result = await service.listConnectors(false);

      expect(result).toHaveLength(2);
    });

    it('should order by connector_name', async () => {
      mockQueryBuilder.execute.mockResolvedValue([]);

      await service.listConnectors();

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('connector_name', 'asc');
    });

    it('should handle empty result', async () => {
      mockQueryBuilder.execute.mockResolvedValue([]);

      const result = await service.listConnectors();

      expect(result).toEqual([]);
    });

    it('should handle database error', async () => {
      mockQueryBuilder.execute.mockRejectedValue(new Error('Query failed'));

      await expect(service.listConnectors()).rejects.toThrow('Query failed');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('audit logging', () => {
    it('should not throw if audit log fails', async () => {
      const storedRecord = {
        id: 1,
        encrypted_credentials: JSON.stringify({ encrypted: true, data: {} }),
        is_active: true,
        organization_id: null
      };

      // First call succeeds (credential lookup), second fails (audit log)
      let callCount = 0;
      mockQueryBuilder.executeTakeFirst.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(storedRecord);
        return Promise.resolve(null);
      });

      // Make audit insert fail
      const originalInsertInto = mockDb.insertInto;
      mockDb.insertInto = jest.fn((table: string) => {
        if (table === 'connector_credential_audit_log') {
          return {
            ...mockQueryBuilder,
            execute: jest.fn().mockRejectedValue(new Error('Audit failed'))
          };
        }
        return originalInsertInto(table);
      });

      // Should not throw even though audit log fails
      await expect(
        service.getCredentials(1, 'test')
      ).resolves.toBeDefined();

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to write audit log'));
    });
  });

  describe('multi-tenant isolation', () => {
    it('should isolate credentials by user_id', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.getCredentials(1, 'salesforce');
      await service.getCredentials(2, 'salesforce');

      const whereCalls = mockQueryBuilder.where.mock.calls;
      const userIdCalls = whereCalls.filter(
        (call: any[]) => call[0] === 'user_id' && call[1] === '='
      );

      expect(userIdCalls).toContainEqual(['user_id', '=', 1]);
      expect(userIdCalls).toContainEqual(['user_id', '=', 2]);
    });

    it('should isolate credentials by environment', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.getCredentials(1, 'salesforce', 'production');
      await service.getCredentials(1, 'salesforce', 'sandbox');

      const whereCalls = mockQueryBuilder.where.mock.calls;
      const envCalls = whereCalls.filter(
        (call: any[]) => call[0] === 'environment' && call[1] === '='
      );

      expect(envCalls).toContainEqual(['environment', '=', 'production']);
      expect(envCalls).toContainEqual(['environment', '=', 'sandbox']);
    });
  });
});
