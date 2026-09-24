import type {
  VendorOnboardingInput,
  VendorOnboardingOutput,
} from '../ai/orchestrator/agents/VendorOnboardingAgent';
import type { AgentExecutionContext } from '../ai/orchestrator/interfaces';
import type { VendorProfile } from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';

export interface VendorOnboardingAssessmentResult {
  success: boolean;
  data?: VendorOnboardingOutput;
  error?: string;
}

/**
 * Adapter that isolates AI input/output translation for the VendorOnboardingAgent.
 * Owns prompt-building (VendorOnboardingInput construction) and agent invocation.
 */
export class VendorOnboardingAgentAdapter {
  constructor(private runtime: SupplierCentralRuntime) {}

  async assess(vendor: VendorProfile): Promise<VendorOnboardingAssessmentResult> {
    if (!this.runtime.vendorOnboardingAgent) {
      return { success: false, error: 'AI assessment not available' };
    }

    try {
      const input = this.buildInput(vendor);
      const context: AgentExecutionContext = {
        sessionId: `vendor-assessment-${vendor.id}`,
        userId: 'system',
        correlationId: vendor.id,
      };

      const result = await this.runtime.vendorOnboardingAgent.execute(context, input);

      if (result.success && result.data) {
        return { success: true, data: result.data as VendorOnboardingOutput };
      }

      return {
        success: false,
        error: result.errors?.[0] || 'Assessment failed',
      };
    } catch (error) {
      this.runtime.logger.error('VendorOnboardingAgent assessment failed', {
        vendorId: vendor.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private buildInput(vendor: VendorProfile): VendorOnboardingInput {
    return {
      vendor: {
        id: vendor.id,
        name: vendor.basicInfo.companyName,
        email: vendor.contacts.primary.email,
        phone: vendor.contacts.primary.phone,
        category: vendor.basicInfo.industry,
        expectedSpend: vendor.metadata.customFields?.expectedSpend as number | undefined,
        paymentTerms: vendor.netSuite.terms,
      },
      documents: this.buildDocumentListForAssessment(vendor),
      existingProfile: {
        taxId: vendor.basicInfo.taxId,
        businessName: vendor.basicInfo.legalName || vendor.basicInfo.companyName,
        address: {
          street: vendor.addresses.headquarters.street1,
          city: vendor.addresses.headquarters.city,
          state: vendor.addresses.headquarters.state,
          zipCode: vendor.addresses.headquarters.postalCode,
          country: vendor.addresses.headquarters.country,
        },
        bankingInfo: {
          hasAchSetup: !!vendor.banking.accountNumber && !!vendor.banking.routingNumber,
          lastVerified: vendor.metadata.updatedAt ? new Date(vendor.metadata.updatedAt).toISOString() : undefined,
        },
        insuranceOnFile: {
          hasValidCoi: vendor.compliance.insurance.generalLiability.status === 'verified',
          expirationDate: vendor.compliance.insurance.generalLiability.expirationDate
            ? new Date(vendor.compliance.insurance.generalLiability.expirationDate).toISOString()
            : undefined,
        },
      },
      companyRequirements: {
        requireW9: true,
        requireCoi: true,
        minCoiCoverage: 1000000,
        requireBackgroundCheck: false,
        requireNda: false,
        approvalThreshold: 50000,
      },
      requestedActions: ['assess_risk', 'generate_profile', 'check_compliance', 'recommend_actions'],
    };
  }

  /**
   * Build document list for AI assessment from vendor compliance data
   */
  private buildDocumentListForAssessment(vendor: VendorProfile): VendorOnboardingInput['documents'] {
    const documents: VendorOnboardingInput['documents'] = [];

    // W-9 document
    if (vendor.compliance.w9Form.status !== 'pending') {
      documents.push({
        documentId: `w9_${vendor.id}`,
        documentType: 'w9',
        validationStatus: vendor.compliance.w9Form.status === 'verified' ? 'valid' :
                         vendor.compliance.w9Form.status === 'rejected' ? 'invalid' : 'pending',
        extractedData: {
          businessName: vendor.basicInfo.legalName || vendor.basicInfo.companyName,
          businessNameDba: vendor.basicInfo.dbaName,
          tin: vendor.basicInfo.taxId,
          tinType: vendor.basicInfo.taxId?.startsWith('XX-') ? 'ssn' : 'ein',
          taxClassification: 'llc',
          address: {
            street: vendor.addresses.headquarters.street1,
            city: vendor.addresses.headquarters.city,
            state: vendor.addresses.headquarters.state,
            zipCode: vendor.addresses.headquarters.postalCode,
          },
        },
      });
    }

    // COI document (general liability)
    if (vendor.compliance.insurance.generalLiability.status !== 'pending') {
      documents.push({
        documentId: `coi_gl_${vendor.id}`,
        documentType: 'coi',
        validationStatus: vendor.compliance.insurance.generalLiability.status === 'verified' ? 'valid' :
                         vendor.compliance.insurance.generalLiability.status === 'rejected' ? 'invalid' : 'pending',
        extractedData: {
          insurerName: 'Insurance Provider',
          policyNumber: 'POL-XXXXXX',
          effectiveDate: new Date(this.runtime.now()).toISOString(),
          expirationDate: vendor.compliance.insurance.generalLiability.expirationDate
            ? new Date(vendor.compliance.insurance.generalLiability.expirationDate).toISOString()
            : new Date(this.runtime.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          coverages: [
            {
              type: 'general_liability' as const,
              limit: vendor.compliance.insurance.generalLiability.coverage || 1000000,
              deductible: 0,
            },
          ],
          namedInsured: vendor.basicInfo.companyName,
          additionalInsureds: [],
        },
      });
    }

    return documents;
  }
}
