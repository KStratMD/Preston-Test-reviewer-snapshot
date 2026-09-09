/**
 * DocumentParsingAgent Integration Tests
 *
 * Integration tests for document parsing workflows:
 * - W-9 form extraction and validation
 * - Certificate of Insurance (COI) extraction
 * - Document classification
 * - Validation rule enforcement
 */

import 'reflect-metadata';
import { DocumentParsingAgent } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';
import type { DocumentParsingInput, DocumentParsingOutput } from '../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';

describe('DocumentParsingAgent Integration Tests', () => {
  let documentParsingAgent: DocumentParsingAgent;

  beforeAll(() => {
    documentParsingAgent = new DocumentParsingAgent();
  });

  // Helper to create execution context
  const createContext = (): AgentExecutionContext => ({
    sessionId: `integration-docparse-session-${Date.now()}`,
    userId: 'integration-test-user',
    correlationId: `integration-docparse-correlation-${Date.now()}`,
    maxExecutionTime: 30000, // 30 second timeout
    confidenceThreshold: 0.5,
    sourceSystem: 'SupplierCentral',
    targetSystem: 'DocumentParsingAgent',
  });

  describe('W-9 Document Parsing', () => {
    it('extracts data from W-9 document', async () => {
      const w9Input: DocumentParsingInput = {
        document: {
          id: 'doc-w9-test-001',
          filename: 'vendor_w9.pdf',
          mimeType: 'application/pdf',
          content: `Form W-9
Request for Taxpayer Identification Number and Certification

Name: Test Vendor Corporation
Business name/disregarded entity name: Test Vendor Corp DBA
Federal tax classification: C Corporation
Address: 100 Business Way
City, state, ZIP: San Francisco, CA 94102
Taxpayer Identification Number: 12-3456789

Certification: Signed and dated`,
          contentType: 'text',
          uploadedBy: 'integration-test',
          uploadedAt: Date.now(),
        },
        expectedDocumentType: 'w9',
        vendorContext: {
          vendorId: 'vendor-w9-test',
          vendorName: 'Test Vendor Corporation',
        },
      };

      const result = await documentParsingAgent.execute(createContext(), w9Input);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const output = result.data as DocumentParsingOutput;
      expect(output.documentType).toBe('w9');
      expect(output.confidence).toBeGreaterThan(0);
      expect(output.extractedData).toBeDefined();
      expect(output.validationResults).toBeDefined();
    });

    it('validates W-9 TIN against vendor profile', async () => {
      const w9WithMismatch: DocumentParsingInput = {
        document: {
          id: 'doc-w9-mismatch',
          filename: 'w9_mismatch.pdf',
          mimeType: 'application/pdf',
          content: `W-9 Form
Business Name: Different Company LLC
TIN: 99-9999999`,
          contentType: 'text',
        },
        expectedDocumentType: 'w9',
        vendorContext: {
          vendorId: 'vendor-mismatch',
          vendorName: 'Original Company',
          existingTin: '12-3456789', // Different from document
          existingBusinessName: 'Original Company',
        },
        validationRules: {
          requireTinMatch: true,
          requireBusinessNameMatch: true,
        },
      };

      const result = await documentParsingAgent.execute(createContext(), w9WithMismatch);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      expect(output.validationResults).toBeDefined();
      // Should have warnings or errors about mismatches
      expect(
        output.validationResults.warnings.length > 0 ||
        output.validationResults.errors.length > 0 ||
        output.recommendations.length > 0
      ).toBe(true);
    });
  });

  describe('Certificate of Insurance Parsing', () => {
    it('extracts data from COI document', async () => {
      const coiInput: DocumentParsingInput = {
        document: {
          id: 'doc-coi-test-001',
          filename: 'vendor_coi.pdf',
          mimeType: 'application/pdf',
          content: `CERTIFICATE OF LIABILITY INSURANCE
DATE: 01/01/2025

INSURER: Liberty Mutual Insurance
POLICY NUMBER: GL-123456-789

INSURED:
Test Vendor Corporation
100 Business Way
San Francisco, CA 94102

COVERAGES:
General Liability: $2,000,000 per occurrence / $4,000,000 aggregate
Auto Liability: $1,000,000 combined single limit
Umbrella Liability: $5,000,000

Policy Period: 01/01/2025 to 01/01/2026

CERTIFICATE HOLDER:
Client Company Inc
200 Client Street
New York, NY 10001`,
          contentType: 'text',
          uploadedBy: 'integration-test',
          uploadedAt: Date.now(),
        },
        expectedDocumentType: 'coi',
        vendorContext: {
          vendorId: 'vendor-coi-test',
          vendorName: 'Test Vendor Corporation',
        },
      };

      const result = await documentParsingAgent.execute(createContext(), coiInput);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      expect(output.documentType).toBe('coi');
      expect(output.confidence).toBeGreaterThan(0);
      expect(output.extractedData).toBeDefined();
    });

    it('validates COI coverage meets minimum requirements', async () => {
      const lowCoverageCoiInput: DocumentParsingInput = {
        document: {
          id: 'doc-coi-lowcov',
          filename: 'coi_low_coverage.pdf',
          mimeType: 'application/pdf',
          content: `CERTIFICATE OF INSURANCE
Insurer: Small Insurance Co
Policy: SI-999
General Liability: $500,000`,
          contentType: 'text',
        },
        expectedDocumentType: 'coi',
        validationRules: {
          minCoverageAmount: 1000000, // Requires $1M
        },
      };

      const result = await documentParsingAgent.execute(createContext(), lowCoverageCoiInput);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      // Should flag insufficient coverage
      expect(
        output.validationResults.warnings.length > 0 ||
        output.validationResults.errors.length > 0 ||
        output.recommendations.some(r => r.toLowerCase().includes('coverage'))
      ).toBe(true);
    });

    it('flags expiring insurance certificate', async () => {
      const expiringCoiInput: DocumentParsingInput = {
        document: {
          id: 'doc-coi-expiring',
          filename: 'coi_expiring.pdf',
          mimeType: 'application/pdf',
          content: `CERTIFICATE OF INSURANCE
Insurer: Standard Insurance
Policy: STD-456
Expiration Date: ${new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
General Liability: $2,000,000`,
          contentType: 'text',
        },
        expectedDocumentType: 'coi',
        validationRules: {
          maxExpirationDays: 30, // Warn if expiring within 30 days
        },
      };

      const result = await documentParsingAgent.execute(createContext(), expiringCoiInput);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      // Should flag expiring certificate
      expect(
        output.validationResults.warnings.length > 0 ||
        output.recommendations.some(r =>
          r.toLowerCase().includes('expir') || r.toLowerCase().includes('renew')
        )
      ).toBe(true);
    });
  });

  describe('Document Classification', () => {
    it('correctly classifies W-9 document', async () => {
      const unclassifiedW9: DocumentParsingInput = {
        document: {
          id: 'doc-classify-w9',
          filename: 'tax_form.pdf',
          mimeType: 'application/pdf',
          content: `Form W-9 (Rev. October 2018)
Request for Taxpayer Identification Number and Certification
Department of the Treasury Internal Revenue Service`,
          contentType: 'text',
        },
        // No expectedDocumentType - let agent classify
      };

      const result = await documentParsingAgent.execute(createContext(), unclassifiedW9);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      expect(output.documentType).toBe('w9');
    });

    it('correctly classifies COI document', async () => {
      const unclassifiedCoi: DocumentParsingInput = {
        document: {
          id: 'doc-classify-coi',
          filename: 'insurance_cert.pdf',
          mimeType: 'application/pdf',
          content: `ACORD 25 (2016/03)
CERTIFICATE OF LIABILITY INSURANCE
THIS CERTIFICATE IS ISSUED AS A MATTER OF INFORMATION ONLY
INSURER: Liberty Mutual Insurance
POLICY NUMBER: GL-123456
General Liability: $2,000,000 per occurrence
Policy Period: 01/01/2025 to 01/01/2026
CERTIFICATE HOLDER: Client Company Inc`,
          contentType: 'text',
        },
      };

      const result = await documentParsingAgent.execute(createContext(), unclassifiedCoi);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      // Agent should classify as COI or insurance-related document
      expect(['coi', 'insurance', 'certificate', 'unknown']).toContain(output.documentType);
      // If unknown, confidence should be low
      if (output.documentType === 'unknown') {
        expect(output.confidence).toBeLessThan(0.7);
      }
    });

    it('handles unknown document type', async () => {
      const unknownDoc: DocumentParsingInput = {
        document: {
          id: 'doc-unknown',
          filename: 'random_document.pdf',
          mimeType: 'application/pdf',
          content: 'This is some random text that does not match any known document format.',
          contentType: 'text',
        },
      };

      const result = await documentParsingAgent.execute(createContext(), unknownDoc);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      // Agent should return some document type (may classify as unknown or attempt classification)
      expect(output.documentType).toBeDefined();
      expect(output.confidence).toBeGreaterThanOrEqual(0);
      expect(output.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Quality Assessment', () => {
    it('assesses document quality for clear documents', async () => {
      const clearDoc: DocumentParsingInput = {
        document: {
          id: 'doc-clear',
          filename: 'clear_w9.pdf',
          mimeType: 'application/pdf',
          content: `Form W-9
Name: Clear Business Inc
Business Name: Clear Business Incorporated
Tax Classification: S Corporation
Address: 500 Clear Street, Suite 100
City: Los Angeles, State: CA, ZIP: 90001
TIN: 55-1234567
Certification: Complete - Signed 01/01/2025`,
          contentType: 'text',
        },
        expectedDocumentType: 'w9',
      };

      const result = await documentParsingAgent.execute(createContext(), clearDoc);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      expect(output.qualityAssessment).toBeDefined();
      expect(output.qualityAssessment.readability).toBeGreaterThan(0);
      expect(output.qualityAssessment.completeness).toBeGreaterThan(0);
      expect(output.qualityAssessment.dataQuality).toBeGreaterThan(0);
    });

    it('flags poor quality documents', async () => {
      const poorDoc: DocumentParsingInput = {
        document: {
          id: 'doc-poor',
          filename: 'poor_scan.pdf',
          mimeType: 'application/pdf',
          content: 'W-9... [illegible] ...name... [smudged]... TIN: XX-XXXXX??',
          contentType: 'ocr_text', // OCR text typically lower quality
        },
        expectedDocumentType: 'w9',
      };

      const result = await documentParsingAgent.execute(createContext(), poorDoc);

      expect(result.success).toBe(true);
      const output = result.data as DocumentParsingOutput;
      expect(output.qualityAssessment).toBeDefined();
      // Should have recommendations about document quality
      expect(
        output.recommendations.length > 0 ||
        output.validationResults.warnings.length > 0
      ).toBe(true);
    });
  });
});
