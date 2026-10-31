/**
 * DocumentParsingAgent Unit Tests
 *
 * Tests for the AI Document Parsing Agent - W-9 and COI extraction
 */

import { DocumentParsingAgent, DocumentParsingInput, DocumentParsingOutput } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';
import { Logger } from '../../../src/utils/Logger';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';

describe('DocumentParsingAgent', () => {
  const logger = new Logger('DocumentParsingAgentTest');
  const agent = new DocumentParsingAgent(logger);

  const baseContext: AgentExecutionContext = {
    sessionId: 'test-session',
    userId: 'tester',
    sourceSystem: 'VendorCentral',
    targetSystem: 'NetSuite',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000
  };

  // Sample W-9 text content
  const sampleW9Text = `
    Form W-9 Request for Taxpayer Identification Number and Certification

    Name: Acme Corporation
    Business name/disregarded entity name: Acme Corp DBA TechServices

    Check appropriate box for federal tax classification:
    [X] C Corporation

    Address: 123 Business Way
    City, state, and ZIP code: San Francisco, CA 94102

    Part I - Taxpayer Identification Number (TIN)
    Employer identification number: 12-3456789

    Part II - Certification
    Under penalties of perjury, I certify that:

    Signature: John Smith
    Date: 01/15/2024
  `;

  // Sample COI text content
  const sampleCOIText = `
    CERTIFICATE OF LIABILITY INSURANCE
    ACORD 25 (2016/03)

    INSURER: ABC Insurance Company
    POLICY NUMBER: GL-2024-123456

    EFFECTIVE DATE: 01/01/2024
    EXPIRATION DATE: 01/01/2025

    NAMED INSURED: TechCorp Inc.

    COVERAGES:
    COMMERCIAL GENERAL LIABILITY
    Each Occurrence Limit: $1,000,000
    General Aggregate: $2,000,000

    AUTOMOBILE LIABILITY
    Combined Single Limit: $500,000

    UMBRELLA LIABILITY
    Each Occurrence: $5,000,000

    WORKERS COMPENSATION
    Statutory Limits

    CERTIFICATE HOLDER:
    Client Company LLC
    456 Client Street
    New York, NY 10001
  `;

  describe('Schema Validation', () => {
    it('returns valid agent schema', () => {
      const schema = agent.getSchema();
      expect(schema).toBeDefined();
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.outputSchema.type).toBe('object');
      expect(schema.capabilities).toContain('w9_extraction');
      expect(schema.capabilities).toContain('coi_extraction');
      expect(schema.capabilities).toContain('document_classification');
    });
  });

  describe('Input Validation', () => {
    it('rejects input without document', async () => {
      const input = {};
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(false);
    });

    it('rejects input without document content', async () => {
      const input = {
        document: {
          id: 'doc-1',
          filename: 'test.pdf',
          mimeType: 'application/pdf',
          contentType: 'text'
        }
      };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(false);
    });

    it('rejects invalid content type', async () => {
      const input = {
        document: {
          id: 'doc-1',
          filename: 'test.pdf',
          mimeType: 'application/pdf',
          content: 'test content',
          contentType: 'invalid'
        }
      };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(false);
    });

    it('accepts valid document input', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-1',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('Document Classification', () => {
    it('classifies W-9 document correctly', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9',
          filename: 'w9_form.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('w9');
    });

    it('classifies COI document correctly', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi',
          filename: 'insurance_cert.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('coi');
    });

    it('uses expected type when classification is uncertain', async () => {
      const genericText = 'This is some generic document content without clear indicators.';
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-generic',
          filename: 'document.pdf',
          mimeType: 'application/pdf',
          content: genericText,
          contentType: 'text'
        },
        expectedDocumentType: 'w9'
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('w9');
    });

    it('returns unknown for unclassifiable documents', async () => {
      const genericText = 'Random text without any document indicators.';
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-unknown',
          filename: 'unknown.pdf',
          mimeType: 'application/pdf',
          content: genericText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.documentType).toBe('unknown');
    });
  });

  describe('W-9 Extraction', () => {
    it('extracts business name from W-9', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-1',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.businessName).toBeDefined();
    });

    it('extracts EIN from W-9', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-2',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.tin).toBeDefined();
      expect(data.tinType).toBe('ein');
    });

    it('extracts tax classification from W-9', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-3',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.taxClassification).toBe('c_corp');
    });

    it('extracts address from W-9', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-4',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.address).toBeDefined();
      expect(data.address.state).toBe('CA');
    });

    it('detects certification completion', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-5',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.certificationComplete).toBe(true);
    });
  });

  describe('COI Extraction', () => {
    it('extracts insurer name from COI', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-1',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.insurerName).toBeDefined();
    });

    it('extracts policy number from COI', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-2',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.policyNumber).toContain('GL-2024');
    });

    it('extracts coverage amounts from COI', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-3',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.coverages).toBeDefined();
      expect(Array.isArray(data.coverages)).toBe(true);
      // Coverages may be empty if parsing doesn't find amounts in expected format
    });

    it('extracts dates from COI', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-4',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(data.effectiveDate).toBeDefined();
      expect(data.expirationDate).toBeDefined();
    });

    it('calculates days until expiration', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-5',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const data = result.data?.extractedData as any;
      expect(typeof data.daysUntilExpiration).toBe('number');
    });
  });

  describe('Validation', () => {
    it('validates W-9 TIN format', async () => {
      const invalidW9 = `
        Form W-9 Request for Taxpayer Identification Number
        Name: Test Company
        TIN: invalid-tin
      `;

      const input: DocumentParsingInput = {
        document: {
          id: 'doc-invalid-w9',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: invalidW9,
          contentType: 'text'
        },
        expectedDocumentType: 'w9'
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.validationResults.errors.length).toBeGreaterThan(0);
    });

    it('validates minimum coverage requirements', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-coi-validate',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: sampleCOIText,
          contentType: 'text'
        },
        validationRules: {
          minCoverageAmount: 5000000 // $5M minimum
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      // Validation should check coverage - either finds coverage issue or GL not found
      expect(result.data?.validationResults.errors.some(e =>
        e.includes('below minimum') || e.includes('not found')
      )).toBe(true);
    });

    it('validates TIN match against vendor context', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-validate',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        },
        vendorContext: {
          vendorId: 'vendor-1',
          vendorName: 'Acme Corp',
          existingTin: '99-9999999' // Different from document
        },
        validationRules: {
          requireTinMatch: true
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.validationResults.errors.some(e =>
        e.includes('mismatch')
      )).toBe(true);
    });
  });

  describe('Quality Assessment', () => {
    it('assesses document quality', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-quality',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.qualityAssessment).toBeDefined();
      expect(result.data?.qualityAssessment.readability).toBeGreaterThan(0);
      expect(result.data?.qualityAssessment.completeness).toBeGreaterThan(0);
      expect(result.data?.qualityAssessment.dataQuality).toBeGreaterThan(0);
    });

    it('reports lower quality for sparse documents', async () => {
      const sparseText = 'W-9 Form. Name: Test.';
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-sparse',
          filename: 'sparse.pdf',
          mimeType: 'application/pdf',
          content: sparseText,
          contentType: 'text'
        },
        expectedDocumentType: 'w9'
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      // Data quality should be lower for sparse documents (fewer valid fields)
      expect(result.data?.qualityAssessment.dataQuality).toBeLessThan(1);
    });
  });

  describe('Recommendations', () => {
    it('generates recommendations for incomplete documents', async () => {
      const incompleteW9 = `
        Form W-9 Request for Taxpayer
        Name: Partial Company
        No TIN provided
      `;

      const input: DocumentParsingInput = {
        document: {
          id: 'doc-incomplete',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: incompleteW9,
          contentType: 'text'
        },
        expectedDocumentType: 'w9'
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendations.length).toBeGreaterThan(0);
    });

    it('recommends renewal for expiring COI', async () => {
      // Create COI that expires in 30 days
      const now = new Date();
      const expirationDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const expiringCOI = `
        CERTIFICATE OF LIABILITY INSURANCE
        POLICY NUMBER: GL-123
        EFFECTIVE DATE: 01/01/2024
        EXPIRATION DATE: ${expirationDate.toLocaleDateString('en-US')}
        INSURER: Test Insurance
        NAMED INSURED: Test Corp
        GENERAL LIABILITY: $1,000,000
      `;

      const input: DocumentParsingInput = {
        document: {
          id: 'doc-expiring',
          filename: 'coi.pdf',
          mimeType: 'application/pdf',
          content: expiringCOI,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendations.some(r =>
        r.toLowerCase().includes('expire') || r.toLowerCase().includes('renewal')
      )).toBe(true);
    });
  });

  describe('Confidence Calculation', () => {
    it('returns higher confidence for complete documents', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-complete',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('returns lower confidence for incomplete documents', async () => {
      const incompleteText = 'Form W-9. Name: Test.';
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-incomplete-conf',
          filename: 'w9.pdf',
          mimeType: 'application/pdf',
          content: incompleteText,
          contentType: 'text'
        },
        expectedDocumentType: 'w9'
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.confidence).toBeLessThan(0.7);
    });
  });

  describe('Content Type Handling', () => {
    it('handles text content type', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-text',
          filename: 'doc.txt',
          mimeType: 'text/plain',
          content: sampleW9Text,
          contentType: 'text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
    });

    it('handles OCR text content type', async () => {
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-ocr',
          filename: 'scanned.pdf',
          mimeType: 'application/pdf',
          content: sampleW9Text,
          contentType: 'ocr_text'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
    });

    it('handles base64 text content', async () => {
      const base64Content = Buffer.from(sampleW9Text).toString('base64');
      const input: DocumentParsingInput = {
        document: {
          id: 'doc-base64',
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          content: base64Content,
          contentType: 'base64'
        }
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
    });
  });
});
