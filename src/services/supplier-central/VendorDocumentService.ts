import { posix as pathPosix } from 'node:path';
import {
  DocumentParsingInput,
  DocumentParsingOutput,
  W9ExtractedData,
  COIExtractedData,
} from '../ai/orchestrator/agents/DocumentParsingAgent';
import type { AgentExecutionContext } from '../ai/orchestrator/interfaces';
import type {
  DocumentUploadInput,
  DocumentUploadResult,
  DocumentParseInput,
  DocumentParseVendorContext,
  DocumentParseResult,
} from '../../types/supplierCentral';
import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import type { VendorDirectory } from './VendorDirectory';
import {
  calculateOnboardingProgress,
  getCompletedSteps,
  getNextSteps,
} from './progressHelpers';

export class VendorDocumentService {
  constructor(
    private runtime: SupplierCentralRuntime,
    private vendorDirectory: VendorDirectory,
  ) {}

  async uploadDocument(
    vendorId: string,
    documentType: 'w9' | 'insurance_gl' | 'insurance_wc' | 'insurance_pl' | 'certification',
    documentData: DocumentUploadInput,
  ): Promise<DocumentUploadResult> {
    const vendorSnapshot = this.vendorDirectory.getVendorById(vendorId);
    if (!vendorSnapshot) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    const documentId = this.runtime.createId('doc');
    const safeFileName = sanitizeFileNameForUrl(documentData.fileName);
    const documentUrl = `/uploads/vendors/${encodeURIComponent(vendorId)}/${documentId}_${safeFileName}`;

    const now = this.runtime.now();

    // AI-powered document extraction
    let aiExtraction: DocumentParsingOutput | undefined;
    if (this.runtime.documentParsingAgent && documentData.content) {
      try {
        const agentInput: DocumentParsingInput = {
          document: {
            id: documentId,
            filename: documentData.fileName,
            mimeType: documentData.mimeType,
            content: documentData.content,
            contentType: documentData.content.startsWith('data:') ? 'base64' : 'text',
            uploadedAt: now,
          },
          expectedDocumentType: documentType === 'w9' ? 'w9' :
            documentType.startsWith('insurance') ? 'coi' : 'unknown',
          vendorContext: {
            vendorId,
            vendorName: vendorSnapshot.basicInfo.companyName,
            existingTin: vendorSnapshot.basicInfo.taxId,
            existingBusinessName: vendorSnapshot.basicInfo.legalName || vendorSnapshot.basicInfo.companyName,
          },
        };

        const context: AgentExecutionContext = {
          sessionId: `doc-parse-${documentId}`,
          userId: 'system',
          correlationId: vendorId,
        };

        const result = await this.runtime.documentParsingAgent.execute(context, agentInput);

        if (result.success && result.data) {
          aiExtraction = result.data as DocumentParsingOutput;

          this.runtime.logger.info('DocumentParsingAgent extraction completed', {
            vendorId,
            documentId,
            documentType: aiExtraction.documentType,
            confidence: aiExtraction.confidence,
            isValid: aiExtraction.validationResults.isValid,
          });
        }
      } catch (error) {
        this.runtime.logger.warn('DocumentParsingAgent extraction failed', {
          vendorId,
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const updatedVendor = this.vendorDirectory.updateVendor(vendorId, vendor => {
      if (aiExtraction?.documentType === 'w9' && aiExtraction.confidence > 0.7) {
        const w9Data = aiExtraction.extractedData as W9ExtractedData;
        if (w9Data.tin && (!vendor.basicInfo.taxId || vendor.basicInfo.taxId === 'pending')) {
          vendor.basicInfo.taxId = w9Data.tin;
        }
        if (w9Data.businessName && w9Data.businessName !== 'Unknown') {
          vendor.basicInfo.legalName = w9Data.businessName;
        }
        if (w9Data.businessNameDba) {
          vendor.basicInfo.dbaName = w9Data.businessNameDba;
        }
        if (w9Data.address?.street) {
          vendor.addresses.headquarters = {
            ...vendor.addresses.headquarters,
            street1: w9Data.address.street,
            city: w9Data.address.city,
            state: w9Data.address.state,
            postalCode: w9Data.address.zipCode,
            country: 'US',
          };
        }
      }

      if (aiExtraction?.documentType === 'coi' && aiExtraction.confidence > 0.7) {
        const coiData = aiExtraction.extractedData as COIExtractedData;
        for (const coverage of coiData.coverages) {
          if (coverage.type === 'general_liability') {
            vendor.compliance.insurance.generalLiability = {
              status: 'submitted',
              coverage: coverage.limit,
              expirationDate: coiData.expirationDate ? new Date(coiData.expirationDate).getTime() : undefined,
              certificateUrl: documentUrl,
            };
          } else if (coverage.type === 'workers_comp') {
            vendor.compliance.insurance.workersComp = {
              status: 'submitted',
              coverage: coverage.limit,
              expirationDate: coiData.expirationDate ? new Date(coiData.expirationDate).getTime() : undefined,
              certificateUrl: documentUrl,
            };
          } else if (coverage.type === 'professional_liability') {
            vendor.compliance.insurance.professionalLiability = {
              status: 'submitted',
              coverage: coverage.limit,
              expirationDate: coiData.expirationDate ? new Date(coiData.expirationDate).getTime() : undefined,
              certificateUrl: documentUrl,
            };
          }
        }
      }

      if (aiExtraction?.validationResults.warnings.length) {
        for (const warning of aiExtraction.validationResults.warnings) {
          vendor.onboardingStatus.notes.push({
            id: this.runtime.createId('note'),
            timestamp: now,
            author: 'ai-system',
            content: `AI Document Analysis Warning: ${warning}`,
            type: 'warning',
          });
        }
      }

      // documentData.metadata is Record<string, unknown> (caller-supplied);
      // narrow each field at the read site instead of casting to a typed
      // shape (which would defeat the safety the unknown gives us — e.g. a
      // client sending {coverage: "high"} would otherwise land a string in
      // vendor.compliance.insurance.*.coverage where number is expected).
      const meta = documentData.metadata ?? {};
      const coverage = typeof meta.coverage === 'number' ? meta.coverage : undefined;
      const certName = typeof meta.name === 'string' ? meta.name : undefined;
      const issuingBody = typeof meta.issuingBody === 'string' ? meta.issuingBody : undefined;
      const certificateNumber = typeof meta.certificateNumber === 'string' ? meta.certificateNumber : undefined;
      const issuedDate = typeof meta.issuedDate === 'number' ? meta.issuedDate : undefined;

      switch (documentType) {
        case 'w9':
          if (vendor.compliance.w9Form?.status !== 'submitted' &&
              vendor.compliance.w9Form?.status !== 'verified') {
            vendor.compliance.w9Form = {
              status: 'submitted',
              submittedAt: now,
              documentUrl,
            };
          }
          break;
        case 'insurance_gl':
          if (vendor.compliance.insurance.generalLiability.status !== 'submitted' &&
              vendor.compliance.insurance.generalLiability.status !== 'verified') {
            vendor.compliance.insurance.generalLiability = {
              status: 'submitted',
              coverage,
              expirationDate: documentData.expirationDate,
              certificateUrl: documentUrl,
            };
          }
          break;
        case 'insurance_wc':
          if (vendor.compliance.insurance.workersComp.status !== 'submitted' &&
              vendor.compliance.insurance.workersComp.status !== 'verified') {
            vendor.compliance.insurance.workersComp = {
              status: 'submitted',
              coverage,
              expirationDate: documentData.expirationDate,
              certificateUrl: documentUrl,
            };
          }
          break;
        case 'insurance_pl':
          if (vendor.compliance.insurance.professionalLiability.status !== 'submitted' &&
              vendor.compliance.insurance.professionalLiability.status !== 'verified') {
            vendor.compliance.insurance.professionalLiability = {
              status: 'submitted',
              coverage,
              expirationDate: documentData.expirationDate,
              certificateUrl: documentUrl,
            };
          }
          break;
        case 'certification':
          if (documentData.metadata) {
            vendor.compliance.certifications.push({
              name: certName || 'Unknown Certification',
              issuingBody: issuingBody || 'Unknown',
              certificateNumber: certificateNumber || 'N/A',
              issuedDate: issuedDate || now,
              expirationDate: documentData.expirationDate || now + (365 * 24 * 60 * 60 * 1000),
              documentUrl,
            });
          }
          break;
      }

      vendor.onboardingStatus.progress = calculateOnboardingProgress(vendor);
      vendor.onboardingStatus.completedSteps = getCompletedSteps(vendor);
      vendor.onboardingStatus.nextSteps = getNextSteps(vendor);
      vendor.onboardingStatus.notes.push({
        id: this.runtime.createId('note'),
        timestamp: now,
        author: 'system',
        content: `${documentType.toUpperCase()} document uploaded: ${documentData.fileName}${aiExtraction ? ' (AI-extracted)' : ''}`,
        type: 'info',
      });

      if (vendor.onboardingStatus.progress >= 75 && vendor.onboardingStatus.stage === 'documents_pending') {
        vendor.onboardingStatus.stage = 'compliance_review';
      }

      vendor.metadata.updatedAt = now;
    });

    if (!updatedVendor) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    // Record activity
    await this.vendorDirectory.recordActivity({
      vendorId,
      type: 'document_upload',
      description: `${documentType.toUpperCase()} document uploaded${aiExtraction ? ' with AI extraction' : ''}`,
      metadata: {
        documentId,
        fileName: documentData.fileName,
        fileSize: documentData.fileSize,
        documentType,
        aiExtracted: !!aiExtraction,
        aiConfidence: aiExtraction?.confidence,
      },
    });

    this.runtime.logger.info('Document uploaded', {
      vendorId,
      documentId,
      documentType,
      fileName: documentData.fileName,
      aiExtracted: !!aiExtraction,
    });

    return { documentId, uploadUrl: documentUrl, aiExtraction };
  }

  async parseDocument(
    documentId: string,
    documentData: DocumentParseInput,
    vendorContext?: DocumentParseVendorContext,
  ): Promise<DocumentParseResult> {
    if (!this.runtime.documentParsingAgent) {
      return { success: false, error: 'Document parsing agent not available' };
    }

    if (!documentData.content) {
      return { success: false, error: 'Document content is required' };
    }

    try {
      const agentInput: DocumentParsingInput = {
        document: {
          id: documentId,
          filename: documentData.fileName,
          mimeType: documentData.mimeType,
          content: documentData.content,
          contentType: documentData.content.startsWith('data:') ? 'base64' : 'text',
          uploadedAt: this.runtime.now(),
        },
        expectedDocumentType: documentData.expectedType || 'unknown',
        vendorContext: vendorContext ? {
          vendorId: vendorContext.vendorId || 'unknown',
          vendorName: vendorContext.vendorName || 'Unknown Vendor',
          existingTin: vendorContext.existingTin,
        } : undefined,
      };

      const context: AgentExecutionContext = {
        sessionId: `doc-parse-${documentId}`,
        userId: 'system',
        correlationId: documentId,
      };

      const result = await this.runtime.documentParsingAgent.execute(context, agentInput);

      if (result.success && result.data) {
        const parsing = result.data as DocumentParsingOutput;

        this.runtime.logger.info('Document parsed successfully', {
          documentId,
          documentType: parsing.documentType,
          confidence: parsing.confidence,
          isValid: parsing.validationResults.isValid,
        });

        return { success: true, parsing };
      }

      return { success: false, error: 'Document parsing returned no data' };
    } catch (error) {
      this.runtime.logger.warn('Document parsing failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Document parsing failed',
      };
    }
  }
}

function sanitizeFileNameForUrl(fileName: string): string {
  const basename = pathPosix.basename(fileName.replace(/\\/g, '/'));
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 0 ? safe : 'unnamed';
}
