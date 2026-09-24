/**
 * AI Vendor Onboarding Agent
 *
 * LLM-powered vendor onboarding automation. Integrates with DocumentParsingAgent
 * to extract data from vendor documents and auto-populate vendor profiles.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import { injectable } from 'inversify';
import { BaseAgent, BaseAgentConfig } from '../BaseAgent';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema
} from '../interfaces';
import { logger, type Logger } from '../../../../utils/Logger';
import type { DocumentType, W9ExtractedData, COIExtractedData } from './DocumentParsingAgent';

// Vendor onboarding status
export type OnboardingStatus =
  | 'pending_documents'
  | 'documents_received'
  | 'under_review'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'on_hold';

// Risk level classification
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// Compliance requirement status
export type RequirementStatus = 'not_started' | 'in_progress' | 'completed' | 'waived' | 'failed';

// Input interface
export interface VendorOnboardingInput {
  vendor: {
    id: string;
    name: string;
    email: string;
    phone?: string;
    category?: string;
    expectedSpend?: number;
    paymentTerms?: string;
  };
  documents?: {
    documentId: string;
    documentType: DocumentType;
    extractedData?: W9ExtractedData | COIExtractedData | Record<string, unknown>;
    validationStatus?: 'valid' | 'invalid' | 'pending';
  }[];
  existingProfile?: {
    taxId?: string;
    businessName?: string;
    address?: {
      street: string;
      city: string;
      state: string;
      zipCode: string;
      country?: string;
    };
    bankingInfo?: {
      hasAchSetup: boolean;
      lastVerified?: string;
    };
    insuranceOnFile?: {
      hasValidCoi: boolean;
      expirationDate?: string;
    };
  };
  companyRequirements?: {
    requireW9: boolean;
    requireCoi: boolean;
    minCoiCoverage?: number;
    requireBackgroundCheck?: boolean;
    requireNda?: boolean;
    approvalThreshold?: number; // Dollar amount requiring additional approval
  };
  requestedActions?: ('assess_risk' | 'generate_profile' | 'check_compliance' | 'recommend_actions')[];
}

// Vendor profile generated from documents
export interface GeneratedVendorProfile {
  taxId: string;
  taxIdType: 'ein' | 'ssn';
  legalName: string;
  dbaName?: string;
  businessType: string;
  address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  insuranceCoverage?: {
    generalLiability?: number;
    autoLiability?: number;
    workersComp?: number;
    umbrella?: number;
    policyExpiration?: string;
  };
  confidence: number;
  dataSource: 'w9' | 'coi' | 'combined' | 'manual';
  fieldsAutoPopulated: string[];
  fieldsRequiringReview: string[];
}

// Risk assessment result
export interface RiskAssessment {
  overallRisk: RiskLevel;
  riskScore: number; // 0-100
  riskFactors: {
    factor: string;
    severity: RiskLevel;
    description: string;
    mitigation?: string;
  }[];
  financialRisk: {
    level: RiskLevel;
    reasons: string[];
  };
  complianceRisk: {
    level: RiskLevel;
    reasons: string[];
  };
  operationalRisk: {
    level: RiskLevel;
    reasons: string[];
  };
  recommendations: string[];
}

// Compliance checklist
export interface ComplianceChecklist {
  overallStatus: 'complete' | 'incomplete' | 'failed';
  completionPercentage: number;
  requirements: {
    id: string;
    name: string;
    category: 'tax' | 'insurance' | 'legal' | 'financial' | 'operational';
    status: RequirementStatus;
    required: boolean;
    dueDate?: string;
    completedDate?: string;
    notes?: string;
    blockedBy?: string[];
  }[];
  nextSteps: string[];
  estimatedCompletionDays?: number;
}

// Output interface
export interface VendorOnboardingOutput {
  vendorId: string;
  vendorName: string;
  onboardingStatus: OnboardingStatus;
  generatedProfile?: GeneratedVendorProfile;
  riskAssessment?: RiskAssessment;
  complianceChecklist?: ComplianceChecklist;
  actions: {
    action: string;
    priority: 'high' | 'medium' | 'low';
    assignee?: string;
    dueDate?: string;
    automatable: boolean;
  }[];
  approvalRecommendation: {
    recommend: 'approve' | 'reject' | 'review' | 'hold';
    confidence: number;
    reasoning: string;
    conditions?: string[];
  };
  processingTime: number;
}

// Agent configuration
export interface VendorOnboardingAgentConfig {
  defaultRequirements?: {
    requireW9: boolean;
    requireCoi: boolean;
    minCoiCoverage: number;
  };
  riskThresholds?: {
    lowRiskMax: number;
    mediumRiskMax: number;
    highRiskMax: number;
  };
  autoApproveMaxSpend?: number;
}

// Schema definition
const VENDOR_ONBOARDING_SCHEMA: AgentSchema = {
  inputSchema: {
    type: 'object',
    required: ['vendor'],
    properties: {
      vendor: {
        type: 'object',
        required: ['id', 'name', 'email'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          category: { type: 'string' },
          expectedSpend: { type: 'number' },
          paymentTerms: { type: 'string' },
        },
      },
      documents: {
        type: 'array',
        items: { type: 'object' },
      },
      existingProfile: { type: 'object' },
      companyRequirements: { type: 'object' },
      requestedActions: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['assess_risk', 'generate_profile', 'check_compliance', 'recommend_actions'],
        },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['vendorId', 'vendorName', 'onboardingStatus', 'actions', 'approvalRecommendation'],
    properties: {
      vendorId: { type: 'string' },
      vendorName: { type: 'string' },
      onboardingStatus: { type: 'string' },
      generatedProfile: { type: 'object' },
      riskAssessment: { type: 'object' },
      complianceChecklist: { type: 'object' },
      actions: { type: 'array' },
      approvalRecommendation: { type: 'object' },
      processingTime: { type: 'number' },
    },
  },
  capabilities: ['document_integration', 'risk_assessment', 'compliance_validation', 'profile_generation'],
  resourceRequirements: {
    maxMemory: 512,
    maxExecutionTime: 45000,
  },
};

@injectable()
export class VendorOnboardingAgent extends BaseAgent {
  readonly agentType = 'vendor-onboarding';
  private log: Logger;
  private agentConfig: VendorOnboardingAgentConfig;

  private static readonly AGENT_CONFIG: BaseAgentConfig = {
    name: 'VendorOnboardingAgent',
    version: '1.0.0',
    capabilities: [
      'document_integration',
      'risk_assessment',
      'compliance_validation',
      'profile_generation',
      'approval_recommendation',
    ],
    dependencies: [],
    maxExecutionTime: 45000,
    confidenceThreshold: 0.7,
  };

  constructor(providedLogger?: Logger) {
    super(VendorOnboardingAgent.AGENT_CONFIG, providedLogger || logger);
    this.agentConfig = {
      defaultRequirements: {
        requireW9: true,
        requireCoi: true,
        minCoiCoverage: 1000000,
      },
      riskThresholds: {
        lowRiskMax: 25,
        mediumRiskMax: 50,
        highRiskMax: 75,
      },
      autoApproveMaxSpend: 10000,
    };
    this.log = providedLogger || logger;
  }

  getSchema(): AgentSchema {
    return VENDOR_ONBOARDING_SCHEMA;
  }

  protected async executeInternal(
    _context: AgentExecutionContext,
    input: unknown
  ): Promise<AgentResult<VendorOnboardingOutput>> {
    const startTime = Date.now();
    const data = input as VendorOnboardingInput;

    try {
      this.log.info('Starting vendor onboarding processing', {
        vendorId: data.vendor.id,
        vendorName: data.vendor.name,
        documentCount: data.documents?.length || 0,
      });

      // Determine requested actions (default to all)
      const actions = data.requestedActions || [
        'assess_risk',
        'generate_profile',
        'check_compliance',
        'recommend_actions',
      ];

      // Process documents and generate profile
      let generatedProfile: GeneratedVendorProfile | undefined;
      if (actions.includes('generate_profile') && data.documents?.length) {
        generatedProfile = this.generateProfileFromDocuments(data);
      }

      // Assess risk
      let riskAssessment: RiskAssessment | undefined;
      if (actions.includes('assess_risk')) {
        riskAssessment = this.assessRisk(data, generatedProfile);
      }

      // Check compliance
      let complianceChecklist: ComplianceChecklist | undefined;
      if (actions.includes('check_compliance')) {
        complianceChecklist = this.checkCompliance(data, generatedProfile);
      }

      // Determine onboarding status
      const onboardingStatus = this.determineOnboardingStatus(
        data,
        complianceChecklist,
        riskAssessment
      );

      // Generate recommended actions
      const recommendedActions = this.generateRecommendedActions(
        data,
        onboardingStatus,
        complianceChecklist,
        riskAssessment
      );

      // Generate approval recommendation
      const approvalRecommendation = this.generateApprovalRecommendation(
        data,
        onboardingStatus,
        complianceChecklist,
        riskAssessment
      );

      const processingTime = Date.now() - startTime;

      const output: VendorOnboardingOutput = {
        vendorId: data.vendor.id,
        vendorName: data.vendor.name,
        onboardingStatus,
        generatedProfile,
        riskAssessment,
        complianceChecklist,
        actions: recommendedActions,
        approvalRecommendation,
        processingTime,
      };

      this.log.info('Vendor onboarding processing complete', {
        vendorId: data.vendor.id,
        status: onboardingStatus,
        recommendation: approvalRecommendation.recommend,
        processingTime,
      });

      const rawConfidence = typeof approvalRecommendation.confidence === 'number'
        ? approvalRecommendation.confidence
        : 0.7;
      const confidence = Math.max(0, Math.min(1, rawConfidence));
      const reasoning = `Onboarding ${data.vendor.name} is ${onboardingStatus}; ${recommendedActions.length} action(s) recommended.`;

      return this.createSuccessResult(output, confidence, reasoning);
    } catch (error) {
      this.log.error('Vendor onboarding processing failed', {
        vendorId: data.vendor?.id || 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return this.createErrorResult(
        error instanceof Error ? error.message : 'Unknown error processing vendor onboarding'
      );
    }
  }

  protected async validateInputInternal(input: unknown): Promise<boolean> {
    const data = input as VendorOnboardingInput;
    if (!data.vendor) {
      return false;
    }
    if (!data.vendor.id || !data.vendor.name || !data.vendor.email) {
      return false;
    }
    // Basic email validation
    if (!data.vendor.email.includes('@')) {
      return false;
    }
    return true;
  }

  private generateProfileFromDocuments(input: VendorOnboardingInput): GeneratedVendorProfile {
    const profile: GeneratedVendorProfile = {
      taxId: '',
      taxIdType: 'ein',
      legalName: input.vendor.name,
      businessType: 'unknown',
      address: {
        street: '',
        city: '',
        state: '',
        zipCode: '',
        country: 'US',
      },
      confidence: 0,
      dataSource: 'manual',
      fieldsAutoPopulated: [],
      fieldsRequiringReview: [],
    };

    const w9Doc = input.documents?.find(d => d.documentType === 'w9');
    const coiDoc = input.documents?.find(d => d.documentType === 'coi');

    // Extract W-9 data
    if (w9Doc?.extractedData && this.isW9Data(w9Doc.extractedData)) {
      const w9Data = w9Doc.extractedData;

      profile.taxId = w9Data.tin;
      profile.taxIdType = w9Data.tinType;
      profile.legalName = w9Data.businessName;
      profile.dbaName = w9Data.businessNameDba;
      profile.businessType = this.mapTaxClassification(w9Data.taxClassification);
      profile.address = {
        ...w9Data.address,
        country: 'US',
      };
      profile.dataSource = 'w9';
      profile.fieldsAutoPopulated.push('taxId', 'taxIdType', 'legalName', 'businessType', 'address');

      if (w9Data.businessNameDba) {
        profile.fieldsAutoPopulated.push('dbaName');
      }
    }

    // Extract COI data
    if (coiDoc?.extractedData && this.isCOIData(coiDoc.extractedData)) {
      const coiData = coiDoc.extractedData;

      profile.insuranceCoverage = {
        policyExpiration: coiData.expirationDate,
      };

      for (const coverage of coiData.coverages) {
        switch (coverage.type) {
          case 'general_liability':
            profile.insuranceCoverage.generalLiability = coverage.limit;
            break;
          case 'auto_liability':
            profile.insuranceCoverage.autoLiability = coverage.limit;
            break;
          case 'workers_comp':
            profile.insuranceCoverage.workersComp = coverage.limit;
            break;
          case 'umbrella':
            profile.insuranceCoverage.umbrella = coverage.limit;
            break;
        }
      }

      profile.fieldsAutoPopulated.push('insuranceCoverage');

      if (profile.dataSource === 'w9') {
        profile.dataSource = 'combined';
      } else {
        profile.dataSource = 'coi';
      }
    }

    // Calculate confidence based on data completeness
    profile.confidence = this.calculateProfileConfidence(profile);

    // Identify fields requiring review
    if (!profile.taxId) {
      profile.fieldsRequiringReview.push('taxId');
    }
    if (profile.address.street === '') {
      profile.fieldsRequiringReview.push('address');
    }
    if (!profile.insuranceCoverage) {
      profile.fieldsRequiringReview.push('insuranceCoverage');
    }

    return profile;
  }

  private isW9Data(data: unknown): data is W9ExtractedData {
    const d = data as W9ExtractedData;
    return typeof d.businessName === 'string' && typeof d.tin === 'string';
  }

  private isCOIData(data: unknown): data is COIExtractedData {
    const d = data as COIExtractedData;
    return typeof d.insurerName === 'string' && Array.isArray(d.coverages);
  }

  private mapTaxClassification(classification: string): string {
    const mapping: Record<string, string> = {
      'individual': 'Sole Proprietor',
      'c_corp': 'C Corporation',
      's_corp': 'S Corporation',
      'partnership': 'Partnership',
      'trust': 'Trust/Estate',
      'llc': 'LLC',
      'other': 'Other',
    };
    return mapping[classification] || 'Unknown';
  }

  private calculateProfileConfidence(profile: GeneratedVendorProfile): number {
    let score = 0;
    const weights = {
      taxId: 0.25,
      legalName: 0.15,
      address: 0.15,
      businessType: 0.1,
      insuranceCoverage: 0.2,
      dataSource: 0.15,
    };

    if (profile.taxId) score += weights.taxId;
    if (profile.legalName && profile.legalName !== 'unknown') score += weights.legalName;
    if (profile.address.street) score += weights.address;
    if (profile.businessType !== 'unknown') score += weights.businessType;
    if (profile.insuranceCoverage) score += weights.insuranceCoverage;
    if (profile.dataSource !== 'manual') score += weights.dataSource;

    return Math.round(score * 100) / 100;
  }

  private assessRisk(
    input: VendorOnboardingInput,
    profile?: GeneratedVendorProfile
  ): RiskAssessment {
    const riskFactors: RiskAssessment['riskFactors'] = [];
    let totalScore = 0;

    // Financial risk factors
    const financialReasons: string[] = [];
    if (input.vendor.expectedSpend && input.vendor.expectedSpend > 100000) {
      riskFactors.push({
        factor: 'High expected spend',
        severity: 'medium',
        description: `Expected annual spend of $${input.vendor.expectedSpend.toLocaleString()} exceeds threshold`,
        mitigation: 'Require additional financial review and approval',
      });
      totalScore += 15;
      financialReasons.push('High expected spend');
    }

    if (!input.existingProfile?.bankingInfo?.hasAchSetup) {
      riskFactors.push({
        factor: 'No banking verification',
        severity: 'low',
        description: 'ACH banking information not verified',
        mitigation: 'Complete banking verification before first payment',
      });
      totalScore += 10;
      financialReasons.push('Banking not verified');
    }

    // Compliance risk factors
    const complianceReasons: string[] = [];
    const requirements = input.companyRequirements || this.agentConfig.defaultRequirements!;

    if (requirements.requireW9) {
      const hasValidW9 = input.documents?.some(d =>
        d.documentType === 'w9' && d.validationStatus === 'valid'
      );
      if (!hasValidW9) {
        riskFactors.push({
          factor: 'Missing W-9',
          severity: 'high',
          description: 'W-9 tax form not received or validated',
          mitigation: 'Request W-9 from vendor before processing payments',
        });
        totalScore += 25;
        complianceReasons.push('Missing W-9');
      }
    }

    if (requirements.requireCoi) {
      const hasValidCoi = input.documents?.some(d =>
        d.documentType === 'coi' && d.validationStatus === 'valid'
      );
      if (!hasValidCoi) {
        riskFactors.push({
          factor: 'Missing insurance certificate',
          severity: 'high',
          description: 'Certificate of Insurance not on file or invalid',
          mitigation: 'Request updated COI from vendor',
        });
        totalScore += 20;
        complianceReasons.push('Missing COI');
      }
    }

    // Check insurance coverage levels
    if (profile?.insuranceCoverage) {
      const minCoverage = requirements.minCoiCoverage || 1000000;
      if ((profile.insuranceCoverage.generalLiability || 0) < minCoverage) {
        riskFactors.push({
          factor: 'Insufficient liability coverage',
          severity: 'medium',
          description: `General liability coverage below minimum of $${minCoverage.toLocaleString()}`,
          mitigation: 'Request vendor increase coverage or obtain waiver',
        });
        totalScore += 15;
        complianceReasons.push('Insufficient insurance coverage');
      }
    }

    // Operational risk factors
    const operationalReasons: string[] = [];
    if (!profile?.taxId) {
      riskFactors.push({
        factor: 'Unverified tax identification',
        severity: 'high',
        description: 'Tax ID not extracted or verified',
        mitigation: 'Verify TIN with IRS TIN matching program',
      });
      totalScore += 20;
      operationalReasons.push('Tax ID not verified');
    }

    if (profile && profile.confidence < 0.7) {
      riskFactors.push({
        factor: 'Low profile confidence',
        severity: 'medium',
        description: `Profile data confidence of ${(profile.confidence * 100).toFixed(0)}% below threshold`,
        mitigation: 'Manual review of extracted data recommended',
      });
      totalScore += 10;
      operationalReasons.push('Low data confidence');
    }

    // Determine risk levels
    const thresholds = this.agentConfig.riskThresholds!;
    const getRiskLevel = (score: number): RiskLevel => {
      if (score <= thresholds.lowRiskMax) return 'low';
      if (score <= thresholds.mediumRiskMax) return 'medium';
      if (score <= thresholds.highRiskMax) return 'high';
      return 'critical';
    };

    const overallRisk = getRiskLevel(totalScore);

    return {
      overallRisk,
      riskScore: Math.min(totalScore, 100),
      riskFactors,
      financialRisk: {
        level: financialReasons.length > 1 ? 'medium' : financialReasons.length > 0 ? 'low' : 'low',
        reasons: financialReasons,
      },
      complianceRisk: {
        level: complianceReasons.length > 1 ? 'high' : complianceReasons.length > 0 ? 'medium' : 'low',
        reasons: complianceReasons,
      },
      operationalRisk: {
        level: operationalReasons.length > 1 ? 'high' : operationalReasons.length > 0 ? 'medium' : 'low',
        reasons: operationalReasons,
      },
      recommendations: this.generateRiskRecommendations(riskFactors, overallRisk),
    };
  }

  private generateRiskRecommendations(
    factors: RiskAssessment['riskFactors'],
    overallRisk: RiskLevel
  ): string[] {
    const recommendations: string[] = [];

    // Add mitigation recommendations from factors
    for (const factor of factors) {
      if (factor.mitigation && factor.severity !== 'low') {
        recommendations.push(factor.mitigation);
      }
    }

    // Add overall recommendations based on risk level
    switch (overallRisk) {
      case 'critical':
        recommendations.push('Escalate to senior management for approval');
        recommendations.push('Consider alternative vendor options');
        break;
      case 'high':
        recommendations.push('Require additional documentation before proceeding');
        recommendations.push('Implement enhanced monitoring for first 90 days');
        break;
      case 'medium':
        recommendations.push('Complete all pending requirements before first transaction');
        break;
      case 'low':
        recommendations.push('Standard onboarding process approved');
        break;
    }

    return recommendations;
  }

  private checkCompliance(
    input: VendorOnboardingInput,
    profile?: GeneratedVendorProfile
  ): ComplianceChecklist {
    const requirements: ComplianceChecklist['requirements'] = [];
    const requirements_config = input.companyRequirements || {
      requireW9: this.agentConfig.defaultRequirements!.requireW9,
      requireCoi: this.agentConfig.defaultRequirements!.requireCoi,
      minCoiCoverage: this.agentConfig.defaultRequirements!.minCoiCoverage,
      requireBackgroundCheck: false,
      requireNda: false,
    };

    // W-9 requirement
    if (requirements_config.requireW9) {
      const w9Doc = input.documents?.find(d => d.documentType === 'w9');
      requirements.push({
        id: 'w9_form',
        name: 'W-9 Tax Form',
        category: 'tax',
        status: this.getDocumentStatus(w9Doc),
        required: true,
        completedDate: w9Doc?.validationStatus === 'valid' ? new Date().toISOString() : undefined,
        notes: !w9Doc ? 'W-9 not received' : undefined,
      });
    }

    // COI requirement
    if (requirements_config.requireCoi) {
      const coiDoc = input.documents?.find(d => d.documentType === 'coi');
      const coiStatus = this.getDocumentStatus(coiDoc);
      let notes: string | undefined;

      if (coiDoc?.extractedData && this.isCOIData(coiDoc.extractedData)) {
        const minCoverage = requirements_config.minCoiCoverage || 1000000;
        const glCoverage = coiDoc.extractedData.coverages.find(c => c.type === 'general_liability');
        if (glCoverage && glCoverage.limit < minCoverage) {
          notes = `Coverage of $${glCoverage.limit.toLocaleString()} below required $${minCoverage.toLocaleString()}`;
        }
      }

      requirements.push({
        id: 'coi',
        name: 'Certificate of Insurance',
        category: 'insurance',
        status: coiStatus,
        required: true,
        completedDate: coiDoc?.validationStatus === 'valid' ? new Date().toISOString() : undefined,
        notes,
      });
    }

    // Banking verification
    requirements.push({
      id: 'banking_verification',
      name: 'ACH Banking Verification',
      category: 'financial',
      status: input.existingProfile?.bankingInfo?.hasAchSetup ? 'completed' : 'not_started',
      required: true,
      completedDate: input.existingProfile?.bankingInfo?.lastVerified,
    });

    // Background check (if required)
    if (requirements_config.requireBackgroundCheck) {
      requirements.push({
        id: 'background_check',
        name: 'Background Check',
        category: 'legal',
        status: 'not_started',
        required: true,
        notes: 'Background check required for vendors with spend > $50,000',
      });
    }

    // NDA (if required)
    if (requirements_config.requireNda) {
      requirements.push({
        id: 'nda',
        name: 'Non-Disclosure Agreement',
        category: 'legal',
        status: 'not_started',
        required: true,
      });
    }

    // Vendor profile completion
    requirements.push({
      id: 'profile_completion',
      name: 'Vendor Profile Completion',
      category: 'operational',
      status: profile && profile.confidence >= 0.8 ? 'completed' :
              profile && profile.confidence >= 0.5 ? 'in_progress' : 'not_started',
      required: true,
      notes: profile ? `${(profile.confidence * 100).toFixed(0)}% complete` : undefined,
    });

    // Calculate completion
    const requiredItems = requirements.filter(r => r.required);
    const completedItems = requiredItems.filter(r => r.status === 'completed');
    const completionPercentage = Math.round((completedItems.length / requiredItems.length) * 100);

    // Determine overall status
    let overallStatus: ComplianceChecklist['overallStatus'] = 'incomplete';
    if (completedItems.length === requiredItems.length) {
      overallStatus = 'complete';
    } else if (requirements.some(r => r.status === 'failed')) {
      overallStatus = 'failed';
    }

    // Generate next steps
    const nextSteps = requirements
      .filter(r => r.required && r.status !== 'completed')
      .map(r => {
        switch (r.id) {
          case 'w9_form':
            return 'Request W-9 form from vendor';
          case 'coi':
            return 'Request Certificate of Insurance from vendor';
          case 'banking_verification':
            return 'Complete ACH banking verification';
          case 'background_check':
            return 'Initiate background check process';
          case 'nda':
            return 'Send NDA for vendor signature';
          case 'profile_completion':
            return 'Complete vendor profile information';
          default:
            return `Complete ${r.name}`;
        }
      });

    // Estimate completion time
    const incompleteCount = requiredItems.length - completedItems.length;
    const estimatedCompletionDays = incompleteCount * 2; // Rough estimate: 2 days per requirement

    return {
      overallStatus,
      completionPercentage,
      requirements,
      nextSteps,
      estimatedCompletionDays: incompleteCount > 0 ? estimatedCompletionDays : undefined,
    };
  }

  private getDocumentStatus(
    doc?: { validationStatus?: string }
  ): RequirementStatus {
    if (!doc) return 'not_started';
    switch (doc.validationStatus) {
      case 'valid':
        return 'completed';
      case 'invalid':
        return 'failed';
      case 'pending':
        return 'in_progress';
      default:
        return 'not_started';
    }
  }

  private determineOnboardingStatus(
    input: VendorOnboardingInput,
    compliance?: ComplianceChecklist,
    risk?: RiskAssessment
  ): OnboardingStatus {
    // Check if any documents received
    const hasDocuments = input.documents && input.documents.length > 0;

    if (!hasDocuments && !input.existingProfile) {
      return 'pending_documents';
    }

    // Check compliance status
    if (compliance) {
      if (compliance.overallStatus === 'failed') {
        return 'rejected';
      }
      if (compliance.overallStatus === 'incomplete') {
        if (compliance.completionPercentage < 50) {
          return 'documents_received';
        }
        return 'under_review';
      }
    }

    // Check risk level
    if (risk) {
      if (risk.overallRisk === 'critical') {
        return 'on_hold';
      }
      if (risk.overallRisk === 'high') {
        return 'under_review';
      }
    }

    // Check if auto-approval is possible
    const expectedSpend = input.vendor.expectedSpend || 0;
    if (
      compliance?.overallStatus === 'complete' &&
      risk?.overallRisk === 'low' &&
      expectedSpend <= (this.agentConfig.autoApproveMaxSpend || 0)
    ) {
      return 'approved';
    }

    return 'pending_approval';
  }

  private generateRecommendedActions(
    input: VendorOnboardingInput,
    status: OnboardingStatus,
    compliance?: ComplianceChecklist,
    risk?: RiskAssessment
  ): VendorOnboardingOutput['actions'] {
    const actions: VendorOnboardingOutput['actions'] = [];

    // Add compliance-related actions
    if (compliance) {
      for (const req of compliance.requirements) {
        if (req.required && req.status !== 'completed' && req.status !== 'waived') {
          actions.push({
            action: this.getActionForRequirement(req.id),
            priority: req.status === 'failed' ? 'high' : 'medium',
            automatable: ['w9_form', 'coi'].includes(req.id), // Can send automated reminders
            dueDate: this.calculateDueDate(req.status === 'failed' ? 1 : 5),
          });
        }
      }
    }

    // Add risk-related actions
    if (risk && risk.overallRisk !== 'low') {
      for (const factor of risk.riskFactors) {
        if (factor.severity === 'high' || factor.severity === 'critical') {
          actions.push({
            action: factor.mitigation || `Address: ${factor.factor}`,
            priority: factor.severity === 'critical' ? 'high' : 'medium',
            automatable: false,
          });
        }
      }
    }

    // Add status-specific actions
    switch (status) {
      case 'pending_documents':
        actions.push({
          action: 'Send initial document request to vendor',
          priority: 'high',
          automatable: true,
        });
        break;
      case 'pending_approval':
        actions.push({
          action: 'Submit for management approval',
          priority: 'high',
          assignee: 'Procurement Manager',
          automatable: false,
        });
        break;
      case 'on_hold':
        actions.push({
          action: 'Schedule risk review meeting',
          priority: 'high',
          automatable: false,
        });
        break;
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return actions;
  }

  private getActionForRequirement(reqId: string): string {
    const actionMap: Record<string, string> = {
      'w9_form': 'Request W-9 form from vendor',
      'coi': 'Request Certificate of Insurance from vendor',
      'banking_verification': 'Complete ACH banking verification',
      'background_check': 'Initiate background check',
      'nda': 'Send NDA for signature',
      'profile_completion': 'Complete vendor profile information',
    };
    return actionMap[reqId] || `Complete ${reqId}`;
  }

  private calculateDueDate(daysFromNow: number): string {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date.toISOString().split('T')[0];
  }

  private generateApprovalRecommendation(
    input: VendorOnboardingInput,
    status: OnboardingStatus,
    compliance?: ComplianceChecklist,
    risk?: RiskAssessment
  ): VendorOnboardingOutput['approvalRecommendation'] {
    // Auto-approve for low risk, complete compliance, low spend
    const expectedSpend = input.vendor.expectedSpend || 0;
    const isLowSpend = expectedSpend <= (this.agentConfig.autoApproveMaxSpend || 0);
    const isCompliant = compliance?.overallStatus === 'complete';
    const isLowRisk = risk?.overallRisk === 'low';

    if (isCompliant && isLowRisk && isLowSpend) {
      return {
        recommend: 'approve',
        confidence: 0.95,
        reasoning: 'Vendor meets all compliance requirements, low risk profile, and spend below auto-approval threshold.',
      };
    }

    if (status === 'rejected' || compliance?.overallStatus === 'failed') {
      return {
        recommend: 'reject',
        confidence: 0.9,
        reasoning: 'Vendor failed critical compliance requirements.',
        conditions: compliance?.requirements
          .filter(r => r.status === 'failed')
          .map(r => `Failed: ${r.name}`),
      };
    }

    if (risk?.overallRisk === 'critical') {
      return {
        recommend: 'reject',
        confidence: 0.85,
        reasoning: 'Risk assessment indicates critical risk level.',
        conditions: risk.riskFactors
          .filter(f => f.severity === 'critical')
          .map(f => f.description),
      };
    }

    if (risk?.overallRisk === 'high' || status === 'on_hold') {
      return {
        recommend: 'hold',
        confidence: 0.8,
        reasoning: 'High risk factors require additional review and approval.',
        conditions: risk?.riskFactors
          .filter(f => f.severity === 'high')
          .map(f => `Resolve: ${f.factor}`),
      };
    }

    if (!isCompliant) {
      const completionPct = compliance?.completionPercentage || 0;
      return {
        recommend: 'review',
        confidence: 0.75,
        reasoning: `Compliance at ${completionPct}%. Additional documentation required.`,
        conditions: compliance?.nextSteps,
      };
    }

    // Medium risk or high spend requires manual review
    return {
      recommend: 'review',
      confidence: 0.7,
      reasoning: `Vendor requires manual review due to ${
        !isLowSpend ? 'high expected spend' : 'moderate risk factors'
      }.`,
      conditions: [
        ...(risk?.recommendations || []).slice(0, 3),
        expectedSpend > 50000 ? `Review expected spend of $${expectedSpend.toLocaleString()}` : '',
      ].filter(Boolean),
    };
  }
}
