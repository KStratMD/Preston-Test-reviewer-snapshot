/**
 * Route regression suite for paymentCentral.ts.
 * The route file is the unit under test; PaymentCentralService is mocked at the boundary.
 *
 * Pattern follows nlActionGateRouter.test.ts:
 *   - jest.mock inversify.config before importing the router
 *   - drive each route with supertest
 *   - one happy path + one error path per major area
 */

import request from 'supertest';
import express from 'express';

// ---- Mock service methods ----
const mockGetPaymentProcessors = jest.fn();
const mockGetTransactions = jest.fn();
const mockGenerateReconciliationReport = jest.fn();
const mockGetReconciliationReport = jest.fn();
const mockGetDunningEntry = jest.fn();
const mockAnalyzeDunningEntry = jest.fn();
const mockCreateJournalEntryFromTransaction = jest.fn();
const mockGetInvoices = jest.fn();
const mockApproveInvoice = jest.fn();
const mockCreateInvoice = jest.fn();
const mockCreateInvoiceDispute = jest.fn();
const mockResolveDispute = jest.fn();
const mockCreateCreditMemo = jest.fn();
const mockMatchInvoiceToPO = jest.fn();
const mockApproveJournalEntry = jest.fn();
const mockPostJournalEntry = jest.fn();
const mockCreatePostingBatch = jest.fn();
const mockProcessPostingBatch = jest.fn();

const mockPaymentService = {
  getPaymentProcessors: mockGetPaymentProcessors,
  getTransactions: mockGetTransactions,
  generateReconciliationReport: mockGenerateReconciliationReport,
  getReconciliationReport: mockGetReconciliationReport,
  getDunningEntry: mockGetDunningEntry,
  analyzeDunningEntry: mockAnalyzeDunningEntry,
  createJournalEntryFromTransaction: mockCreateJournalEntryFromTransaction,
  getInvoices: mockGetInvoices,
  // Additional methods accessed by routes we don't specifically test here
  configureProcessor: jest.fn(),
  syncTransactionToBusinessCentral: jest.fn(),
  getPaymentAnalytics: jest.fn(),
  getDunningSchedules: jest.fn(),
  getDunningSchedule: jest.fn(),
  saveDunningSchedule: jest.fn(),
  updateDunningSchedule: jest.fn(),
  deleteDunningSchedule: jest.fn(),
  getDunningEntries: jest.fn(),
  sendDunningReminder: jest.fn(),
  pauseDunning: jest.fn(),
  resumeDunning: jest.fn(),
  markDunningPaid: jest.fn(),
  escalateToCollections: jest.fn(),
  getDunningStatistics: jest.fn(),
  processPendingDunning: jest.fn(),
  getGLAccounts: jest.fn(),
  getGLAccount: jest.fn(),
  getJournalEntries: jest.fn(),
  getJournalEntry: jest.fn(),
  approveJournalEntry: mockApproveJournalEntry,
  postJournalEntry: mockPostJournalEntry,
  voidJournalEntry: jest.fn(),
  getPostingBatches: jest.fn(),
  getPostingBatch: jest.fn(),
  createPostingBatch: mockCreatePostingBatch,
  processPostingBatch: mockProcessPostingBatch,
  getGLPostingStatistics: jest.fn(),
  getGLPostingDashboard: jest.fn(),
  createInvoice: mockCreateInvoice,
  getInvoice: jest.fn(),
  getInvoiceStatistics: jest.fn(),
  autoMatchInvoice: jest.fn(),
  matchInvoiceToPO: mockMatchInvoiceToPO,
  approveInvoice: mockApproveInvoice,
  createInvoiceDispute: mockCreateInvoiceDispute,
  getDisputes: jest.fn(),
  resolveDispute: mockResolveDispute,
  getCreditMemos: jest.fn(),
  createCreditMemo: mockCreateCreditMemo,
};

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock the inversify container before importing the router
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

import { paymentCentralRouter } from '../../../../src/routes/paymentCentral';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payment-central', paymentCentralRouter);
  return app;
}

function createAuthedApp(userId: string, tenantId = 'tenant-a') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { tenantId, id: userId }; next(); });
  app.use('/api/payment-central', paymentCentralRouter);
  return app;
}

describe('paymentCentral router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  it('composes mounted domain subrouters under the top-level router', () => {
    const mountedRouters = (paymentCentralRouter as any).stack.filter((layer: any) => layer.name === 'router');
    expect(mountedRouters).toHaveLength(5);
  });

  it('processors and invoices subrouters (both mounted at /) declare disjoint method+path pairs', () => {
    // Express routing dispatches on (method, path), not path alone. Two subrouters
    // sharing a path but declaring different HTTP methods is legitimate REST split,
    // so the guard must compare (method, path) signatures — not raw paths.
    const mountedLayers = (paymentCentralRouter as any).stack.filter((layer: any) => layer.name === 'router');
    const rootMounts = mountedLayers.filter((layer: any) => layer.regexp.test('/'));
    const declaredSignatures = (router: any): string[] =>
      router.stack
        .filter((layer: any) => layer.route)
        .flatMap((layer: any) => {
          const path = layer.route.path;
          const methods = Object.entries(layer.route.methods ?? {})
            .filter(([, enabled]) => enabled)
            .map(([method]) => method.toUpperCase());
          return methods.map((method: string) => `${method} ${path}`);
        });
    const sigSets = rootMounts.map((mount: any) => new Set(declaredSignatures(mount.handle)));
    const [first, second] = sigSets;
    const overlap = [...first].filter(sig => second.has(sig));
    expect(overlap).toEqual([]);
  });

  // ==================== GET /processors ====================

  describe('GET /processors', () => {
    it('happy path — returns processor list with 200', async () => {
      const processors = [
        {
          id: 'proc_001',
          name: 'Stripe',
          type: 'stripe',
          status: 'active',
          fees: { percentage: 2.9, fixed: 30, currency: 'USD' },
          limits: { dailyVolume: 1000000 },
        },
      ];
      mockGetPaymentProcessors.mockResolvedValue(processors);

      const res = await request(app).get('/api/payment-central/processors');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].id).toBe('proc_001');
    });

    it('error path — service throws, returns 500', async () => {
      mockGetPaymentProcessors.mockRejectedValue(new Error('DB unavailable'));

      const res = await request(app).get('/api/payment-central/processors');

      expect(res.status).toBe(500);
    });
  });

  // ==================== GET /transactions ====================

  describe('GET /transactions', () => {
    it('happy path — returns {transactions, totalCount} with 200', async () => {
      const payload = {
        transactions: [
          { id: 'txn_001', amount: 5000, status: 'completed', timestamp: Date.now() },
        ],
        totalCount: 1,
      };
      mockGetTransactions.mockResolvedValue(payload);

      const res = await request(app).get('/api/payment-central/transactions');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('transactions');
      expect(res.body).toHaveProperty('totalCount');
      expect(res.body.totalCount).toBe(1);
    });

    it('query params — forwards parsed filters to getTransactions', async () => {
      const payload = {
        transactions: [
          { id: 'txn_001', amount: 5000, status: 'completed', timestamp: Date.now() },
        ],
        totalCount: 1,
      };
      mockGetTransactions.mockResolvedValue(payload);

      const res = await request(app)
        .get('/api/payment-central/transactions')
        .query({
          limit: '5',
          status: 'completed',
          processorIds: ['proc-1', 'proc-2'],
          startDate: '1000',
          endDate: '2000',
          minAmount: '10',
          maxAmount: '100',
          customerIds: 'cust-1',
          syncStatus: 'synced',
        });

      expect(res.status).toBe(200);
      expect(mockGetTransactions).toHaveBeenCalledWith({
        limit: 5,
        offset: 0,
        status: ['completed'],
        processorIds: ['proc-1', 'proc-2'],
        dateRange: { start: 1000, end: 2000 },
        amountRange: { min: 10, max: 100 },
        customerIds: ['cust-1'],
        syncStatus: ['synced'],
      });
    });

    it('error path — service throws, returns 500', async () => {
      mockGetTransactions.mockRejectedValue(new Error('Query failed'));

      const res = await request(app).get('/api/payment-central/transactions');

      expect(res.status).toBe(500);
    });
  });

  // ==================== POST /reconciliation/reports ====================

  describe('POST /reconciliation/reports', () => {
    it('happy path — returns {reportId} with 201', async () => {
      mockGenerateReconciliationReport.mockResolvedValue('report_abc123');

      const res = await request(app)
        .post('/api/payment-central/reconciliation/reports')
        .send({ startDate: Date.now() - 86400000, endDate: Date.now(), processorIds: [] });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('reportId');
      expect(res.body.reportId).toBe('report_abc123');
    });

    it('error path — missing startDate returns 400', async () => {
      const res = await request(app)
        .post('/api/payment-central/reconciliation/reports')
        .send({ endDate: Date.now() });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== POST /dunning/entries/:entryId/ai-analyze ====================

  describe('POST /dunning/entries/:entryId/ai-analyze', () => {
    it('happy path — returns ai analysis preview with 200', async () => {
      const mockEntry = {
        id: 'dun_001',
        customerId: 'cust_001',
        customerName: 'ACME Corp',
        invoiceAmount: 5000,
        amountDue: 5000,
        daysOverdue: 30,
        status: 'pending',
      };
      // Mock matches the real DunningOutput shape from
      // src/services/ai/orchestrator/agents/DunningAgent.ts so the router
      // test exercises the same response-extraction path production uses.
      const mockAnalysis = {
        success: true,
        message: 'Analysis complete',
        aiAnalysis: {
          recommendedAction: 'send_email',
          recommendedTone: 'neutral',
          generatedMessage: {
            subject: 'Payment reminder for invoice',
            body: 'Please pay your outstanding invoice of $5,000 at your earliest convenience.',
            callToAction: 'Submit payment or contact us if you need assistance.',
          },
          sentimentAnalysis: {
            customerSentiment: 'neutral',
            paymentLikelihood: 0.7,
            churnRisk: 0.3,
          },
          recommendations: [],
          escalationPath: {
            nextLevel: 2,
            nextAction: 'send_email',
            suggestedDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
          },
        },
      };
      mockGetDunningEntry.mockResolvedValue(mockEntry);
      mockAnalyzeDunningEntry.mockResolvedValue(mockAnalysis);

      const res = await request(app)
        .post('/api/payment-central/dunning/entries/dun_001/ai-analyze');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entryId', 'dun_001');
      expect(res.body).toHaveProperty('entry');
      expect(res.body).toHaveProperty('preview', true);
      expect(res.body).toHaveProperty('aiAnalysis');
    });

    it('error path — entry not found returns 404', async () => {
      mockGetDunningEntry.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/payment-central/dunning/entries/non-existent/ai-analyze');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('error path — analyzeDunningEntry returns failure returns 400', async () => {
      const mockEntry = { id: 'dun_002', customerId: 'cust_002', status: 'pending' };
      mockGetDunningEntry.mockResolvedValue(mockEntry);
      mockAnalyzeDunningEntry.mockResolvedValue({
        success: false,
        message: 'AI analysis not available (no agent or schedule)',
      });

      const res = await request(app)
        .post('/api/payment-central/dunning/entries/dun_002/ai-analyze');

      expect(res.status).toBe(400);
    });
  });

  // ==================== POST /gl/journal-entries/from-transaction ====================

  describe('POST /gl/journal-entries/from-transaction', () => {
    it('happy path — returns {success: true, journalEntryId} with 201', async () => {
      mockCreateJournalEntryFromTransaction.mockResolvedValue({
        success: true,
        journalEntryId: 'je_001',
      });

      const res = await request(app)
        .post('/api/payment-central/gl/journal-entries/from-transaction')
        .send({ transactionId: 'txn_001' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.journalEntryId).toBe('je_001');
    });

    it('error path — missing transactionId returns 400', async () => {
      const res = await request(app)
        .post('/api/payment-central/gl/journal-entries/from-transaction')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('error path — service returns failure returns 400', async () => {
      mockCreateJournalEntryFromTransaction.mockResolvedValue({
        success: false,
        error: 'Transaction not found',
      });

      const res = await request(app)
        .post('/api/payment-central/gl/journal-entries/from-transaction')
        .send({ transactionId: 'txn_does_not_exist' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ==================== GET /invoices ====================

  describe('GET /invoices', () => {
    it('happy path — returns {invoices, totalCount} with 200', async () => {
      const payload = {
        invoices: [
          { id: 'inv_001', vendorId: 'VENDOR-001', amount: 1000, matchStatus: 'pending' },
        ],
        totalCount: 1,
      };
      mockGetInvoices.mockResolvedValue(payload);

      const res = await request(app).get('/api/payment-central/invoices');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('invoices');
      expect(res.body).toHaveProperty('totalCount');
      expect(res.body.totalCount).toBe(1);
    });

    it('error path — service throws, returns 500', async () => {
      mockGetInvoices.mockRejectedValue(new Error('Storage error'));

      const res = await request(app).get('/api/payment-central/invoices');

      expect(res.status).toBe(500);
    });
  });

  describe('attribution hardening (resolveActor)', () => {
    it('approve: authenticated identity overrides a spoofed body approvedBy', async () => {
      mockApproveInvoice.mockResolvedValue({ success: true });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/invoices/inv1/approve')
        .send({ approvedBy: 'ceo@evil.example' })
        .expect(200);
      expect(mockApproveInvoice).toHaveBeenCalledWith('tenant-a', 'inv1', 'alice');
    });

    it('approve: authenticated request needs no body approvedBy', async () => {
      mockApproveInvoice.mockResolvedValue({ success: true });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/invoices/inv1/approve')
        .send({})
        .expect(200);
      expect(mockApproveInvoice).toHaveBeenCalledWith('tenant-a', 'inv1', 'alice');
    });

    it('approve: pre-auth still 400s on missing approvedBy', async () => {
      await request(createApp())
        .post('/api/payment-central/invoices/inv1/approve')
        .send({})
        .expect(400);
      expect(mockApproveInvoice).not.toHaveBeenCalled();
    });

    it('approve: pre-auth uses a valid body approvedBy', async () => {
      mockApproveInvoice.mockResolvedValue({ success: true });
      await request(createApp())
        .post('/api/payment-central/invoices/inv1/approve')
        .send({ approvedBy: 'demo-approver' })
        .expect(200);
      expect(mockApproveInvoice).toHaveBeenCalledWith('__system__', 'inv1', 'demo-approver');
    });

    it('createInvoice: authenticated identity overrides body createdBy', async () => {
      mockCreateInvoice.mockResolvedValue({ id: 'inv1' });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/invoices')
        .send({ vendorId: 'v1', invoiceNumber: 'N1', amount: 10, lineItems: [{}], createdBy: 'spoof' })
        .expect(201);
      expect(mockCreateInvoice).toHaveBeenCalledWith('tenant-a', 'v1', expect.objectContaining({ invoiceNumber: 'N1' }), 'alice');
    });

    it('createInvoice: pre-auth with no createdBy falls back to "api"', async () => {
      mockCreateInvoice.mockResolvedValue({ id: 'inv1' });
      await request(createApp())
        .post('/api/payment-central/invoices')
        .send({ vendorId: 'v1', invoiceNumber: 'N1', amount: 10, lineItems: [{}] })
        .expect(201);
      expect(mockCreateInvoice).toHaveBeenCalledWith('__system__', 'v1', expect.objectContaining({ invoiceNumber: 'N1' }), 'api');
    });

    it('dispute: authenticated identity overrides spoofed createdBy', async () => {
      mockCreateInvoiceDispute.mockResolvedValue({ success: true, dispute: { id: 'd1' } });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/invoices/inv1/dispute')
        .send({ reason: 'r', description: 'd', createdBy: 'spoof' })
        .expect(201);
      expect(mockCreateInvoiceDispute).toHaveBeenCalledWith('tenant-a', 'inv1', 'r', 'd', 'alice');
    });

    it('dispute: pre-auth 400s on missing createdBy', async () => {
      await request(createApp())
        .post('/api/payment-central/invoices/inv1/dispute')
        .send({ reason: 'r', description: 'd' })
        .expect(400);
      expect(mockCreateInvoiceDispute).not.toHaveBeenCalled();
    });

    it('credit-memo: authenticated identity overrides spoofed createdBy', async () => {
      mockCreateCreditMemo.mockResolvedValue({ id: 'cm1' });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/credit-memos')
        .send({ invoiceId: 'inv1', amount: 5, reason: 'r', createdBy: 'spoof' })
        .expect(201);
      expect(mockCreateCreditMemo).toHaveBeenCalledWith('tenant-a', 'inv1', 5, 'r', 'alice');
    });

    it('credit-memo: pre-auth 400s on missing createdBy', async () => {
      await request(createApp())
        .post('/api/payment-central/credit-memos')
        .send({ invoiceId: 'inv1', amount: 5, reason: 'r' })
        .expect(400);
      expect(mockCreateCreditMemo).not.toHaveBeenCalled();
    });

    it('match: authenticated identity overrides spoofed matchedBy', async () => {
      mockMatchInvoiceToPO.mockResolvedValue({ success: true });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/invoices/inv1/match')
        .send({ poId: 'po1', matchedBy: 'spoof' })
        .expect(200);
      expect(mockMatchInvoiceToPO).toHaveBeenCalledWith('tenant-a', 'inv1', 'po1', 'alice');
    });

    it('match: pre-auth with no matchedBy falls back to "api"', async () => {
      mockMatchInvoiceToPO.mockResolvedValue({ success: true });
      await request(createApp())
        .post('/api/payment-central/invoices/inv1/match')
        .send({ poId: 'po1' })
        .expect(200);
      expect(mockMatchInvoiceToPO).toHaveBeenCalledWith('__system__', 'inv1', 'po1', 'api');
    });

    it('dispute: pre-auth uses a valid body createdBy', async () => {
      mockCreateInvoiceDispute.mockResolvedValue({ success: true, dispute: { id: 'd1' } });
      await request(createApp())
        .post('/api/payment-central/invoices/inv1/dispute')
        .send({ reason: 'r', description: 'd', createdBy: 'demo-user' })
        .expect(201);
      expect(mockCreateInvoiceDispute).toHaveBeenCalledWith('__system__', 'inv1', 'r', 'd', 'demo-user');
    });

    it('credit-memo: pre-auth uses a valid body createdBy', async () => {
      mockCreateCreditMemo.mockResolvedValue({ id: 'cm1' });
      await request(createApp())
        .post('/api/payment-central/credit-memos')
        .send({ invoiceId: 'inv1', amount: 5, reason: 'r', createdBy: 'demo-user' })
        .expect(201);
      expect(mockCreateCreditMemo).toHaveBeenCalledWith('__system__', 'inv1', 5, 'r', 'demo-user');
    });

    it('gl approve-journal: authenticated identity overrides body approvedBy', async () => {
      mockApproveJournalEntry.mockResolvedValue({ id: 'je1' });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/gl/journal-entries/je1/approve')
        .send({ approvedBy: 'spoof' })
        .expect(200);
      expect(mockApproveJournalEntry).toHaveBeenCalledWith('je1', 'alice');
    });

    it('gl approve-journal: pre-auth with no approvedBy defaults to "system"', async () => {
      mockApproveJournalEntry.mockResolvedValue({ id: 'je1' });
      await request(createApp())
        .post('/api/payment-central/gl/journal-entries/je1/approve')
        .send({})
        .expect(200);
      expect(mockApproveJournalEntry).toHaveBeenCalledWith('je1', 'system');
    });

    it('gl post-journal: authenticated identity overrides body postedBy', async () => {
      mockPostJournalEntry.mockResolvedValue({ success: true });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/gl/journal-entries/je1/post')
        .send({ postedBy: 'spoof' })
        .expect(200);
      expect(mockPostJournalEntry).toHaveBeenCalledWith('je1', 'alice');
    });

    it('gl post-journal: pre-auth defaults to "system"', async () => {
      mockPostJournalEntry.mockResolvedValue({ success: true });
      await request(createApp())
        .post('/api/payment-central/gl/journal-entries/je1/post')
        .send({})
        .expect(200);
      expect(mockPostJournalEntry).toHaveBeenCalledWith('je1', 'system');
    });

    it('gl batches-create: authenticated identity overrides body createdBy', async () => {
      mockCreatePostingBatch.mockResolvedValue({ id: 'b1' });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/gl/batches')
        .send({ name: 'B', entryIds: ['je1'], createdBy: 'spoof' })
        .expect(201);
      expect(mockCreatePostingBatch).toHaveBeenCalledWith('B', ['je1'], 'alice');
    });

    it('gl batches-process: authenticated identity overrides body processedBy', async () => {
      mockProcessPostingBatch.mockResolvedValue({ id: 'b1', status: 'processed' });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/gl/batches/b1/process')
        .send({ processedBy: 'spoof' })
        .expect(200);
      expect(mockProcessPostingBatch).toHaveBeenCalledWith('b1', 'alice');
    });

    it('gl batches-process: pre-auth defaults to "system"', async () => {
      mockProcessPostingBatch.mockResolvedValue({ id: 'b1', status: 'processed' });
      await request(createApp())
        .post('/api/payment-central/gl/batches/b1/process')
        .send({})
        .expect(200);
      expect(mockProcessPostingBatch).toHaveBeenCalledWith('b1', 'system');
    });

    it('dispute-resolve: authenticated identity overrides spoofed resolvedBy', async () => {
      mockResolveDispute.mockResolvedValue({ success: true });
      await request(createAuthedApp('alice'))
        .post('/api/payment-central/disputes/d1/resolve')
        .send({ type: 'credit', description: 'x', resolvedBy: 'spoof' })
        .expect(200);
      expect(mockResolveDispute).toHaveBeenCalledWith('tenant-a', 'd1', { type: 'credit', description: 'x', adjustedAmount: undefined }, 'alice');
    });

    it('dispute-resolve: pre-auth 400s on missing resolvedBy', async () => {
      await request(createApp())
        .post('/api/payment-central/disputes/d1/resolve')
        .send({ type: 'credit', description: 'x' })
        .expect(400);
      expect(mockResolveDispute).not.toHaveBeenCalled();
    });
  });
});
