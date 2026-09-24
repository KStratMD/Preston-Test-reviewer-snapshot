import express from 'express';
import request from 'supertest';

const mockManager = {
  storeCredentials: jest.fn(),
  getCredentialMetadata: jest.fn(),
  deleteCredentials: jest.fn(),
};
const mockRegistry = {
  assertSystemOwnedByTenant: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    getAsync: jest.fn((type: symbol) => {
      const { TYPES } = jest.requireActual('../../../src/inversify/types');
      return Promise.resolve(type === TYPES.SecureCredentialManager ? mockManager : mockRegistry);
    }),
  },
}));
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { secureCredentialsRouter } from '../../../src/routes/secureCredentials';
import { globalErrorHandler } from '../../../src/middleware/errorBoundary';
import { CrossTenantCredentialError } from '../../../src/services/integration/TenantSystemCredentialRegistry';

describe('SecureCredentialManager credential write surface', () => {
  beforeEach(() => jest.clearAllMocks());

  function appFor(roles = ['integration_manager'], tenantId: string | null = 'tenant-a'): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'operator-1', tenantId: tenantId ?? undefined, roles, permissions: [] };
      next();
    });
    app.use('/api/credentials', secureCredentialsRouter);
    app.use(globalErrorHandler());
    return app;
  }

  it('authorizes a verified integration manager and asserts tenant ownership before storing', async () => {
    const app = appFor();
    const sentinel = 'secure-write-route-sentinel';

    const response = await request(app)
      .post('/api/credentials')
      .send({
        systemType: 'Salesforce',
        systemId: 'sf-prod',
        credentials: { clientSecret: sentinel },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      success: true,
      data: { systemType: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(mockRegistry.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'Salesforce', 'sf-prod');
    expect(mockManager.storeCredentials).toHaveBeenCalledWith('Salesforce', 'sf-prod', { clientSecret: sentinel });
    expect(mockRegistry.assertSystemOwnedByTenant.mock.invocationCallOrder[0])
      .toBeLessThan(mockManager.storeCredentials.mock.invocationCallOrder[0]);
  });

  it('rejects an unauthorized caller before resolving a manager', async () => {
    const response = await request(appFor(['viewer']))
      .post('/api/credentials')
      .send({ systemType: 'Salesforce', systemId: 'sf-prod', credentials: { clientSecret: 'sentinel' } });

    expect(response.status).toBe(403);
    expect(mockRegistry.assertSystemOwnedByTenant).not.toHaveBeenCalled();
    expect(mockManager.storeCredentials).not.toHaveBeenCalled();
  });

  it('rejects credential payloads that fail the route schema', async () => {
    const response = await request(appFor(undefined, 'tenant-a'))
      .post('/api/credentials')
      .send({ systemType: '', systemId: 'sf-prod', credentials: {} });

    expect(response.status).toBe(400);
    expect(mockRegistry.assertSystemOwnedByTenant).not.toHaveBeenCalled();
    expect(mockManager.storeCredentials).not.toHaveBeenCalled();
  });

  it('rejects whitespace-padded system identifiers at the write boundary', async () => {
    const response = await request(appFor())
      .post('/api/credentials')
      .send({ systemType: 'Salesforce', systemId: ' sf-prod ', credentials: {} });

    expect(response.status).toBe(400);
    expect(mockRegistry.assertSystemOwnedByTenant).not.toHaveBeenCalled();
    expect(mockManager.storeCredentials).not.toHaveBeenCalled();
  });

  it('rejects a caller with no tenant claim before resolving ownership', async () => {
    const response = await request(appFor(undefined, null))
      .post('/api/credentials')
      .send({ systemType: 'Salesforce', systemId: 'sf-prod', credentials: { clientSecret: 'sentinel' } });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
    expect(mockRegistry.assertSystemOwnedByTenant).not.toHaveBeenCalled();
    expect(mockManager.storeCredentials).not.toHaveBeenCalled();
  });

  it('returns a generic 403 when the system is owned by another tenant', async () => {
    mockRegistry.assertSystemOwnedByTenant.mockRejectedValueOnce(new CrossTenantCredentialError('refused'));
    const response = await request(appFor(undefined, 'tenant-a'))
      .post('/api/credentials')
      .send({ systemType: 'Salesforce', systemId: 'sf-prod', credentials: { clientSecret: 'sentinel' } });

    expect(response.status).toBe(403);
    expect(mockManager.storeCredentials).not.toHaveBeenCalled();
  });

  it('asserts tenant ownership before deleting credential material', async () => {
    const response = await request(appFor())
      .delete('/api/credentials/Salesforce/sf-prod');

    expect(response.status).toBe(200);
    expect(mockRegistry.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'Salesforce', 'sf-prod');
    expect(mockManager.deleteCredentials).toHaveBeenCalledWith('Salesforce', 'sf-prod');
  });
});
