/**
 * Route regression suite for supplierCentral.ts.
 * The route file is the unit under test; SupplierCentralService is mocked at
 * the inversify boundary (same pattern as paymentCentral.router.test.ts).
 *
 * Goal: lock the HTTP contract (status codes, param shapes, response shapes)
 * before Task 2+ begins splitting the facade, so refactors preserve external
 * behavior byte-for-byte.
 */

import request from 'supertest';
import express from 'express';

// ---- Mock service methods (only what the routes actually call) ----
const mockCreateVendorProfile = jest.fn();
const mockGetVendorProfiles = jest.fn();
const mockGetVendorProfile = jest.fn();
const mockUploadDocument = jest.fn();
const mockParseDocument = jest.fn();
const mockAssessVendorForApproval = jest.fn();
const mockSyncVendorToBusinessCentral = jest.fn();
const mockGetPurchaseOrdersForVendor = jest.fn();
const mockCreatePurchaseOrder = jest.fn();
const mockAcknowledgePurchaseOrder = jest.fn();
const mockCreateAdvancedShippingNotice = jest.fn();
const mockSyncVendorToNetSuite = jest.fn();
const mockGetNetSuiteSyncStatus = jest.fn();
const mockGetGovernanceMetrics = jest.fn();
const mockUpdateGovernanceConfig = jest.fn();
const mockUpdateASNStatus = jest.fn();

const mockSupplierService = {
  createVendorProfile: mockCreateVendorProfile,
  getVendorProfiles: mockGetVendorProfiles,
  getVendorProfile: mockGetVendorProfile,
  uploadDocument: mockUploadDocument,
  parseDocument: mockParseDocument,
  assessVendorForApproval: mockAssessVendorForApproval,
  syncVendorToBusinessCentral: mockSyncVendorToBusinessCentral,
  getPurchaseOrdersForVendor: mockGetPurchaseOrdersForVendor,
  createPurchaseOrder: mockCreatePurchaseOrder,
  acknowledgePurchaseOrder: mockAcknowledgePurchaseOrder,
  createAdvancedShippingNotice: mockCreateAdvancedShippingNotice,
  syncVendorToNetSuite: mockSyncVendorToNetSuite,
  getNetSuiteSyncStatus: mockGetNetSuiteSyncStatus,
  getGovernanceMetrics: mockGetGovernanceMetrics,
  updateGovernanceConfig: mockUpdateGovernanceConfig,
  updateASNStatus: mockUpdateASNStatus,
  // Additional methods some routes may touch but that we don't exercise here
  updateVendorProfile: jest.fn(),
  approveVendor: jest.fn(),
  rejectVendor: jest.fn(),
  getOnboardingStats: jest.fn(),
  getPortalActivity: jest.fn(),
  getPurchaseOrder: jest.fn(),
  getAdvancedShippingNoticesForVendor: jest.fn(),
  getAdvancedShippingNoticesForPO: jest.fn(),
  batchSyncVendorsToNetSuite: jest.fn(),
  syncPurchaseOrderToNetSuite: jest.fn(),
};

// Mock the inversify container before importing the router
jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('SupplierCentralService')) return mockSupplierService;
      return {};
    }),
  },
}));

import { supplierCentralRouter } from '../../../../src/routes/supplierCentral';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/supplier-central', supplierCentralRouter);
  return app;
}

describe('supplierCentral router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  // ==================== POST /vendors ====================

  describe('POST /vendors', () => {
    it('happy path — returns 201 with vendorId', async () => {
      mockCreateVendorProfile.mockResolvedValue('vendor_abc123');

      const res = await request(app)
        .post('/api/supplier-central/vendors')
        .send({ basicInfo: { companyName: 'X' } });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('vendorId', 'vendor_abc123');
    });
  });

  // ==================== GET /vendors ====================

  describe('GET /vendors', () => {
    it('happy path — returns {vendors, totalCount} with 200', async () => {
      const payload = {
        vendors: [{ id: 'vendor_1', basicInfo: { companyName: 'V1' } }],
        totalCount: 1,
      };
      mockGetVendorProfiles.mockResolvedValue(payload);

      const res = await request(app).get('/api/supplier-central/vendors');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('vendors');
      expect(res.body).toHaveProperty('totalCount', 1);
    });
  });

  // ==================== POST /vendors/:vendorId/documents ====================

  describe('POST /vendors/:vendorId/documents', () => {
    it('happy path — returns 201 with upload result', async () => {
      mockUploadDocument.mockResolvedValue({ documentId: 'doc_1', uploadUrl: '/uploads/doc_1' });

      const res = await request(app)
        .post('/api/supplier-central/vendors/v1/documents')
        .send({
          documentType: 'w9',
          fileName: 'w9.pdf',
          fileSize: 1024,
          mimeType: 'application/pdf',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('documentId', 'doc_1');
    });

    it('error path — missing documentType returns 400', async () => {
      const res = await request(app)
        .post('/api/supplier-central/vendors/v1/documents')
        .send({ fileName: 'only-name.pdf' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== POST /documents/:documentId/parse ====================

  describe('POST /documents/:documentId/parse', () => {
    it('happy path — returns 200 with parsing result', async () => {
      mockParseDocument.mockResolvedValue({
        success: true,
        parsing: { documentType: 'w9', confidence: 0.95 },
      });

      const res = await request(app)
        .post('/api/supplier-central/documents/doc_1/parse')
        .send({ fileName: 'w9.pdf', content: 'base64data' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('documentId', 'doc_1');
      expect(res.body).toHaveProperty('parsing');
    });

    it('error path — service returns failure returns 400', async () => {
      mockParseDocument.mockResolvedValue({
        success: false,
        error: 'Document parsing agent not available',
      });

      const res = await request(app)
        .post('/api/supplier-central/documents/doc_1/parse')
        .send({ fileName: 'w9.pdf', content: 'base64data' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== GET /vendors/:vendorId/ai-assessment ====================

  describe('GET /vendors/:vendorId/ai-assessment', () => {
    it('happy path with AI-absent fallback — service returns error, route returns 400', async () => {
      mockGetVendorProfile.mockResolvedValue({
        id: 'v1',
        basicInfo: { companyName: 'V1' },
        metadata: { customFields: {} },
      });
      mockAssessVendorForApproval.mockResolvedValue({
        vendorId: 'v1',
        assessment: null,
        error: 'AI assessment not available',
      });

      const res = await request(app).get('/api/supplier-central/vendors/v1/ai-assessment');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error', 'AI assessment not available');
    });

    it('error path — vendor not found returns 404', async () => {
      mockGetVendorProfile.mockResolvedValue(null);

      const res = await request(app).get('/api/supplier-central/vendors/missing/ai-assessment');

      expect(res.status).toBe(404);
    });
  });

  // ==================== POST /vendors/:vendorId/ai-recommend ====================

  describe('POST /vendors/:vendorId/ai-recommend', () => {
    it('AI-absent fallback — returns 400 with fallbackRecommendation', async () => {
      mockGetVendorProfile.mockResolvedValue({
        id: 'v1',
        basicInfo: { companyName: 'V1' },
        onboardingStatus: { stage: 'profile_complete' },
      });
      mockAssessVendorForApproval.mockResolvedValue({
        vendorId: 'v1',
        assessment: null,
        error: 'AI assessment not available',
      });

      const res = await request(app).post('/api/supplier-central/vendors/v1/ai-recommend');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error', 'AI assessment not available');
      expect(res.body).toHaveProperty('fallbackRecommendation');
      expect(res.body.fallbackRecommendation).toHaveProperty('recommend', 'review');
    });
  });

  // ==================== POST /vendors/:vendorId/sync ====================

  describe('POST /vendors/:vendorId/sync', () => {
    it('happy path — returns BC sync result with 200', async () => {
      mockSyncVendorToBusinessCentral.mockResolvedValue({
        success: true,
        bcVendorId: 'BC_V_1',
      });

      const res = await request(app).post('/api/supplier-central/vendors/v1/sync');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('bcVendorId', 'BC_V_1');
    });
  });

  // ==================== GET /vendors/:vendorId/purchase-orders ====================

  describe('GET /vendors/:vendorId/purchase-orders', () => {
    it('happy path — returns 200 with {orders, totalCount}', async () => {
      const payload = { orders: [{ id: 'po_1' }], totalCount: 1 };
      mockGetPurchaseOrdersForVendor.mockResolvedValue(payload);

      const res = await request(app).get('/api/supplier-central/vendors/v1/purchase-orders');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(res.body).toHaveProperty('orders');
      expect(res.body).not.toHaveProperty('purchaseOrders');
    });
  });

  // ==================== POST /purchase-orders ====================

  describe('POST /purchase-orders', () => {
    it('happy path — returns 201 with PO', async () => {
      mockCreatePurchaseOrder.mockResolvedValue({ id: 'po_1', vendorId: 'v1', status: 'pending_acknowledgement' });

      const res = await request(app)
        .post('/api/supplier-central/purchase-orders')
        .send({
          vendorId: 'v1',
          lines: [{ itemName: 'Item 1', quantity: 1, unitPrice: 10 }],
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id', 'po_1');
    });

    it('error path — missing vendorId and vendorName returns 400', async () => {
      const res = await request(app)
        .post('/api/supplier-central/purchase-orders')
        .send({ lines: [{ itemName: 'X', quantity: 1, unitPrice: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== POST /purchase-orders/:poId/acknowledge ====================

  describe('POST /purchase-orders/:poId/acknowledge', () => {
    it('happy path — returns 200 with acknowledged PO', async () => {
      mockAcknowledgePurchaseOrder.mockResolvedValue({ id: 'po_1', status: 'acknowledged' });

      const res = await request(app)
        .post('/api/supplier-central/purchase-orders/po_1/acknowledge')
        .send({ acknowledgedBy: 'tester' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'acknowledged');
    });
  });

  // ==================== POST /purchase-orders/:poId/asn ====================

  describe('POST /purchase-orders/:poId/asn', () => {
    it('happy path — returns 201 with ASN', async () => {
      mockCreateAdvancedShippingNotice.mockResolvedValue({
        id: 'asn_1',
        asnNumber: 'ASN-12345678',
        status: 'created',
      });

      const res = await request(app)
        .post('/api/supplier-central/purchase-orders/po_1/asn')
        .send({
          vendorId: 'v1',
          carrierName: 'UPS',
          trackingNumber: 'T1',
          shipDate: Date.now(),
          estimatedDeliveryDate: Date.now() + 86400000,
          lines: [{ poLineId: 'line_1', quantityShipped: 1 }],
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id', 'asn_1');
      expect(res.body).toHaveProperty('status', 'created');
    });
  });

  // ==================== POST /vendors/:vendorId/sync-netsuite ====================

  describe('POST /vendors/:vendorId/sync-netsuite', () => {
    it('happy path — returns NetSuite sync result', async () => {
      mockSyncVendorToNetSuite.mockResolvedValue({
        success: true,
        netSuiteId: 'NS_V_1',
      });

      const res = await request(app).post('/api/supplier-central/vendors/v1/sync-netsuite');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });
  });

  // ==================== GET /netsuite/governance ====================

  describe('GET /netsuite/governance', () => {
    it('happy path — returns 200 with metrics', async () => {
      const metrics = {
        requestsInLastMinute: 2,
        activeRequests: 0,
        config: { maxRequestsPerMinute: 60 },
        healthStatus: 'healthy',
      };
      mockGetGovernanceMetrics.mockReturnValue(metrics);

      const res = await request(app).get('/api/supplier-central/netsuite/governance');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('healthStatus', 'healthy');
    });
  });

  // ==================== PATCH /netsuite/governance ====================

  describe('PATCH /netsuite/governance', () => {
    it('happy path — returns 200 with {success, config}', async () => {
      mockGetGovernanceMetrics.mockReturnValue({
        requestsInLastMinute: 0,
        activeRequests: 0,
        config: { maxRequestsPerMinute: 120 },
        healthStatus: 'healthy',
      });

      const res = await request(app)
        .patch('/api/supplier-central/netsuite/governance')
        .send({ maxRequestsPerMinute: 120 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('config');
      expect(mockUpdateGovernanceConfig).toHaveBeenCalledWith({ maxRequestsPerMinute: 120 });
    });
  });

  // ==================== PATCH /asn/:asnId/status ====================

  describe('PATCH /asn/:asnId/status', () => {
    it('happy path — returns 200 with updated ASN', async () => {
      mockUpdateASNStatus.mockResolvedValue({
        id: 'asn_1',
        status: 'delivered',
      });

      const res = await request(app)
        .patch('/api/supplier-central/asn/asn_1/status')
        .send({ status: 'delivered' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'delivered');
    });
  });
});
