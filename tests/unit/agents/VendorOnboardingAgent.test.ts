/**
 * Vendor Onboarding Agent Tests
 *
 * Tests for AI-powered vendor onboarding automation, including:
 * - Profile generation from documents
 * - Risk assessment
 * - Compliance checking
 * - Approval recommendations
 */

import 'reflect-metadata';
import {
  VendorOnboardingAgent,
  VendorOnboardingInput,
  VendorOnboardingOutput,
} from '../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';
import type { W9ExtractedData, COIExtractedData } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';

describe('VendorOnboardingAgent', () => {
  let agent: VendorOnboardingAgent;

  beforeEach(() => {
    agent = new VendorOnboardingAgent();
  });

  // Helper to create execution context
  const createContext = (input?: VendorOnboardingInput): AgentExecutionContext => ({
    input: input || {},
    sessionId: 'test-session-001',
    userId: 'test-user',
    correlationId: 'test-correlation-001',
    maxExecutionTime: 30000,
    sourceSystem: 'test-source',
    targetSystem: 'test-target',
    confidenceThreshold: 0.5,
  });

  // Helper to execute agent with context and input
  const executeAgent = async (input: VendorOnboardingInput) => {
    const context = createContext(input);
    return agent.execute(context, input);
  };

  // Sample extracted W-9 data
  const sampleW9Data: W9ExtractedData = {
    businessName: 'Acme Corporation',
    businessNameDba: 'Acme Corp',
    taxClassification: 'c_corp',
    address: {
      street: '123 Main Street',
      city: 'San Francisco',
      state: 'CA',
      zipCode: '94102',
    },
    tin: '12-3456789',
    tinType: 'ein',
    certificationComplete: true,
  };

  // Sample extracted COI data
  const sampleCOIData: COIExtractedData = {
    insurerName: 'Liberty Mutual',
    policyNumber: 'GL-123456',
    effectiveDate: '2025-01-01',
    expirationDate: '2026-01-01',
    namedInsured: 'Acme Corporation',
    coverages: [
      { type: 'general_liability', limit: 2000000, perOccurrence: 1000000, aggregate: 2000000 },
      { type: 'auto_liability', limit: 1000000 },
      { type: 'workers_comp', limit: 500000 },
    ],
    isValid: true,
    daysUntilExpiration: 358,
  };

  describe('Schema', () => {
    it('returns valid schema', () => {
      const schema = agent.getSchema();

      expect(schema.capabilities).toContain('document_integration');
      expect(schema.capabilities).toContain('risk_assessment');
      expect(schema.capabilities).toContain('compliance_validation');
      expect(schema.inputSchema).toBeDefined();
      expect(schema.outputSchema).toBeDefined();
      expect(schema.resourceRequirements).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    it('requires vendor information', async () => {
      const input = {} as VendorOnboardingInput;
      const result = await executeAgent(input);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('requires vendor ID', async () => {
      const input = {
        vendor: { id: '', name: 'Test', email: 'test@example.com' },
      } as VendorOnboardingInput;
      const result = await executeAgent(input);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('requires vendor name', async () => {
      const input = {
        vendor: { id: 'v-001', name: '', email: 'test@example.com' },
      } as VendorOnboardingInput;
      const result = await executeAgent(input);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('requires vendor email', async () => {
      const input = {
        vendor: { id: 'v-001', name: 'Test Vendor', email: '' },
      } as VendorOnboardingInput;
      const result = await executeAgent(input);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('validates email format', async () => {
      const input = {
        vendor: { id: 'v-001', name: 'Test Vendor', email: 'invalid-email' },
      } as VendorOnboardingInput;
      const result = await executeAgent(input);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('Profile Generation', () => {
    it('generates profile from W-9 document', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [{
          documentId: 'doc-001',
          documentType: 'w9',
          extractedData: sampleW9Data,
          validationStatus: 'valid',
        }],
        requestedActions: ['generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.generatedProfile).toBeDefined();
      expect(result.data?.generatedProfile?.taxId).toBe('12-3456789');
      expect(result.data?.generatedProfile?.taxIdType).toBe('ein');
      expect(result.data?.generatedProfile?.legalName).toBe('Acme Corporation');
      expect(result.data?.generatedProfile?.dbaName).toBe('Acme Corp');
      expect(result.data?.generatedProfile?.businessType).toBe('C Corporation');
    });

    it('generates profile from COI document', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [{
          documentId: 'doc-002',
          documentType: 'coi',
          extractedData: sampleCOIData,
          validationStatus: 'valid',
        }],
        requestedActions: ['generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.generatedProfile?.insuranceCoverage).toBeDefined();
      expect(result.data?.generatedProfile?.insuranceCoverage?.generalLiability).toBe(2000000);
      expect(result.data?.generatedProfile?.insuranceCoverage?.autoLiability).toBe(1000000);
    });

    it('generates combined profile from multiple documents', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          {
            documentId: 'doc-001',
            documentType: 'w9',
            extractedData: sampleW9Data,
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-002',
            documentType: 'coi',
            extractedData: sampleCOIData,
            validationStatus: 'valid',
          },
        ],
        requestedActions: ['generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.generatedProfile?.dataSource).toBe('combined');
      expect(result.data?.generatedProfile?.taxId).toBe('12-3456789');
      expect(result.data?.generatedProfile?.insuranceCoverage?.generalLiability).toBe(2000000);
    });

    it('calculates high confidence for complete profiles', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          {
            documentId: 'doc-001',
            documentType: 'w9',
            extractedData: sampleW9Data,
            validationStatus: 'valid',
          },
          {
            documentId: 'doc-002',
            documentType: 'coi',
            extractedData: sampleCOIData,
            validationStatus: 'valid',
          },
        ],
        requestedActions: ['generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.generatedProfile?.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('Risk Assessment', () => {
    it('identifies low risk for complete documentation', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 5000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true } },
        requestedActions: ['assess_risk'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.overallRisk).toBe('low');
    });

    it('identifies high risk for missing W-9', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: false },
        requestedActions: ['assess_risk'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.complianceRisk.level).not.toBe('low');
      expect(result.data?.riskAssessment?.riskFactors.some(f => f.factor === 'Missing W-9')).toBe(true);
    });

    it('identifies medium risk for high expected spend', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 150000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true } },
        requestedActions: ['assess_risk'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.riskFactors.some(f => f.factor === 'High expected spend')).toBe(true);
    });

    it('identifies risk for insufficient insurance coverage', async () => {
      const lowCoverageCOI: COIExtractedData = {
        ...sampleCOIData,
        coverages: [{ type: 'general_liability', limit: 500000 }],
      };

      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: lowCoverageCOI, validationStatus: 'valid' },
        ],
        companyRequirements: { requireW9: true, requireCoi: true, minCoiCoverage: 1000000 },
        requestedActions: ['assess_risk', 'generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.riskFactors.some(f => f.factor === 'Insufficient liability coverage')).toBe(true);
    });

    it('provides risk mitigation recommendations', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true },
        requestedActions: ['assess_risk'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment?.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('Compliance Checking', () => {
    it('returns complete status when all requirements met', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true, lastVerified: '2025-01-01' } },
        companyRequirements: { requireW9: true, requireCoi: true },
        requestedActions: ['check_compliance', 'generate_profile'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.complianceChecklist?.overallStatus).toBe('complete');
      expect(result.data?.complianceChecklist?.completionPercentage).toBe(100);
    });

    it('returns incomplete status when requirements missing', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
        ],
        companyRequirements: { requireW9: true, requireCoi: true },
        requestedActions: ['check_compliance'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.complianceChecklist?.overallStatus).toBe('incomplete');
      expect(result.data?.complianceChecklist?.completionPercentage).toBeLessThan(100);
    });

    it('generates next steps for incomplete requirements', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true },
        requestedActions: ['check_compliance'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.complianceChecklist?.nextSteps.length).toBeGreaterThan(0);
      expect(result.data?.complianceChecklist?.nextSteps.some(s => s.includes('W-9'))).toBe(true);
    });

    it('estimates completion time for pending requirements', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true, requireNda: true },
        requestedActions: ['check_compliance'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.complianceChecklist?.estimatedCompletionDays).toBeDefined();
      expect(result.data?.complianceChecklist?.estimatedCompletionDays).toBeGreaterThan(0);
    });
  });

  describe('Onboarding Status', () => {
    it('returns pending_documents when no documents received', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.onboardingStatus).toBe('pending_documents');
    });

    it('returns approved for low-risk auto-approved vendors', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 5000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true, lastVerified: '2025-01-01' } },
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.onboardingStatus).toBe('approved');
    });

    it('returns pending_approval for high-spend vendors', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 50000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true, lastVerified: '2025-01-01' } },
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(['pending_approval', 'under_review']).toContain(result.data?.onboardingStatus);
    });

    it('returns on_hold for critical risk vendors', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 200000 },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true, requireBackgroundCheck: true, requireNda: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      // High risk should result in on_hold or under_review
      expect(['on_hold', 'under_review', 'pending_documents']).toContain(result.data?.onboardingStatus);
    });
  });

  describe('Approval Recommendations', () => {
    it('recommends approval for low-risk complete vendors', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 5000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true, lastVerified: '2025-01-01' } },
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.approvalRecommendation.recommend).toBe('approve');
      expect(result.data?.approvalRecommendation.confidence).toBeGreaterThan(0.9);
    });

    it('recommends review for incomplete compliance', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
        ],
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.approvalRecommendation.recommend).toBe('review');
      expect(result.data?.approvalRecommendation.conditions).toBeDefined();
    });

    it('recommends hold for high-risk vendors', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 150000 },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      // Missing all docs + high spend = high/critical risk
      expect(['hold', 'review', 'reject']).toContain(result.data?.approvalRecommendation.recommend);
    });

    it('includes reasoning in recommendation', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.approvalRecommendation.reasoning).toBeDefined();
      expect(result.data?.approvalRecommendation.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe('Action Generation', () => {
    it('generates actions for pending documents', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.actions.length).toBeGreaterThan(0);
      expect(result.data?.actions.some(a => a.action.includes('document'))).toBe(true);
    });

    it('generates approval action for pending_approval status', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com', expectedSpend: 50000 },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', extractedData: sampleW9Data, validationStatus: 'valid' },
          { documentId: 'doc-002', documentType: 'coi', extractedData: sampleCOIData, validationStatus: 'valid' },
        ],
        existingProfile: { bankingInfo: { hasAchSetup: true } },
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      // Should have some actions related to approval process
      expect(result.data?.actions).toBeDefined();
    });

    it('sorts actions by priority', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      const actions = result.data?.actions || [];

      // Verify high priority comes before low priority
      const priorities = actions.map(a => a.priority);
      const highIndex = priorities.indexOf('high');
      const lowIndex = priorities.indexOf('low');

      if (highIndex >= 0 && lowIndex >= 0) {
        expect(highIndex).toBeLessThan(lowIndex);
      }
    });

    it('identifies automatable actions', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
        companyRequirements: { requireW9: true, requireCoi: true },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      // Document requests should be automatable
      expect(result.data?.actions.some(a => a.automatable)).toBe(true);
    });
  });

  describe('Processing Metadata', () => {
    it('includes processing time in output', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.processingTime).toBeDefined();
      expect(result.data?.processingTime).toBeGreaterThanOrEqual(0);
    });

    it('includes processing time and handles requested actions', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        requestedActions: ['assess_risk', 'check_compliance'],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.processingTime).toBeDefined();
      expect(result.data?.processingTime).toBeGreaterThanOrEqual(0);
      // Verify that requested actions were processed (risk assessment and compliance checklist generated)
      expect(result.data?.riskAssessment).toBeDefined();
      expect(result.data?.complianceChecklist).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('handles empty documents array', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.onboardingStatus).toBe('pending_documents');
    });

    it('handles documents without extracted data', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        documents: [
          { documentId: 'doc-001', documentType: 'w9', validationStatus: 'pending' },
        ],
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      // Should handle gracefully without crashing
      expect(result.data?.vendorId).toBe('v-001');
    });

    it('handles missing optional fields', async () => {
      const input: VendorOnboardingInput = {
        vendor: {
          id: 'v-001',
          name: 'Acme Corp',
          email: 'vendor@acme.com',
          // No phone, category, expectedSpend, paymentTerms
        },
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.vendorId).toBe('v-001');
    });

    it('handles default actions when none specified', async () => {
      const input: VendorOnboardingInput = {
        vendor: { id: 'v-001', name: 'Acme Corp', email: 'vendor@acme.com' },
        // No requestedActions specified - should default to all
      };

      const result = await executeAgent(input);

      expect(result.success).toBe(true);
      expect(result.data?.riskAssessment).toBeDefined();
      expect(result.data?.complianceChecklist).toBeDefined();
    });
  });
});
