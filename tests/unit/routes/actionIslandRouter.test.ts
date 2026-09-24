import express, { type RequestHandler } from 'express';
import request from 'supertest';

const mockRequestW9 = jest.fn();
const mockGetActionIslandService = jest.fn(() => ({ requestW9: mockRequestW9 }));
const mockExtractIdentityContext = jest.fn(() => {
  throw new Error('legacy identity resolver must not be called');
});

jest.mock('../../../src/services/embedded/ActionIslandService', () => ({
  getActionIslandService: mockGetActionIslandService,
}));
jest.mock('../../../src/services/governance/identityContext', () => ({
  extractIdentityContext: mockExtractIdentityContext,
  SYSTEM_IDENTITY: { userId: '__adversarial_system_identity__' },
}));

import { actionIslandRouter } from '../../../src/routes/ActionIslandRouter';

function createApp(userId?: string): express.Application {
  const app = express();
  const identity: RequestHandler = (req, _res, next) => {
    if (userId) {
      req.user = {
        id: userId,
        username: userId,
        tenantId: 'tenant-a',
        roles: ['user'],
        permissions: [],
      };
    }
    next();
  };
  app.use(express.json());
  app.use(identity);
  app.use('/api/actions', actionIslandRouter);
  return app;
}

describe('ActionIslandRouter verified-user attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestW9.mockResolvedValue({ success: true, message: 'sent', actionId: 'action-1' });
  });

  it('passes undefined userId for an anonymous request without consulting the legacy identity resolver', async () => {
    const res = await request(createApp()).post('/api/actions/request-w9').send({
      vendorId: 'vendor-1',
      vendorEmail: 'vendor@example.com',
      system: 'NetSuite',
      recordType: 'vendor',
      recordId: 'vendor-1',
      entityName: 'Example Vendor',
    });

    expect(res.status).toBe(200);
    expect(mockGetActionIslandService).toHaveBeenCalledTimes(1);
    expect(mockRequestW9).toHaveBeenCalledWith('vendor-1', 'vendor@example.com', {
      system: 'NetSuite',
      recordType: 'vendor',
      recordId: 'vendor-1',
      entityName: 'Example Vendor',
      userId: undefined,
    });
    expect(mockExtractIdentityContext).not.toHaveBeenCalled();
  });

  it('passes the exact verified req.user.id without consulting the legacy identity resolver', async () => {
    const res = await request(createApp('verified-user-42')).post('/api/actions/request-w9').send({
      vendorId: 'vendor-1',
      system: 'NetSuite',
      recordType: 'vendor',
      recordId: 'vendor-1',
    });

    expect(res.status).toBe(200);
    expect(mockRequestW9).toHaveBeenCalledWith(
      'vendor-1',
      undefined,
      expect.objectContaining({ userId: 'verified-user-42' }),
    );
    expect(mockExtractIdentityContext).not.toHaveBeenCalled();
  });
});
