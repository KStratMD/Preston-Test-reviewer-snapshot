import 'reflect-metadata';
import crypto from 'crypto';
import { ApiKeyService, ApiKeyData } from '../../../src/security/ApiKeyService';
import { OAuth2Service } from '../../../src/security/OAuth2Service';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockAuditLogRepository = {
  create: jest.fn().mockResolvedValue(undefined),
};

const createChainMock = (result?: any) => {
  const chain: any = {};
  const methods = [
    'selectFrom', 'insertInto', 'updateTable', 'deleteFrom', 'selectAll',
    'select', 'where', 'set', 'values', 'limit', 'offset', 'orderBy',
    'groupBy', 'innerJoin', 'filterWhere', 'execute', 'executeTakeFirst',
    'ifNotExists', 'addColumn',
  ];
  methods.forEach((m) => {
    chain[m] = jest.fn().mockReturnValue(chain);
  });
  chain.execute.mockResolvedValue(result || []);
  chain.executeTakeFirst.mockResolvedValue(result);
  chain.fn = {
    count: jest.fn().mockReturnValue({ as: jest.fn().mockReturnValue('count') }),
    countAll: jest.fn().mockReturnValue({
      filterWhere: jest.fn().mockReturnValue({
        as: jest.fn().mockReturnValue('count'),
      }),
    }),
  };
  chain.or = jest.fn().mockReturnValue(chain);
  chain.schema = { createTable: jest.fn().mockReturnValue(chain) };
  return chain;
};

// ---------------------------------------------------------------------------
// ApiKeyService
// ---------------------------------------------------------------------------

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let chainMock: ReturnType<typeof createChainMock>;
  let mockDatabaseService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    chainMock = createChainMock();
    mockDatabaseService = {
      getDatabase: jest.fn().mockReturnValue(chainMock),
    };
    service = new ApiKeyService(
      mockLogger,
      mockDatabaseService,
      mockAuditLogRepository as any,
    );
  });

  describe('constructor', () => {
    it('should initialise without error', () => {
      expect(service).toBeInstanceOf(ApiKeyService);
    });
  });

  describe('hasPermission', () => {
    const baseKey: ApiKeyData = {
      id: 'key-1',
      keyName: 'Test Key',
      keyHash: 'abc',
      keyPrefix: 'ik_test1',
      permissions: ['read', 'write'],
      isActive: true,
      createdBy: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should return true when key has the specific permission', () => {
      expect(service.hasPermission(baseKey, 'read')).toBe(true);
      expect(service.hasPermission(baseKey, 'write')).toBe(true);
    });

    it('should return false when key does not have the permission', () => {
      expect(service.hasPermission(baseKey, 'admin')).toBe(false);
      expect(service.hasPermission(baseKey, 'delete')).toBe(false);
    });

    it('should return true for any permission when key has wildcard "*"', () => {
      const wildcardKey: ApiKeyData = { ...baseKey, permissions: ['*'] };
      expect(service.hasPermission(wildcardKey, 'read')).toBe(true);
      expect(service.hasPermission(wildcardKey, 'admin')).toBe(true);
      expect(service.hasPermission(wildcardKey, 'anything')).toBe(true);
    });

    it('should return true when wildcard is present alongside other permissions', () => {
      const mixedKey: ApiKeyData = { ...baseKey, permissions: ['read', '*'] };
      expect(service.hasPermission(mixedKey, 'delete')).toBe(true);
    });

    it('should return false for empty permissions list', () => {
      const noPermsKey: ApiKeyData = { ...baseKey, permissions: [] };
      expect(service.hasPermission(noPermsKey, 'read')).toBe(false);
    });
  });

  describe('createApiKey', () => {
    it('should create an API key and return data with plainKey', async () => {
      const result = await service.createApiKey('My Key', ['read'], 'user-1');

      expect(result).toBeDefined();
      expect(result.keyName).toBe('My Key');
      expect(result.permissions).toEqual(['read']);
      expect(result.createdBy).toBe('user-1');
      expect(result.isActive).toBe(true);
      expect(result.plainKey).toBeDefined();
      expect(result.plainKey!.startsWith('ik_')).toBe(true);
      expect(result.keyPrefix).toBe(result.plainKey!.substring(0, 8));
    });

    it('should call database insertInto with correct table', async () => {
      await service.createApiKey('Key', ['write'], 'user-2');
      expect(chainMock.insertInto).toHaveBeenCalledWith('api_keys');
      expect(chainMock.values).toHaveBeenCalled();
      expect(chainMock.execute).toHaveBeenCalled();
    });

    it('should create an audit log entry', async () => {
      await service.createApiKey('Audit Key', ['read', 'write'], 'user-3');
      expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-3',
          action: 'api_key_created',
          resource_type: 'api_key',
        }),
      );
    });

    it('should pass optional tenantId and rateLimit', async () => {
      const result = await service.createApiKey('Tenant Key', ['read'], 'user-4', {
        tenantId: 'tenant-abc',
        rateLimit: 1000,
      });
      expect(result.tenantId).toBe('tenant-abc');
      expect(result.rateLimit).toBe(1000);
    });

    it('should generate keys with the "ik_" prefix and 64 hex chars', async () => {
      const result = await service.createApiKey('Prefix Key', ['read'], 'user-5');
      expect(result.plainKey!.startsWith('ik_')).toBe(true);
      const randomPart = result.plainKey!.substring(3);
      expect(randomPart).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should throw and log error when database insert fails', async () => {
      chainMock.execute.mockRejectedValueOnce(new Error('DB error'));
      await expect(service.createApiKey('Fail Key', ['read'], 'user-7')).rejects.toThrow('DB error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create API key',
        expect.objectContaining({ keyName: 'Fail Key' }),
      );
    });
  });

  describe('validateApiKey', () => {
    it('should return null when no key is found in cache or database', async () => {
      chainMock.executeTakeFirst.mockResolvedValue(undefined);
      const result = await service.validateApiKey('ik_unknown_key_value');
      expect(result).toBeNull();
    });

    it('should return null and log error when database throws', async () => {
      chainMock.executeTakeFirst.mockRejectedValue(new Error('DB down'));
      const result = await service.validateApiKey('ik_error_key');
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to validate API key',
        expect.objectContaining({ error: 'DB down' }),
      );
    });
  });

  describe('initialize', () => {
    it('should load active keys to cache and log info', async () => {
      chainMock.execute.mockResolvedValue([]);
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'API key service initialized',
        expect.objectContaining({ cachedKeys: 0 }),
      );
    });

    it('should throw and log error when loading keys fails', async () => {
      chainMock.execute.mockRejectedValue(new Error('Init fail'));
      await expect(service.initialize()).rejects.toThrow('Init fail');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize API key service',
        expect.objectContaining({ error: 'Init fail' }),
      );
    });
  });

  describe('checkRateLimit', () => {
    const baseKey: ApiKeyData = {
      id: 'key-rl', keyName: 'Rate Key', keyHash: 'abc', keyPrefix: 'ik_ratel',
      permissions: ['read'], isActive: true, createdBy: 'admin',
      createdAt: new Date(), updatedAt: new Date(),
    };

    it('should return allowed=true with no limit when rateLimit is undefined', async () => {
      const result = await service.checkRateLimit(baseKey);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(0);
    });

    it('should return allowed=true when usage is below limit', async () => {
      const limitedKey = { ...baseKey, rateLimit: 100 };
      chainMock.executeTakeFirst.mockResolvedValue({ count: 5 });
      const result = await service.checkRateLimit(limitedKey);
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(5);
      expect(result.limit).toBe(100);
    });

    it('should return allowed=false when usage is at or above limit', async () => {
      const limitedKey = { ...baseKey, rateLimit: 10 };
      chainMock.executeTakeFirst.mockResolvedValue({ count: 10 });
      const result = await service.checkRateLimit(limitedKey);
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(10);
    });
  });

  describe('recordUsage', () => {
    const baseKey: ApiKeyData = {
      id: 'key-usage', keyName: 'Usage Key', keyHash: 'abc', keyPrefix: 'ik_usage',
      permissions: ['read'], isActive: true, createdBy: 'admin',
      createdAt: new Date(), updatedAt: new Date(),
    };

    it('should insert usage record into database', async () => {
      await service.recordUsage(baseKey, '/api/test', 'GET', 200, 50);
      expect(chainMock.insertInto).toHaveBeenCalledWith('api_key_usage');
    });

    it('should log error but not throw when recording fails', async () => {
      chainMock.execute.mockRejectedValueOnce(new Error('Usage insert fail'));
      await service.recordUsage(baseKey, '/api/fail', 'GET', 500, 10);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to record API key usage',
        expect.objectContaining({ keyId: 'key-usage' }),
      );
    });
  });

  describe('revokeApiKey', () => {
    it('should throw when key is not found', async () => {
      chainMock.executeTakeFirst.mockResolvedValue(undefined);
      await expect(service.revokeApiKey('nonexistent', 'admin')).rejects.toThrow(
        'API key not found: nonexistent',
      );
    });

    it('should revoke key and create audit log', async () => {
      chainMock.executeTakeFirst.mockResolvedValue({
        id: 'key-r1', key_prefix: 'ik_rev01', tenant_id: 'tenant-1',
      });
      await service.revokeApiKey('key-r1', 'admin');
      expect(chainMock.updateTable).toHaveBeenCalledWith('api_keys');
      expect(chainMock.set).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
      expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api_key_revoked', resource_id: 'key-r1' }),
      );
    });
  });

  describe('cleanup', () => {
    it('should deactivate expired keys and delete old usage records', async () => {
      chainMock.executeTakeFirst.mockResolvedValue({
        numUpdatedRows: BigInt(3), numDeletedRows: BigInt(50),
      });
      const result = await service.cleanup(30);
      expect(result.expiredKeysDeactivated).toBe(3);
      expect(result.oldUsageRecordsDeleted).toBe(50);
    });

    it('should throw and log error on failure', async () => {
      chainMock.executeTakeFirst.mockRejectedValue(new Error('Cleanup fail'));
      await expect(service.cleanup()).rejects.toThrow('Cleanup fail');
    });
  });
});

// ---------------------------------------------------------------------------
// OAuth2Service
// ---------------------------------------------------------------------------

describe('OAuth2Service', () => {
  let service: OAuth2Service;
  let chainMock: ReturnType<typeof createChainMock>;
  let mockDatabaseService: any;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    chainMock = createChainMock();
    mockDatabaseService = {
      getDatabase: jest.fn().mockReturnValue(chainMock),
    };
    service = new OAuth2Service(
      mockLogger,
      mockDatabaseService,
      mockAuditLogRepository as any,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should initialise without error', () => {
      expect(service).toBeInstanceOf(OAuth2Service);
    });

    it('should use the default issuer when OAUTH_ISSUER is not set', () => {
      delete process.env.OAUTH_ISSUER;
      const svc = new OAuth2Service(mockLogger, mockDatabaseService, mockAuditLogRepository as any);
      const doc = svc.getDiscoveryDocument();
      expect(doc.issuer).toBe('https://integration-hub.local');
    });

    it('should use OAUTH_ISSUER from env when set', () => {
      process.env.OAUTH_ISSUER = 'https://custom-issuer.example.com';
      const svc = new OAuth2Service(mockLogger, mockDatabaseService, mockAuditLogRepository as any);
      const doc = svc.getDiscoveryDocument();
      expect(doc.issuer).toBe('https://custom-issuer.example.com');
    });
  });

  describe('generateAuthorizationUrl', () => {
    it('should return a URL containing the required OAuth2 parameters', () => {
      const url = service.generateAuthorizationUrl('client-123', 'http://localhost:3000/callback', ['read', 'write']);
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=client-123');
      expect(url).toContain(encodeURIComponent('http://localhost:3000/callback'));
      expect(url).toContain('scope=read+write');
    });

    it('should start with the issuer URL', () => {
      const url = service.generateAuthorizationUrl('client-abc', 'http://localhost/cb');
      expect(url.startsWith('https://integration-hub.local/oauth/authorize?')).toBe(true);
    });

    it('should include state parameter when provided', () => {
      const url = service.generateAuthorizationUrl('client-1', 'http://localhost/cb', ['read'], 'random-state-value');
      expect(url).toContain('state=random-state-value');
    });

    it('should not include state parameter when not provided', () => {
      const url = service.generateAuthorizationUrl('client-1', 'http://localhost/cb', ['read']);
      expect(url).not.toContain('state=');
    });

    it('should include nonce parameter when provided', () => {
      const url = service.generateAuthorizationUrl('client-1', 'http://localhost/cb', ['openid'], undefined, 'nonce-value-123');
      expect(url).toContain('nonce=nonce-value-123');
    });

    it('should not include nonce parameter when not provided', () => {
      const url = service.generateAuthorizationUrl('client-1', 'http://localhost/cb', ['read']);
      expect(url).not.toContain('nonce=');
    });

    it('should default to ["read"] scope when scopes not provided', () => {
      const url = service.generateAuthorizationUrl('client-1', 'http://localhost/cb');
      expect(url).toContain('scope=read');
    });
  });

  describe('getDiscoveryDocument', () => {
    it('should return a valid OIDC discovery document', () => {
      const doc = service.getDiscoveryDocument();
      expect(doc.issuer).toBe('https://integration-hub.local');
      expect(doc.authorization_endpoint).toBe('https://integration-hub.local/oauth/authorize');
      expect(doc.token_endpoint).toBe('https://integration-hub.local/oauth/token');
      expect(doc.userinfo_endpoint).toBe('https://integration-hub.local/oauth/userinfo');
      expect(doc.jwks_uri).toBe('https://integration-hub.local/.well-known/jwks.json');
    });

    it('should include all required OIDC fields', () => {
      const doc = service.getDiscoveryDocument();
      const requiredFields = [
        'issuer', 'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint',
        'jwks_uri', 'scopes_supported', 'response_types_supported', 'grant_types_supported',
        'subject_types_supported', 'id_token_signing_alg_values_supported',
        'token_endpoint_auth_methods_supported', 'claims_supported',
      ];
      for (const field of requiredFields) {
        expect(doc).toHaveProperty(field);
      }
    });

    it('should list expected scopes', () => {
      const doc = service.getDiscoveryDocument();
      const scopes = doc.scopes_supported as string[];
      expect(scopes).toContain('openid');
      expect(scopes).toContain('read');
      expect(scopes).toContain('write');
      expect(scopes).toContain('admin');
    });

    it('should list expected grant types', () => {
      const doc = service.getDiscoveryDocument();
      const grantTypes = doc.grant_types_supported as string[];
      expect(grantTypes).toContain('authorization_code');
      expect(grantTypes).toContain('refresh_token');
      expect(grantTypes).toContain('client_credentials');
    });

    it('should use custom issuer in all endpoint URLs', () => {
      process.env.OAUTH_ISSUER = 'https://sso.acme.org';
      const svc = new OAuth2Service(mockLogger, mockDatabaseService, mockAuditLogRepository as any);
      const doc = svc.getDiscoveryDocument();
      expect(doc.issuer).toBe('https://sso.acme.org');
      expect(doc.authorization_endpoint).toBe('https://sso.acme.org/oauth/authorize');
      expect(doc.token_endpoint).toBe('https://sso.acme.org/oauth/token');
    });
  });

  describe('registerClient', () => {
    it('should register a client and return OAuthClient data', async () => {
      const result = await service.registerClient('Test App', ['http://localhost/cb'], ['authorization_code'], ['read'], 'tenant-1');
      expect(result.name).toBe('Test App');
      expect(result.redirectUris).toEqual(['http://localhost/cb']);
      expect(result.isActive).toBe(true);
      expect(result.clientId).toBeDefined();
      expect(result.clientId.startsWith('client_')).toBe(true);
    });

    it('should insert client into database', async () => {
      await service.registerClient('DB Client', ['http://localhost/cb']);
      expect(chainMock.insertInto).toHaveBeenCalledWith('oauth_clients');
    });

    it('should throw and log error when database fails', async () => {
      chainMock.execute.mockRejectedValueOnce(new Error('Insert fail'));
      await expect(service.registerClient('Fail Client', ['http://localhost/cb'])).rejects.toThrow('Insert fail');
    });
  });

  describe('createAuthorizationCode', () => {
    it('should return a hex string authorization code', async () => {
      const code = await service.createAuthorizationCode('client-1', 'user-1', 'http://localhost/cb', ['read']);
      expect(code).toBeDefined();
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should store the code in the database', async () => {
      await service.createAuthorizationCode('client-1', 'user-1', 'http://localhost/cb', ['read']);
      expect(chainMock.insertInto).toHaveBeenCalledWith('oauth_authorization_codes');
    });
  });

  describe('revokeToken', () => {
    it('should update the token record to revoked', async () => {
      await service.revokeToken('some-token-value', 'user-1');
      expect(chainMock.updateTable).toHaveBeenCalledWith('oauth_access_tokens');
      expect(chainMock.set).toHaveBeenCalledWith(expect.objectContaining({ revoked: true }));
    });

    it('should throw and log error on failure', async () => {
      chainMock.execute.mockRejectedValueOnce(new Error('Revoke fail'));
      await expect(service.revokeToken('bad-token')).rejects.toThrow('Revoke fail');
    });
  });

  describe('initialize', () => {
    it('should call createTablesIfNotExist and log info', async () => {
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'OAuth2 service initialized',
        expect.objectContaining({ issuer: 'https://integration-hub.local' }),
      );
    });

    it('should throw and log error on failure', async () => {
      chainMock.execute.mockRejectedValue(new Error('Schema fail'));
      await expect(service.initialize()).rejects.toThrow('Schema fail');
    });
  });
});
