/**
 * MCP Auto-Redact Fixture Tests (DLP Commit 2 regression prevention)
 *
 * These tests pin the behavior that motivated commit 2's entire
 * design: MCPAggregatorService.ts:215 calls
 * `dlpService.scanForPII({autoRedact:true})` on every MCP tool result,
 * and a false positive in a non-PII field would silently mutate
 * production tool output before it reaches the agent. Commit 2 wires
 * 5 new PII types (bank_account, date_of_birth, passport,
 * drivers_license, name) via field-name-aware validate(match, fieldPath)
 * gates, and these fixture tests prove:
 *
 *   1. Each new type IS redacted when the value sits in a field with
 *      a matching lexeme (the positive case).
 *   2. Each new type is NOT redacted when the value sits in a field
 *      without a matching lexeme (the negative case — this is the
 *      Codex false-positive class that was blocked on PR #589).
 *   3. When a structured input has one PII field and multiple non-PII
 *      fields, ONLY the PII field is redacted — the non-PII fields
 *      come through unchanged. This is the load-bearing structural
 *      guard against the object-mode redaction bug flagged by Codex
 *      review 2026-04-09 finding 3 (index-based redactPIIFromText()
 *      with placeholder startIndex=0/endIndex=0 would prepend the
 *      replacement to every string field in the entire object).
 *
 * Implementation note (per open question 3 in the commit 2 plan):
 * this file calls `dlpService.scanForPII({autoRedact:true})` directly
 * rather than going through the full MCPAggregatorService.callTool()
 * roundtrip. The logic under test lives in DLPService; the aggregator
 * is a thin wrapper that forwards tool results through scanForPII.
 * Direct testing is faster and exercises the same code path.
 *
 * Historical note (ultraplan review 2026-04-09 finding 4, resolved by
 * Phase 3 of docs/archive/superseded/2026-04/plans/2026-04-20-repo-improvements-combined.md): the
 * `DLPService.redactData()` `path.includes(key)` substring-match bug
 * that required fixtures in this file to avoid sibling-overlap shapes
 * like `{bank, bank_account}` has been fixed. `redactData` now threads
 * a `currentPath` parameter and filters findings via exact-path match
 * (`pathTargetsNode`). The sibling-overlap regression guard below
 * (`overlapping names ... even when values coincide`) deliberately uses
 * `{bank, bank_account}` with identical values to pin the fix. New
 * fixtures are free to use any field-name shape.
 */

import 'reflect-metadata';
import { DLPService, DLPPolicy } from '../../src/services/security/DLPService';
import type { Logger } from '../../src/utils/Logger';

describe('MCP auto-redact fixture tests (DLP commit 2)', () => {
  let dlpService: DLPService;
  const autoRedactPolicy: DLPPolicy = {
    allowPII: false,
    piiTypes: [],
    autoRedact: true,
    blockOnDetection: false,
  };

  beforeEach(() => {
    const mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    dlpService = new DLPService(mockLogger);
  });

  // ------------------------------------------------------------------
  // Per-type positive/negative pairs — 10 tests total
  // ------------------------------------------------------------------

  describe('phone_intl — Codex false-positive class', () => {
    it('should NOT redact `+12.3456.7890` in a `version` field (no phone hint)', async () => {
      const fixture = { tool: 'release_info', version: '+12.3456.7890' };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      const intlFinding = result.findings.find(f => f.type === 'phone_intl');
      expect(intlFinding).toBeUndefined();
      // Redacted data MUST preserve the version field verbatim — this
      // is the structural guard: if phone_intl fired incorrectly, the
      // auto-redact path would silently mutate the tool output.
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.version).toBe('+12.3456.7890');
    });

    it('should redact `+44 20 1234 5678` in a `customer.phone` field', async () => {
      const fixture = { customer: { phone: '+44 20 1234 5678' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'phone_intl')).toBeDefined();
      const redacted = result.redactedData as { customer: { phone: string } };
      expect(redacted.customer.phone).not.toBe('+44 20 1234 5678');
    });
  });

  describe('bank_account — 8-17 digit run', () => {
    it('should NOT redact `12345678` in an `internal_id` field', async () => {
      const fixture = { product: { internal_id: '12345678', sku: 'SKU-ABC' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'bank_account')).toBeUndefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.product.internal_id).toBe('12345678');
    });

    it('should redact `12345678` in an `accountNumber` field', async () => {
      const fixture = { accountNumber: '12345678', institution: 'ACME Bank' };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'bank_account')).toBeDefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.accountNumber).not.toBe('12345678');
      // Institution field must come through unchanged — it's not PII.
      expect(redacted.institution).toBe('ACME Bank');
    });
  });

  describe('date_of_birth — year-bounded date shape', () => {
    it('should NOT redact `01/15/2024` in an `order_date` field', async () => {
      const fixture = { order: { order_date: '01/15/2024', status: 'shipped' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeUndefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.order.order_date).toBe('01/15/2024');
    });

    it('should redact `01/15/1990` in a `dob` field', async () => {
      const fixture = { profile: { dob: '01/15/1990', timezone: 'America/Denver' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'date_of_birth')).toBeDefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.profile.dob).not.toBe('01/15/1990');
      expect(redacted.profile.timezone).toBe('America/Denver');
    });
  });

  describe('passport — 9-char alphanumeric with letter-prefix variant', () => {
    it('should NOT redact `A12345678` in a `product_code` field', async () => {
      const fixture = { inventory: { product_code: 'A12345678', quantity: 42 } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'passport')).toBeUndefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.inventory.product_code).toBe('A12345678');
    });

    it('should redact `A12345678` in a `passportNumber` field', async () => {
      const fixture = { traveler: { passportNumber: 'A12345678', country: 'US' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'passport')).toBeDefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.traveler.passportNumber).not.toBe('A12345678');
      expect(redacted.traveler.country).toBe('US');
    });
  });

  describe("drivers_license — 5-15 char alphanumeric", () => {
    it('should NOT redact `A1234567` in a ticket `comment` field', async () => {
      const fixture = { ticket: { comment: 'Customer mentioned DL A1234567', priority: 'low' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'drivers_license')).toBeUndefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.ticket.comment).toBe('Customer mentioned DL A1234567');
    });

    it('should redact `A1234567` in a `drivers_license` field', async () => {
      const fixture = { applicant: { drivers_license: 'A1234567', state: 'CA' } };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      expect(result.findings.find(f => f.type === 'drivers_license')).toBeDefined();
      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;
      expect(redacted.applicant.drivers_license).not.toBe('A1234567');
      expect(redacted.applicant.state).toBe('CA');
    });
  });

  // ------------------------------------------------------------------
  // Multi-field object-integrity guard (ultraplan review finding 3 /
  // Codex review finding 3 — THE load-bearing structural test)
  //
  // If the adapter's placeholder startIndex=0/endIndex=0 ever got
  // consumed by the index-based redactPIIFromText() path, the non-PII
  // fields in this fixture would have the email redaction prepended
  // to them. This test fails loudly if that regression ships.
  // ------------------------------------------------------------------

  describe('multi-field object-integrity guard', () => {
    it('should redact ONLY the PII field, leaving non-PII fields untouched', async () => {
      // Safe fixture shape: no substring collisions between sibling
      // field names. `email` is PII; `displayTitle` and `bio` are not.
      // Deliberately NOT using `name` as a sibling to sidestep the
      // pre-existing DLPService.redactData() `path.includes(key)` bug.
      const fixture = {
        customer: {
          email: 'john@example.com',
          displayTitle: 'Public Title',
          bio: 'prefers dark mode',
        },
      };
      const result = await dlpService.scanForPII(fixture, autoRedactPolicy);

      // Exactly one finding, for email.
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].type).toBe('email');

      // redactedData is undefined when no findings trigger redaction;
      // fall back to the original fixture so the "unchanged" assertions
      // hold in both cases (negative tests) without extra branching.
      const redacted = (result.redactedData ?? fixture) as typeof fixture;

      // The email MUST be redacted.
      expect(redacted.customer.email).not.toBe('john@example.com');
      // The non-PII fields MUST come through unchanged. If the
      // index-based redactPIIFromText() path were accidentally
      // exercised via placeholder startIndex=0, these fields would
      // have the email redaction PREPENDED to them:
      //   displayTitle: 'j***@example.comPublic Title'
      //   bio:          'j***@example.comprefers dark mode'
      // and these assertions would fail loudly.
      expect(redacted.customer.displayTitle).toBe('Public Title');
      expect(redacted.customer.bio).toBe('prefers dark mode');
    });
  });

  it('does not redact sibling fields with overlapping names via MCP auto-redact, even when values coincide', async () => {
    const fixture = {
      account: {
        bank: '12345678',              // same value as bank_account so the bug is observable
        bank_account: '12345678',      // PII, field-gated
        displayTitle: 'Operating account',
      },
    };

    const result = await dlpService.scanForPII(fixture, autoRedactPolicy);
    const redacted = (result.redactedData ?? fixture) as typeof fixture;

    expect(result.findings.filter(f => f.type === 'bank_account')).toHaveLength(1);
    expect(redacted.account.bank).toBe('12345678');
    expect(redacted.account.bank_account).not.toBe('12345678');
    expect(redacted.account.displayTitle).toBe('Operating account');
  });
});
