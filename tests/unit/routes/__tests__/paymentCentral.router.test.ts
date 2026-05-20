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
  approveJournalEntry: jest.fn(),
  postJournalEntry: jest.fn(),
  voidJournalEntry: jest.fn(),
  getPostingBatches: jest.fn(),
  getPostingBatch: jest.fn(),
  createPostingBatch: jest.fn(),
  processPostingBatch: jest.fn(),
  getGLPostingStatistics: jest.fn(),
  getGLPostingDashboard: jest.fn(),
  createInvoice: jest.fn(),
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
});
