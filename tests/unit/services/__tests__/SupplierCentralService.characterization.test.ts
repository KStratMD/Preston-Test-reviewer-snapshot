/**
 * SupplierCentralService characterization suite.
 *
 * Locks the current god-class facade behavior before Task 2+ begins extracting
 * collaborators. Intentionally uses the DI-free harness (no Inversify container)
 * so these tests exercise the exact constructor shape the service exposes today.
 *
 * Assertions below are anchored to specific line ranges in
 * src/services/SupplierCentralService.ts so future refactors can verify the
 * pre/post behavior is identical. Line references are noted in each test.
 */

import { createSupplierCentralService } from './helpers/createSupplierCentralService';

async function createDocumentUploadVendor(service) {
  return service.createVendorProfile({
    basicInfo: {
      companyName: 'Document Upload Vendor',
      taxId: '77-7777777',
      industry: 'Services',
      companySize: 'small',
    },
    contacts: {
      primary: {
        firstName: 'Doc',
        lastName: 'Owner',
        title: 'Manager',
        email: 'document-upload@test.com',
        phone: '555-7000',
      },
    },
    addresses: {
      headquarters: {
        street1: '7 Upload Ave',
        city: 'Doc City',
        state: 'TX',
        postalCode: '75001',
        country: 'USA',
      },
    },
    banking: {
      accountName: 'Document Upload Vendor',
      accountNumber: '****7777',
      routingNumber: '777777777',
      bankName: 'Doc Bank',
      accountType: 'business',
      currency: 'USD',
    },
    compliance: {
      w9Form: { status: 'pending' },
      insurance: {
        generalLiability: { status: 'pending' },
        workersComp: { status: 'pending' },
        professionalLiability: { status: 'not_required' },
      },
      certifications: [],
    },
    capabilities: {
      services: [],
      specializations: [],
      geographicCoverage: [],
      languages: [],
      businessHours: {
        timezone: 'America/Chicago',
        monday: null,
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
      capacity: {},
    },
  });
}

describe('SupplierCentralService — characterization (pre-refactor behavior lock)', () => {
  describe('getVendorProfiles', () => {
    it('returns {vendors, totalCount} with at least 2 demo-seeded vendors', async () => {
      const { service } = createSupplierCentralService();
      const result = await service.getVendorProfiles({});

      expect(result).toHaveProperty('vendors');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.length).toBeGreaterThanOrEqual(2);
      expect(result.totalCount).toBeGreaterThanOrEqual(2);
    });

    it('filters by stage (only returns matching stage — service:835-837)', async () => {
      const { service } = createSupplierCentralService();
      // Demo seed at src/services/SupplierCentralService.ts:1488-1529 includes
      // 5 vendors with stages: active, compliance_review, documents_pending,
      // profile_complete, approved. At least one has stage === 'approved'.
      const result = await service.getVendorProfiles({ stage: ['approved'] });

      expect(result.vendors.length).toBeGreaterThan(0);
      expect(result.vendors.every(v => v.onboardingStatus.stage === 'approved')).toBe(true);
    });

    it('respects limit while totalCount reflects unfiltered total (service:869-877)', async () => {
      const { service } = createSupplierCentralService();
      const unfiltered = await service.getVendorProfiles({});
      const limited = await service.getVendorProfiles({ limit: 1 });

      expect(limited.vendors.length).toBeLessThanOrEqual(1);
      // totalCount is pre-pagination count from service:869
      expect(limited.totalCount).toBe(unfiltered.totalCount);
    });
  });

  describe('createVendorProfile + getVendorProfile round-trip', () => {
    it('returns a vendor_-prefixed id that is retrievable (service:378-431)', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await service.createVendorProfile({
        basicInfo: {
          companyName: 'Characterization Vendor',
          taxId: '99-9999999',
          industry: 'Tech',
          companySize: 'small',
        },
        contacts: {
          primary: {
            firstName: 'Char',
            lastName: 'Test',
            title: 'CEO',
            email: 'char@test.com',
            phone: '555-9999',
          },
        },
        addresses: {
          headquarters: {
            street1: '1 Char St',
            city: 'Chartown',
            state: 'CA',
            postalCode: '90001',
            country: 'USA',
          },
        },
        banking: {
          accountName: 'Characterization Vendor',
          accountNumber: '****9999',
          routingNumber: '999999999',
          bankName: 'Char Bank',
          accountType: 'business',
          currency: 'USD',
        },
        compliance: {
          w9Form: { status: 'pending' },
          insurance: {
            generalLiability: { status: 'pending' },
            workersComp: { status: 'not_required' },
            professionalLiability: { status: 'not_required' },
          },
          certifications: [],
        },
        capabilities: {
          services: [],
          specializations: [],
          geographicCoverage: [],
          languages: [],
          businessHours: {
            timezone: 'America/Los_Angeles',
            monday: null,
            tuesday: null,
            wednesday: null,
            thursday: null,
            friday: null,
            saturday: null,
            sunday: null,
          },
          capacity: {},
        },
      });

      expect(vendorId).toMatch(/^vendor_/);
      const profile = await service.getVendorProfile(vendorId);
      expect(profile).not.toBeNull();
      expect(profile?.id).toBe(vendorId);
      expect(profile?.basicInfo.companyName).toBe('Characterization Vendor');
    });
  });

  describe('uploadDocument', () => {
    it('returns a fresh vendor snapshot after upload updates', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await createDocumentUploadVendor(service);
      const vendorBeforeUpload = await service.getVendorProfile(vendorId);

      await service.uploadDocument(vendorId, 'w9', {
        fileName: 'w9.pdf',
        fileSize: 102400,
        mimeType: 'application/pdf',
      });

      const vendorAfterUpload = await service.getVendorProfile(vendorId);
      expect(vendorAfterUpload).not.toBe(vendorBeforeUpload);
      expect(vendorBeforeUpload?.compliance.w9Form.status).toBe('pending');
      expect(vendorAfterUpload?.compliance.w9Form.status).toBe('submitted');
    });

    it('uses the runtime createId format for the upload note id', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await createDocumentUploadVendor(service);

      await service.uploadDocument(vendorId, 'w9', {
        fileName: 'w9.pdf',
        fileSize: 102400,
        mimeType: 'application/pdf',
      });

      const vendor = await service.getVendorProfile(vendorId);
      const uploadNote = vendor?.onboardingStatus.notes.at(-1);
      expect(uploadNote?.content).toContain('W9 document uploaded: w9.pdf');
      expect(uploadNote?.id).toMatch(/^note_\d+_[a-z0-9]+$/);
    });

    it('strips path traversal and unsafe characters from uploadUrl', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await createDocumentUploadVendor(service);

      const result = await service.uploadDocument(vendorId, 'w9', {
        fileName: '../../etc/passwd',
        fileSize: 1024,
        mimeType: 'application/pdf',
      });

      expect(result.uploadUrl).not.toContain('..');
      expect(result.uploadUrl).not.toContain('etc/passwd');
      expect(result.uploadUrl).toMatch(/_passwd$/);

      const resultWithSpaces = await service.uploadDocument(vendorId, 'w9', {
        fileName: 'my file?name&evil.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
      });
      expect(resultWithSpaces.uploadUrl).toMatch(/_my_file_name_evil\.pdf$/);
    });
  });

  describe('AI-absent fallbacks', () => {
    it('parseDocument returns exact error when documentParsingAgent absent (service:751-753)', async () => {
      const { service } = createSupplierCentralService();
      const result = await service.parseDocument(
        'doc-1',
        { fileName: 'test.pdf', mimeType: 'application/pdf', content: 'base64data' },
      );

      expect(result).toEqual({ success: false, error: 'Document parsing agent not available' });
    });

    it('assessVendorForApproval returns exact fallback when vendorOnboardingAgent absent (service:947-950)', async () => {
      const { service } = createSupplierCentralService();
      const seeded = await service.getVendorProfiles({});
      const vendorId = seeded.vendors[0].id;

      const result = await service.assessVendorForApproval(vendorId);

      expect(result).toEqual({
        vendorId,
        assessment: null,
        error: 'AI assessment not available',
      });
    });
  });

  describe('approveVendor', () => {
    it('flips stage to approved OR active because BC sync runs inline (service:885-931, 1163-1227)', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await service.createVendorProfile({
        basicInfo: {
          companyName: 'Approve Me',
          taxId: '55-5555555',
          industry: 'Tech',
          companySize: 'small',
        },
        contacts: {
          primary: { firstName: 'A', lastName: 'B', title: 'CEO', email: 'ab@t.com', phone: '555-1111' },
        },
        addresses: {
          headquarters: { street1: '1 X', city: 'Y', state: 'CA', postalCode: '00001', country: 'USA' },
        },
        banking: {
          accountName: 'Approve Me',
          accountNumber: '****0000',
          routingNumber: '000000000',
          bankName: 'B',
          accountType: 'business',
          currency: 'USD',
        },
        compliance: {
          w9Form: { status: 'verified' },
          insurance: {
            generalLiability: { status: 'verified' },
            workersComp: { status: 'not_required' },
            professionalLiability: { status: 'not_required' },
          },
          certifications: [],
        },
        capabilities: {
          services: [],
          specializations: [],
          geographicCoverage: [],
          languages: [],
          businessHours: {
            timezone: 'America/Los_Angeles',
            monday: null,
            tuesday: null,
            wednesday: null,
            thursday: null,
            friday: null,
            saturday: null,
            sunday: null,
          },
          capacity: {},
        },
      });

      await service.approveVendor(vendorId, 'approver@test.com');
      const vendor = await service.getVendorProfile(vendorId);

      // approveVendor sets stage to 'approved' at service:892 then immediately
      // calls syncVendorToBusinessCentral at service:930, which (on success)
      // flips stage to 'active' at service:1181.
      expect(['approved', 'active']).toContain(vendor?.onboardingStatus.stage);
      expect(vendor?.onboardingStatus.progress).toBe(100);
    });
  });

  describe('rejectVendor', () => {
    it('flips stage to rejected and stores reason (service:1127-1158)', async () => {
      const { service } = createSupplierCentralService();
      const vendorId = await service.createVendorProfile({
        basicInfo: {
          companyName: 'Reject Me',
          taxId: '66-6666666',
          industry: 'Tech',
          companySize: 'small',
        },
        contacts: {
          primary: { firstName: 'R', lastName: 'M', title: 'CEO', email: 'rm@t.com', phone: '555-2222' },
        },
        addresses: {
          headquarters: { street1: '1 R', city: 'S', state: 'CA', postalCode: '00002', country: 'USA' },
        },
        banking: {
          accountName: 'Reject Me',
          accountNumber: '****0000',
          routingNumber: '000000000',
          bankName: 'B',
          accountType: 'business',
          currency: 'USD',
        },
        compliance: {
          w9Form: { status: 'pending' },
          insurance: {
            generalLiability: { status: 'pending' },
            workersComp: { status: 'not_required' },
            professionalLiability: { status: 'not_required' },
          },
          certifications: [],
        },
        capabilities: {
          services: [],
          specializations: [],
          geographicCoverage: [],
          languages: [],
          businessHours: {
            timezone: 'America/Los_Angeles',
            monday: null,
            tuesday: null,
            wednesday: null,
            thursday: null,
            friday: null,
            saturday: null,
            sunday: null,
          },
          capacity: {},
        },
      });

      await service.rejectVendor(vendorId, 'reviewer@test.com', 'failed compliance');
      const vendor = await service.getVendorProfile(vendorId);

      expect(vendor?.onboardingStatus.stage).toBe('rejected');
      expect(vendor?.onboardingStatus.rejectionReason).toBe('failed compliance');
    });
  });

  describe('getOnboardingStats', () => {
    it('returns all 5 top-level blocks (service:1313-1326)', async () => {
      const { service } = createSupplierCentralService();
      const stats = await service.getOnboardingStats();

      expect(stats).toHaveProperty('summary');
      expect(stats).toHaveProperty('byStage');
      expect(stats).toHaveProperty('byIndustry');
      expect(stats).toHaveProperty('complianceStats');
      expect(stats).toHaveProperty('recentActivity');
    });
  });

  describe('getPortalActivity', () => {
    it('returns {activities, totalCount} with at least one entry (service:1332-1351)', async () => {
      const { service } = createSupplierCentralService();
      const result = await service.getPortalActivity();

      expect(result).toHaveProperty('activities');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.activities)).toBe(true);
      expect(result.activities.length).toBeGreaterThan(0);
    });
  });

  describe('createPurchaseOrder', () => {
    it('returns populated PO with status pending_acknowledgement (service:1831-2017)', async () => {
      const { service } = createSupplierCentralService();
      const seeded = await service.getVendorProfiles({});
      const vendorId = seeded.vendors[0].id;

      const po = await service.createPurchaseOrder({
        vendorId,
        lines: [{
          itemId: 'I1',
          itemName: 'Item 1',
          description: 'd',
          quantity: 2,
          unitPrice: 10,
          expectedShipDate: Date.now() + 86400000,
        }],
      });

      expect(po.vendorId).toBe(vendorId);
      expect(po.status).toBe('pending_acknowledgement');
      expect(po.lines.length).toBe(1);
      expect(po.lines[0].itemName).toBe('Item 1');
      expect(po.total).toBeGreaterThan(0);
    });
  });

  describe('acknowledgePurchaseOrder', () => {
    it('returns PO with status acknowledged (service:2022-2097)', async () => {
      const { service } = createSupplierCentralService();
      const seeded = await service.getVendorProfiles({});
      const vendorId = seeded.vendors[0].id;

      const po = await service.createPurchaseOrder({
        vendorId,
        lines: [{
          itemId: 'I1',
          itemName: 'Item 1',
          description: 'd',
          quantity: 1,
          unitPrice: 5,
          expectedShipDate: Date.now() + 86400000,
        }],
      });

      const ack = await service.acknowledgePurchaseOrder(po.id, { acknowledgedBy: 'tester' });

      expect(ack.status).toBe('acknowledged');
      expect(ack.acknowledgement?.acknowledgedBy).toBe('tester');
    });
  });

  describe('createAdvancedShippingNotice', () => {
    it('returns ASN with status created (service:2102-2156)', async () => {
      const { service } = createSupplierCentralService();
      const seeded = await service.getVendorProfiles({});
      const vendorId = seeded.vendors[0].id;

      const po = await service.createPurchaseOrder({
        vendorId,
        lines: [{
          itemId: 'I1',
          itemName: 'Item 1',
          description: 'd',
          quantity: 3,
          unitPrice: 7,
          expectedShipDate: Date.now() + 86400000,
        }],
      });
      await service.acknowledgePurchaseOrder(po.id, { acknowledgedBy: 'tester' });

      const asn = await service.createAdvancedShippingNotice({
        purchaseOrderId: po.id,
        vendorId,
        carrierName: 'UPS',
        trackingNumber: 'T1',
        shipDate: Date.now(),
        estimatedDeliveryDate: Date.now() + 86400000,
        lines: [{
          poLineId: po.lines[0].id,
          quantityShipped: 3,
        }],
      });

      expect(asn.status).toBe('created');
      expect(asn.asnNumber).toBeDefined();
      expect(asn.purchaseOrderId).toBe(po.id);
    });
  });

  describe('getNetSuiteSyncStatus', () => {
    it('returns {summary, recentSyncs, failedSyncs, governance} (service:2511-2581)', async () => {
      const { service } = createSupplierCentralService();
      const status = await service.getNetSuiteSyncStatus();

      expect(status).toHaveProperty('summary');
      expect(status).toHaveProperty('recentSyncs');
      expect(status).toHaveProperty('failedSyncs');
      expect(status).toHaveProperty('governance');
    });
  });

  describe('getGovernanceMetrics', () => {
    it('returns {requestsInLastMinute, activeRequests, config, healthStatus} (service:2634-2658)', async () => {
      const { service } = createSupplierCentralService();
      const metrics = service.getGovernanceMetrics();

      expect(metrics).toHaveProperty('requestsInLastMinute');
      expect(metrics).toHaveProperty('activeRequests');
      expect(metrics).toHaveProperty('config');
      expect(metrics).toHaveProperty('healthStatus');
    });
  });
});
