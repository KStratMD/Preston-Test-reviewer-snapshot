/**
 * Data Loss Prevention (DLP) Service
 * Enterprise-grade PII detection and data protection
 *
 * Detects 14 PII pattern types via a single registry. Adding or
 * removing a pattern is a one-line change to `buildPatternRegistry()` —
 * `scanString()` iterates the registry and never special-cases a type.
 *
 * Categories:
 *   government_id: ssn, date_of_birth, passport, drivers_license
 *   financial:     credit_card, bank_account
 *   contact:       email, phone, phone_intl, name
 *   health:        medical_record_number
 *   credential:    api_key, jwt_token
 *   network:       ip_address
 *
 * Field-name-aware validation:
 *   Six patterns (phone_intl, bank_account, date_of_birth, passport,
 *   drivers_license, name) are gated on surrounding field context via
 *   per-type isXxxRelatedFieldPath() helpers. Each delegates to an
 *   anchored XXX_FIELD_TOKEN_REGEX that only matches tokens whose whole
 *   shape matches the per-type lexeme family. This eliminates the
 *   false-positive class Codex blocked on PR #589 — a phone-shaped
 *   token in a `version` field is NOT treated as PII, but the same
 *   token in `customer.phone` IS. Since `MCPAggregatorService.ts:215`
 *   auto-redacts every MCP tool result via `scanForPII({autoRedact:true})`,
 *   these gates are the load-bearing guard that prevents silent
 *   corruption of non-PII payloads. Patterns declare
 *   `requiresFieldContext: true` so the metadata view and test
 *   guards can distinguish field-gated from value-gated patterns
 *   without reading validator source.
 *
 * Single source of truth for the compliance dashboard / SOC 2 evidence:
 *   - `getRegisteredPatterns()` returns metadata only (no regexes)
 *   - `GET /api/compliance/dlp-patterns` exposes that view
 *   - `public/compliance-dashboard.html` C1 panel fetches from that endpoint
 *   - `GovernanceService.detectPII()` routes by input shape to either
 *     `scanForPII(data)` or `scanText(text)`, both with `autoRedact:true`
 *     — there is no longer a separate Governance pattern registry.
 *
 * Integrates with GovernanceService for pre-flight checks and is used
 * by MCPAggregatorService to auto-redact tool results.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';

export interface PIIDetectionResult {
  detected: boolean;
  piiTypes: string[];
  findings: PIIFinding[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendation: string;
  redactedData?: unknown;
  /** True when the scanner caught an internal error and returned an empty result.
   *  Consumers (OutboundGovernanceService) MUST treat this as a fail-safe block,
   *  not a "no PII detected" signal — otherwise scanner crashes silently approve. */
  scanFailed?: boolean;
}

export interface PIIFinding {
  type: string;
  field?: string;
  value: string;
  confidence: number;
  location: {
    path: string;
    line?: number;
    column?: number;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  redactedValue: string;
}

export interface DLPPolicy {
  allowPII: boolean;
  piiTypes: string[];
  autoRedact: boolean;
  blockOnDetection: boolean;
  customPatterns?: RegExp[];
}

/**
 * Pattern category — used by the compliance dashboard to group entries.
 */
export type PIICategory =
  | 'government_id'
  | 'financial'
  | 'contact'
  | 'health'
  | 'credential'
  | 'network';

/**
 * Canonical union of all PII type identifiers in the DLPService registry.
 * Re-exported by GovernanceService so that `PIIType.type` stays
 * exhaustively typed across the two services. Adding a new pattern to
 * `buildPatternRegistry()` requires a matching entry here.
 */
export type DLPPIIType =
  | 'ssn'
  | 'credit_card'
  | 'email'
  | 'phone'
  | 'phone_intl'
  | 'medical_record_number'
  | 'api_key'
  | 'jwt_token'
  | 'ip_address'
  | 'bank_account'
  | 'date_of_birth'
  | 'passport'
  | 'drivers_license'
  | 'name';

/**
 * A registered PII pattern. Each entry is fully self-contained:
 * regex + redactor + (optional) value validator. The registry is the
 * canonical source — anything not in it is not scanned.
 *
 * `validate` receives both the matched substring AND the field path
 * the match was found at (e.g. `user.contact.mobile`, `phones[0]`).
 * Patterns that need field-name awareness use the second arg via a
 * per-type `isXxxRelatedFieldPath()` helper; value-only validators
 * (credit_card Luhn, ip_address private-IP denylist) ignore it.
 */
interface PIIPattern {
  type: DLPPIIType;
  displayName: string;
  category: PIICategory;
  regex: RegExp;
  confidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  redact: (match: string) => string;
  validate?: (match: string, fieldPath: string) => boolean;
  /**
   * True if this pattern's `validate()` callback requires a non-empty
   * `fieldPath` argument to fire (i.e. it's gated on surrounding field
   * name context, not just on value shape). Used by the metadata view
   * so callers can distinguish field-gated patterns (`phone_intl`,
   * `bank_account`, `date_of_birth`, `passport`, `drivers_license`,
   * `name`) from value-gated patterns (`credit_card` has Luhn;
   * `ip_address` has private-IP denylist) without reading `validate`
   * source. Defaults to false when omitted.
   */
  requiresFieldContext?: boolean;
}

/**
 * Public, metadata-only view of a registered pattern.
 * Excludes regex/redactor/validator so the API can expose the list
 * without leaking detection logic.
 */
export interface PIIPatternMetadata {
  type: DLPPIIType;
  displayName: string;
  category: PIICategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** True if this pattern requires field-name context to fire. */
  requiresFieldContext: boolean;
}

@injectable()
export class DLPService {
  private readonly piiPatterns: PIIPattern[];

  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.piiPatterns = this.buildPatternRegistry();
    this.logger.info('DLP Service initialized', {
      patterns: this.piiPatterns.length,
      capabilities: ['PII detection', 'Auto-redaction', 'Policy enforcement']
    });
  }

  /**
   * Build the canonical pattern registry. Order is the dashboard display order.
   *
   * Each entry uses `str.matchAll(regex)` in `scanString()` — the spec
   * defines `matchAll` as cloning the regex internally, so the shared
   * `/g` instances here have no `lastIndex` state hazards.
   */
  private buildPatternRegistry(): PIIPattern[] {
    return [
      // 1. Social Security Number
      {
        type: 'ssn',
        displayName: 'Social Security Number',
        category: 'government_id',
        regex: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g,
        confidence: 0.95,
        severity: 'critical',
        redact: () => '***-**-****',
      },

      // 2. Credit Card (Luhn-validated)
      {
        type: 'credit_card',
        displayName: 'Credit Card Number',
        category: 'financial',
        regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
        confidence: 0.9,
        severity: 'critical',
        redact: (m) => '**** **** **** ' + m.slice(-4),
        validate: (m) => this.isValidCreditCard(m),
      },

      // 3. Email
      {
        type: 'email',
        displayName: 'Email Address',
        category: 'contact',
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        confidence: 0.85,
        severity: 'medium',
        redact: (m) => m.charAt(0) + '***@' + m.split('@')[1],
      },

      // 4. Phone (US/NANP — exactly 10 digits with 3-3-4 structure,
      //    optionally prefixed by +1).
      {
        type: 'phone',
        displayName: 'Phone Number',
        category: 'contact',
        regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
        confidence: 0.8,
        severity: 'medium',
        redact: (m) => '***-***-' + m.replace(/\D/g, '').slice(-4),
      },

      // 5. International phone — FIELD-NAME AWARE
      //
      // Regex: `+`, 1-3 digit country code (leading non-zero), then 6-12
      // more digits with 0-3 separator chars between each, with a trailing
      // word boundary AND a terminal negative-lookahead guard
      // `(?![ .\-()]*\d)` that rejects the match if it is immediately
      // followed by zero-or-more separators and another digit.
      //
      // Total digit count: 7-15 — exactly within E.164's 7-15 digit range
      // (https://www.itu.int/rec/T-REC-E.164). Naturally handles varied
      // layouts like `+44 20 1234 5678`, `+33 1 23 45 67 89`, etc., and
      // rejects 16+ digit runs that aren't valid E.164 numbers
      // (Copilot review on PR #595, round 1).
      //
      // The terminal guard is a second Copilot finding from the same PR:
      // without it, a partial-match prefix attack is possible on longer
      // invalid sequences. Example: the 16-digit token `+123 4567890 12345
      // 6` previously matched the first 15 digits (`+123 4567890 12345`)
      // and silently dropped the trailing `6`, because `\b` is satisfied
      // between `5` (word) and ` ` (non-word). With the lookahead, the
      // regex sees that ` 6` (separator + digit) would extend the match
      // and refuses to partial-match — so the whole token is rejected.
      // The guard preserves all legitimate behaviors (numbers followed
      // by prose/`ext`/punctuation/comma-separated second intl phones
      // still match correctly — verified against 10 edge cases).
      //
      // FIELD-CONTEXT REQUIRED: Codex review on PR #589 flagged that regex
      // alone cannot distinguish a real intl phone from phone-structurally-
      // identical tokens like `+12.3456.7890` or `+123-45-6789` (which
      // could be version codes, coordinates, IDs, etc.). Since
      // `MCPAggregatorService.ts:215` auto-redacts every MCP tool result
      // via `scanForPII({autoRedact:true})`, a false positive in a non-
      // phone field would silently mutate production data.
      //
      // The validate() below restricts matches to fields whose path looks
      // phone-related (phone/telephone/tel/mobile/cell/cellphone/fax/
      // msisdn, plus their plural/numbered/concatenated variants like
      // `telephone1`, `phone2`, `phonenumber`, `phoneNumbers` — see
      // `isPhoneRelatedFieldPath()` for the full token shape). It also
      // excludes NANP numbers (`+1` + 10 digits) since those are already
      // caught by the `phone` US branch above — preventing duplicate
      // findings on the same value.
      //
      // SCOPE LIMITATION (free-text MCP payloads):
      //   This is a STRUCTURAL gate. Intl phones embedded in the
      //   `content[0].text` payload of an `IMCPAdapter.MCPToolResult`
      //   (the human-visible MCP tool output produced by adapters like
      //   BusinessCentralMcpClient and NetSuiteOfficialMcpClient) are
      //   intentionally NOT flagged here, because the same Codex false-
      //   positive risk (`+12.3456.7890` could be a version code or
      //   coordinate) applies even more strongly inside free-form text
      //   without a stable surrounding field name. Free-text intl phone
      //   detection requires in-string context analysis (preceding
      //   "Tel:" / "Call" / country-name proximity) and is tracked as
      //   a follow-up. The `should NOT flag intl phone in free-text
      //   MCP content[].text` test pins the current behavior.
      //
      // The same field-context approach is the prerequisite for the four
      // other deferred PII types (bank_account, date_of_birth, passport,
      // drivers_license). See CLAUDE.md.
      {
        type: 'phone_intl',
        displayName: 'International Phone Number',
        category: 'contact',
        regex: /\+[1-9]\d{0,2}(?:[ .\-()]{0,3}\d){6,12}\b(?![ .\-()]*\d)/g,
        confidence: 0.7,
        severity: 'medium',
        requiresFieldContext: true,
        redact: (m) => '+**-***-***-' + m.replace(/\D/g, '').slice(-4),
        validate: (match, fieldPath) => {
          // NANP (+1 + 10 digits) is caught by the `phone` US branch —
          // skip to avoid duplicate findings on the same value.
          const digits = match.replace(/\D/g, '');
          if (digits.length === 11 && digits.startsWith('1')) {
            return false;
          }
          return this.isPhoneRelatedFieldPath(fieldPath);
        },
      },

      // 6. Medical Record Number
      {
        type: 'medical_record_number',
        displayName: 'Medical Record Number',
        category: 'health',
        regex: /\b(?:MRN|Medical Record #?):?\s*\d{6,10}\b/gi,
        confidence: 0.75,
        severity: 'high',
        redact: () => 'MRN: ******',
      },

      // 7. API Key (generic 32+ char alphanumeric)
      {
        type: 'api_key',
        displayName: 'API Key',
        category: 'credential',
        regex: /\b[A-Za-z0-9]{32,}\b/g,
        confidence: 0.7,
        severity: 'critical',
        redact: (m) => m.substring(0, 4) + '...' + m.substring(m.length - 4),
      },

      // 8. JWT Token
      {
        type: 'jwt_token',
        displayName: 'JWT Token',
        category: 'credential',
        regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        confidence: 0.95,
        severity: 'critical',
        redact: () => '[REDACTED JWT]',
      },

      // 9. IP Address — wires former ipAddress dead code.
      // Octet-bounded form (borrowed from PatternRecognizer.ts:75) plus
      // a private/loopback denylist via validate(), to suppress noise from
      // RFC1918 ranges, link-local, multicast, and 127.x.x.x.
      {
        type: 'ip_address',
        displayName: 'IP Address',
        category: 'network',
        regex: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
        confidence: 0.65,
        severity: 'medium',
        redact: (m) => {
          const parts = m.split('.');
          return parts[0] + '.' + parts[1] + '.*.*';
        },
        validate: (m) => !this.isPrivateOrLoopbackIp(m),
      },

      // 10. Bank Account Number — FIELD-NAME AWARE
      //
      // 8–17 digit run — wide enough to cover US ACH (9-digit routing),
      // IBAN body digits, and most national bank account formats while
      // rejecting short IDs. Value-level shape is deliberately simple
      // because the per-type field-name gate does the heavy lifting.
      //
      // FIELD-CONTEXT REQUIRED: without gating, an 8–17 digit run would
      // match customer IDs, order numbers, part numbers, etc. The
      // isBankAccountRelatedFieldPath() gate restricts matches to fields
      // whose path tokenizes to a bank/routing/IBAN/ACH lexeme — see
      // BANK_ACCOUNT_FIELD_TOKEN_REGEX for the full shape. Deliberately
      // excludes bare `account` (would match `account_id`/`account_status`)
      // and bare `number` (would match `part_number`/`invoice_number`).
      {
        type: 'bank_account',
        displayName: 'Bank Account Number',
        category: 'financial',
        regex: /\b\d{8,17}\b/g,
        confidence: 0.65,
        severity: 'high',
        requiresFieldContext: true,
        redact: (m) => '****' + m.slice(-4),
        validate: (_match, fieldPath) => this.isBankAccountRelatedFieldPath(fieldPath),
      },

      // 11. Date of Birth — FIELD-NAME AWARE
      //
      // Matches MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD, YYYY/MM/DD with a
      // plausible-year gate (1900 ≤ year ≤ current year). Value-level
      // check rejects obvious non-DOBs like order dates in 2099 or
      // legacy epoch dates; the per-type field-name gate restricts
      // matches to fields whose path tokenizes to dob/dateofbirth/
      // birthdate/birthday/born. Excludes bare `date` (would match
      // `order_date`) and bare `birth` (would match `birth_certificate_id`).
      {
        type: 'date_of_birth',
        displayName: 'Date of Birth',
        category: 'government_id',
        regex: /\b(?:(?:\d{1,2}[/\-]\d{1,2}[/\-]\d{4})|(?:\d{4}[/\-]\d{1,2}[/\-]\d{1,2}))\b/g,
        confidence: 0.7,
        severity: 'high',
        requiresFieldContext: true,
        redact: () => '****-**-**',
        validate: (match, fieldPath) => {
          if (!this.isDobRelatedFieldPath(fieldPath)) return false;
          // Year plausibility gate — reject obvious non-DOBs.
          const yearMatch = match.match(/\b(\d{4})\b/);
          if (!yearMatch) return false;
          const year = parseInt(yearMatch[1], 10);
          const currentYear = new Date().getFullYear();
          return year >= 1900 && year <= currentYear;
        },
      },

      // 12. Passport Number — FIELD-NAME AWARE
      //
      // Matches US 9-digit passport numbers OR ICAO format (1 letter +
      // 8 alphanumeric, total 9 chars). Value-level shape is specific
      // enough to avoid most false positives, but gating is still
      // required because 9 alphanumeric chars also matches SKUs,
      // product codes, etc. The per-type field-name gate restricts
      // matches to fields explicitly named passport/passportnumber/
      // passportno/passportid.
      {
        type: 'passport',
        displayName: 'Passport Number',
        category: 'government_id',
        regex: /\b(?:\d{9}|[A-Z]\d{8}|[A-Z][A-Z0-9]{8})\b/g,
        confidence: 0.7,
        severity: 'high',
        requiresFieldContext: true,
        redact: (m) => m.charAt(0) + '********',
        validate: (_match, fieldPath) => this.isPassportRelatedFieldPath(fieldPath),
      },

      // 13. Driver's License Number — FIELD-NAME AWARE
      //
      // Matches "DL:" / "License:" prefixed forms AND bare
      // alphanumeric runs 5–15 chars long that look like state DL
      // numbers. The alphanumeric-run form is very broad (would match
      // almost any short ID), so field gating is load-bearing here.
      // The per-type field-name gate accepts driverslicense/
      // driverlicense/drivinglicense/dlnumber/licensenumber and the
      // bare `dl` lexeme, but excludes bare `license` (would match
      // `software_license`/`license_url`) and bare `driver` (database
      // driver field name collision).
      {
        type: 'drivers_license',
        displayName: "Driver's License Number",
        category: 'government_id',
        regex: /\b(?:DL\s*#?:?\s*)?[A-Z0-9]{5,15}\b/g,
        confidence: 0.6,
        severity: 'high',
        requiresFieldContext: true,
        redact: () => 'DL: *********',
        validate: (_match, fieldPath) => this.isDriversLicenseRelatedFieldPath(fieldPath),
      },

      // 14. Name — FIELD-NAME AWARE
      //
      // Adopted from GovernanceService's former detector. The old
      // GovernanceService regex was the title-prefix heuristic
      // `/\b(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Prof\.?)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/`
      // which was a false-positive nightmare in free text (`Dr. Watson
      // said...` matches). Because field-gating via
      // isNameRelatedFieldPath() eliminates the free-text FP class,
      // we can use a much simpler whole-value shape match: starts
      // with a capital letter, body allows letters + apostrophes +
      // hyphens + periods + commas + spaces, 2–80 chars total. This
      // catches `{name: 'John Smith'}`, `{customer: {fullName: 'Jane Doe'}}`,
      // `{displayName: 'Public User'}` without requiring a title prefix.
      //
      // ASCII-only for parity with the old GovernanceService detector.
      // Unicode names (`José`, `李明`) are a documented future enhancement.
      {
        type: 'name',
        displayName: 'Personal Name',
        category: 'contact',
        regex: /^[A-Z][a-zA-Z'\-.,\s]{1,79}$/g,
        confidence: 0.6,
        severity: 'medium',
        requiresFieldContext: true,
        redact: () => '[NAME_REDACTED]',
        validate: (_match, fieldPath) => this.isNameRelatedFieldPath(fieldPath),
      },
    ];
  }

  /**
   * Public metadata view of the registered patterns.
   * Used by `GET /api/compliance/dlp-patterns` and the compliance dashboard.
   */
  public getRegisteredPatterns(): PIIPatternMetadata[] {
    return this.piiPatterns.map(p => ({
      type: p.type,
      displayName: p.displayName,
      category: p.category,
      severity: p.severity,
      requiresFieldContext: p.requiresFieldContext ?? false,
    }));
  }

  /**
   * Scan data for PII using pattern-based detection.
   */
  async scanForPII(data: unknown, policy?: DLPPolicy): Promise<PIIDetectionResult> {
    const findings: PIIFinding[] = [];
    const piiTypes = new Set<string>();

    try {
      // Recursively scan the data structure
      this.scanObject(data, '', findings, piiTypes);
      const normalizedFindings = this.normalizeFindings(findings);
      const normalizedPiiTypes = Array.from(piiTypes).filter(type =>
        normalizedFindings.some(finding => finding.type === type)
      );

      // Determine risk level based on findings
      const riskLevel = this.assessRiskLevel(normalizedFindings);

      // Generate recommendation
      const recommendation = this.generateRecommendation(normalizedFindings, policy);

      // Optionally redact data
      let redactedData: unknown | undefined;
      if (policy?.autoRedact && normalizedFindings.length > 0) {
        redactedData = this.redactData(data, normalizedFindings);
      }

      const result: PIIDetectionResult = {
        detected: normalizedFindings.length > 0,
        piiTypes: normalizedPiiTypes,
        findings: normalizedFindings,
        riskLevel,
        recommendation,
        redactedData
      };

      this.logger.info('PII scan completed', {
        findingsCount: normalizedFindings.length,
        piiTypes: normalizedPiiTypes,
        riskLevel
      });

      return result;

    } catch (error) {
      this.logger.error(
        'PII scan failed',
        error instanceof Error ? error : new Error(String(error)),
      );
      return {
        detected: false,
        piiTypes: [],
        findings: [],
        riskLevel: 'low',
        recommendation: 'Scan failed - manual review recommended',
        scanFailed: true
      };
    }
  }

  /**
   * Scan a flat text string for PII. Used by consumers that have only
   * raw text and no structural field context (e.g. log lines, free-text
   * notes, raw string inputs to GovernanceService.detectPII()).
   *
   * Field-gated patterns (phone_intl, date_of_birth, passport,
   * bank_account, drivers_license, name) are intentionally NOT applied
   * here — without a field name, there's nothing to gate on, and bare
   * regex matching reintroduces the false-positive class Codex blocked
   * on PR #589. The gate-skipping happens implicitly: every gated
   * pattern's validate() delegates to an isXxxRelatedFieldPath(path)
   * helper that returns false for empty path. No explicit check is
   * needed here.
   *
   * When called with `{ autoRedact: true }`, scanText ALSO populates
   * `redactedData` with a redacted copy of the input string, produced
   * via the same value-based redactData() path scanForPII uses. This
   * lets consumers (e.g. the GovernanceService adapter) use
   * redactedData uniformly for both object and string inputs without
   * rebuilding startIndex/endIndex offsets — eliminating a class of
   * off-by-one risk flagged during plan review.
   *
   * For structured data (objects/arrays), use scanForPII(data) instead.
   * It preserves dotted field paths so the gates can fire AND runs
   * normalizeFindings() before returning to de-dupe overlapping phone/
   * phone_intl matches (PR #599).
   *
   * NOTE: scanText() does NOT run normalizeFindings() because the only
   * current normalization target is phone/phone_intl overlap — and in
   * text mode, phone_intl never fires (gated), so there's nothing to
   * normalize.
   */
  public async scanText(text: string, policy?: DLPPolicy): Promise<{
    findings: PIIFinding[];
    piiTypes: string[];
    redactedData?: string;
  }> {
    const findings: PIIFinding[] = [];
    const piiTypes = new Set<string>();
    // Empty path → every isXxxRelatedFieldPath('') returns false → every
    // field-gated pattern is naturally skipped for this call.
    this.scanString(text, '', findings, piiTypes);

    let redactedData: string | undefined;
    if (policy?.autoRedact && findings.length > 0) {
      // redactData() for string input uses value-based .replace(),
      // not index-based slicing — so it's safe with any findings shape.
      redactedData = this.redactData(text, findings) as string;
    }

    return {
      findings,
      piiTypes: Array.from(piiTypes),
      redactedData,
    };
  }

  /**
   * Recursively scan object for PII
   */
  private scanObject(
    obj: unknown,
    path: string,
    findings: PIIFinding[],
    piiTypes: Set<string>
  ): void {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === 'string') {
      this.scanString(obj, path, findings, piiTypes);
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.scanObject(item, `${path}[${index}]`, findings, piiTypes);
      });
    } else if (typeof obj === 'object') {
      Object.entries(obj).forEach(([key, value]) => {
        const newPath = path ? `${path}.${key}` : key;
        this.scanObject(value, newPath, findings, piiTypes);
      });
    }
  }

  /**
   * Scan a string against the full pattern registry.
   * Single loop — no per-type branches.
   *
   * `path` is the dotted/bracketed field path of the string within the
   * scanned object (e.g. `user.contact.mobile`, `phones[0]`). It is
   * passed to each pattern's `validate(match, fieldPath)` so that
   * field-name-aware patterns (currently `phone_intl`) can suppress
   * matches outside their expected fields. Existing validators that
   * only inspect the value ignore the second arg — TypeScript permits
   * arity widening at the call site.
   */
  private scanString(
    str: string,
    path: string,
    findings: PIIFinding[],
    piiTypes: Set<string>
  ): void {
    for (const pattern of this.piiPatterns) {
      const matches = str.matchAll(pattern.regex);
      for (const match of matches) {
        const value = match[0];
        if (pattern.validate && !pattern.validate(value, path)) {
          continue;
        }
        findings.push({
          type: pattern.type,
          field: path,
          value,
          confidence: pattern.confidence,
          location: { path, column: match.index },
          severity: pattern.severity,
          redactedValue: pattern.redact(value),
        });
        piiTypes.add(pattern.type);
      }
    }
  }

  /**
   * Normalize overlapping findings after the full scan.
   *
   * The `phone` regex can match the trailing 10-digit local slice inside a
   * broader non-NANP `phone_intl` match (for example `+44 123 456 7890`).
   * If both findings survive, auto-redaction can partially mask the local
   * substring before the intl replacement runs. Prefer the broader
   * `phone_intl` finding and drop any nested `phone` finding at the same path.
   */
  private normalizeFindings(findings: PIIFinding[]): PIIFinding[] {
    return findings.filter(finding => {
      if (finding.type !== 'phone') {
        return true;
      }

      const findingStart = finding.location.column;
      if (findingStart === undefined) {
        return true;
      }

      const findingEnd = findingStart + finding.value.length;
      return !findings.some(other => {
        if (other.type !== 'phone_intl' || other.location.path !== finding.location.path) {
          return false;
        }

        const otherStart = other.location.column;
        if (otherStart === undefined) {
          return false;
        }

        const otherEnd = otherStart + other.value.length;
        return findingStart >= otherStart && findingEnd <= otherEnd;
      });
    });
  }

  /**
   * Validate credit card number using Luhn algorithm
   */
  private isValidCreditCard(cardNumber: string): boolean {
    const digits = cardNumber.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return false;
    }

    let sum = 0;
    let isEven = false;

    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = parseInt(digits[i], 10);

      if (isEven) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }

      sum += digit;
      isEven = !isEven;
    }

    return sum % 10 === 0;
  }

  /**
   * Field-name-aware gate for `phone_intl` (and any future PII pattern
   * that needs surrounding-field context). Returns true when ANY token
   * in the field path matches a known phone-related shape — including
   * the suffixed/numbered/concatenated variants used by Dynamics, NetSuite,
   * and the project's own field-mapping synonyms (`telephone1`, `phone1`,
   * `phonenumber`, `phoneNumbers`, etc.).
   *
   * Path is tokenized by:
   *   1. Splitting on path separators (`.`, `[`, `]`, `_`)
   *   2. Splitting each segment on lowercase→uppercase camelCase
   *      boundaries AND on uppercase→Capitalized boundaries — but NOT
   *      between two uppercase letters that belong to the same acronym.
   *      This preserves all-caps tokens like `MSISDN`, `PHONE`, `URL`.
   *   3. Lower-casing each token
   *
   * Each token is then matched against PHONE_FIELD_TOKEN_REGEX, which
   * accepts a base phone term (`phone`, `telephone`, `tel`, `mobile`,
   * `cell`, `cellphone`, `fax`, `msisdn`), with:
   *   - an optional curated PREFIX for concatenated forms
   *     (`primary`, `secondary`, `main`, `home`, `work`, `office`,
   *     `personal`, `business`, `alt`/`alternate`, `backup`,
   *     `emergency`, `mobile`, `direct`) — e.g. `primaryphone`,
   *     `mainphone`, `homephone`, `workmobile`.
   *   - an optional SUFFIX:
   *       - `s`/`es` (plural)
   *       - one or more digits (Dynamics-style: `telephone1`, `phone2`)
   *       - `num` / `nums` / `number` / `numbers` (concatenated:
   *         `phonenumber`, `telephoneNumbers`)
   *
   * Examples that match:
   *   `phone`, `phoneNumber`, `customer_phone`, `user.contact.mobile`,
   *   `phones[0]`, `homePhone`, `cellphones`, `MSISDN`, `PHONE_NUMBER`,
   *   `CONTACT.MOBILE`, `myPHONENumber`, `telephone1`, `phone1`,
   *   `phonenumber`, `telephoneNumber`, `mobiles`, `faxes`, `MSISDN1`,
   *   `primaryphone`, `mainphone`, `homephone`, `workphone`,
   *   `emergencyphone`, `altphone`.
   * Examples that do NOT match:
   *   `description`, `telegram`, `hotel`, `contactName`, `contactEmail`,
   *   `phoned`, `phony`, `cellular`, `smartphone`, `headphone`,
   *   `megaphone`, `microphone`.
   *
   * SCOPE LIMITATION (free-text MCP payloads):
   *   This gate is structural — it requires a phone-named field path.
   *   It deliberately does NOT flag intl phones embedded in free-text
   *   payloads such as `content[0].text` (the human-visible MCP tool
   *   output shape from `IMCPAdapter.MCPToolResult`). The same Codex
   *   false-positive risk that motivated this whole gate (`+12.3456.7890`
   *   could be a version code, coordinate, or ID) applies even more
   *   strongly inside free-form text. Free-text intl phone detection
   *   needs in-string context analysis (preceding "Tel:", "Call",
   *   country-name proximity, etc.) and is tracked as a follow-up.
   *   The `should NOT flag intl phone in free-text content[].text`
   *   test in DLPService.test.ts pins this current behavior so the
   *   gap stays visible.
   */
  private isPhoneRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.PHONE_FIELD_TOKEN_REGEX);
  }

  /**
   * Shared tokenize-and-test utility for per-type field-path helpers.
   * Tokenizes a dotted/bracketed path (e.g. `customer.contact.mobile`,
   * `records[0].metadata.dob`, `accounts["bank"]`) and tests each
   * segment against an anchored per-type regex using a TWO-PASS
   * strategy:
   *
   * Pass 1 — joined form (for multi-word lexemes):
   *   Strip underscores from the segment and lowercase it, then test
   *   the whole result against the regex. Catches multi-word lexemes
   *   like `drivers_license` → `driverslicense`, `date_of_birth` →
   *   `dateofbirth`, `account_number` → `accountnumber`. Also catches
   *   camelCase multi-word forms like `dateOfBirth` (no underscores,
   *   just lowercased → `dateofbirth`) and `accountNumber` →
   *   `accountnumber`.
   *
   * Pass 2 — sub-token form (for single-word lexemes in concatenated
   * names):
   *   Split the segment on underscores AND camelCase boundaries with
   *   acronym preservation, lowercase each piece, and test each
   *   against the regex. Catches forms like `customer_phone` →
   *   `['customer', 'phone']` where `phone` alone matches
   *   PHONE_FIELD_TOKEN_REGEX via its optional-prefix + base alternation.
   *
   * The two passes are complementary, not redundant. Pass 1 is
   * required for multi-word lexemes whose joined form is in the base
   * alternatives (`driverslicense`, `dateofbirth`, `bankaccount`).
   * Pass 2 is required for single-word lexemes that appear with a
   * non-base prefix (`customer_phone`, `user.email`) where the base
   * word alone matches and the prefix is just path structure.
   *
   * Camel-case split rules:
   *   - lowercase→uppercase boundary (`phoneNumber` → `phone|Number`)
   *   - uppercase→Capitalized boundary (`MSISDNNumber` → `MSISDN|Number`)
   *   All-caps runs without a trailing capitalized word stay intact:
   *   `MSISDN` → `[MSISDN]`, `PHONE` → `[PHONE]`, `URL` → `[URL]`.
   *
   * Factored out from isPhoneRelatedFieldPath (the original single
   * helper) once five more gated patterns landed in commit 2. Having
   * six helpers duplicate the same split loop was past the "inline
   * until the third repeats" threshold.
   *
   * Returns false for empty/null path — this is the mechanism by which
   * gated patterns naturally skip themselves in scanText() mode where
   * path === ''.
   */
  private matchesFieldPath(path: string, tokenRegex: RegExp): boolean {
    if (!path) return false;
    // Outer split on dots and brackets only — NOT underscores.
    // Underscores are part of the token for multi-word lexemes like
    // `drivers_license` and `date_of_birth`; pass 1 below strips them
    // to produce the joined form.
    for (const segment of path.split(/[.\[]|\]/g)) {
      if (!segment) continue;

      // Pass 1: joined form — strip underscores and lowercase the
      // whole segment, then test. Catches multi-word lexemes.
      const joined = segment.toLowerCase().replace(/_/g, '');
      if (joined && tokenRegex.test(joined)) {
        return true;
      }

      // Pass 2: sub-token form — split on underscores AND acronym-
      // preserving camelCase boundaries, then test each piece.
      // Catches single-word lexemes in concatenated names.
      for (const word of segment.split(/_|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g)) {
        if (word && tokenRegex.test(word.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Phone-related field token shape. Anchored at both ends so it only
   * matches tokens that are ENTIRELY phone-shaped — no substring/prefix
   * matches like `telegram` (`tel...`), `cellular` (`cell...`), or
   * `phoned` (`phone...`).
   *
   * Base alternatives cover:
   *   phone(s) | telephone(s) | tel(s) | mobile(s) | cell(s) |
   *   cellphone(s) | fax(es) | msisdn(s)
   *
   * Optional prefix covers concatenated-name forms that the project's
   * own field-mapping synonym table already treats as phone synonyms
   * (e.g. `primaryphone` at `public/ai-field-mapping-editor.html:6486`
   * and `mainPhone` at `config/templates/integration-templates.json:33`):
   *   primary | secondary | main | home | work | office | personal |
   *   business | alt(ernate) | backup | emergency | mobile | direct
   *
   * The prefix list is intentionally curated (not `\w*`) — a blanket
   * "anything ending in phone" would match unrelated device/product
   * tokens like `smartphone`, `headphone`, `megaphone`, `microphone`,
   * and `saxophone`, each of which could carry non-phone string values
   * that would then feed the auto-redact path.
   *
   * Optional suffix covers:
   *   - digits     (`telephone1`, `phone2`, `MSISDN1`)
   *   - num/nums   (concatenated short form)
   *   - number(s)  (`phonenumber`, `telephoneNumbers`)
   */
  private static readonly PHONE_FIELD_TOKEN_REGEX =
    /^(?:primary|secondary|main|home|work|office|personal|business|alt(?:ernate)?|backup|emergency|mobile|direct)?(?:phones?|telephones?|tels?|mobiles?|cells?|cellphones?|fax(?:es)?|msisdns?)(?:\d+|nums?|numbers?)?$/;

  /**
   * Bank-account-related field token shape. Accepts:
   *   bankaccount(s) | accountnumber(s) | routingnumber(s) |
   *   iban(s) | achaccount(s)
   * with optional digit/num/nums/number/numbers suffix.
   *
   * Deliberately excludes bare `account` (would match `account_id`,
   * `account_status`, `account_type` — none of which are bank
   * accounts) and bare `number` (would match `part_number`,
   * `invoice_number`, `phone_number`). Must have a bank/routing/
   * IBAN/ACH lexeme in the token.
   */
  private isBankAccountRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.BANK_ACCOUNT_FIELD_TOKEN_REGEX);
  }

  private static readonly BANK_ACCOUNT_FIELD_TOKEN_REGEX =
    /^(?:bankaccounts?|accountnumbers?|routingnumbers?|ibans?|achaccounts?)(?:\d+|nums?|numbers?)?$/;

  /**
   * DOB-related field token shape. Accepts:
   *   dob(s) | dateofbirth(s) | birthdate(s) | birthday(s) |
   *   born | dateborn
   *
   * Deliberately excludes bare `date` (would match `order_date`,
   * `created_date`, `ship_date`) and bare `birth` (would match
   * `birth_certificate_id`, `birth_place`, `birth_country`). Must
   * have an explicit DOB lexeme.
   */
  private isDobRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.DOB_FIELD_TOKEN_REGEX);
  }

  private static readonly DOB_FIELD_TOKEN_REGEX =
    /^(?:dobs?|dateofbirths?|birthdates?|birthdays?|born|dateborn)$/;

  /**
   * Passport-related field token shape. Accepts:
   *   passport(s) | passportnumber(s) | passportno(s) | passportid(s)
   * with optional digit suffix, AND with an optional curated prefix
   * for concatenated names that contain `passport` as a suffix lexeme:
   *   customer | user | traveler | applicant | employee | client | holder
   *
   * Examples that match: `passport`, `passportNumber`, `passport_no`,
   * `passport1`, `customerPassport`, `user_passport`, `travelerPassport`,
   * `applicantPassportNumber`, `employeePassport`, `holderPassport`.
   *
   * Examples that don't: bare `number`/`id`/`code` (too broad — would
   * silently flag SKUs, ticket IDs, product codes), `passportphoto`
   * (no `photo` in the suffix group), `passportoffice` (no `office` in
   * the suffix group).
   *
   * The prefix list is intentionally curated, not `\w*`, for the same
   * reason as PHONE_FIELD_TOKEN_REGEX — a blanket "anything ending in
   * passport" would over-match unrelated word-boundary collisions.
   * Per the plan (DLP commit 2 plan, table row 12: "anchored to
   * `passport` lexeme so `userpassport`/`customerpassport` match").
   */
  private isPassportRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.PASSPORT_FIELD_TOKEN_REGEX);
  }

  private static readonly PASSPORT_FIELD_TOKEN_REGEX =
    /^(?:customer|user|traveler|applicant|employee|client|holder)?(?:passports?|passportnumbers?|passportnos?|passportids?)(?:\d+)?$/;

  /**
   * Driver's-license-related field token shape. Accepts:
   *   driverslicense(s) | driverlicense(s) | drivinglicense(s) |
   *   dlnumber(s) | licensenumber(s) | dl
   *
   * Deliberately excludes bare `license` (would match
   * `software_license`, `license_url`, `license_key`) and bare
   * `driver` (would match database driver field names). The bare `dl`
   * lexeme is allowed because it's a narrow, conventional abbreviation.
   */
  private isDriversLicenseRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.DL_FIELD_TOKEN_REGEX);
  }

  private static readonly DL_FIELD_TOKEN_REGEX =
    /^(?:driverslicenses?|driverlicenses?|drivinglicenses?|dlnumbers?|licensenumbers?|dl)$/;

  /**
   * Name-related field token shape. Accepts:
   *   name(s) | firstname(s) | lastname(s) | fullname(s) | displayname(s)
   * with optional curated prefixes:
   *   customer | contact | user | client | vendor | supplier | employee
   *
   * Examples that match: `name`, `firstName`, `last_name`, `fullName`,
   * `displayName`, `customerName`, `vendor_name`, `employeeFirstName`.
   * Examples that don't: `filename`, `hostname`, `username` (no bare
   * `user` + `name` concat — `username` starts with `user` which isn't
   * in the base alternatives). Actually `username` WILL match because
   * `user` is a curated prefix and `name` is in the base — so
   * `username` is treated as a name field, which is intentional for
   * display-name-style detection.
   */
  private isNameRelatedFieldPath(path: string): boolean {
    return this.matchesFieldPath(path, DLPService.NAME_FIELD_TOKEN_REGEX);
  }

  private static readonly NAME_FIELD_TOKEN_REGEX =
    /^(?:customer|contact|user|client|vendor|supplier|employee)?(?:names?|firstnames?|lastnames?|fullnames?|displaynames?)$/;

  /**
   * Suppress IPs that are loopback, link-local, RFC1918 private, or multicast.
   * Reduces noise from infra logs without losing real public-IP detection.
   */
  private isPrivateOrLoopbackIp(ip: string): boolean {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true;                              // 0.0.0.0/8
    if (a === 127) return true;                            // 127.0.0.0/8 loopback
    if (a === 10) return true;                             // 10.0.0.0/8 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16 RFC1918
    if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local
    if (a >= 224) return true;                             // multicast / reserved
    return false;
  }

  /**
   * Assess overall risk level based on findings
   */
  private assessRiskLevel(findings: PIIFinding[]): 'low' | 'medium' | 'high' | 'critical' {
    if (findings.length === 0) {
      return 'low';
    }

    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const highCount = findings.filter(f => f.severity === 'high').length;
    const mediumCount = findings.filter(f => f.severity === 'medium').length;

    if (criticalCount > 0) {
      return 'critical';
    } else if (highCount >= 2 || (highCount >= 1 && mediumCount >= 2)) {
      return 'high';
    } else if (highCount >= 1 || mediumCount >= 2) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Generate recommendation based on findings and policy
   */
  private generateRecommendation(findings: PIIFinding[], policy?: DLPPolicy): string {
    if (findings.length === 0) {
      return 'No PII detected - request approved';
    }

    const criticalFindings = findings.filter(f => f.severity === 'critical');

    if (criticalFindings.length > 0 && policy?.blockOnDetection) {
      return `Request blocked: ${criticalFindings.length} critical PII finding(s) detected. Remove sensitive data before retrying.`;
    }

    if (policy?.autoRedact) {
      return `${findings.length} PII finding(s) detected and automatically redacted. Review redacted data before processing.`;
    }

    return `${findings.length} PII finding(s) detected. Manual review recommended before proceeding.`;
  }

  /**
   * Exact-path match: does `nodePath` name the exact target-path location
   * or a parent of it? Replaces the prior `path.includes(key)` heuristic
   * which caused sibling collisions (e.g. `bank` vs `bank_account`).
   */
  private pathTargetsNode(targetPath: string, nodePath: string): boolean {
    if (!targetPath || !nodePath) return targetPath === nodePath;
    return (
      targetPath === nodePath ||
      targetPath.startsWith(`${nodePath}.`) ||
      targetPath.startsWith(`${nodePath}[`)
    );
  }

  /**
   * Redact PII from data structure.
   *
   * `currentPath` is the dotted+indexed path to `data` in the original
   * object (empty string at the top level). Each recursive step narrows
   * `findings` to just the ones whose `.location.path` targets the
   * current node — not siblings whose key happens to share a substring.
   */
  private redactData(data: unknown, findings: PIIFinding[], currentPath = ''): unknown {
    if (typeof data === 'string') {
      let redacted = data;
      findings.forEach(finding => {
        redacted = redacted.replace(finding.value, finding.redactedValue);
      });
      return redacted;
    } else if (Array.isArray(data)) {
      return data.map((item, index) => {
        const itemPath = `${currentPath}[${index}]`;
        const itemFindings = findings.filter(f => this.pathTargetsNode(f.location.path, itemPath));
        return this.redactData(item, itemFindings, itemPath);
      });
    } else if (typeof data === 'object' && data !== null) {
      const redacted: Record<string, unknown> = {};
      Object.entries(data).forEach(([key, value]) => {
        const childPath = currentPath ? `${currentPath}.${key}` : key;
        const childFindings = findings.filter(f => this.pathTargetsNode(f.location.path, childPath));
        redacted[key] = this.redactData(value, childFindings, childPath);
      });
      return redacted;
    }
    return data;
  }

  /**
   * Validate data against DLP policy
   */
  async validatePolicy(data: unknown, policy: DLPPolicy): Promise<{
    approved: boolean;
    reason?: string;
    findings?: PIIFinding[];
  }> {
    const scanResult = await this.scanForPII(data, policy);

    if (!scanResult.detected) {
      return { approved: true };
    }

    // Check if any detected PII types are blocked by policy
    const blockedTypes = scanResult.piiTypes.filter(type => {
      return policy.piiTypes.includes(type);
    });

    if (blockedTypes.length > 0 && policy.blockOnDetection) {
      return {
        approved: false,
        reason: `Blocked PII types detected: ${blockedTypes.join(', ')}`,
        findings: scanResult.findings
      };
    }

    if (scanResult.riskLevel === 'critical' && policy.blockOnDetection) {
      return {
        approved: false,
        reason: `Critical risk level detected with ${scanResult.findings.length} PII findings`,
        findings: scanResult.findings
      };
    }

    return {
      approved: true,
      reason: `Approved with warnings: ${scanResult.findings.length} PII findings detected`,
      findings: scanResult.findings
    };
  }
}
