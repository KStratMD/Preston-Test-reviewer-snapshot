/**
 * GovernanceService — DLP Commit 2 regression tests
 *
 * Targeted unit coverage for the commit-2 unification work that
 * cannot be exercised by the existing DLPService unit tests:
 *
 *   1. **String-mode offset preservation** (Codex review 2026-04-09
 *      finding 1). The adapter MUST populate real
 *      `PIIType.startIndex/endIndex` from `DLPFinding.location.column`
 *      when the input is a raw string, so consumers that highlight
 *      or anchor PII by offset still work. Object-mode keeps 0/0
 *      placeholders by design — see PIIType JSDoc.
 *
 *   2. **Object-mode redaction routes through `piiResult.redactedData`**
 *      (Codex review 2026-04-09 finding 3). `redactPIIFromData()` must
 *      short-circuit to the value-based redacted form, not walk the
 *      object via the index-based legacy path with placeholder
 *      offsets. Multi-field integrity is also covered end-to-end by
 *      `tests/integration/MCPAutoRedact.fixture.test.ts`; this unit
 *      test pins the GovernanceService surface specifically.
 *
 *   3. **Confidence aggregation formula** (ultraplan finding 1).
 *      `result.confidence` must remain `avg(findings.confidence)`
 *      (finding-weighted, not type-weighted) per the pre-commit-2
 *      contract.
 *
 *   4. **Widened PIIType.type union** (ultraplan nit A). New DLP
 *      types (`bank_account`, `phone_intl`, etc.) must pass through
 *      the adapter without being lossily mapped to `'custom'`.
 */

import 'reflect-metadata';
import { GovernanceService } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import { DLPService } from '../../../../../src/services/security/DLPService';
import type { Logger } from '../../../../../src/utils/Logger';

describe('GovernanceService — DLP commit 2', () => {
  let governanceService: GovernanceService;
  let dlpService: DLPService;

  beforeEach(() => {
    const mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    dlpService = new DLPService(mockLogger);
    governanceService = new GovernanceService(mockLogger, dlpService);
  });

  describe('string-mode startIndex/endIndex offsets (Codex finding 1)', () => {
    it('should populate real startIndex/endIndex for an email match in raw text', async () => {
      const text = 'Contact us at support@example.com for help';
      const expectedStart = text.indexOf('support@example.com');
      const expectedEnd = expectedStart + 'support@example.com'.length;

      const result = await governanceService.detectPII(text);

      expect(result.hasPII).toBe(true);
      const emailPii = result.piiTypes.find(p => p.type === 'email');
      expect(emailPii).toBeDefined();
      expect(emailPii!.startIndex).toBe(expectedStart);
      expect(emailPii!.endIndex).toBe(expectedEnd);
      expect(emailPii!.value).toBe('support@example.com');
    });

    it('should populate real offsets for a phone match in raw text', async () => {
      const text = 'Call 555-123-4567 anytime';
      const expectedStart = text.indexOf('555-123-4567');

      const result = await governanceService.detectPII(text);

      const phonePii = result.piiTypes.find(p => p.type === 'phone');
      expect(phonePii).toBeDefined();
      expect(phonePii!.startIndex).toBe(expectedStart);
      expect(phonePii!.endIndex).toBe(expectedStart + '555-123-4567'.length);
    });

    it('should populate offsets for multiple findings in the same string', async () => {
      const text = 'Email: a@b.com, Phone: 555-123-4567 — call me';
      const result = await governanceService.detectPII(text);

      expect(result.piiTypes.length).toBeGreaterThanOrEqual(2);
      // Each finding's slice should round-trip back to its value.
      for (const pii of result.piiTypes) {
        const slice = text.slice(pii.startIndex, pii.endIndex);
        expect(slice).toBe(pii.value);
      }
    });

    it('should produce a redactedText that is consistent with offsets in string mode', async () => {
      const text = 'Hello support@example.com world';
      const result = await governanceService.detectPII(text);

      expect(result.hasPII).toBe(true);
      // String mode threads dlpResult.redactedData through to redactedText
      // (DLPService.scanText with autoRedact:true populates it via the
      // value-based redactData() path).
      expect(result.redactedText).toBeDefined();
      expect(result.redactedText).not.toContain('support@example.com');
    });
  });

  describe('object-mode startIndex/endIndex placeholders (per JSDoc contract)', () => {
    it('should set placeholder 0/0 offsets for findings from object input', async () => {
      const data = { customer: { email: 'test@example.com' } };
      const result = await governanceService.detectPII(data);

      const emailPii = result.piiTypes.find(p => p.type === 'email');
      expect(emailPii).toBeDefined();
      // Object-mode is documented as placeholder per the PIIType
      // JSDoc — consumers that need real offsets in object mode
      // must use finding.location.path + value matching.
      expect(emailPii!.startIndex).toBe(0);
      expect(emailPii!.endIndex).toBe(0);
    });

    it('should populate redactedData (NOT redactedText) for object input', async () => {
      const data = { customer: { email: 'test@example.com', other: 'unchanged' } };
      const result = await governanceService.detectPII(data);

      // Object inputs get a redactedData (deep-cloned redacted object),
      // not a redactedText (which is reserved for string-mode round-trip).
      expect(result.redactedData).toBeDefined();
      expect(result.redactedText).toBeUndefined();
      const redacted = result.redactedData as typeof data;
      expect(redacted.customer.email).not.toBe('test@example.com');
      // Non-PII sibling field must come through unchanged.
      expect(redacted.customer.other).toBe('unchanged');
    });
  });

  describe('redactPIIFromData() short-circuits to piiResult.redactedData', () => {
    it('should preserve non-PII fields when redacting an object with one PII field', async () => {
      const data = {
        customer: {
          email: 'john@example.com',
          displayTitle: 'Public Title',
          bio: 'prefers dark mode',
        },
      };
      const piiResult = await governanceService.detectPII(data);
      const redacted = governanceService.redactPIIFromData(data, piiResult) as typeof data;

      // Email should be redacted; siblings must be unchanged.
      // If the legacy index-based path were exercised (with the
      // placeholder 0/0 offsets) the email redaction would be
      // PREPENDED to displayTitle and bio.
      expect(redacted.customer.email).not.toBe('john@example.com');
      expect(redacted.customer.displayTitle).toBe('Public Title');
      expect(redacted.customer.bio).toBe('prefers dark mode');
    });
  });

  describe('confidence aggregation formula (finding-weighted average)', () => {
    it('should compute confidence as the average across findings', async () => {
      const text = 'Email a@b.com and phone 555-123-4567';
      const result = await governanceService.detectPII(text);

      // Verify the formula matches dlpResult.findings exactly:
      //   avg = sum(finding.confidence) / findings.length
      // Reproduce by re-running scanText and computing the expected average.
      const dlpResult = await dlpService.scanText(text);
      const expected = dlpResult.findings.length > 0
        ? dlpResult.findings.reduce((sum, f) => sum + f.confidence, 0) / dlpResult.findings.length
        : 0;

      expect(result.confidence).toBeCloseTo(expected, 5);
    });

    it('should return confidence: 0 when no PII is found', async () => {
      const result = await governanceService.detectPII('hello world');
      expect(result.hasPII).toBe(false);
      expect(result.confidence).toBe(0);
    });
  });

  describe('PIIType.type union widening (DLPPIIType pass-through)', () => {
    it('should pass through new DLP types that were not in the old union', async () => {
      // bank_account, phone_intl, date_of_birth, passport, drivers_license
      // were NOT in the pre-commit-2 union. They must flow through the
      // adapter intact, not get mapped to 'custom'.
      const data = { customer: { phone: '+44 20 1234 5678' } };
      const result = await governanceService.detectPII(data);

      const intlPii = result.piiTypes.find(p => p.type === 'phone_intl');
      expect(intlPii).toBeDefined();
      // Type field is the literal DLP type, not 'custom'.
      expect(intlPii!.type).toBe('phone_intl');
    });

    it('should pass through `name` (was in old union, now from DLP)', async () => {
      const data = { customerName: 'John Smith' };
      const result = await governanceService.detectPII(data);

      const namePii = result.piiTypes.find(p => p.type === 'name');
      expect(namePii).toBeDefined();
      expect(namePii!.type).toBe('name');
    });
  });

  describe('shape routing — string vs object vs primitive', () => {
    it('should NOT fire field-gated patterns for raw string input (no field context)', async () => {
      // Same value in scanText mode → gated patterns naturally skip
      // because empty path → isXxxRelatedFieldPath('') returns false.
      const result = await governanceService.detectPII('My DOB is 01/15/1990');
      expect(result.piiTypes.find(p => p.type === 'date_of_birth')).toBeUndefined();
    });

    it('should fire field-gated patterns for structured input (field context present)', async () => {
      const data = { user: { dob: '01/15/1990' } };
      const result = await governanceService.detectPII(data);
      expect(result.piiTypes.find(p => p.type === 'date_of_birth')).toBeDefined();
    });

    it('should detect SSN in a bare numeric primitive (Codex PR review 2026-04-10, P1)', async () => {
      // The old detectPII() called extractTextFromData(data) which
      // stringified non-object inputs via String(data). A 9-digit
      // number like 123456789 would become "123456789" and match the
      // SSN pattern. The commit-2 shape router must coerce non-string
      // primitives to String before routing to scanText, or bare
      // numerics silently drop PII detection.
      const result = await governanceService.detectPII(123456789);
      expect(result.hasPII).toBe(true);
      const ssnPii = result.piiTypes.find(p => p.type === 'ssn');
      expect(ssnPii).toBeDefined();
      expect(ssnPii!.value).toBe('123456789');
    });

    it('should handle null input without crashing', async () => {
      const result = await governanceService.detectPII(null);
      expect(result.hasPII).toBe(false);
      expect(result.piiTypes).toHaveLength(0);
    });

    it('should handle undefined input without crashing', async () => {
      const result = await governanceService.detectPII(undefined);
      expect(result.hasPII).toBe(false);
      expect(result.piiTypes).toHaveLength(0);
    });
  });
});
