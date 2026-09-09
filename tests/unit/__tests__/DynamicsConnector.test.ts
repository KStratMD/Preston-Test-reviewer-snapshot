// Removed ts-nocheck to enforce type checking

import axios from 'axios';
import { DynamicsConnector } from '../connectors/DynamicsConnector';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock axios.create to return a mock instance
const mockAxiosInstance = {
  defaults: { baseURL: '', headers: { common: {} } },
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
  request: jest.fn(),
};

(mockedAxios.create as jest.Mock).mockReturnValue(mockAxiosInstance);

describe('DynamicsConnector', () => {
  let connector: DynamicsConnector;
  let authService: AuthService;
  let logger: Logger;

  beforeEach(() => {
    // Mock AuthService
    authService = {
      authenticateOAuth2: jest.fn().mockResolvedValue({ accessToken: 'token', expiresAt: Date.now() + 3600, issued: new Date() }),
    } as any;
    // Mock Logger
    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;
    // Create instance
    connector = new DynamicsConnector('system1', logger, authService);
    // Clear previous mocks
    mockedAxios.create?.mockClear();
    mockedAxios.request?.mockClear();
  });

  describe('initialize', () => {
    it('throws if auth type is not oauth2', async () => {
      await expect(
        connector.initialize({ type: 'api_key', credentials: {} } as any),
      ).rejects.toThrow('Dynamics 365 connector requires OAuth2 authentication');
    });

    it('sets baseURL on httpClient when credentials provided', async () => {
      const config = {
        type: 'oauth2',
        credentials: {
          clientId: 'cid',
          clientSecret: 'cs',
          tenantId: 'tid',
          resourceUrl: 'https://dynamics.example.com',
          baseUrl: 'https://custom.example.com/api/data/v9.2',
        },
      } as any;
      await connector.initialize(config);
      expect(connector['httpClient'].defaults.baseURL).toBe('https://custom.example.com/api/data/v9.2');
    });
  });

  describe('authenticate', () => {
    it('authenticates and sets headers', async () => {
      // Prepare
      connector['clientId'] = 'cid';
      connector['clientSecret'] = 'cs';
      connector['tenantId'] = 'tid';
      connector['resourceUrl'] = 'https://dynamics.example.com';
      // Use mocked axios instance from BaseConnector initialization
      connector['httpClient'] = mockAxiosInstance as any;
      // Mock token
      (authService.authenticateOAuth2 as jest.Mock).mockResolvedValue({ accessToken: 'abc', expiresAt: Date.now() + 1000, issued: new Date() });

      const result = await connector.authenticate();
      expect(result).toBe(true);
      expect(connector['httpClient'].defaults.headers.common['Authorization']).toBe('Bearer abc');
      expect(connector['isAuthenticated']).toBe(true);
      expect(logger.info).toHaveBeenCalledWith('Dynamics 365 authentication successful');
    });

    it('throws and logs on failure', async () => {
      // Mock failure
      (authService.authenticateOAuth2 as jest.Mock).mockRejectedValue(new Error('fail'));
      await expect(connector.authenticate()).rejects.toThrow('fail');
      expect(connector['isAuthenticated']).toBe(false);
      expect(logger.error).toHaveBeenCalledWith('Dynamics 365 authentication failed', expect.any(Error));
    });
  });

  describe('testConnection', () => {
    it('returns connected when authenticate and getSystemInfo succeed', async () => {
      jest.spyOn(connector, 'authenticate').mockResolvedValue(true as any);
      jest.spyOn(connector, 'getSystemInfo').mockResolvedValue({
        name: 'Dynamics 365',
        type: 'Dynamics365',
        version: '1.0',
        capabilities: [],
        rateLimits: { requestsPerMinute: 1, requestsPerHour: 1, requestsPerDay: 1 },
        endpoints: { baseUrl: '', authUrl: '', webhookUrl: '' },
      } as any);

      const status = await connector.testConnection();
      expect(status.isConnected).toBe(true);
      expect(status.systemId).toBe('system1');
    });

    it('returns disconnected when authenticate fails', async () => {
      jest.spyOn(connector, 'authenticate').mockRejectedValue(new Error('fail auth'));
      const status = await connector.testConnection();
      expect(status.isConnected).toBe(false);
      expect(status.errorMessage).toContain('fail auth');
    });
  });

  describe('getSystemInfo', () => {
    it('returns system info from Dynamics organizations', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({
        value: [{ friendlyname: 'Org', version: '9.1' }],
      });

      const info = await connector.getSystemInfo();
      expect(info.name).toBe('Org');
      expect(info.version).toBe('9.1');
      expect(info.type).toBe('Dynamics365');
    });

    it('throws error when request fails', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('error'));
      await expect(connector.getSystemInfo()).rejects.toThrow('Failed to get Dynamics 365 system info');
    });
  });

  describe('create', () => {
    it('returns formatted record on success', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      const payload = { id: '123', name: 'Test' };
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue(payload);

      connector['getEntitySetName'] = () => 'entities';
      connector['formatDataForDynamics'] = (data) => data;
      connector['formatDataFromDynamics'] = (res) => res as any;

      const result = await connector.create('Entity', { name: 'Test' } as any);
      expect(result).toEqual(payload);
    });

    it('throws error with message on failure', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('fail'));
      connector['getEntitySetName'] = () => 'entities';
      connector['formatDataForDynamics'] = (data) => data;
      await expect(connector.create('Entity', {} as any)).rejects.toThrow('Failed to create Entity: fail');
    });
  });

  describe('read', () => {
    it('returns record on success', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ id: '1' });
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      connector['formatDataFromDynamics'] = (res) => res as any;
      const result = await connector.read('Entity', '1');
      expect(result).toEqual({ id: '1' });
    });
    it('returns null on 404 error', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('404'));
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      const result = await connector.read('Entity', '1');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('returns updated record on success', async () => {
      const mockData = { id: '1', name: 'New' };
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue(mockData);
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      connector['formatDataForDynamics'] = (data) => data;
      connector['formatDataFromDynamics'] = (res) => res as any;
      const result = await connector.update('Entity', '1', { name: 'New' });
      expect(result).toEqual(mockData);
    });
    it('throws on failure', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('upd fail'));
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      connector['formatDataForDynamics'] = (data) => data;
      await expect(connector.update('Entity', '1', {} as any)).rejects.toThrow('Failed to update Entity 1: upd fail');
    });
  });

  describe('delete', () => {
    it('returns true on success', async () => {
      // Use mocked axios instance for delete
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector['httpClient'], 'request').mockResolvedValue({});
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      const result = await connector.delete('Entity', '1');
      expect(result).toBe(true);
    });
    it('throws on failure', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('del fail'));
      connector['getEntitySetName'] = () => 'entities';
      connector['getPrimaryKeyField'] = () => 'id';
      await expect(connector.delete('Entity', '1')).rejects.toThrow('Failed to delete Entity 1: del fail');
    });
  });

  describe('list', () => {
    it('returns formatted list on success', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ value: [{ a: 1 }, { b: 2 }] });
      connector['getEntitySetName'] = () => 'entities';
      connector['formatDataFromDynamics'] = (item) => item as any;
      const result = await connector.list('Entity', { limit: 2 });
      expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    });
    it('returns empty array on non-array value', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ value: null });
      connector['getEntitySetName'] = () => 'entities';
      connector['formatDataFromDynamics'] = (item) => item as any;
      const result = await connector.list('Entity');
      expect(result).toEqual([]);
    });
  });

  describe('search', () => {
    it('returns formatted search results', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ value: [{ x: 1 }] });
      connector['getEntitySetName'] = () => 'entities';
      connector['formatDataFromDynamics'] = (item) => item as any;
      const result = await connector.search('Entity', { filters: [] as any });
      expect(result).toEqual([{ x: 1 }]);
    });
  });

  describe('setupWebhook', () => {
    it('returns webhook id on success', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ serviceendpointid: 'w1' });
      const id = await connector.setupWebhook('url', []);
      expect(id).toBe('w1');
    });
  });

  describe('removeWebhook', () => {
    it('returns true on success', async () => {
      connector['httpClient'] = mockAxiosInstance as any;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({});
      const result = await connector.removeWebhook('w1');
      expect(result).toBe(true);
    });
  });
  // Further tests for create, read, etc. can be added here.
});
