import { ConnectorCredentialService } from '../../../../src/services/ConnectorCredentialService';
import { CredentialEncryption } from '../../../../src/utils/CredentialEncryption';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { Logger } from '../../../../src/utils/Logger';

// Mock dependencies
jest.mock('../../../../src/utils/CredentialEncryption');
jest.mock('../../../../src/utils/Logger');

describe('ConnectorCredentialService', () => {
  let service: ConnectorCredentialService;
  let mockDb: any;
  let mockDbService: jest.Mocked<DatabaseService>;
  let mockLogger: jest.Mocked<Logger>;

  const testCredentials = {
    accountId: 'TSTDRV2698307',
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    tokenId: 'test-token-id',
    tokenSecret: 'test-token-secret'
  };

  const encryptedCredentials = 'encrypted-base64-string';

  beforeEach(() => {
    // Mock Kysely database instance
    mockDb = {
      selectFrom: jest.fn().mockReturnThis(),
      selectAll: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(null),
      executeTakeFirstOrThrow: jest.fn().mockResolvedValue({}),
      insertInto: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returningAll: jest.fn().mockReturnThis(),
      updateTable: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      deleteFrom: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    mockDbService = {
      getDatabase: jest.fn().mockReturnValue(mockDb),
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    // Mock CredentialEncryption
    (CredentialEncryption.isKeyConfigured as jest.Mock).mockReturnValue(true);
    (CredentialEncryption.encrypt as jest.Mock).mockReturnValue(encryptedCredentials);
    (CredentialEncryption.decrypt as jest.Mock).mockReturnValue(testCredentials);

    service = new ConnectorCredentialService(mockDbService, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('storeCredentials', () => {
    it('should encrypt and store new credentials', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const connectorName = 'NetSuite ERP';
      const credentialType = 'oauth1';
      const environment = 'sandbox';

      // Mock no existing credentials
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      // Mock successful insert
      const mockResult = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: connectorName,
        environment,
        credential_type: credentialType,
        encrypted_credentials: encryptedCredentials,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockDb.executeTakeFirstOrThrow.mockResolvedValueOnce(mockResult);

      const result = await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        testCredentials,
        credentialType,
        environment
      );

      expect(CredentialEncryption.encrypt).toHaveBeenCalledWith(testCredentials);
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credentials');
      expect(result.id).toBe(123);
      expect(result.connector_id).toBe(connectorId);
    });

    it('should update existing credentials', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const connectorName = 'NetSuite ERP Updated';
      const credentialType = 'oauth1';
      const environment = 'sandbox';

      // Mock existing credentials
      const existingRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: credentialType,
        encrypted_credentials: 'old-encrypted-data',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockDb.executeTakeFirst.mockResolvedValueOnce(existingRecord);

      // Mock successful update
      const updatedRecord = { ...existingRecord, connector_name: connectorName };
      mockDb.executeTakeFirstOrThrow.mockResolvedValueOnce(updatedRecord);

      const result = await service.storeCredentials(
        userId,
        connectorId,
        connectorName,
        testCredentials,
        credentialType,
        environment
      );

      expect(CredentialEncryption.encrypt).toHaveBeenCalledWith(testCredentials);
      expect(mockDb.updateTable).toHaveBeenCalledWith('connector_credentials');
      expect(result.connector_name).toBe(connectorName);
    });

    it('should throw error if encryption key not configured', async () => {
      (CredentialEncryption.isKeyConfigured as jest.Mock).mockReturnValueOnce(false);

      await expect(
        service.storeCredentials(1, 'netsuite', 'NetSuite', testCredentials, 'oauth1')
      ).rejects.toThrow('ENCRYPTION_KEY not configured');
    });

    it('should create audit log for new credentials', async () => {
      const userId = 1;
      const connectorId = 'netsuite';

      // Mock no existing credentials
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      // Mock successful insert
      const mockResult = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment: 'production',
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockDb.executeTakeFirstOrThrow.mockResolvedValueOnce(mockResult);

      // Mock audit log insert (second insertInto call)
      mockDb.execute.mockResolvedValue(undefined);

      await service.storeCredentials(
        userId,
        connectorId,
        'NetSuite ERP',
        testCredentials,
        'oauth1'
      );

      // Verify audit log was created (insertInto called twice: credentials + audit)
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credentials');
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });
  });

  describe('getCredentials', () => {
    it('should retrieve and decrypt credentials', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      const mockRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        is_active: true,
        last_used_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);

      const result = await service.getCredentials(userId, connectorId, environment);

      expect(CredentialEncryption.decrypt).toHaveBeenCalledWith(encryptedCredentials);
      expect(result).toBeDefined();
      expect(result?.credentials).toEqual(testCredentials);
      expect(result?.connector_id).toBe(connectorId);

      // Verify last_used_at was updated
      expect(mockDb.updateTable).toHaveBeenCalledWith('connector_credentials');
      expect(mockDb.set).toHaveBeenCalledWith({ last_used_at: expect.any(Date) });
    });

    it('should return null if credentials not found', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      const result = await service.getCredentials(userId, connectorId, environment);

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No credentials found')
      );
    });

    it('should create audit log when credentials accessed', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      const mockRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        is_active: true,
        last_used_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      mockDb.execute.mockResolvedValue(undefined);

      await service.getCredentials(userId, connectorId, environment);

      // Verify audit log was created
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });
  });

  describe('listCredentials', () => {
    it('should list all active credentials for user', async () => {
      const userId = 1;

      const mockCredentials = [
        {
          id: 1,
          user_id: userId,
          connector_id: 'netsuite',
          connector_name: 'NetSuite ERP',
          environment: 'sandbox',
          credential_type: 'oauth1',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          user_id: userId,
          connector_id: 'salesforce',
          connector_name: 'Salesforce CRM',
          environment: 'production',
          credential_type: 'oauth2',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockDb.execute.mockResolvedValueOnce(mockCredentials);

      const result = await service.listCredentials(userId);

      expect(result).toHaveLength(2);
      expect(result[0].connector_id).toBe('netsuite');
      expect(result[1].connector_id).toBe('salesforce');

      // Verify encrypted_credentials not included in select
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.not.arrayContaining(['encrypted_credentials'])
      );
    });

    it('should include inactive credentials when activeOnly is false', async () => {
      const userId = 1;

      mockDb.execute.mockResolvedValueOnce([]);

      await service.listCredentials(userId, false);

      // Verify no where clause for is_active was added
      expect(mockDb.where).toHaveBeenCalledWith('user_id', '=', userId);
    });
  });

  describe('deleteCredentials', () => {
    it('should delete credentials and create audit log', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      const existingRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        organization_id: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(existingRecord);
      mockDb.execute.mockResolvedValue(undefined);

      const result = await service.deleteCredentials(userId, connectorId, environment);

      expect(result).toBe(true);
      expect(mockDb.deleteFrom).toHaveBeenCalledWith('connector_credentials');
      expect(mockDb.insertInto).toHaveBeenCalledWith('connector_credential_audit_log');
    });

    it('should return false if credentials not found', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      const result = await service.deleteCredentials(userId, connectorId, environment);

      expect(result).toBe(false);
      expect(mockDb.deleteFrom).not.toHaveBeenCalled();
    });
  });

  describe('testCredentials', () => {
    it('should successfully test credentials', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      const mockRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        organization_id: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      mockDb.execute.mockResolvedValue(undefined);

      const result = await service.testCredentials(userId, connectorId, environment);

      expect(result.success).toBe(true);
      expect(result.message).toContain('valid');
      expect(CredentialEncryption.decrypt).toHaveBeenCalledWith(encryptedCredentials);

      // Verify test status was updated
      expect(mockDb.updateTable).toHaveBeenCalledWith('connector_credentials');
      expect(mockDb.set).toHaveBeenCalledWith({
        last_tested_at: expect.any(Date),
        last_test_status: 'success',
        last_test_error: null,
      });
    });

    it('should handle decryption failure', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      const mockRecord = {
        id: 123,
        user_id: userId,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        environment,
        credential_type: 'oauth1',
        encrypted_credentials: encryptedCredentials,
        organization_id: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(mockRecord);
      (CredentialEncryption.decrypt as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Decryption failed');
      });
      mockDb.execute.mockResolvedValue(undefined);

      const result = await service.testCredentials(userId, connectorId, environment);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Decryption failed');

      // Verify test status was updated with error
      expect(mockDb.set).toHaveBeenCalledWith({
        last_tested_at: expect.any(Date),
        last_test_status: 'failed',
        last_test_error: 'Decryption failed',
      });
    });

    it('should return error if credentials not found', async () => {
      const userId = 1;
      const connectorId = 'netsuite';
      const environment = 'sandbox';

      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      const result = await service.testCredentials(userId, connectorId, environment);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No credentials found');
    });
  });

  describe('getConnectorMetadata', () => {
    it('should retrieve connector metadata', async () => {
      const connectorId = 'netsuite';

      const mockMetadata = {
        id: 1,
        connector_id: connectorId,
        connector_name: 'NetSuite ERP',
        connector_type: 'erp',
        supported_auth_types: ['oauth1'],
        required_credential_fields: ['accountId', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret'],
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDb.executeTakeFirst.mockResolvedValueOnce(mockMetadata);

      const result = await service.getConnectorMetadata(connectorId);

      expect(result).toBeDefined();
      expect(result?.connector_id).toBe(connectorId);
      expect(result?.connector_type).toBe('erp');
    });

    it('should return null if metadata not found', async () => {
      const connectorId = 'unknown';

      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      const result = await service.getConnectorMetadata(connectorId);

      expect(result).toBeNull();
    });
  });

  describe('listConnectors', () => {
    it('should list all active connectors', async () => {
      const mockConnectors = [
        {
          id: 1,
          connector_id: 'netsuite',
          connector_name: 'NetSuite ERP',
          connector_type: 'erp',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          connector_id: 'salesforce',
          connector_name: 'Salesforce CRM',
          connector_type: 'crm',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockDb.execute.mockResolvedValueOnce(mockConnectors);

      const result = await service.listConnectors();

      expect(result).toHaveLength(2);
      expect(result[0].connector_id).toBe('netsuite');
      expect(result[1].connector_id).toBe('salesforce');
    });
  });
});
