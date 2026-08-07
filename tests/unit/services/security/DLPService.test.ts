/**
 * DLPService Unit Tests
 * Tests for Data Loss Prevention PII detection
 */

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DLPService, DLPPolicy } from '../../../../src/services/security/DLPService';
import type { Logger } from '../../../../src/utils/Logger';

describe('DLPService', () => {
  let dlpService: DLPService;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    dlpService = new DLPService(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize and log capabilities', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('DLP Service initialized', expect.any(Object));
    });
  });

  describe('scanForPII()', () => {
    describe('SSN detection', () => {
      it('should detect SSN with dashes format', async () => {
        const data = { ssn: '123-45-6789' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('ssn');
        const ssnFinding = result.findings.find(f => f.type === 'ssn');
        expect(ssnFinding?.severity).toBe('critical');
        expect(ssnFinding?.redactedValue).toBe('***-**-****');
      });

      it('should detect SSN without dashes', async () => {
        const data = { taxId: 'SSN is 123456789' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('ssn');
      });
    });

    describe('credit card detection', () => {
      it('should detect valid credit card with Luhn check', async () => {
        // 4111111111111111 is a valid test Visa number
        const data = { payment: '4111111111111111' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('credit_card');
        const ccFinding = result.findings.find(f => f.type === 'credit_card');
        expect(ccFinding?.severity).toBe('critical');
        expect(ccFinding?.redactedValue).toContain('****');
        expect(ccFinding?.redactedValue).toContain('1111');
      });

      it('should detect credit card with spaces', async () => {
        const data = { card: '4111 1111 1111 1111' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('credit_card');
      });

      it('should detect credit card with dashes', async () => {
        const data = { card: '4111-1111-1111-1111' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('credit_card');
      });

      it('should not flag invalid credit card numbers', async () => {
        // Invalid Luhn checksum
        const data = { number: '1234567890123456' };

        const result = await dlpService.scanForPII(data);

        const ccFinding = result.findings.find(f => f.type === 'credit_card');
        expect(ccFinding).toBeUndefined();
      });
    });

    describe('email detection', () => {
      it('should detect email addresses', async () => {
        const data = { contact: 'Email: john.doe@example.com' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('email');
        const emailFinding = result.findings.find(f => f.type === 'email');
        expect(emailFinding?.severity).toBe('medium');
        expect(emailFinding?.redactedValue).toContain('***@example.com');
      });

      it('should detect multiple emails', async () => {
        const data = { contacts: 'Contact alice@test.com or bob@test.com' };

        const result = await dlpService.scanForPII(data);

        const emailFindings = result.findings.filter(f => f.type === 'email');
        expect(emailFindings.length).toBe(2);
      });
    });

    describe('phone number detection', () => {
      it('should detect US phone numbers', async () => {
        const data = { phone: 'Call 555-123-4567' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('phone');
        const phoneFinding = result.findings.find(f => f.type === 'phone');
        expect(phoneFinding?.severity).toBe('medium');
        expect(phoneFinding?.redactedValue).toContain('4567');
      });

      it('should detect phone with parentheses', async () => {
        const data = { contact: '(555) 123-4567' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('phone');
      });

      it('should detect phone with country code', async () => {
        const data = { phone: '+1 555-123-4567' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('phone');
      });
    });

    describe('medical record number detection', () => {
      it('should detect MRN with prefix', async () => {
        const data = { record: 'MRN: 12345678' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('medical_record_number');
        const mrnFinding = result.findings.find(f => f.type === 'medical_record_number');
        expect(mrnFinding?.severity).toBe('high');
      });

      it('should detect Medical Record # format', async () => {
        const data = { patient: 'Medical Record #123456789' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('medical_record_number');
      });
    });

    describe('API key detection', () => {
      it('should detect long alphanumeric strings as potential API keys', async () => {
        // Pure alphanumeric 32+ characters
        const data = { config: 'abcd1234efgh5678ijkl9012mnop3456' };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('api_key');
        const apiFinding = result.findings.find(f => f.type === 'api_key');
        expect(apiFinding?.severity).toBe('critical');
      });
    });

    describe('JWT token detection', () => {
      it('should detect JWT tokens', async () => {
        const jwtToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const data = { auth: `Bearer ${jwtToken}` };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.piiTypes).toContain('jwt_token');
        const jwtFinding = result.findings.find(f => f.type === 'jwt_token');
        expect(jwtFinding?.redactedValue).toBe('[REDACTED JWT]');
      });
    });

    describe('data structure scanning', () => {
      it('should scan nested objects', async () => {
        const data = {
          customer: {
            personal: {
              ssn: '123-45-6789'
            }
          }
        };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        const finding = result.findings[0];
        expect(finding.location.path).toContain('customer');
      });

      it('should scan arrays', async () => {
        const data = {
          records: [
            { email: 'a@test.com' },
            { email: 'b@test.com' }
          ]
        };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(true);
        expect(result.findings.length).toBe(2);
      });

      it('should handle null values', async () => {
        const data = { ssn: null, name: 'Test' };

        const result = await dlpService.scanForPII(data);

        expect(result).toBeDefined();
      });

      it('should handle undefined values', async () => {
        const data = { ssn: undefined };

        const result = await dlpService.scanForPII(data);

        expect(result.detected).toBe(false);
      });

      it('should handle empty object', async () => {
        const result = await dlpService.scanForPII({});

        expect(result.detected).toBe(false);
        expect(result.riskLevel).toBe('low');
      });
    });

    describe('risk level assessment', () => {
      it('should return low risk when no PII found', async () => {
        const data = { name: 'Test User' };

        const result = await dlpService.scanForPII(data);

        expect(result.riskLevel).toBe('low');
      });

      it('should return critical risk for SSN', async () => {
        const data = { ssn: '123-45-6789' };

        const result = await dlpService.scanForPII(data);

        expect(result.riskLevel).toBe('critical');
      });

      it('should return critical risk for credit card', async () => {
        const data = { card: '4111111111111111' };

        const result = await dlpService.scanForPII(data);

        expect(result.riskLevel).toBe('critical');
      });

      it('should return medium risk for multiple emails', async () => {
        const data = { contacts: 'email1@test.com, email2@test.com, email3@test.com' };

        const result = await dlpService.scanForPII(data);

        // Multiple medium-severity findings
        expect(result.riskLevel).toBe('medium');
      });
    });

    describe('auto-redaction', () => {
      it('should redact data when policy.autoRedact is true', async () => {
        const data = { ssn: '123-45-6789' };
        const policy: DLPPolicy = {
          allowPII: false,
          piiTypes: ['ssn'],
          autoRedact: true,
          blockOnDetection: false
        };

        const result = await dlpService.scanForPII(data, policy);

        expect(result.redactedData).toBeDefined();
        expect((result.redactedData as any).ssn).toBe('***-**-****');
      });

      it('should not redact when policy.autoRedact is false', async () => {
        const data = { ssn: '123-45-6789' };
        const policy: DLPPolicy = {
          allowPII: false,
          piiTypes: ['ssn'],
          autoRedact: false,
          blockOnDetection: false
        };

        const result = await dlpService.scanForPII(data, policy);

        expect(result.redactedData).toBeUndefined();
      });
    });

    describe('recommendations', () => {
      it('should recommend approval when no PII', async () => {
        const data = { id: '12345' };

        const result = await dlpService.scanForPII(data);

        expect(result.recommendation).toContain('approved');
      });

      it('should recommend blocking for critical PII with blockOnDetection policy', async () => {
        const data = { ssn: '123-45-6789' };
        const policy: DLPPolicy = {
          allowPII: false,
          piiTypes: ['ssn'],
          autoRedact: false,
          blockOnDetection: true
        };

        const result = await dlpService.scanForPII(data, policy);

        expect(result.recommendation).toContain('blocked');
      });

      it('should recommend review for redacted data', async () => {
        const data = { email: 'test@example.com' };
        const policy: DLPPolicy = {
          allowPII: false,
          piiTypes: ['email'],
          autoRedact: true,
          blockOnDetection: false
        };

        const result = await dlpService.scanForPII(data, policy);

        expect(result.recommendation).toContain('redacted');
      });
    });
  });

  describe('validatePolicy()', () => {
    it('should approve when no PII detected', async () => {
      const data = { name: 'Test' };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: ['ssn'],
        autoRedact: false,
        blockOnDetection: true
      };

      const result = await dlpService.validatePolicy(data, policy);

      expect(result.approved).toBe(true);
    });

    it('should block when blocked PII type detected', async () => {
      const data = { ssn: '123-45-6789' };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: ['ssn'],
        autoRedact: false,
        blockOnDetection: true
      };

      const result = await dlpService.validatePolicy(data, policy);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('ssn');
      expect(result.findings).toBeDefined();
    });

    it('should approve with warnings when blockOnDetection is false', async () => {
      const data = { email: 'test@example.com' };
      const policy: DLPPolicy = {
        allowPII: true,
        piiTypes: ['email'],
        autoRedact: false,
        blockOnDetection: false
      };

      const result = await dlpService.validatePolicy(data, policy);

      expect(result.approved).toBe(true);
      expect(result.reason).toContain('warnings');
    });

    it('should block on critical risk level with blockOnDetection', async () => {
      const data = { card: '4111111111111111' };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: [],  // No specific types, but critical risk
        autoRedact: false,
        blockOnDetection: true
      };

      const result = await dlpService.validatePolicy(data, policy);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Critical');
    });
  });

  describe('error handling', () => {
    it('should return safe result on scan error', async () => {
      // Pass something that might cause issues
      const circularRef: any = {};
      circularRef.self = circularRef;

      // This should not throw, should return safe default
      const result = await dlpService.scanForPII(circularRef);

      // Should either return results or safe default
      expect(result).toBeDefined();
      expect(result.riskLevel).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Pattern registry — wires for previously dead code, plus the
  // canonical "single source of truth" guard test that breaks CI if
  // anyone touches the registry without updating downstream consumers.
  // ------------------------------------------------------------------

  describe('international phone detection (field-name aware)', () => {
    // The intl phone branch is wired as a SEPARATE `phone_intl` pattern
    // type with field-name-aware validation. Codex review on PR #589
    // flagged that regex-only intl detection cannot distinguish phone-
    // structurally-identical tokens (like `+12.3456.7890` or
    // `+123-45-6789`) from real phones, and MCPAggregatorService.ts:215
    // auto-redacts every tool result — so any false positive silently
    // mutates production data. The fix: only flag intl matches when the
    // surrounding field path looks phone-related (phone, tel, mobile,
    // cell, fax, msisdn — both camelCase and snake_case).
    //
    // The same field-context approach is the prerequisite for the four
    // remaining deferred PII types (bank_account, date_of_birth,
    // passport, drivers_license).

    it('should flag +44 intl phone in a phone-named field', async () => {
      const data = { phone: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      expect(result.detected).toBe(true);
      expect(result.piiTypes).toContain('phone_intl');
      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding?.value).toBe('+44 20 1234 5678');
      expect(finding?.severity).toBe('medium');
      expect(finding?.redactedValue).toContain('5678');
    });

    it('should flag +33 intl phone in a mobile-named field', async () => {
      const data = { mobile: '+33 1 23 45 67 89' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      expect(finding?.value).toBe('+33 1 23 45 67 89');
    });

    it('should flag +44 intl phone in a snake_case home_phone field', async () => {
      const data = { home_phone: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag +44 intl phone in a camelCase customerPhone field', async () => {
      const data = { customerPhone: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag +44 intl phone in a deeply nested user.contact.mobile path', async () => {
      const data = { user: { contact: { mobile: '+44 20 1234 5678' } } };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      expect(finding?.location.path).toBe('user.contact.mobile');
    });

    it('should flag intl phone in a phones[0] array element', async () => {
      const data = { phones: ['+44 20 1234 5678'] };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should NOT flag +44 intl phone in a non-phone field (description)', async () => {
      // The Codex false-positive case: the value is phone-structurally
      // valid but the field name says it is description text. Auto-redact
      // must NOT mutate this string.
      const data = { description: 'Reach me at +44 20 1234 5678 anytime.' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT flag +12.3456.7890 in a non-phone field (Codex example)', async () => {
      // This is one of the two specific examples Codex flagged: the
      // token is phone-structurally identical to a 10-digit intl phone
      // but in production data could equally be a version code, a
      // coordinate, or an ID. Field-context validation suppresses it.
      const data = { version: '+12.3456.7890' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT flag +123-45-6789 in a non-phone field (Codex example)', async () => {
      // The second Codex false-positive example.
      const data = { code: '+123-45-6789' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT flag +44 intl phone in a similar-but-distinct field name (telegram)', async () => {
      // `telegram` contains the substring `tel` but is NOT a phone field.
      // The token-split logic must NOT match it.
      const data = { telegram: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT flag +44 intl phone in a contactName / contactEmail field', async () => {
      // `contact` alone is NOT a phone token (would over-flag every
      // contactName / contactEmail field). Phone tokens must appear.
      const data = {
        contactName: '+44 20 1234 5678',
        contactEmail: '+44 20 1234 5678',
      };

      const result = await dlpService.scanForPII(data);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(0);
    });

    // Codex review on PR #595 (round 2, High): the original Set-based
    // exact-match was too narrow. Real-world Dynamics/NetSuite/synonym-
    // table field names use suffixed/numbered/concatenated variants
    // (`telephone1` in DynamicsConnector.ts:679 and api-responses.ts:53;
    // `phonenumber` in RuleBasedAIProvider.ts:37) that the original
    // allowlist did not recognize, producing silent false negatives.
    // The fix replaces the Set with a regex that accepts a base phone
    // term followed by an optional digit/`num`/`number`/plural suffix.
    it('should flag intl phone in a Dynamics-style telephone1 field', async () => {
      // DynamicsConnector.ts:679 maps `phone` → `telephone1` and
      // src/types/api-responses.ts:53 declares `telephone1?: string`.
      // This is a real codebase shape — the field MUST be detected.
      const data = { telephone1: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in a Dynamics-style telephone2 field', async () => {
      const data = { telephone2: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in a phone1 / phone2 numbered field', async () => {
      const data = { phone1: '+44 20 1234 5678', phone2: '+33 1 23 45 67 89' };

      const result = await dlpService.scanForPII(data);

      const findings = result.findings.filter(f => f.type === 'phone_intl');
      expect(findings).toHaveLength(2);
    });

    it('should flag intl phone in a phonenumber concatenated field (RuleBasedAIProvider synonym)', async () => {
      // src/services/ai/providers/RuleBasedAIProvider.ts:37 already
      // treats `phonenumber` as a phone synonym in the field-mapping
      // synonym table. The DLP gate must agree.
      const data = { phonenumber: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in a telephoneNumber camelCase field', async () => {
      const data = { telephoneNumber: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in a phoneNumbers plural concatenated field', async () => {
      const data = { phoneNumbers: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in an MSISDN1 numbered acronym field', async () => {
      const data = { MSISDN1: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should NOT flag look-alike words that share a phone-token prefix', async () => {
      // Token shapes that contain a phone-token prefix but are not
      // actually phone fields. Anchored regex (^...$) must reject these.
      const data = {
        telegram: '+44 20 1234 5678',     // tel + egram
        cellular: '+44 20 1234 5678',     // cell + ular
        phoned: '+44 20 1234 5678',       // phone + d (verb)
        phony: '+44 20 1234 5678',        // phon + y (no full `phone`)
        telegraph: '+44 20 1234 5678',    // tel + egraph
      };

      const result = await dlpService.scanForPII(data);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(0);
    });

    // Follow-up review on PR #595: `primaryphone` (all-lowercase
    // concatenated) is in the project's own field-mapping synonym table
    // at `public/ai-field-mapping-editor.html:6486`
    // (`'phone': ['phonenumber', 'primaryphone', 'phone_number']`), so
    // the DLP gate must agree. Adds a curated PREFIX list to
    // PHONE_FIELD_TOKEN_REGEX covering the common concatenated forms
    // (primary, main, home, work, office, personal, business, alt,
    // backup, emergency, mobile, direct) WITHOUT resorting to a
    // blanket `\w*phone` that would match device/product words like
    // smartphone, headphone, megaphone, etc.
    it('should flag intl phone in a primaryphone concatenated field (synonym table)', async () => {
      const data = { primaryphone: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in mainphone/homephone/workphone concatenated fields', async () => {
      const data = {
        mainphone: '+44 20 1234 5678',
        homephone: '+33 1 23 45 67 89',
        workphone: '+49 30 1234 5678',
      };

      const result = await dlpService.scanForPII(data);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(3);
    });

    it('should flag intl phone in prefix + base + suffix combinations', async () => {
      const data = {
        primaryphonenumber: '+44 20 1234 5678',  // prefix + base + number
        homephones: '+33 1 23 45 67 89',         // prefix + base + plural
        altphone1: '+49 30 1234 5678',           // prefix + base + digit
        emergencyfax: '+44 20 1234 5678',        // prefix + fax base
      };

      const result = await dlpService.scanForPII(data);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(4);
    });

    it('should NOT flag device/product words that merely end in a phone base (smartphone family)', async () => {
      // Critical false-positive guard: the curated prefix list is
      // intentionally NOT `\w*phone`, because blanket suffix matching
      // would catch consumer-electronics words where a value could
      // plausibly be anything — leaving the auto-redact path exposed
      // to the exact Codex false-positive risk the gate was designed
      // to prevent.
      const data = {
        smartphone: '+44 20 1234 5678',
        headphone: '+44 20 1234 5678',
        megaphone: '+44 20 1234 5678',
        microphone: '+44 20 1234 5678',
        saxophone: '+44 20 1234 5678',
      };

      const result = await dlpService.scanForPII(data);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(0);
    });

    // Codex review on PR #595 (round 2, Medium): document the deliberate
    // scope cut. The MCPAggregatorService auto-redact path scans the full
    // tool result, but human-visible payloads from BC/NetSuite adapters
    // sit at `content[0].text` (free-form text). That path is NOT
    // phone-related under the structural gate, so phone_intl is skipped
    // there. This is intentional — Codex's original false-positive risk
    // (a `+12.3456.7890` version code being silently redacted) applies
    // even more strongly to free-text payloads. The fix for free-text
    // intl phone detection (in-string context: preceding "Tel:", "Call",
    // country-name proximity) is a separate follow-up.
    it('should NOT flag intl phone in a free-text MCP content[].text payload', async () => {
      // Mirrors the IMCPAdapter.MCPToolResult shape used by
      // BusinessCentralMcpClient.ts:298 and NetSuiteOfficialMcpClient.ts:318.
      const mcpToolResult = {
        content: [
          {
            type: 'text',
            text: 'Customer record updated. Please call +44 20 1234 5678 for confirmation.',
          },
        ],
      };

      const result = await dlpService.scanForPII(mcpToolResult);

      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(intlFindings).toHaveLength(0);
    });

    it('should still flag intl phone in MCP structuredContent.phone (structured path)', async () => {
      // The structured-content path IS covered: `structuredContent.phone`
      // tokenizes to `[structuredContent, phone]` (via camelCase split)
      // and `phone` is a phone-related token. This pins that the scope
      // cut only applies to free-text, not structured fields, even
      // within the same MCPToolResult shape.
      const mcpToolResult = {
        content: [{ type: 'text', text: 'Customer updated.' }],
        structuredContent: {
          customer: {
            phone: '+44 20 1234 5678',
          },
        },
      };

      const result = await dlpService.scanForPII(mcpToolResult);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      expect(finding?.location.path).toBe('structuredContent.customer.phone');
    });

    // ----- previously-added acronym regression tests -----
    it('should flag intl phone in an all-caps MSISDN field (acronym)', async () => {
      const data = { MSISDN: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in an UPPER_SNAKE PHONE_NUMBER field', async () => {
      const data = { PHONE_NUMBER: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    it('should flag intl phone in an all-caps CONTACT.MOBILE nested path', async () => {
      const data = { CONTACT: { MOBILE: '+44 20 1234 5678' } };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      expect(finding?.location.path).toBe('CONTACT.MOBILE');
    });

    it('should flag intl phone in mixed acronym+camelCase myPHONENumber field', async () => {
      // The acronym-preserving split must produce `[my, PHONE, Number]`,
      // not letter-by-letter fragments.
      const data = { myPHONENumber: '+44 20 1234 5678' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
    });

    // Copilot review on PR #595: the regex must enforce E.164's 15-digit
    // ceiling. The original `{6,14}` second quantifier allowed 16-17 digit
    // runs, which are not valid E.164 numbers. The fix tightens to
    // `{6,12}` so total digit count is 7-15 (E.164 range exactly).
    it('should flag the maximum-length 15-digit E.164 number in a phone field', async () => {
      // Real-world example: 15-digit E.164 (3-digit cc + 12-digit number).
      const data = { phone: '+123 4567890 12345' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      const digits = finding!.value.replace(/\D/g, '');
      expect(digits.length).toBe(15);
    });

    it('should NOT match a 16-digit run that exceeds E.164 max', async () => {
      // 16 digits after `+` — outside E.164. Even in a phone-named field
      // the regex must not match (the new {6,12} second quantifier caps
      // total digit count at 15).
      const data = { phone: '+1234567890123456' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT match a 17-digit run that exceeds E.164 max', async () => {
      const data = { phone: '+12345678901234567' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    // Copilot review on PR #595, round 2: even with the {6,12} quantifier
    // cap, a 16-digit token with separators between the extra digits could
    // partial-match the first 15 digits because `\b` is satisfied at the
    // separator boundary. Example: `+123 4567890 12345 6` previously
    // matched `+123 4567890 12345` and silently dropped the trailing `6`.
    // The terminal negative-lookahead guard `(?![ .\-()]*\d)` fixes this
    // by rejecting any match whose next-non-separator char is a digit.
    it('should NOT partial-match a longer-than-E.164 sequence with trailing separator+digit (Copilot prefix-attack case)', async () => {
      // 16 digits with separators: "+123 4567890 12345 6" — would have
      // previously matched the first 15 digits because \b is satisfied
      // between `5` and ` `. The terminal guard now rejects the whole
      // token.
      const data = { phone: '+123 4567890 12345 6' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should NOT partial-match a longer sequence with multiple trailing digits', async () => {
      // Double-check the guard catches >1 trailing digit too, e.g. a
      // typo'd phone field with trailing noise: `+44 20 1234 5678 910`.
      const data = { phone: '+44 20 1234 5678 910' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeUndefined();
    });

    it('should still match a valid intl phone followed by prose (not digits)', async () => {
      // Positive case that MUST keep working — the guard only rejects
      // trailing separator+DIGIT, not trailing separator+letter. Prose
      // like "call me anytime" must not cause a miss.
      const data = { phone: '+44 20 1234 5678 call me anytime' };

      const result = await dlpService.scanForPII(data);

      const finding = result.findings.find(f => f.type === 'phone_intl');
      expect(finding).toBeDefined();
      expect(finding?.value).toBe('+44 20 1234 5678');
    });

    it('should still match two comma-separated intl phones (guard does not break mid-list)', async () => {
      // Positive case: two phones separated by comma. The guard at the
      // end of the first match sees `,` which is NOT in `[ .\-()]`, so
      // `[ .\-()]*` consumes 0 chars and tries to match `\d` against
      // `,` — fails. Negative lookahead succeeds. First phone matches.
      // Scanner advances and matches the second phone independently.
      const data = { phones: '+44 20 1234 5678, +33 1 23 45 67 89' };

      const result = await dlpService.scanForPII(data);

      const findings = result.findings.filter(f => f.type === 'phone_intl');
      expect(findings).toHaveLength(2);
    });

    it('should NOT double-flag a NANP +1 number as both phone and phone_intl', async () => {
      // `+1 555-123-4567` matches both the US `phone` regex AND the
      // `phone_intl` regex. The `phone_intl` validate() must skip NANP
      // (11 digits starting with 1) so the same value never produces
      // two findings.
      const data = { phone: '+1 555-123-4567' };

      const result = await dlpService.scanForPII(data);

      const phoneFindings = result.findings.filter(f => f.type === 'phone');
      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(phoneFindings.length).toBeGreaterThanOrEqual(1);
      expect(intlFindings).toHaveLength(0);
    });

    it('should NOT double-flag a non-NANP intl number as both phone and phone_intl', async () => {
      // `+44 123 456 7890` contains a local-looking `123 456 7890`
      // substring. Keep the broader intl finding and drop the nested US one.
      const data = { phone: '+44 123 456 7890' };

      const result = await dlpService.scanForPII(data);

      const phoneFindings = result.findings.filter(f => f.type === 'phone');
      const intlFindings = result.findings.filter(f => f.type === 'phone_intl');
      expect(phoneFindings).toHaveLength(0);
      expect(intlFindings).toHaveLength(1);
      expect(intlFindings[0].value).toBe('+44 123 456 7890');
    });

    it('should redact intl phone preserving the last 4 digits', async () => {
      const data = { phone: '+44 20 1234 5678' };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: ['phone_intl'],
        autoRedact: true,
        blockOnDetection: false,
      };

      const result = await dlpService.scanForPII(data, policy);

      expect(result.redactedData).toBeDefined();
      const redacted = (result.redactedData as { phone: string }).phone;
      expect(redacted).toContain('5678');
      expect(redacted).not.toBe('+44 20 1234 5678');
    });

    it('should redact non-NANP intl numbers without partial US masking', async () => {
      const data = { phone: '+44 123 456 7890' };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: ['phone', 'phone_intl'],
        autoRedact: true,
        blockOnDetection: false,
      };

      const result = await dlpService.scanForPII(data, policy);

      expect(result.redactedData).toBeDefined();
      expect(result.findings.filter(f => f.type === 'phone')).toHaveLength(0);
      expect((result.redactedData as { phone: string }).phone).toBe('+**-***-***-7890');
    });
  });

  describe('IP address detection', () => {
    it('should flag a public IP address', async () => {
      const data = { server: 'Origin: 8.8.8.8' };

      const result = await dlpService.scanForPII(data);

      expect(result.detected).toBe(true);
      expect(result.piiTypes).toContain('ip_address');
      const ipFinding = result.findings.find(f => f.type === 'ip_address');
      expect(ipFinding?.value).toBe('8.8.8.8');
      expect(ipFinding?.severity).toBe('medium');
    });

    it('should NOT flag loopback (127.0.0.1)', async () => {
      const data = { local: 'connect to 127.0.0.1' };

      const result = await dlpService.scanForPII(data);

      const ipFinding = result.findings.find(f => f.type === 'ip_address');
      expect(ipFinding).toBeUndefined();
    });

    it('should NOT flag RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x)', async () => {
      const data = {
        a: 'host 10.0.0.1',
        b: 'host 172.16.5.10',
        c: 'host 192.168.1.50',
      };

      const result = await dlpService.scanForPII(data);

      const ipFindings = result.findings.filter(f => f.type === 'ip_address');
      expect(ipFindings).toHaveLength(0);
    });

    it('should NOT flag link-local (169.254.x.x) or multicast (224+)', async () => {
      const data = { a: 'link 169.254.1.1', b: 'mcast 239.255.0.1' };

      const result = await dlpService.scanForPII(data);

      const ipFindings = result.findings.filter(f => f.type === 'ip_address');
      expect(ipFindings).toHaveLength(0);
    });

    it('should reject invalid octets via the bounded regex (e.g. 999.999.999.999)', async () => {
      const data = { bogus: 'addr 999.999.999.999 here' };

      const result = await dlpService.scanForPII(data);

      const ipFinding = result.findings.find(f => f.type === 'ip_address');
      expect(ipFinding).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Commit 2: Field-name-aware patterns (bank_account, date_of_birth,
  // passport, drivers_license, name)
  //
  // Each pattern gets 3 tests per the DLP commit 2 plan:
  //   1. Positive: hit in a correctly-named field
  //   2. Negative (text mode): same value in scanText() does NOT match
  //      (no field context → isXxxRelatedFieldPath('') returns false)
  //   3. Negative (wrong field): same value in a non-matching field
  //      via scanForPII() does NOT match
  //
  // The negative tests are the load-bearing guards against the Codex
  // false-positive class that motivated the whole commit — without
  // them, a phone-shaped value in a `version` field would silently
  // feed the MCP auto-redact path.
  // ------------------------------------------------------------------

  describe('bank account detection (field-name aware)', () => {
    it('should flag an 8-17 digit run in a bank_account field', async () => {
      const data = { customer: { bank_account: '12345678' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'bank_account');
      expect(finding).toBeDefined();
      expect(finding?.value).toBe('12345678');
    });

    it('should NOT flag in scanText() — no field context', async () => {
      const result = await dlpService.scanText('Account: 12345678');
      expect(result.findings.find(f => f.type === 'bank_account')).toBeUndefined();
    });

    it('should NOT flag in a non-bank field (internal_id)', async () => {
      const data = { product: { internal_id: '12345678' } };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'bank_account')).toBeUndefined();
    });

    it('should flag in camelCase accountNumber field', async () => {
      const data = { accountNumber: '987654321' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'bank_account');
      expect(finding).toBeDefined();
    });

    it('should flag in an iban field', async () => {
      const data = { iban: '123456789012' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'bank_account');
      expect(finding).toBeDefined();
    });
  });

  describe('date of birth detection (field-name aware)', () => {
    it('should flag MM/DD/YYYY in a dob field', async () => {
      const data = { user: { dob: '01/15/1990' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'date_of_birth');
      expect(finding).toBeDefined();
    });

    it('should flag YYYY-MM-DD in a dateOfBirth field', async () => {
      const data = { dateOfBirth: '1990-01-15' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'date_of_birth');
      expect(finding).toBeDefined();
    });

    it('should NOT flag in scanText() — no field context', async () => {
      const result = await dlpService.scanText('Born on 01/15/1990');
      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
    });

    it('should NOT flag in an order_date field', async () => {
      const data = { order: { order_date: '01/15/2024' } };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
    });

    it('should reject out-of-range years in a dob field (2099)', async () => {
      const data = { dob: '01/15/2099' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
    });

    it('should reject years before 1900 in a dob field', async () => {
      const data = { birthdate: '01/15/1899' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
    });
  });

  describe('passport detection (field-name aware)', () => {
    it('should flag a 9-digit number in a passport field', async () => {
      const data = { user: { passport: '123456789' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'passport');
      expect(finding).toBeDefined();
    });

    it('should flag ICAO format in a passportNumber field', async () => {
      const data = { passportNumber: 'A12345678' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'passport');
      expect(finding).toBeDefined();
    });

    it('should NOT flag in scanText() — no field context', async () => {
      const result = await dlpService.scanText('Passport A12345678');
      expect(result.findings.find(f => f.type === 'passport')).toBeUndefined();
    });

    it('should NOT flag in a product_code field', async () => {
      const data = { product: { product_code: 'A12345678' } };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'passport')).toBeUndefined();
    });

    it('should flag in a userPassport field (Codex review 2026-04-09 finding 2)', async () => {
      // Plan-faithful: the DLP commit 2 plan explicitly says
      // `userpassport`/`customerpassport` should match. This was
      // initially missed (the regex had no prefix group); Codex
      // review caught the gap and the fix added a curated prefix
      // list to PASSPORT_FIELD_TOKEN_REGEX.
      const data = { traveler: { userPassport: 'B98765432' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'passport');
      expect(finding).toBeDefined();
    });

    it('should flag in a customer_passport field (snake_case prefixed form)', async () => {
      const data = { record: { customer_passport: 'C12345678' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'passport');
      expect(finding).toBeDefined();
    });

    it('should flag in an employeePassportNumber field (prefix + suffix together)', async () => {
      const data = { hr: { employeePassportNumber: 'D55554444' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'passport');
      expect(finding).toBeDefined();
    });
  });

  describe('driver\'s license detection (field-name aware)', () => {
    it('should flag a DL number in a drivers_license field', async () => {
      const data = { drivers_license: 'A1234567' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'drivers_license');
      expect(finding).toBeDefined();
    });

    it('should flag in a dlNumber field', async () => {
      const data = { dlNumber: 'CA1234567' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'drivers_license');
      expect(finding).toBeDefined();
    });

    it('should NOT flag in scanText() — no field context', async () => {
      const result = await dlpService.scanText('DL: A1234567');
      expect(result.findings.find(f => f.type === 'drivers_license')).toBeUndefined();
    });

    it('should NOT flag in a comment field', async () => {
      const data = { ticket: { comment: 'DL: A1234567' } };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'drivers_license')).toBeUndefined();
    });

    it('should NOT flag in a software_license field (license substring)', async () => {
      const data = { app: { software_license: 'MIT-12345' } };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'drivers_license')).toBeUndefined();
    });
  });

  describe('name detection (field-name aware)', () => {
    it('should flag a full name in a name field', async () => {
      const data = { customer: { name: 'John Smith' } };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'name');
      expect(finding).toBeDefined();
    });

    it('should flag in a firstName field', async () => {
      const data = { firstName: 'John' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'name');
      expect(finding).toBeDefined();
    });

    it('should flag in a customerName field', async () => {
      const data = { customerName: 'Jane Doe' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'name');
      expect(finding).toBeDefined();
    });

    it('should NOT flag in scanText() — no field context', async () => {
      const result = await dlpService.scanText('Mr. John Smith said...');
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
    });

    it('should NOT flag in a description field', async () => {
      const data = { description: 'John Smith wrote this' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
    });

    it('should NOT flag in a filename field', async () => {
      const data = { filename: 'Report-Q4.pdf' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
    });

    // Codex PR review residual risk: `username` matches as a name field
    // because NAME_FIELD_TOKEN_REGEX allows `user` prefix + `name` base.
    // These tests make the behavior EXPLICIT so the decision is visible:
    //   - A real name in a username field IS flagged (correct — it's PII
    //     regardless of whether the field is a "login ID" or "display name")
    //   - A login-style identifier in a username field is NOT flagged
    //     (the name regex requires capital start + alpha-only, so
    //     `jsmith123` doesn't match the value shape)
    // If login IDs that happen to look like names (e.g. "John.Smith" as
    // a username) should NOT be flagged, the fix is to remove `user`
    // from the NAME_FIELD_TOKEN_REGEX prefix list — but that would also
    // lose detection of `userName` (display name) fields. Tracked as a
    // follow-up if real-world false positives surface.

    it('should flag a real name in a username field (user prefix + name base)', async () => {
      const data = { username: 'John Smith' };
      const result = await dlpService.scanForPII(data);
      const finding = result.findings.find(f => f.type === 'name');
      expect(finding).toBeDefined();
    });

    it('should NOT flag a login-style ID in a username field (fails value shape)', async () => {
      // Login IDs like `jsmith123` start lowercase and contain digits —
      // the name regex /^[A-Z][a-zA-Z'\-.,\s]{1,79}$/ rejects both.
      const data = { username: 'jsmith123' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
    });

    it('should NOT flag a lowercase login in a username field', async () => {
      const data = { username: 'admin_user' };
      const result = await dlpService.scanForPII(data);
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
    });
  });

  describe('scanText() — string-mode scanning', () => {
    it('should detect unconditional patterns in raw text', async () => {
      const result = await dlpService.scanText('Contact: test@example.com or 555-123-4567');
      expect(result.findings.find(f => f.type === 'email')).toBeDefined();
      expect(result.findings.find(f => f.type === 'phone')).toBeDefined();
    });

    it('should skip ALL field-gated patterns in text mode', async () => {
      const mixedPii =
        'John Smith born 01/15/1990 DL: A1234567 passport A98765432 ' +
        'account 12345678 intl phone +44 20 1234 5678';
      const result = await dlpService.scanText(mixedPii);
      // Every gated type must be absent — the whole point of scanText().
      expect(result.findings.find(f => f.type === 'name')).toBeUndefined();
      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
      expect(result.findings.find(f => f.type === 'drivers_license')).toBeUndefined();
      expect(result.findings.find(f => f.type === 'passport')).toBeUndefined();
      expect(result.findings.find(f => f.type === 'bank_account')).toBeUndefined();
      expect(result.findings.find(f => f.type === 'phone_intl')).toBeUndefined();
    });

    it('should populate redactedData when policy.autoRedact is true', async () => {
      const result = await dlpService.scanText('Contact: test@example.com', {
        allowPII: false,
        piiTypes: [],
        autoRedact: true,
        blockOnDetection: false,
      });
      expect(result.redactedData).toBeDefined();
      expect(typeof result.redactedData).toBe('string');
      // Should contain the redacted form, not the raw email
      expect(result.redactedData).not.toContain('test@example.com');
    });

    it('should NOT populate redactedData when policy.autoRedact is false', async () => {
      const result = await dlpService.scanText('Contact: test@example.com', {
        allowPII: false,
        piiTypes: [],
        autoRedact: false,
        blockOnDetection: false,
      });
      expect(result.redactedData).toBeUndefined();
    });

    it('should NOT populate redactedData when no findings', async () => {
      const result = await dlpService.scanText('Nothing sensitive here', {
        allowPII: false,
        piiTypes: [],
        autoRedact: true,
        blockOnDetection: false,
      });
      expect(result.redactedData).toBeUndefined();
    });
  });

  describe('getRegisteredPatterns() — single source of truth guard', () => {
    // CRITICAL: This is the regression net for the dashboard mismatch bug.
    // If anyone adds or removes a pattern from DLPService.buildPatternRegistry()
    // without also updating the compliance dashboard / docs / route response
    // shape, this test breaks CI before the drift can ship.
    //
    // To extend the registry: update EXPECTED_TYPES below AND the snapshot
    // list in public/compliance-dashboard.html (DLP_PATTERNS_SNAPSHOT) AND
    // the integration test in tests/integration/ComplianceRouter.integration.test.ts.

    const EXPECTED_TYPES = [
      'ssn',
      'credit_card',
      'email',
      'phone',
      'phone_intl',
      'medical_record_number',
      'api_key',
      'jwt_token',
      'ip_address',
      'bank_account',
      'date_of_birth',
      'passport',
      'drivers_license',
      'name',
    ];

    // Commit 2: exactly 6 field-gated patterns (phone_intl, bank_account,
    // date_of_birth, passport, drivers_license, name). Any change to this
    // list requires a corresponding update to the requiresFieldContext
    // flag in DLPService.buildPatternRegistry().
    const FIELD_GATED_TYPES = new Set([
      'phone_intl',
      'bank_account',
      'date_of_birth',
      'passport',
      'drivers_license',
      'name',
    ]);

    it('should return exactly the canonical 14 pattern types in order', () => {
      const patterns = dlpService.getRegisteredPatterns();
      const types = patterns.map(p => p.type);

      expect(types).toEqual(EXPECTED_TYPES);
    });

    it('should expose only metadata fields — no regex/redact/validate leakage', () => {
      const patterns = dlpService.getRegisteredPatterns();

      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p).toHaveProperty('type');
        expect(p).toHaveProperty('displayName');
        expect(p).toHaveProperty('category');
        expect(p).toHaveProperty('severity');
        expect(p).toHaveProperty('requiresFieldContext');
        // Metadata-only contract — these MUST NOT leak through the API.
        expect(p).not.toHaveProperty('regex');
        expect(p).not.toHaveProperty('redact');
        expect(p).not.toHaveProperty('validate');
      }
    });

    it('should populate requiresFieldContext as a boolean on every entry', () => {
      // Commit 2 (ultraplan review finding 8): the flag must be
      // explicitly present (not just absent-with-default) so a
      // regression where getRegisteredPatterns() stops emitting it
      // slips through before the metadata-only contract test runs.
      const patterns = dlpService.getRegisteredPatterns();
      for (const p of patterns) {
        expect(typeof p.requiresFieldContext).toBe('boolean');
      }
    });

    it('should set requiresFieldContext: true for exactly the 6 field-gated patterns', () => {
      const patterns = dlpService.getRegisteredPatterns();
      const gated = new Set(
        patterns.filter(p => p.requiresFieldContext).map(p => p.type)
      );
      expect(gated).toEqual(FIELD_GATED_TYPES);
    });

    it('should set requiresFieldContext: false for the 8 unconditional patterns', () => {
      const patterns = dlpService.getRegisteredPatterns();
      const unconditional = patterns.filter(p => !p.requiresFieldContext).map(p => p.type);
      expect(new Set(unconditional)).toEqual(
        new Set(['ssn', 'credit_card', 'email', 'phone', 'medical_record_number', 'api_key', 'jwt_token', 'ip_address'])
      );
      expect(unconditional.length).toBe(8);
    });

    it('should populate every entry with a non-empty displayName', () => {
      const patterns = dlpService.getRegisteredPatterns();

      for (const p of patterns) {
        expect(typeof p.displayName).toBe('string');
        expect(p.displayName.length).toBeGreaterThan(0);
      }
    });

    it('should assign each entry a known category', () => {
      const validCategories = new Set([
        'government_id',
        'financial',
        'contact',
        'health',
        'credential',
        'network',
      ]);
      const patterns = dlpService.getRegisteredPatterns();

      for (const p of patterns) {
        expect(validCategories.has(p.category)).toBe(true);
      }
    });

    it('should assign each entry a valid severity', () => {
      const validSeverities = new Set(['low', 'medium', 'high', 'critical']);
      const patterns = dlpService.getRegisteredPatterns();

      for (const p of patterns) {
        expect(validSeverities.has(p.severity)).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // Compliance dashboard snapshot drift guard
  //
  // The C1 confidentiality panel in public/compliance-dashboard.html
  // fetches the live pattern list from /api/compliance/dlp-patterns,
  // but falls back to a hardcoded DLP_PATTERNS_SNAPSHOT constant for
  // unauthenticated/snapshot-mode users. The integration test pins the
  // live API; this test pins the static fallback so the two paths
  // never drift from the registry without CI catching it.
  //
  // Codex review on PR #589 flagged this gap: the registry guard above
  // only covered the API surface, not the unauthenticated dashboard.
  // ------------------------------------------------------------------
  describe('redactData — sibling key substring collision (regression guard)', () => {
    // CRITICAL: the bug only produces an observable wrong redaction when the
    // sibling's VALUE contains the finding's value. The string-branch of
    // redactData runs `redacted.replace(finding.value, finding.redactedValue)`
    // — a value-matched replace. If `bank: 'Community Credit'` and
    // `bank_account: '000111222333'`, the misrouted finding for bank_account
    // (value '000111222333') tries to replace '000111222333' inside
    // 'Community Credit' — no match, silent no-op, test passes even with the
    // bug intact. Use same-value siblings so the bug is observable.
    it('does not propagate bank_account redaction onto a sibling `bank` field that shares the same numeric value', async () => {
      const fixture = {
        account: {
          bank: '12345678',            // non-PII plain field; same value so the bug is observable
          bank_account: '12345678',    // PII, field-gated
          displayTitle: 'Operating',   // control — must be untouched
        },
      };
      const policy: DLPPolicy = {
        allowPII: false,
        piiTypes: [],
        autoRedact: true,
        blockOnDetection: false,
      };

      const result = await dlpService.scanForPII(fixture, policy);
      const redacted = result.redactedData as typeof fixture;

      // Exactly one bank_account finding (not one-per-sibling).
      expect(result.findings.filter(f => f.type === 'bank_account')).toHaveLength(1);
      // Sibling survives even though its string value is identical.
      expect(redacted.account.bank).toBe('12345678');
      // Target is redacted.
      expect(redacted.account.bank_account).not.toBe('12345678');
      // Control field, same subtree, untouched.
      expect(redacted.account.displayTitle).toBe('Operating');
    });

    // Second bug shape: parent-level key whose NAME appears as a segment of a
    // deeper finding's path. Under the buggy filter
    // `f.field === key || f.location.path.includes(key)`, both the field-match
    // branch (f.field === 'account' at the top level) and the substring branch
    // (`'wrapper.account'.includes('account')` → true) would route the
    // wrapper-scoped finding onto the top-level `account` sibling.
    // Same-value siblings make the value-matched string replace fire so the
    // misrouting is observable. The fix (pathTargetsNode + currentPath)
    // rejects the top-level `account` because `'wrapper.account'` neither
    // equals `'account'` nor starts with `'account.'` / `'account['`.
    it('does not redact a parent-level sibling key that appears as a substring of a deeper finding path', () => {
      const data = {
        account: 'shared-value',              // top-level sibling; MUST survive
        wrapper: { account: 'shared-value' }, // nested target
      };
      const findings = [
        {
          type: 'bank_account',
          field: 'account',
          value: 'shared-value',
          confidence: 0.85,
          location: { path: 'wrapper.account' },
          severity: 'medium',
          redactedValue: 'REDACTED',
        },
      ];

      // Reach through visibility for a direct unit-level assertion. The
      // integration fixture exercises the same routing through the public
      // scanForPII() entry point.
      const redacted = (dlpService as any).redactData(data, findings) as typeof data;

      expect(redacted.wrapper.account).toBe('REDACTED');           // target redacted
      expect(redacted.account).toBe('shared-value');               // top-level sibling survives
    });
  });

  describe('compliance-dashboard.html DLP_PATTERNS_SNAPSHOT drift guard', () => {
    // When adding a new pattern type to DLPService.buildPatternRegistry(),
    // ALSO add a short label here AND update the DLP_PATTERNS_SNAPSHOT
    // constant in public/compliance-dashboard.html. This test will fail
    // loudly if any of those three places drift apart.
    const SHORT_LABELS: Record<string, string> = {
      ssn: 'SSN',
      credit_card: 'credit card',
      email: 'email',
      phone: 'phone',
      phone_intl: 'intl phone',
      medical_record_number: 'medical record',
      api_key: 'API key',
      jwt_token: 'JWT',
      ip_address: 'IP address',
      bank_account: 'bank account',
      date_of_birth: 'DOB',
      passport: 'passport',
      drivers_license: "driver's license",
      name: 'name',
    };

    let dashboardHtml: string;

    beforeAll(() => {
      const dashboardPath = path.resolve(
        __dirname,
        '../../../../public/compliance-dashboard.html',
      );
      dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');
    });

    it('should find DLP_PATTERNS_SNAPSHOT in the dashboard HTML', () => {
      expect(dashboardHtml).toMatch(/const\s+DLP_PATTERNS_SNAPSHOT\s*=/);
    });

    it('should pin snapshot count to the registered pattern count', () => {
      const patterns = dlpService.getRegisteredPatterns();
      const countMatch = dashboardHtml.match(
        /DLP_PATTERNS_SNAPSHOT\s*=\s*\{[\s\S]*?count\s*:\s*(\d+)/,
      );

      expect(countMatch).not.toBeNull();
      const snapshotCount = parseInt(countMatch![1], 10);
      expect(snapshotCount).toBe(patterns.length);
    });

    it('should reference every registered pattern type in the snapshot summary', () => {
      const patterns = dlpService.getRegisteredPatterns();
      // Accept both single-quoted and double-quoted summary strings.
      // Commit 2 added `driver's license` which contains an apostrophe,
      // forcing the dashboard to use double quotes for the whole literal.
      const summaryMatch = dashboardHtml.match(
        /DLP_PATTERNS_SNAPSHOT\s*=\s*\{[\s\S]*?summary\s*:\s*(?:'([^']+)'|"([^"]+)")/,
      );

      expect(summaryMatch).not.toBeNull();
      const summary = (summaryMatch![1] ?? summaryMatch![2]).toLowerCase();

      for (const pattern of patterns) {
        const label = SHORT_LABELS[pattern.type];
        // Forces SHORT_LABELS update when a new pattern type is added.
        expect(label).toBeDefined();
        expect(summary).toContain(label.toLowerCase());
      }
    });

    it('should have a SHORT_LABELS entry for every registered pattern (no orphans)', () => {
      const patterns = dlpService.getRegisteredPatterns();
      const registeredTypes = new Set(patterns.map(p => p.type));
      const labelTypes = new Set(Object.keys(SHORT_LABELS));

      // Catches a stale label that no longer maps to a real registry entry.
      for (const labelType of labelTypes) {
        expect(registeredTypes.has(labelType)).toBe(true);
      }
    });
  });
});
