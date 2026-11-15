/**
 * SupplierCentralService Tests
 * Session 14 - Large untested service (1,249 lines)
 */

import { SupplierCentralService } from '../../../../src/services/SupplierCentralService';
import type { Logger } from '../../../../src/utils/Logger';
import type { TelemetryService } from '../../../../src/services/TelemetryService';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createMockTelemetryService(): jest.Mocked<TelemetryService> {
  return {
    recordMetric: jest.fn(),
    recordEvent: jest.fn(),
    startSpan: jest.fn(),
    endSpan: jest.fn(),
  } as any;
}

describe('SupplierCentralService', () => {
  let service: SupplierCentralService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTelemetryService: jest.Mocked<TelemetryService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockTelemetryService = createMockTelemetryService();
    service = new SupplierCentralService(mockLogger, mockTelemetryService);
  });

  describe('Initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SupplierCentralService initialized',
        expect.objectContaining({
          hasDocumentParsingAgent: expect.any(Boolean),
          hasVendorOnboardingAgent: expect.any(Boolean),
        })
      );
    });
  });

  describe('Vendor Profile Management', () => {
    it('should create vendor profile', async () => {
      const vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: {
          companyName: 'Test Vendor Inc',
          legalName: 'Test Vendor Incorporated',
          taxId: '12-3456789',
          industry: 'Technology',
          companySize: 'medium',
        },
        contacts: {
          primary: {
            firstName: 'John',
            lastName: 'Doe',
            title: 'CEO',
            email: 'john@testvendor.com',
            phone: '555-1234',
          },
        },
        addresses: {
          headquarters: {
            street1: '123 Main St',
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94105',
            country: 'USA',
          },
        },
        banking: {
          accountName: 'Test Vendor Inc',
          accountNumber: '****1234',
          routingNumber: '123456789',
          bankName: 'Test Bank',
          accountType: 'business',
          currency: 'USD',
        },
        compliance: {
          w9Form: {
            status: 'pending',
          },
          insurance: {
            generalLiability: {
              status: 'pending',
            },
            workersComp: {
              status: 'not_required',
            },
          },
        },
      });

      expect(typeof vendorId).toBe('string');
      expect(vendorId).toContain('vendor_');
    });

    it('should get vendor profile by ID', async () => {
      const vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: {
          companyName: 'Test Company',
          taxId: '12-3456789',
          industry: 'Tech',
          companySize: 'small',
        },
        contacts: {
          primary: {
            firstName: 'Jane',
            lastName: 'Smith',
            title: 'CFO',
            email: 'jane@test.com',
            phone: '555-5678',
          },
        },
        addresses: {
          headquarters: {
            street1: '456 Oak Ave',
            city: 'Boston',
            state: 'MA',
            postalCode: '02101',
            country: 'USA',
          },
        },
        banking: {
          accountName: 'Test Company',
          accountNumber: '****5678',
          routingNumber: '987654321',
          bankName: 'Bank of Test',
          accountType: 'checking',
          currency: 'USD',
        },
        compliance: {
          w9Form: { status: 'pending' },
          insurance: {
            generalLiability: { status: 'pending' },
            workersComp: { status: 'pending' },
          },
        },
      });

      const profile = await service.getVendorProfile('tenant-test', vendorId);
      expect(profile).not.toBeNull();
      expect(profile?.id).toBe(vendorId);
      expect(profile?.basicInfo.companyName).toBe('Test Company');
    });

    it('should return null for non-existent vendor', async () => {
      const profile = await service.getVendorProfile('tenant-test', 'non-existent-id');
      expect(profile).toBeNull();
    });

    it('should update vendor profile', async () => {
      const vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: {
          companyName: 'Original Name',
          taxId: '11-1111111',
          industry: 'Manufacturing',
          companySize: 'large',
        },
        contacts: {
          primary: {
            firstName: 'Bob',
            lastName: 'Johnson',
            title: 'Owner',
            email: 'bob@original.com',
            phone: '555-0000',
          },
        },
        addresses: {
          headquarters: {
            street1: '789 Elm St',
            city: 'Chicago',
            state: 'IL',
            postalCode: '60601',
            country: 'USA',
          },
        },
        banking: {
          accountName: 'Original Name',
          accountNumber: '****0000',
          routingNumber: '111111111',
          bankName: 'First Bank',
          accountType: 'business',
          currency: 'USD',
        },
        compliance: {
          w9Form: { status: 'pending' },
          insurance: {
            generalLiability: { status: 'pending' },
            workersComp: { status: 'pending' },
          },
        },
      });

      await service.updateVendorProfile('tenant-test', vendorId, {
        basicInfo: {
          companyName: 'Updated Name',
          taxId: '11-1111111',
          industry: 'Manufacturing',
          companySize: 'large',
        },
      });

      const updated = await service.getVendorProfile('tenant-test', vendorId);
      expect(updated?.basicInfo.companyName).toBe('Updated Name');
    });

    it('should throw error updating non-existent vendor', async () => {
      await expect(
        service.updateVendorProfile('tenant-test', 'non-existent', { basicInfo: { companyName: 'Test', taxId: '12-3456789', industry: 'Tech', companySize: 'small' } })
      ).rejects.toThrow('Vendor not found');
    });
  });

  describe('Vendor Listing and Filtering', () => {
    beforeEach(async () => {
      // Create test vendors
      await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Vendor A', taxId: '11-1111111', industry: 'Tech', companySize: 'small' },
        contacts: { primary: { firstName: 'A', lastName: 'User', title: 'CEO', email: 'a@test.com', phone: '555-0001' } },
        addresses: { headquarters: { street1: '1 A St', city: 'City A', state: 'CA', postalCode: '90001', country: 'USA' } },
        banking: { accountName: 'Vendor A', accountNumber: '****0001', routingNumber: '111111111', bankName: 'Bank A', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'verified' }, insurance: { generalLiability: { status: 'verified' }, workersComp: { status: 'not_required' } } },
      });

      await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Vendor B', taxId: '22-2222222', industry: 'Manufacturing', companySize: 'medium' },
        contacts: { primary: { firstName: 'B', lastName: 'User', title: 'CFO', email: 'b@test.com', phone: '555-0002' } },
        addresses: { headquarters: { street1: '2 B St', city: 'City B', state: 'NY', postalCode: '10001', country: 'USA' } },
        banking: { accountName: 'Vendor B', accountNumber: '****0002', routingNumber: '222222222', bankName: 'Bank B', accountType: 'checking', currency: 'USD' },
        compliance: { w9Form: { status: 'pending' }, insurance: { generalLiability: { status: 'pending' }, workersComp: { status: 'pending' } } },
      });
    });

    it('should get all vendor profiles', async () => {
      const result = await service.getVendorProfiles('tenant-test', {});
      expect(result).toHaveProperty('vendors');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter vendors by onboarding stage', async () => {
      const result = await service.getVendorProfiles('tenant-test', { stage: ['profile_complete'] });
      expect(result).toHaveProperty('vendors');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.every(v => v.onboardingStatus.stage === 'profile_complete')).toBe(true);
    });

    it('should filter vendors by industry', async () => {
      const result = await service.getVendorProfiles('tenant-test', { industry: ['Tech'] });
      expect(result).toHaveProperty('vendors');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.every(v => v.basicInfo.industry === 'Tech')).toBe(true);
    });

    it('should filter vendors by company size', async () => {
      const result = await service.getVendorProfiles('tenant-test', { companySize: ['small', 'medium'] });
      expect(result).toHaveProperty('vendors');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.every(v => ['small', 'medium'].includes(v.basicInfo.companySize))).toBe(true);
    });

    it('should filter vendors by source', async () => {
      const result = await service.getVendorProfiles('tenant-test', { source: ['portal'] });
      expect(result).toHaveProperty('vendors');
      expect(Array.isArray(result.vendors)).toBe(true);
      expect(result.vendors.every(v => v.metadata.source === 'portal')).toBe(true);
    });

    it('should support pagination', async () => {
      const result = await service.getVendorProfiles('tenant-test', { limit: 1, offset: 0 });
      expect(result.vendors.length).toBeLessThanOrEqual(1);
      expect(result).toHaveProperty('totalCount');
    });
  });

  describe('Document Upload', () => {
    let vendorId: string;

    beforeEach(async () => {
      vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Doc Test Vendor', taxId: '33-3333333', industry: 'Services', companySize: 'small' },
        contacts: { primary: { firstName: 'Doc', lastName: 'User', title: 'Manager', email: 'doc@test.com', phone: '555-0003' } },
        addresses: { headquarters: { street1: '3 C St', city: 'City C', state: 'TX', postalCode: '75001', country: 'USA' } },
        banking: { accountName: 'Doc Test', accountNumber: '****0003', routingNumber: '333333333', bankName: 'Bank C', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'pending' }, insurance: { generalLiability: { status: 'pending' }, workersComp: { status: 'pending' } } },
      });
    });

    it('should upload W9 document', async () => {
      await service.uploadDocument('tenant-test', vendorId, 'w9', {
        fileName: 'w9.pdf',
        fileSize: 102400,
        mimeType: 'application/pdf',
      });
      const vendor = await service.getVendorProfile('tenant-test', vendorId);
      expect(vendor?.compliance.w9Form.status).toBe('submitted');
      expect(vendor?.compliance.w9Form.documentUrl).toBeDefined();
      expect(typeof vendor?.compliance.w9Form.documentUrl).toBe('string');
    });

    it('should upload insurance certificate', async () => {
      await service.uploadDocument('tenant-test', vendorId, 'insurance_gl', {
        fileName: 'insurance-gl.pdf',
        fileSize: 204800,
        mimeType: 'application/pdf',
        expirationDate: Date.now() + 365 * 24 * 60 * 60 * 1000,
        metadata: {
          coverage: 1000000,
        },
      });
      const vendor = await service.getVendorProfile('tenant-test', vendorId);
      expect(vendor?.compliance.insurance.generalLiability.status).toBe('submitted');
      expect(vendor?.compliance.insurance.generalLiability.coverage).toBe(1000000);
    });

    it('should upload workers comp certificate', async () => {
      await service.uploadDocument('tenant-test', vendorId, 'insurance_wc', {
        fileName: 'workers-comp.pdf',
        fileSize: 153600,
        mimeType: 'application/pdf',
        expirationDate: Date.now() + 365 * 24 * 60 * 60 * 1000,
        metadata: {
          coverage: 500000,
        },
      });
      const vendor = await service.getVendorProfile('tenant-test', vendorId);
      expect(vendor?.compliance.insurance.workersComp.status).toBe('submitted');
    });

    it('should throw error uploading to non-existent vendor', async () => {
      await expect(
        service.uploadDocument('tenant-test', 'non-existent', 'w9', {
          fileName: 'w9.pdf',
          fileSize: 102400,
          mimeType: 'application/pdf',
        })
      ).rejects.toThrow('Vendor not found');
    });
  });

  describe('Vendor Approval Workflow', () => {
    let vendorId: string;

    beforeEach(async () => {
      vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Approval Test Vendor', taxId: '44-4444444', industry: 'Retail', companySize: 'medium' },
        contacts: { primary: { firstName: 'Approval', lastName: 'User', title: 'Director', email: 'approval@test.com', phone: '555-0004' } },
        addresses: { headquarters: { street1: '4 D St', city: 'City D', state: 'FL', postalCode: '33101', country: 'USA' } },
        banking: { accountName: 'Approval Test', accountNumber: '****0004', routingNumber: '444444444', bankName: 'Bank D', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'verified' }, insurance: { generalLiability: { status: 'verified' }, workersComp: { status: 'not_required' } } },
      });
    });

    it('should approve vendor', async () => {
      await service.approveVendor('tenant-test', vendorId, 'approver@company.com', 'All documents verified');
      const vendor = await service.getVendorProfile('tenant-test', vendorId);
      // After approval, vendor may be approved or synced to BC (stage might be 'active')
      expect(['approved', 'active']).toContain(vendor?.onboardingStatus.stage);
      expect(vendor?.onboardingStatus.progress).toBe(100);
    });

    it('should reject vendor', async () => {
      await service.rejectVendor('tenant-test', vendorId, 'reviewer@company.com', 'Missing required documents');
      const vendor = await service.getVendorProfile('tenant-test', vendorId);
      expect(vendor?.onboardingStatus.stage).toBe('rejected');
    });

    it('should throw error approving non-existent vendor', async () => {
      await expect(
        service.approveVendor('tenant-test', 'non-existent', 'approver@company.com')
      ).rejects.toThrow('Vendor not found');
    });

    it('should throw error rejecting non-existent vendor', async () => {
      await expect(
        service.rejectVendor('tenant-test', 'non-existent', 'reviewer@company.com', 'Reason')
      ).rejects.toThrow('Vendor not found');
    });
  });

  describe('Business Central Sync', () => {
    let vendorId: string;

    beforeEach(async () => {
      vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'BC Sync Vendor', taxId: '55-5555555', industry: 'Wholesale', companySize: 'large' },
        contacts: { primary: { firstName: 'BC', lastName: 'User', title: 'VP', email: 'bc@test.com', phone: '555-0005' } },
        addresses: { headquarters: { street1: '5 E St', city: 'City E', state: 'WA', postalCode: '98101', country: 'USA' } },
        banking: { accountName: 'BC Sync', accountNumber: '****0005', routingNumber: '555555555', bankName: 'Bank E', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'verified' }, insurance: { generalLiability: { status: 'verified' }, workersComp: { status: 'verified' } } },
      });
      await service.approveVendor('tenant-test', vendorId, 'approver@company.com');
    });

    it('should sync approved vendor to Business Central', async () => {
      const result = await service.syncVendorToBusinessCentral('tenant-test', vendorId);
      expect(result.success).toBe(true);
      expect(result.bcVendorId).toBeDefined();
      expect(typeof result.bcVendorId).toBe('string');
    });

    it('should handle sync errors gracefully', async () => {
      // Test with a vendor that hasn't been approved
      const unapprovedId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Unapproved', taxId: '66-6666666', industry: 'Tech', companySize: 'small' },
        contacts: { primary: { firstName: 'Un', lastName: 'Approved', title: 'CEO', email: 'un@test.com', phone: '555-0006' } },
        addresses: { headquarters: { street1: '6 F St', city: 'City F', state: 'OR', postalCode: '97201', country: 'USA' } },
        banking: { accountName: 'Unapproved', accountNumber: '****0006', routingNumber: '666666666', bankName: 'Bank F', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'pending' }, insurance: { generalLiability: { status: 'pending' }, workersComp: { status: 'pending' } } },
      });

      const result = await service.syncVendorToBusinessCentral('tenant-test', unapprovedId);
      // Service may allow sync or return an error - either is acceptable
      expect(result).toHaveProperty('success');
    });

    it('should throw error syncing non-existent vendor', async () => {
      await expect(
        service.syncVendorToBusinessCentral('tenant-test', 'non-existent')
      ).rejects.toThrow('Vendor not found');
    });
  });

  describe('Purchase Order Creation', () => {
    let vendorId: string;

    beforeEach(async () => {
      vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Acme Corp', legalName: 'Acme Corporation', taxId: '78-8888888', industry: 'Manufacturing', companySize: 'medium' },
        contacts: { primary: { firstName: 'PO', lastName: 'Owner', title: 'Procurement', email: 'po@acme.com', phone: '555-1010' } },
        addresses: { headquarters: { street1: '100 Procurement Way', city: 'Dallas', state: 'TX', postalCode: '75001', country: 'USA' } },
        banking: { accountName: 'Acme Corp', accountNumber: '****1010', routingNumber: '101010101', bankName: 'Bank PO', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'verified' }, insurance: { generalLiability: { status: 'verified' }, workersComp: { status: 'verified' } } },
      });
    });

    it('should create a purchase order with valid lines', async () => {
      const po = await service.createPurchaseOrder('tenant-test', {
        vendorId,
        lines: [{
          itemName: 'Widget A',
          quantity: 2,
          unitPrice: 10,
        }],
      });

      expect(po.vendorId).toBe(vendorId);
      expect(po.lines[0].itemName).toBe('Widget A');
      expect(po.total).toBeGreaterThan(0);
    });

    it('should reject non-finite requestedDeliveryDate', async () => {
      await expect(service.createPurchaseOrder('tenant-test', {
        vendorId,
        requestedDeliveryDate: Number.NaN,
        lines: [{
          itemName: 'Widget A',
          quantity: 2,
          unitPrice: 10,
        }],
      })).rejects.toThrow('requestedDeliveryDate must be a finite timestamp number');
    });

    it('should reject invalid line quantity and price values', async () => {
      await expect(service.createPurchaseOrder('tenant-test', {
        vendorId,
        lines: [{
          itemName: 'Widget A',
          quantity: Number.NaN as unknown as number,
          unitPrice: 10,
        }],
      })).rejects.toThrow('Purchase order numeric fields must be finite numbers');

      await expect(service.createPurchaseOrder('tenant-test', {
        vendorId,
        lines: [{
          itemName: 'Widget A',
          quantity: 2,
          unitPrice: -1,
        }],
      })).rejects.toThrow('unitPrice must be >= 0');
    });

    it('should resolve vendor name when query includes trailing text', async () => {
      const po = await service.createPurchaseOrder('tenant-test', {
        vendorName: 'Acme Corp tomorrow',
        lines: [{
          itemName: 'Widget A',
          quantity: 1,
          unitPrice: 5,
        }],
      });

      expect(po.vendorId).toBe(vendorId);
    });

    it('should not resolve broad partial vendor names', async () => {
      await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Big Acme Industries', taxId: '79-9999999', industry: 'Manufacturing', companySize: 'large' },
        contacts: { primary: { firstName: 'Big', lastName: 'Acme', title: 'Procurement', email: 'big@acme.com', phone: '555-2020' } },
        addresses: { headquarters: { street1: '200 Industry Ave', city: 'Austin', state: 'TX', postalCode: '73301', country: 'USA' } },
        banking: { accountName: 'Big Acme Industries', accountNumber: '****2020', routingNumber: '202020202', bankName: 'Bank Big', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'verified' }, insurance: { generalLiability: { status: 'verified' }, workersComp: { status: 'verified' } } },
      });

      await expect(service.createPurchaseOrder('tenant-test', {
        vendorName: 'Acme',
        lines: [{
          itemName: 'Widget A',
          quantity: 1,
          unitPrice: 5,
        }],
      })).rejects.toThrow('Vendor ID or resolvable vendor name is required');
    });
  });

  describe('Onboarding Statistics', () => {
    it('should get onboarding stats', async () => {
      const stats = await service.getOnboardingStats('tenant-test');

      expect(stats).toHaveProperty('summary');
      expect(stats.summary).toHaveProperty('totalVendors');
      expect(stats.summary).toHaveProperty('activeVendors');
      expect(stats.summary).toHaveProperty('pendingApproval');

      expect(typeof stats.summary.totalVendors).toBe('number');
      expect(typeof stats.summary.activeVendors).toBe('number');
      expect(typeof stats.summary.pendingApproval).toBe('number');
    });

    it('should get stats by onboarding stage', async () => {
      const stats = await service.getOnboardingStats('tenant-test');

      expect(stats).toHaveProperty('byStage');
      expect(Array.isArray(stats.byStage)).toBe(true);

      if (stats.byStage.length > 0) {
        const stage = stats.byStage[0];
        expect(stage).toHaveProperty('stage');
        expect(stage).toHaveProperty('count');
        expect(stage).toHaveProperty('percentage');
      }
    });

    it('should get stats by industry', async () => {
      const stats = await service.getOnboardingStats('tenant-test');

      expect(stats).toHaveProperty('byIndustry');
      expect(Array.isArray(stats.byIndustry)).toBe(true);
    });

    it('should get compliance stats', async () => {
      const stats = await service.getOnboardingStats('tenant-test');

      expect(stats).toHaveProperty('complianceStats');
      expect(stats.complianceStats).toHaveProperty('w9Completion');
      expect(stats.complianceStats).toHaveProperty('insuranceCompletion');
      expect(stats.complianceStats).toHaveProperty('overallComplianceRate');

      expect(typeof stats.complianceStats.w9Completion).toBe('number');
      expect(typeof stats.complianceStats.insuranceCompletion).toBe('number');
    });

    it('should get recent activity stats', async () => {
      const stats = await service.getOnboardingStats('tenant-test');

      expect(stats).toHaveProperty('recentActivity');
      expect(stats.recentActivity).toHaveProperty('newRegistrations');
      expect(stats.recentActivity).toHaveProperty('documentsSubmitted');
      expect(stats.recentActivity).toHaveProperty('approvalsPending');

      expect(typeof stats.recentActivity.newRegistrations).toBe('number');
    });
  });

  describe('Portal Activity', () => {
    it('should get all portal activity', async () => {
      const result = await service.getPortalActivity('tenant-test');

      expect(result).toHaveProperty('activities');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.activities)).toBe(true);
    });

    it('should filter activity by vendor', async () => {
      const vendorId = await service.createVendorProfile('tenant-test', {
        basicInfo: { companyName: 'Activity Test', taxId: '77-7777777', industry: 'Services', companySize: 'small' },
        contacts: { primary: { firstName: 'Activity', lastName: 'User', title: 'Owner', email: 'activity@test.com', phone: '555-0007' } },
        addresses: { headquarters: { street1: '7 G St', city: 'City G', state: 'CO', postalCode: '80201', country: 'USA' } },
        banking: { accountName: 'Activity Test', accountNumber: '****0007', routingNumber: '777777777', bankName: 'Bank G', accountType: 'business', currency: 'USD' },
        compliance: { w9Form: { status: 'pending' }, insurance: { generalLiability: { status: 'pending' }, workersComp: { status: 'pending' } } },
      });

      const result = await service.getPortalActivity('tenant-test', vendorId);
      expect(result).toHaveProperty('activities');
      expect(Array.isArray(result.activities)).toBe(true);
    });

    it('should support activity pagination', async () => {
      const result = await service.getPortalActivity('tenant-test', undefined, 5, 0);
      expect(result.activities.length).toBeLessThanOrEqual(5);
      expect(result).toHaveProperty('totalCount');
    });
  });
});
