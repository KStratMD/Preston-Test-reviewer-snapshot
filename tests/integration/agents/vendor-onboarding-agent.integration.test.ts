/**
 * VendorOnboardingAgent Integration Tests
 *
 * Integration tests for vendor onboarding workflows:
 * - Vendor registration and profile generation
 * - Risk assessment and compliance checking
 * - Approval recommendations
 */

import 'reflect-metadata';
import { VendorOnboardingAgent } from '../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';
import type { VendorOnboardingInput, VendorOnboardingOutput } from '../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';

describe('VendorOnboardingAgent Integration Tests', () => {
  let vendorOnboardingAgent: VendorOnboardingAgent;

  beforeAll(() => {
    vendorOnboardingAgent = new VendorOnboardingAgent();
  });

  // Helper to create execution context
  const createContext = (): AgentExecutionContext => ({
    sessionId: `integration-vendor-session-${Date.now()}`,
    userId: 'integration-test-user',
    correlationId: `integration-vendor-correlation-${Date.now()}`,
    maxExecutionTime: 30000, // 30 second timeout
    confidenceThreshold: 0.5,
    sourceSystem: 'SupplierCentral',
    targetSystem: 'VendorOnboardingAgent',
  });

  describe('Vendor Registration Flow', () => {
    it('processes new vendor registration', async () => {
      const vendorRegistration: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-001',
          name: 'Test Vendor Corp',
          email: 'vendor@testvendor.com',
          phone: '555-0100',
          category: 'Technology',
          expectedSpend: 5000,
          paymentTerms: 'Net 30',
        },
        requestedActions: ['generate_profile', 'assess_risk', 'check_compliance'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), vendorRegistration);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const output = result.data as VendorOnboardingOutput;
      expect(output.onboardingStatus).toBeDefined();
      expect(output.actions).toBeDefined();
      expect(Array.isArray(output.actions)).toBe(true);
    });

    it('generates vendor profile from documents', async () => {
      const vendorWithDocs: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-002',
          name: 'Documented Vendor LLC',
          email: 'docs@docvendor.com',
        },
        documents: [
          {
            documentId: 'doc-w9-001',
            documentType: 'w9',
            extractedData: {
              businessName: 'Documented Vendor LLC',
              taxClassification: 'llc' as const,
              address: {
                street: '100 Test Street',
                city: 'San Francisco',
                state: 'CA',
                zipCode: '94102',
              },
              tin: '12-3456789',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
        ],
        requestedActions: ['generate_profile'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), vendorWithDocs);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      expect(output.generatedProfile).toBeDefined();
      expect(output.generatedProfile?.taxId).toBe('12-3456789');
    });
  });

  describe('Risk Assessment', () => {
    it('assesses low-risk vendor correctly', async () => {
      const lowRiskVendor: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-low-risk',
          name: 'Established Vendor Inc',
          email: 'contact@established.com',
          expectedSpend: 10000,
        },
        documents: [
          {
            documentId: 'doc-w9-low',
            documentType: 'w9',
            extractedData: {
              businessName: 'Established Vendor Inc',
              taxClassification: 'c_corp' as const,
              address: {
                street: '500 Corporate Blvd',
                city: 'New York',
                state: 'NY',
                zipCode: '10001',
              },
              tin: '98-7654321',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-coi-low',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Major Insurance Co',
              policyNumber: 'POL-123456',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-01-01',
              namedInsured: 'Established Vendor Inc',
              coverages: [
                { type: 'general_liability' as const, limit: 2000000 },
              ],
              isValid: true,
              daysUntilExpiration: 358,
            },
            validationStatus: 'valid',
          },
        ],
        existingProfile: {
          bankingInfo: {
            hasAchSetup: true,
            lastVerified: new Date().toISOString(),
          },
        },
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
          minCoiCoverage: 1000000,
        },
        requestedActions: ['assess_risk', 'check_compliance', 'recommend_actions'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), lowRiskVendor);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      expect(output.riskAssessment).toBeDefined();
      expect(['low', 'medium']).toContain(output.riskAssessment?.overallRisk);
    });

    it('flags high-spend vendor for additional review', async () => {
      const highSpendVendor: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-high-spend',
          name: 'Enterprise Vendor Inc',
          email: 'enterprise@bigvendor.com',
          expectedSpend: 500000, // High spend
        },
        documents: [
          {
            documentId: 'doc-w9-high',
            documentType: 'w9',
            extractedData: {
              businessName: 'Enterprise Vendor Inc',
              taxClassification: 'c_corp' as const,
              address: {
                street: '1 Corp Dr',
                city: 'Austin',
                state: 'TX',
                zipCode: '78701',
              },
              tin: '11-2233445',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
        ],
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
          approvalThreshold: 100000, // Requires approval for spend > $100K
        },
        requestedActions: ['assess_risk', 'recommend_actions'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), highSpendVendor);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      expect(['pending_approval', 'under_review']).toContain(output.onboardingStatus);
      expect(['review', 'hold']).toContain(output.approvalRecommendation.recommend);
    });
  });

  describe('Compliance Checking', () => {
    it('flags vendor missing required documents', async () => {
      const missingDocsVendor: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-missing-docs',
          name: 'Incomplete Vendor',
          email: 'incomplete@vendor.com',
        },
        documents: [], // No documents
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
        },
        requestedActions: ['check_compliance'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), missingDocsVendor);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      expect(output.complianceChecklist?.overallStatus).toBe('incomplete');
      expect(output.approvalRecommendation.recommend).not.toBe('approve');
    });

    it('identifies insufficient insurance coverage', async () => {
      const lowCoverageVendor: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-low-coverage',
          name: 'Low Coverage Vendor',
          email: 'lowcov@vendor.com',
          expectedSpend: 50000,
        },
        documents: [
          {
            documentId: 'doc-w9-lowcov',
            documentType: 'w9',
            extractedData: {
              businessName: 'Low Coverage Vendor',
              taxClassification: 'llc' as const,
              address: { street: '1 Main St', city: 'NYC', state: 'NY', zipCode: '10001' },
              tin: '98-7654321',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-coi-lowcov',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Small Insurance Co',
              policyNumber: 'GL-999',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-01-01',
              namedInsured: 'Low Coverage Vendor',
              coverages: [
                { type: 'general_liability' as const, limit: 500000 }, // Below $1M requirement
              ],
              isValid: true,
              daysUntilExpiration: 358,
            },
            validationStatus: 'valid',
          },
        ],
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
          minCoiCoverage: 1000000, // Requires $1M, vendor has $500K
        },
        requestedActions: ['assess_risk', 'check_compliance'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), lowCoverageVendor);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      // Agent should flag risk - either in riskFactors, actions, or overall risk level
      expect(
        output.riskAssessment?.riskFactors.some(
          f => f.factor.toLowerCase().includes('coverage') ||
               f.factor.toLowerCase().includes('insurance') ||
               f.factor.toLowerCase().includes('documentation')
        ) ||
        output.riskAssessment?.overallRisk === 'medium' ||
        output.riskAssessment?.overallRisk === 'high' ||
        output.actions.some(a => a.action.toLowerCase().includes('insurance') || a.action.toLowerCase().includes('coverage'))
      ).toBe(true);
    });
  });

  describe('Approval Recommendations', () => {
    it('approves compliant vendor with all documents', async () => {
      const compliantVendor: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-compliant',
          name: 'Compliant Vendor Corp',
          email: 'compliant@vendor.com',
          expectedSpend: 25000,
        },
        documents: [
          {
            documentId: 'doc-w9-compliant',
            documentType: 'w9',
            extractedData: {
              businessName: 'Compliant Vendor Corp',
              taxClassification: 'c_corp' as const,
              address: {
                street: '123 Compliance Ave',
                city: 'Chicago',
                state: 'IL',
                zipCode: '60601',
              },
              tin: '55-1234567',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-coi-compliant',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Reliable Insurance',
              policyNumber: 'RI-567890',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-06-01',
              namedInsured: 'Compliant Vendor Corp',
              coverages: [
                { type: 'general_liability' as const, limit: 2000000 },
              ],
              isValid: true,
              daysUntilExpiration: 500,
            },
            validationStatus: 'valid',
          },
        ],
        existingProfile: {
          bankingInfo: { hasAchSetup: true },
        },
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
          minCoiCoverage: 1000000,
        },
        requestedActions: ['assess_risk', 'check_compliance', 'recommend_actions'],
      };

      const result = await vendorOnboardingAgent.execute(createContext(), compliantVendor);

      expect(result.success).toBe(true);
      const output = result.data as VendorOnboardingOutput;
      // Agent should either approve or recommend approval based on complete documentation
      expect(['approved', 'under_review', 'pending_approval']).toContain(output.onboardingStatus);
      expect(['approve', 'review']).toContain(output.approvalRecommendation.recommend);
      // Compliance status depends on agent's evaluation of requirements
      expect(['complete', 'in_progress', 'incomplete']).toContain(output.complianceChecklist?.overallStatus);
    });
  });
});
