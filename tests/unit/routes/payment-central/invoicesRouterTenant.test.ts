/**
 * F5b Task 11: payment-central invoices router off the SYSTEM_IDENTITY
 * fallback. PaymentCentralService is mocked at the container boundary;
 * attestReadsOnly() simulates the gate's reads-only anonymous demo
 * attestation.
 */
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const mockGetInvoices = jest.fn();
const mockCreateInvoice = jest.fn();

const mockPaymentService = {
  getInvoices: mockGetInvoices,
  createInvoice: mockCreateInvoice,
  getInvoice: jest.fn(),
  getInvoiceStatistics: jest.fn(),
  autoMatchInvoice: jest.fn(),
  matchInvoiceToPO: jest.fn(),
  approveInvoice: jest.fn(),
  createInvoiceDispute: jest.fn(),
  getDisputes: jest.fn(),
  resolveDispute: jest.fn(),
  getCreditMemos: jest.fn(),
  createCreditMemo: jest.fn(),
};

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('PaymentCentralService')) return mockPaymentService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
  },
}));

// eslint-disable-next-line import/first
import { paymentCentralInvoicesRouter } from '../../../../src/routes/payment-central/invoices.router';
// eslint-disable-next-line import/first
import { attestReadsOnly } from '../central/centralRouterHarness';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../../src/services/governance/demoTenant';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(attestReadsOnly());
  app.use('/api/payment-central', paymentCentralInvoicesRouter);
  return app;
}

describe('payment-central invoices router tenant resolution (F5b)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  it('no longer imports extractIdentityContext', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/routes/payment-central/invoices.router.ts'),
      'utf8',
    );
    expect(src).not.toContain('extractIdentityContext');
  });

  it('resolves a gate-attested anonymous GET /invoices to the demo tenant', async () => {
    mockGetInvoices.mockResolvedValue({ invoices: [], total: 0 });
    const res = await request(app).get('/api/payment-central/invoices').set('x-test-demo', '1');
    expect(res.status).toBe(200);
    expect(mockGetInvoices).toHaveBeenCalledWith(
      CENTRAL_DEMO_TENANT_ID,
      expect.anything(),
    );
  });

  it('401s an unattested credential-free GET /invoices (the removed fallback)', async () => {
    const res = await request(app).get('/api/payment-central/invoices');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockGetInvoices).not.toHaveBeenCalled();
  });

  it('401s an anonymous POST /invoices even with the demo header (harness attests reads only)', async () => {
    // Body is OTHERWISE VALID so the 401 is unambiguously an identity
    // refusal and not body validation, whichever guard the handler runs
    // first. A partial body would 401 or 400 depending on that order and
    // so would prove nothing about identity.
    const res = await request(app)
      .post('/api/payment-central/invoices')
      .set('x-test-demo', '1')
      .send({ vendorId: 'v1', invoiceNumber: 'INV-1', amount: 10, lineItems: [] });
    expect(res.status).toBe(401);
    expect(mockCreateInvoice).not.toHaveBeenCalled();
  });
});
