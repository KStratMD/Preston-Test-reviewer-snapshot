/**
 * AI Document Parsing Agent
 *
 * LLM-powered document extraction for vendor onboarding documents.
 * Supports W-9 forms, insurance certificates (COI), and other business documents.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import { BaseAgent, BaseAgentConfig } from '../BaseAgent';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema
} from '../interfaces';
import { logger, type Logger } from '../../../../utils/Logger';

// Document types supported
export type DocumentType = 'w9' | 'coi' | 'w8ben' | 'ach_form' | 'business_license' | 'unknown';

// Input/Output interfaces
export interface DocumentParsingInput {
  document: {
    id: string;
    filename: string;
    mimeType: string;
    content: string; // Base64 encoded or extracted text
    contentType: 'base64' | 'text' | 'ocr_text';
    uploadedBy?: string;
    uploadedAt?: number;
  };
  expectedDocumentType?: DocumentType;
  vendorContext?: {
    vendorId: string;
    vendorName: string;
    existingTin?: string;
    existingBusinessName?: string;
  };
  validationRules?: {
    requireTinMatch?: boolean;
    requireBusinessNameMatch?: boolean;
    minCoverageAmount?: number;
    maxExpirationDays?: number;
  };
}

// W-9 extracted data
export interface W9ExtractedData extends Record<string, unknown> {
  businessName: string;
  businessNameDba?: string;
  taxClassification: 'individual' | 'c_corp' | 's_corp' | 'partnership' | 'trust' | 'llc' | 'other';
  llcTaxClassification?: 'c' | 's' | 'p';
  exemptPayeeCode?: string;
  fatcaExemptionCode?: string;
  address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  };
  tin: string;
  tinType: 'ssn' | 'ein';
  signatureDate?: string;
  certificationComplete: boolean;
}

// Certificate of Insurance (COI) extracted data
export interface COIExtractedData extends Record<string, unknown> {
  insurerName: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string;
  namedInsured: string;
  coverages: {
    type: 'general_liability' | 'auto_liability' | 'umbrella' | 'workers_comp' | 'professional_liability' | 'other';
    limit: number;
    deductible?: number;
    perOccurrence?: number;
    aggregate?: number;
  }[];
  additionalInsured?: string[];
  certificateHolder?: {
    name: string;
    address: string;
  };
  isValid: boolean;
  daysUntilExpiration: number;
}

export interface DocumentParsingOutput {
  documentType: DocumentType;
  confidence: number;
  extractedData: W9ExtractedData | COIExtractedData | Record<string, unknown>;
  validationResults: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
  qualityAssessment: {
    readability: number; // 0-1
    completeness: number; // 0-1
    dataQuality: number; // 0-1
  };
  recommendations: string[];
  rawExtraction?: Record<string, unknown>;
}

/**
 * AI Document Parsing Agent - Intelligent document extraction
 */
export class DocumentParsingAgent extends BaseAgent {
  private static readonly AGENT_CONFIG: BaseAgentConfig = {
    name: 'DocumentParsingAgent',
    version: '1.0.0',
    capabilities: [
      'document_classification',
      'w9_extraction',
      'coi_extraction',
      'tin_validation',
      'coverage_validation',
      'ocr_processing'
    ],
    dependencies: [],
    maxExecutionTime: 30000,
    confidenceThreshold: 0.7
  };

  // TIN validation patterns
  private static readonly SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;
  private static readonly EIN_PATTERN = /^\d{2}-?\d{7}$/;

  // Document type indicators
  private static readonly W9_INDICATORS = [
    'request for taxpayer',
    'identification number',
    'form w-9',
    'w-9',
    'taxpayer identification',
    'backup withholding',
    'fatca'
  ];

  private static readonly COI_INDICATORS = [
    'certificate of insurance',
    'certificate of liability',
    'acord 25',
    'general liability',
    'commercial general liability',
    'policy number',
    'certificate holder'
  ];

  constructor(providedLogger?: Logger) {
    super(DocumentParsingAgent.AGENT_CONFIG, providedLogger || logger);
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {
        type: 'object',
        properties: {
          document: { type: 'object', required: true },
          expectedDocumentType: { type: 'string', required: false },
          vendorContext: { type: 'object', required: false },
          validationRules: { type: 'object', required: false }
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          documentType: { type: 'string' },
          confidence: { type: 'number' },
          extractedData: { type: 'object' },
          validationResults: { type: 'object' },
          qualityAssessment: { type: 'object' },
          recommendations: { type: 'array' }
        }
      },
      capabilities: this.capabilities,
      resourceRequirements: {
        maxMemory: 512,
        maxExecutionTime: 30000
      }
    };
  }

  protected async validateInputInternal(input: unknown): Promise<boolean> {
    const data = input as DocumentParsingInput;

    if (!data.document?.id || !data.document?.content) {
      return false;
    }

    if (!['base64', 'text', 'ocr_text'].includes(data.document.contentType)) {
      return false;
    }

    return true;
  }

  protected async executeInternal(
    context: AgentExecutionContext,
    input: unknown
  ): Promise<AgentResult<DocumentParsingOutput>> {
    const data = input as DocumentParsingInput;
    const { document, expectedDocumentType, vendorContext, validationRules } = data;

    this.logger.info('DocumentParsingAgent executing', {
      documentId: document.id,
      filename: document.filename,
      expectedType: expectedDocumentType
    });

    // Step 1: Extract text content
    const textContent = this.extractTextContent(document);

    // Step 2: Classify document type
    const { documentType, typeConfidence } = this.classifyDocument(textContent, expectedDocumentType);

    // Step 3: Extract data based on document type
    let extractedData: W9ExtractedData | COIExtractedData | Record<string, unknown>;
    let extractionConfidence: number;

    switch (documentType) {
      case 'w9':
        const w9Result = this.extractW9Data(textContent);
        extractedData = w9Result.data;
        extractionConfidence = w9Result.confidence;
        break;
      case 'coi':
        const coiResult = this.extractCOIData(textContent);
        extractedData = coiResult.data;
        extractionConfidence = coiResult.confidence;
        break;
      default:
        extractedData = this.extractGenericData(textContent);
        extractionConfidence = 0.5;
    }

    // Step 4: Validate extracted data
    const validationResults = this.validateExtractedData(
      documentType,
      extractedData,
      vendorContext,
      validationRules
    );

    // Step 5: Assess document quality
    const qualityAssessment = this.assessDocumentQuality(textContent, extractedData, documentType);

    // Step 6: Generate recommendations
    const recommendations = this.generateRecommendations(
      documentType,
      extractedData,
      validationResults,
      qualityAssessment
    );

    // Calculate overall confidence
    const overallConfidence = this.calculateConfidence([
      { factor: 'type_classification', value: typeConfidence, weight: 0.3 },
      { factor: 'extraction_quality', value: extractionConfidence, weight: 0.4 },
      { factor: 'validation_pass', value: validationResults.isValid ? 1 : 0.3, weight: 0.2 },
      { factor: 'document_quality', value: qualityAssessment.dataQuality, weight: 0.1 }
    ]);

    const output: DocumentParsingOutput = {
      documentType,
      confidence: overallConfidence,
      extractedData,
      validationResults,
      qualityAssessment,
      recommendations
    };

    const reasoning = this.mergeReasoning([
      `Document classified as ${documentType} with ${(typeConfidence * 100).toFixed(0)}% confidence`,
      `Extracted ${Object.keys(extractedData).length} data fields`,
      validationResults.isValid
        ? 'All validation checks passed'
        : `Validation issues: ${validationResults.errors.join(', ')}`,
      `Document quality score: ${(qualityAssessment.dataQuality * 100).toFixed(0)}%`
    ]);

    return this.createSuccessResult(output, overallConfidence, reasoning);
  }

  private extractTextContent(document: DocumentParsingInput['document']): string {
    if (document.contentType === 'text' || document.contentType === 'ocr_text') {
      return document.content;
    }

    // For base64 content, we would normally decode and OCR
    // For now, return decoded text if it's text-based
    try {
      const decoded = Buffer.from(document.content, 'base64').toString('utf8');
      // Check if it looks like text
      if (/^[\x20-\x7E\s]+$/.test(decoded.substring(0, 1000))) {
        return decoded;
      }
    } catch {
      // Not decodable as text
    }

    // Return placeholder indicating OCR needed
    return '[OCR_REQUIRED]';
  }

  private classifyDocument(
    textContent: string,
    expectedType?: DocumentType
  ): { documentType: DocumentType; typeConfidence: number } {
    const lowerContent = textContent.toLowerCase();

    // Count indicators for each type
    const w9Score = DocumentParsingAgent.W9_INDICATORS.filter(
      indicator => lowerContent.includes(indicator)
    ).length / DocumentParsingAgent.W9_INDICATORS.length;

    const coiScore = DocumentParsingAgent.COI_INDICATORS.filter(
      indicator => lowerContent.includes(indicator)
    ).length / DocumentParsingAgent.COI_INDICATORS.length;

    // Determine document type
    let documentType: DocumentType;
    let typeConfidence: number;

    if (w9Score > coiScore && w9Score > 0.3) {
      documentType = 'w9';
      typeConfidence = Math.min(w9Score * 1.5, 0.95);
    } else if (coiScore > w9Score && coiScore > 0.3) {
      documentType = 'coi';
      typeConfidence = Math.min(coiScore * 1.5, 0.95);
    } else if (expectedType && expectedType !== 'unknown') {
      documentType = expectedType;
      typeConfidence = 0.6; // Lower confidence when relying on expected type
    } else {
      documentType = 'unknown';
      typeConfidence = 0.3;
    }

    // Boost confidence if matches expected type
    if (expectedType && documentType === expectedType) {
      typeConfidence = Math.min(typeConfidence + 0.1, 0.98);
    }

    return { documentType, typeConfidence };
  }

  private extractW9Data(textContent: string): { data: W9ExtractedData; confidence: number } {
    let fieldsFound = 0;
    const totalFields = 8;

    // Extract business name (usually near the top)
    let businessName = '';
    const nameMatch = textContent.match(/name.*?:?\s*([A-Za-z0-9\s&,.'()-]+)/i);
    if (nameMatch) {
      businessName = nameMatch[1].trim();
      fieldsFound++;
    }

    // Extract DBA name
    let businessNameDba: string | undefined;
    const dbaMatch = textContent.match(/(?:dba|doing business as|business name).*?:?\s*([A-Za-z0-9\s&,.'()-]+)/i);
    if (dbaMatch && dbaMatch[1].trim() !== businessName) {
      businessNameDba = dbaMatch[1].trim();
      fieldsFound++;
    }

    // Extract TIN (SSN or EIN)
    let tin = '';
    let tinType: 'ssn' | 'ein' = 'ein';
    const ssnMatch = textContent.match(DocumentParsingAgent.SSN_PATTERN);
    const einMatch = textContent.match(DocumentParsingAgent.EIN_PATTERN);

    if (einMatch) {
      tin = einMatch[0].replace(/-/g, '');
      tinType = 'ein';
      fieldsFound++;
    } else if (ssnMatch) {
      tin = ssnMatch[0].replace(/-/g, '');
      tinType = 'ssn';
      fieldsFound++;
    }

    // Extract tax classification
    let taxClassification: W9ExtractedData['taxClassification'] = 'other';
    if (/individual|sole proprietor/i.test(textContent)) {
      taxClassification = 'individual';
      fieldsFound++;
    } else if (/c[\s-]?corporation|c[\s-]?corp/i.test(textContent)) {
      taxClassification = 'c_corp';
      fieldsFound++;
    } else if (/s[\s-]?corporation|s[\s-]?corp/i.test(textContent)) {
      taxClassification = 's_corp';
      fieldsFound++;
    } else if (/partnership/i.test(textContent)) {
      taxClassification = 'partnership';
      fieldsFound++;
    } else if (/llc|limited liability/i.test(textContent)) {
      taxClassification = 'llc';
      fieldsFound++;
    } else if (/trust|estate/i.test(textContent)) {
      taxClassification = 'trust';
      fieldsFound++;
    }

    // Extract address
    const address = this.extractAddress(textContent);
    if (address.street) fieldsFound++;

    // Extract signature date
    let signatureDate: string | undefined;
    const dateMatch = textContent.match(/(?:date|signed).*?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    if (dateMatch) {
      signatureDate = dateMatch[1];
      fieldsFound++;
    }

    // Check if certification is complete
    const certificationComplete = /certify|certification|under penalties of perjury/i.test(textContent);
    if (certificationComplete) fieldsFound++;

    const confidence = fieldsFound / totalFields;

    const data: W9ExtractedData = {
      businessName: businessName || 'Unknown',
      businessNameDba,
      taxClassification,
      address,
      tin: tin || '',
      tinType,
      signatureDate,
      certificationComplete
    };

    return { data, confidence };
  }

  private extractCOIData(textContent: string): { data: COIExtractedData; confidence: number } {
    let fieldsFound = 0;
    const totalFields = 8;

    // Extract insurer name
    let insurerName = '';
    const insurerMatch = textContent.match(/(?:insurer|insurance company|carrier).*?:?\s*([A-Za-z0-9\s&,.'()-]+)/i);
    if (insurerMatch) {
      insurerName = insurerMatch[1].trim();
      fieldsFound++;
    }

    // Extract policy number
    let policyNumber = '';
    const policyMatch = textContent.match(/(?:policy\s*(?:number|#|no\.?)).*?:?\s*([A-Za-z0-9-]+)/i);
    if (policyMatch) {
      policyNumber = policyMatch[1].trim();
      fieldsFound++;
    }

    // Extract dates
    let effectiveDate = '';
    let expirationDate = '';
    const datePattern = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g;
    const dates = textContent.match(datePattern) || [];
    if (dates.length >= 2) {
      effectiveDate = dates[0];
      expirationDate = dates[1];
      fieldsFound += 2;
    }

    // Extract named insured
    let namedInsured = '';
    const insuredMatch = textContent.match(/(?:named insured|insured).*?:?\s*([A-Za-z0-9\s&,.'()-]+)/i);
    if (insuredMatch) {
      namedInsured = insuredMatch[1].trim();
      fieldsFound++;
    }

    // Extract coverages
    const coverages: COIExtractedData['coverages'] = [];

    // General liability
    const glMatch = textContent.match(/general\s*liability.*?(\$?[\d,]+)/i);
    if (glMatch) {
      coverages.push({
        type: 'general_liability',
        limit: this.parseAmount(glMatch[1])
      });
      fieldsFound++;
    }

    // Auto liability
    const autoMatch = textContent.match(/auto(?:mobile)?\s*liability.*?(\$?[\d,]+)/i);
    if (autoMatch) {
      coverages.push({
        type: 'auto_liability',
        limit: this.parseAmount(autoMatch[1])
      });
    }

    // Workers comp
    const wcMatch = textContent.match(/workers?\s*comp(?:ensation)?.*?(\$?[\d,]+)/i);
    if (wcMatch) {
      coverages.push({
        type: 'workers_comp',
        limit: this.parseAmount(wcMatch[1])
      });
    }

    // Umbrella
    const umbrellaMatch = textContent.match(/umbrella.*?(\$?[\d,]+)/i);
    if (umbrellaMatch) {
      coverages.push({
        type: 'umbrella',
        limit: this.parseAmount(umbrellaMatch[1])
      });
    }

    // Calculate days until expiration
    let daysUntilExpiration = 0;
    if (expirationDate) {
      const expDate = new Date(expirationDate);
      const now = new Date();
      daysUntilExpiration = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    const isValid = daysUntilExpiration > 0 && coverages.length > 0;
    if (isValid) fieldsFound++;

    const confidence = fieldsFound / totalFields;

    const data: COIExtractedData = {
      insurerName: insurerName || 'Unknown',
      policyNumber: policyNumber || '',
      effectiveDate,
      expirationDate,
      namedInsured: namedInsured || '',
      coverages,
      isValid,
      daysUntilExpiration
    };

    return { data, confidence };
  }

  private extractGenericData(textContent: string): Record<string, unknown> {
    const lines = textContent.split('\n').map(l => l.trim()).filter(l => l);
    const data: Record<string, unknown> = {};

    // Extract any key-value pairs
    for (const line of lines) {
      const kvMatch = line.match(/^([A-Za-z\s]+):\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
        data[key] = kvMatch[2].trim();
      }
    }

    // Extract any dates found
    const dates = textContent.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g);
    if (dates && dates.length > 0) {
      data.dates_found = dates;
    }

    // Extract any amounts found
    const amounts = textContent.match(/\$[\d,]+(?:\.\d{2})?/g);
    if (amounts && amounts.length > 0) {
      data.amounts_found = amounts;
    }

    return data;
  }

  private extractAddress(textContent: string): W9ExtractedData['address'] {
    // Simple address extraction
    const statePattern = /\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/;
    const stateMatch = textContent.match(statePattern);

    let state = '';
    let zipCode = '';
    if (stateMatch) {
      state = stateMatch[1];
      zipCode = stateMatch[2];
    }

    // Try to find city before state
    let city = '';
    if (state) {
      const cityPattern = new RegExp(`([A-Za-z\\s]+),?\\s*${state}`, 'i');
      const cityMatch = textContent.match(cityPattern);
      if (cityMatch) {
        city = cityMatch[1].trim();
      }
    }

    // Try to find street address
    let street = '';
    const streetMatch = textContent.match(/(\d+\s+[A-Za-z0-9\s,.'#-]+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd|way|court|ct|circle|cir))/i);
    if (streetMatch) {
      street = streetMatch[1].trim();
    }

    return { street, city, state, zipCode };
  }

  private parseAmount(amountStr: string): number {
    return parseInt(amountStr.replace(/[$,]/g, ''), 10) || 0;
  }

  private validateExtractedData(
    documentType: DocumentType,
    extractedData: W9ExtractedData | COIExtractedData | Record<string, unknown>,
    vendorContext?: DocumentParsingInput['vendorContext'],
    validationRules?: DocumentParsingInput['validationRules']
  ): DocumentParsingOutput['validationResults'] {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (documentType === 'w9') {
      const w9Data = extractedData as W9ExtractedData;

      // Validate TIN format
      if (!w9Data.tin) {
        errors.push('TIN (Tax Identification Number) is missing');
      } else if (w9Data.tinType === 'ein' && !DocumentParsingAgent.EIN_PATTERN.test(w9Data.tin)) {
        errors.push('Invalid EIN format');
      } else if (w9Data.tinType === 'ssn' && !DocumentParsingAgent.SSN_PATTERN.test(w9Data.tin)) {
        errors.push('Invalid SSN format');
      }

      // Validate business name
      if (!w9Data.businessName || w9Data.businessName === 'Unknown') {
        errors.push('Business name could not be extracted');
      }

      // Check certification
      if (!w9Data.certificationComplete) {
        warnings.push('W-9 certification may be incomplete');
      }

      // Vendor context validation
      if (vendorContext && validationRules?.requireTinMatch) {
        if (vendorContext.existingTin && w9Data.tin !== vendorContext.existingTin) {
          errors.push(`TIN mismatch: extracted ${w9Data.tin} does not match existing ${vendorContext.existingTin}`);
        }
      }

      if (vendorContext && validationRules?.requireBusinessNameMatch) {
        if (vendorContext.existingBusinessName &&
            !w9Data.businessName.toLowerCase().includes(vendorContext.existingBusinessName.toLowerCase())) {
          warnings.push('Business name may not match vendor records');
        }
      }
    } else if (documentType === 'coi') {
      const coiData = extractedData as COIExtractedData;

      // Validate expiration
      if (coiData.daysUntilExpiration <= 0) {
        errors.push('Certificate of Insurance has expired');
      } else if (coiData.daysUntilExpiration < 30) {
        warnings.push(`Certificate expires in ${coiData.daysUntilExpiration} days`);
      }

      if (validationRules?.maxExpirationDays && coiData.daysUntilExpiration > validationRules.maxExpirationDays) {
        warnings.push('Certificate expiration date is unusually far in the future');
      }

      // Validate coverages
      if (coiData.coverages.length === 0) {
        errors.push('No coverage information could be extracted');
      }

      // Validate minimum coverage
      if (validationRules?.minCoverageAmount) {
        const glCoverage = coiData.coverages.find(c => c.type === 'general_liability');
        if (!glCoverage) {
          errors.push('General liability coverage not found');
        } else if (glCoverage.limit < validationRules.minCoverageAmount) {
          errors.push(`General liability coverage ($${glCoverage.limit.toLocaleString()}) is below minimum requirement ($${validationRules.minCoverageAmount.toLocaleString()})`);
        }
      }

      // Validate policy number
      if (!coiData.policyNumber) {
        warnings.push('Policy number could not be extracted');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  private assessDocumentQuality(
    textContent: string,
    extractedData: Record<string, unknown> | W9ExtractedData | COIExtractedData,
    documentType: DocumentType
  ): DocumentParsingOutput['qualityAssessment'] {
    // Readability - based on text clarity
    let readability = 0.5;
    if (textContent !== '[OCR_REQUIRED]') {
      const wordCount = textContent.split(/\s+/).length;
      const lineCount = textContent.split('\n').length;
      if (wordCount > 50 && lineCount > 5) {
        readability = 0.8;
      }
      if (wordCount > 200) {
        readability = 0.9;
      }
    }

    // Completeness - based on fields extracted
    const fieldCount = Object.keys(extractedData).length;
    const completeness = Math.min(fieldCount / 10, 1);

    // Data quality - based on validation
    let dataQuality = 0.5;
    if (documentType === 'w9') {
      const w9Data = extractedData as W9ExtractedData;
      let qualityScore = 0;
      if (w9Data.businessName && w9Data.businessName !== 'Unknown') qualityScore++;
      if (w9Data.tin) qualityScore++;
      if (w9Data.address?.street) qualityScore++;
      if (w9Data.taxClassification !== 'other') qualityScore++;
      if (w9Data.certificationComplete) qualityScore++;
      dataQuality = qualityScore / 5;
    } else if (documentType === 'coi') {
      const coiData = extractedData as COIExtractedData;
      let qualityScore = 0;
      if (coiData.insurerName && coiData.insurerName !== 'Unknown') qualityScore++;
      if (coiData.policyNumber) qualityScore++;
      if (coiData.effectiveDate) qualityScore++;
      if (coiData.expirationDate) qualityScore++;
      if (coiData.coverages.length > 0) qualityScore++;
      dataQuality = qualityScore / 5;
    }

    return { readability, completeness, dataQuality };
  }

  private generateRecommendations(
    documentType: DocumentType,
    extractedData: W9ExtractedData | COIExtractedData | Record<string, unknown>,
    validationResults: DocumentParsingOutput['validationResults'],
    qualityAssessment: DocumentParsingOutput['qualityAssessment']
  ): string[] {
    const recommendations: string[] = [];

    // Quality-based recommendations
    if (qualityAssessment.readability < 0.5) {
      recommendations.push('Document quality is poor - consider requesting a clearer copy');
    }

    if (qualityAssessment.completeness < 0.6) {
      recommendations.push('Document appears incomplete - verify all required sections are included');
    }

    // Validation-based recommendations
    if (validationResults.errors.length > 0) {
      recommendations.push('Review and correct validation errors before proceeding');
    }

    if (validationResults.warnings.length > 0) {
      recommendations.push('Review warnings and confirm data accuracy');
    }

    // Document-specific recommendations
    if (documentType === 'w9') {
      const w9Data = extractedData as W9ExtractedData;
      if (!w9Data.signatureDate) {
        recommendations.push('Ensure W-9 is signed and dated');
      }
      if (w9Data.taxClassification === 'llc' && !w9Data.llcTaxClassification) {
        recommendations.push('LLC tax classification election should be specified');
      }
    } else if (documentType === 'coi') {
      const coiData = extractedData as COIExtractedData;
      if (coiData.daysUntilExpiration < 60 && coiData.daysUntilExpiration > 0) {
        recommendations.push(`Certificate expires soon (${coiData.daysUntilExpiration} days) - request renewal`);
      }
      if (!coiData.coverages.find(c => c.type === 'general_liability')) {
        recommendations.push('General liability coverage not found - confirm coverage is adequate');
      }
    } else if (documentType === 'unknown') {
      recommendations.push('Document type could not be determined - manual review required');
    }

    return recommendations;
  }
}
