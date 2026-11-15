/**
 * VendorCentral Portal E2E Flow Tests
 *
 * End-to-end tests for complete vendor onboarding workflows:
 * - Vendor registration → document upload → approval flow
 * - Integration with VendorOnboardingAgent
 * - Integration with DocumentParsingAgent
 */

import 'reflect-metadata';
import { VendorOnboardingAgent } from '../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';
import { DocumentParsingAgent } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';
import type { VendorOnboardingInput } from '../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';
import type { DocumentParsingInput } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';

describe('VendorCentral E2E Flow', () => {
  let vendorOnboardingAgent: VendorOnboardingAgent;
  let documentParsingAgent: DocumentParsingAgent;

  beforeAll(() => {
    vendorOnboardingAgent = new VendorOnboardingAgent();
    documentParsingAgent = new DocumentParsingAgent();
  });

  // Base context for DocumentParsingAgent (BaseAgent pattern - two params)
  const baseContext: AgentExecutionContext = {
    sessionId: 'e2e-test-session',
    userId: 'e2e-test-user',
    sourceSystem: 'VendorCentral',
    targetSystem: 'NetSuite',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
  };

  // Context creator for VendorOnboardingAgent
  const createVendorContext = (input: VendorOnboardingInput): AgentExecutionContext => ({
    input,
    sessionId: 'e2e-test-session',
    userId: 'e2e-test-user',
    correlationId: `e2e-${Date.now()}`,
    sourceSystem: 'vendor-portal',
    targetSystem: 'vendor-central',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
  });

  // Helper to execute VendorOnboardingAgent with proper params
  const executeVendorAgent = async (input: VendorOnboardingInput) => {
    const context = createVendorContext(input);
    return vendorOnboardingAgent.execute(context, input);
  };

  // Sample W-9 content that matches DocumentParsingAgent's expected format
  const sampleW9Text = `
    Form W-9 Request for Taxpayer Identification Number and Certification

    Name: E2E Test Vendor Corp
    Business name/disregarded entity name: E2E Corp

    Check appropriate box for federal tax classification:
    [X] C Corporation

    Address: 100 Test Street
    City, state, and ZIP code: San Francisco, CA 94102

    Part I - Taxpayer Identification Number (TIN)
    Employer identification number: 12-3456789

    Part II - Certification
    Under penalties of perjury, I certify that:

    Signature: John Doe
    Date: 01/01/2025
  `;

  // Sample COI content
  const sampleCOIText = `
    CERTIFICATE OF LIABILITY INSURANCE
    ACORD 25 (2016/03)

    INSURER: Liberty Mutual Insurance
    POLICY NUMBER: GL-2025-123456

    EFFECTIVE DATE: 01/01/2025
    EXPIRATION DATE: 01/01/2026

    NAMED INSURED: E2E Test Vendor Corp

    COVERAGES:
    COMMERCIAL GENERAL LIABILITY
    Each Occurrence Limit: $2,000,000
    General Aggregate: $4,000,000

    AUTOMOBILE LIABILITY
    Combined Single Limit: $1,000,000

    CERTIFICATE HOLDER:
    Client Company LLC
    456 Client Street
    New York, NY 10001
  `;

  describe('Complete Vendor Registration Flow', () => {
    it('processes new vendor from registration to approval', async () => {
      const vendorRegistration: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-001',
          name: 'E2E Test Vendor Corp',
          email: 'vendor@e2etest.com',
          phone: '555-0100',
          category: 'Technology',
          expectedSpend: 5000,
          paymentTerms: 'Net 30',
        },
        requestedActions: ['generate_profile', 'assess_risk', 'check_compliance'],
      };

      const result = await executeVendorAgent(vendorRegistration);

      expect(result.success).toBe(true);
      expect(result.data?.onboardingStatus).toBe('pending_documents');
      expect(result.data?.actions.some(a => a.action.includes('document'))).toBe(true);
    });

    it('processes W-9 document upload', async () => {
      const w9Input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-001',
          filename: 'vendor_w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text',
        },
        expectedDocumentType: 'w9',
        vendorContext: {
          vendorId: 'vendor-001',
          vendorName: 'E2E Test Vendor Corp',
        },
      };

      const result = await documentParsingAgent.execute(baseContext, w9Input);

      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('w9');
      expect(result.data?.confidence).toBeGreaterThan(0);
    });

    it('processes COI document upload', async () => {
      const coiInput: DocumentParsingInput = {
        document: {
          id: 'doc-coi-001',
          filename: 'vendor_coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text',
        },
        expectedDocumentType: 'coi',
        vendorContext: {
          vendorId: 'vendor-001',
          vendorName: 'E2E Test Vendor Corp',
        },
      };

      const result = await documentParsingAgent.execute(baseContext, coiInput);

      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('coi');
    });

    it('completes vendor onboarding with all documents', async () => {
      const completeOnboarding: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-001',
          name: 'E2E Test Vendor Corp',
          email: 'vendor@e2etest.com',
          expectedSpend: 5000,
        },
        documents: [
          {
            documentId: 'doc-w9-001',
            documentType: 'w9',
            extractedData: {
              businessName: 'E2E Test Vendor Corp',
              taxClassification: 'c_corp' as const,
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
          {
            documentId: 'doc-coi-001',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Liberty Mutual',
              policyNumber: 'GL-123456',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-01-01',
              namedInsured: 'E2E Test Vendor Corp',
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
      };

      const result = await executeVendorAgent(completeOnboarding);

      expect(result.success).toBe(true);
      expect(result.data?.onboardingStatus).toBe('approved');
      expect(result.data?.approvalRecommendation.recommend).toBe('approve');
      expect(result.data?.generatedProfile?.taxId).toBe('12-3456789');
    });
  });

  describe('Vendor Rejection Flow', () => {
    it('identifies vendor with insufficient insurance coverage', async () => {
      const insufficientCoverageInput: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-002',
          name: 'Low Coverage Vendor',
          email: 'lowcov@example.com',
          expectedSpend: 50000,
        },
        documents: [
          {
            documentId: 'doc-w9-002',
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
            documentId: 'doc-coi-002',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Small Insurance Co',
              policyNumber: 'GL-999',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-01-01',
              namedInsured: 'Low Coverage Vendor',
              coverages: [
                { type: 'general_liability' as const, limit: 500000 },
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
          minCoiCoverage: 1000000,
        },
      };

      const result = await executeVendorAgent(insufficientCoverageInput);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.riskFactors.some(
        f => f.factor === 'Insufficient liability coverage'
      )).toBe(true);
    });

    it('flags vendor missing required documents', async () => {
      const missingDocsInput: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-003',
          name: 'Incomplete Vendor',
          email: 'incomplete@example.com',
        },
        documents: [],
        companyRequirements: {
          requireW9: true,
          requireCoi: true,
        },
      };

      const result = await executeVendorAgent(missingDocsInput);

      expect(result.success).toBe(true);
      expect(result.data?.complianceChecklist?.overallStatus).toBe('incomplete');
      expect(result.data?.approvalRecommendation.recommend).not.toBe('approve');
    });
  });

  describe('High-Risk Vendor Flow', () => {
    it('flags high-spend vendor for additional review', async () => {
      const highSpendInput: VendorOnboardingInput = {
        vendor: {
          id: 'vendor-004',
          name: 'Enterprise Vendor Inc',
          email: 'enterprise@example.com',
          expectedSpend: 500000,
        },
        documents: [
          {
            documentId: 'doc-w9-004',
            documentType: 'w9',
            extractedData: {
              businessName: 'Enterprise Vendor Inc',
              taxClassification: 'c_corp' as const,
              address: { street: '1 Corp Dr', city: 'Austin', state: 'TX', zipCode: '78701' },
              tin: '11-2233445',
              tinType: 'ein' as const,
              certificationComplete: true,
            },
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-coi-004',
            documentType: 'coi',
            extractedData: {
              insurerName: 'Enterprise Insurance',
              policyNumber: 'EI-12345',
              effectiveDate: '2025-01-01',
              expirationDate: '2026-01-01',
              namedInsured: 'Enterprise Vendor Inc',
              coverages: [{ type: 'general_liability' as const, limit: 5000000 }],
              isValid: true,
              daysUntilExpiration: 358,
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
          approvalThreshold: 100000,
        },
      };

      const result = await executeVendorAgent(highSpendInput);

      expect(result.success).toBe(true);
      expect(['pending_approval', 'under_review']).toContain(result.data?.onboardingStatus);
      expect(result.data?.approvalRecommendation.recommend).toBe('review');
    });
  });
});
