/**
 * F5b Task 12: supplierCentral off the SYSTEM_IDENTITY fallback.
 * SupplierCentralService is mocked at the container boundary;
 * attestReadsOnly() simulates the gate's reads-only anonymous demo
 * attestation.
 */
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const mockGetVendorProfiles = jest.fn();
const mockCreateVendorProfile = jest.fn();

const mockSupplierService = new Proxy(
  {
    getVendorProfiles: mockGetVendorProfiles,
    createVendorProfile: mockCreateVendorProfile,
  } as Record<string, jest.Mock>,
  {
    // Any method the 33 handlers reach that we did not name explicitly
    // resolves to a fresh no-op mock — this suite pins identity dispatch,
    // not per-handler behavior.
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = jest.fn();
      return target[prop];
    },
  },
);

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('SupplierCentralService')) return mockSupplierService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
    getAsync: jest.fn(async (type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('SupplierCentralService')) return mockSupplierService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
  },
}));

// eslint-disable-next-line import/first
import { supplierCentralRouter } from '../../../src/routes/supplierCentral';
// eslint-disable-next-line import/first
import { attestReadsOnly } from './central/centralRouterHarness';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../src/services/governance/demoTenant';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(attestReadsOnly());
  app.use('/api/supplier-central', supplierCentralRouter);
  return app;
}

describe('supplierCentral tenant resolution (F5b)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  it('no longer imports extractIdentityContext', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/routes/supplierCentral.ts'),
      'utf8',
    );
    expect(src).not.toContain('extractIdentityContext');
  });

  it('resolves a gate-attested anonymous GET /vendors to the demo tenant', async () => {
    mockGetVendorProfiles.mockResolvedValue({ vendors: [], total: 0 });
    const res = await request(app).get('/api/supplier-central/vendors').set('x-test-demo', '1');
    expect(res.status).toBe(200);
    expect(mockGetVendorProfiles).toHaveBeenCalledWith(
      CENTRAL_DEMO_TENANT_ID,
      expect.anything(),
    );
  });

  it('401s an unattested credential-free GET /vendors (the removed fallback)', async () => {
    const res = await request(app).get('/api/supplier-central/vendors');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockGetVendorProfiles).not.toHaveBeenCalled();
  });

  it('POST /public/register requires an identity despite the route name', async () => {
    // attestReadsOnly does not attest POST, matching the real gate — so this
    // is an unattested write and must 401, not reach the handler.
    const res = await request(app)
      .post('/api/supplier-central/public/register')
      .set('x-test-demo', '1')
      .send({ companyName: 'Acme' });
    expect(res.status).toBe(401);
    expect(mockCreateVendorProfile).not.toHaveBeenCalled();
  });
});
