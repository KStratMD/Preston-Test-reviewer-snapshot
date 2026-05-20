/**
 * GovernanceService — Coverage Uplift Tests (PR 5)
 *
 * Lifts `src/services/ai/orchestrator/GovernanceService.ts` from
 * 22.27% lines / 21.7% branches to ≥70%/≥60% via direct exercise of
 * the public surface plus the private helpers reached through it.
 *
 * Pairs with the existing `GovernanceService.commit2.test.ts` which
 * pins the DLPService adapter shape; this file does not duplicate that
 * coverage. Instead it exercises:
 *
 *   - validateInput() PII routing matrix across enablePIIDetection,
 *     autoRedactPII, and strictMode (including the documented dangerous
 *     combo and the autoRedact-wins-over-strictMode short-circuit)
 *   - validateInput() content moderation through all 3 initialized
 *     filters (malicious/profanity/sensitive)
 *   - validateInput() governance rules through all 3 initialized rules
 *     (data_size_limit/production_protection/industry_compliance)
 *   - validateBusinessLogic() business-hours + user-auth checks
 *   - validateOutput() symmetric coverage + output quality checks
 *   - detectPII() shape routing (structured vs primitive)
 *   - redactPIIFromData() fallback to legacy index-based path
 *   - Mutator + stats lifecycle
 *   - Error-handling paths in validateInput/validateOutput
 *
 * Out of scope (deferred per plan, may land in future PR):
 *   - Adding prompt-injection patterns to initializeRules()
 *   - Adding `enableHallucinationCheck` config knob (validateOutputQuality
 *     is hardcoded; spec section 4 reframed as testing existing behaviour)
 *   - Making validateBusinessLogic time-independent (currently mocked via
 *     a Date.prototype.getHours spy; future cleanup could thread
 *     context.timestamp through the production code)
 */

import 'reflect-metadata';
import { GovernanceService, type PIIDetectionResult } from '../../../../../src/services/ai/orchestrator/GovernanceService';
import { DLPService } from '../../../../../src/services/security/DLPService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { AgentExecutionContext } from '../../../../../src/services/ai/orchestrator/interfaces';

const baseContext: AgentExecutionContext = {
  sessionId: 'test-session',
  userId: 'test-user',
  sourceSystem: 'test',
  targetSystem: 'test',
  businessProcess: 'test',
  correlationId: 'test-corr',
  timestamp: new Date('2026-05-13T14:00:00Z'),
};

describe('GovernanceService — coverage uplift (PR 5)', () => {
  let governance: GovernanceService;
  let dlpService: DLPService;
  let mockLogger: Logger;
  let getHoursSpy: jest.SpyInstance;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    dlpService = new DLPService(mockLogger);
    governance = new GovernanceService(mockLogger, dlpService);

    // Mock Date.prototype.getHours to a deterministic in-business-hours
    // value (14:00). validateBusinessLogic reads `new Date().getHours()`
    // (local-time hour), so jest.setSystemTime alone is timezone-fragile
    // — UTC 14:00 maps to non-business-hours in some test environments.
    // Section 4's 03:00 test reuses this spy via getHoursSpy.mockReturnValue(3)
    // rather than re-spying (which would wrap our own spy as the
    // "original" and corrupt restoreAllMocks behaviour).
    getHoursSpy = jest.spyOn(Date.prototype, 'getHours').mockReturnValue(14);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  // Section 1: validateInput PII routing matrix
  // -------------------------------------------------------------------
  describe('validateInput() PII routing matrix', () => {
    it('skips PII detection when enablePIIDetection=false', async () => {
      governance.updateConfig({ enablePIIDetection: false });
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.flags).not.toContain('pii_detected');
      expect(result.redactedData).toBeUndefined();
    });

    it('passes clean input through with no pii_detected flag', async () => {
      // Avoid PII-shaped values AND PII-related field names. The `name`
      // pattern is field-gated and would fire on `{name: 'Acme Corp'}` even
      // though Acme Corp is a company name, not a person — the field-gate
      // matches the field token, not the value semantics.
      const result = await governance.validateInput({ note: 'no sensitive content here' }, baseContext);
      expect(result.flags).not.toContain('pii_detected');
      expect(result.approved).toBe(true);
    });

    it('flags + auto-redacts when PII detected and autoRedactPII=true (default)', async () => {
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.flags).toContain('pii_detected');
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.riskLevel).toBe('high');
      expect(result.redactedData).toBeDefined();
      // PII detection alone doesn't block when autoRedactPII is true
      expect(result.approved).toBe(true);
    });

    it('blocks PII when autoRedactPII=false and strictMode=true', async () => {
      governance.updateConfig({ autoRedactPII: false, strictMode: true });
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('PII detected');
      expect(result.flags).toContain('pii_detected');
      expect(result.redactedData).toBeUndefined();
    });

    it('flags-but-approves when both autoRedactPII=false and strictMode=false (documented dangerous combo)', async () => {
      // This is the "kept for back-compat" combination in the GovernanceService
      // JSDoc. Real deployments should not run with this configuration; this
      // test pins the documented behaviour so a future change is visible.
      governance.updateConfig({ autoRedactPII: false, strictMode: false });
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.flags).toContain('pii_detected');
      expect(result.riskLevel).toBe('high');
      expect(result.approved).toBe(true);
      expect(result.redactedData).toBeUndefined();
    });

    it('redacts (not blocks) when both autoRedactPII=true and strictMode=true (autoRedact wins)', async () => {
      // Inside the PII branch, autoRedact wins via the if/else-if order:
      // `if (autoRedactPII) { redact } else if (strictMode) { block }`.
      // The two flags are not orthogonal — autoRedact short-circuits the
      // strictMode block path when both are enabled.
      governance.updateConfig({ autoRedactPII: true, strictMode: true });
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('pii_auto_redacted');
      expect(result.redactedData).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Section 2: validateInput content moderation (malicious/profanity/sensitive)
  // -------------------------------------------------------------------
  describe('validateInput() content moderation', () => {
    it('blocks malicious content (script injection pattern)', async () => {
      const result = await governance.validateInput({ payload: '<script>alert(1)</script>' }, baseContext);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('input_malicious_detected');
      expect(result.reason).toContain("Content filter 'malicious'");
      expect(result.riskLevel).toBe('high');
    });

    it('warns (not blocks) on profanity match and escalates risk to medium', async () => {
      const result = await governance.validateInput("damn that's broken", baseContext);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('input_profanity_detected');
      // Risk escalates from 'low' to 'medium' via the
      // content-filter warnings-non-empty branch in validateInput.
      // Indirectly confirms escalateRiskLevel('low','medium') === 'medium'.
      expect(result.riskLevel).toBe('medium');
    });

    it('warns on sensitive-data pattern (password mention)', async () => {
      const result = await governance.validateInput('my password is hunter2', baseContext);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('input_sensitive_detected');
    });

    it('skips content filtering when enableContentFiltering=false', async () => {
      governance.updateConfig({ enableContentFiltering: false });
      const result = await governance.validateInput({ payload: '<script>alert(1)</script>' }, baseContext);
      expect(result.flags).not.toContain('input_malicious_detected');
      expect(result.approved).toBe(true);
    });

    it('produces no content-filter flags on clean input', async () => {
      const result = await governance.validateInput('Hello world, totally normal text', baseContext);
      expect(result.flags.filter((f) => f.startsWith('input_'))).toHaveLength(0);
    });

    it('blocks on first matching filter even if multiple would match (loop short-circuits)', async () => {
      // Malicious filter (action='block') iterates before profanity in
      // initializeFilters() insertion order, and Map iteration is
      // insertion-ordered. Once blocked=true, the outer for-of-filters
      // loop breaks — confirms applyContentFilters does not continue
      // evaluating remaining filters after a block hit.
      const result = await governance.validateInput(
        { payload: "<script>alert(1)</script> + 'damn'" },
        baseContext,
      );
      expect(result.flags).toContain('input_malicious_detected');
      expect(result.approved).toBe(false);
      // The negative assertion is what actually proves short-circuit:
      // both malicious AND profanity patterns match this payload, so if
      // the outer-loop `break` ever regressed (and applyContentFilters
      // kept evaluating after a block), profanity would also flag here.
      expect(result.flags).not.toContain('input_profanity_detected');
    });

    it('skips a disabled filter (enabled=false) without testing its patterns', async () => {
      // Overwrite the existing 'malicious' filter with a disabled version
      // via the public addContentFilter API (which uses Map.set keyed by
      // filter.name). The `if (!filter.enabled) continue` skip branch
      // short-circuits before evaluating patterns, so the patterns array
      // is intentionally empty here — supplying production regexes would
      // create maintenance coupling to initializeFilters() without
      // affecting test correctness.
      governance.addContentFilter({
        name: 'malicious',
        enabled: false,
        patterns: [],
        severity: 'high',
        action: 'block',
      });
      const result = await governance.validateInput({ payload: '<script>alert(1)</script>' }, baseContext);
      expect(result.flags).not.toContain('input_malicious_detected');
    });
  });

  // -------------------------------------------------------------------
  // Section 3: validateInput governance rules
  // -------------------------------------------------------------------
  describe('validateInput() governance rules', () => {
    it('blocks input exceeding data_size_limit (1MB)', async () => {
      // Disable PII detection + content filtering before exercising the
      // rule path. Both run BEFORE governance rules in validateInput and
      // perform regex passes over the entire input — for a 1MB payload
      // that's hundreds of ms of scanning per filter that adds nothing
      // to what this test asserts (rule-path coverage in isolation).
      governance.updateConfig({ enablePIIDetection: false, enableContentFiltering: false });
      const huge = { payload: 'x'.repeat(1024 * 1024 + 100) };
      const result = await governance.validateInput(huge, baseContext);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('rule_data_size_limit_triggered');
      expect(result.riskLevel).toBe('high');
      // Compliance check entries record the rule outcome
      const sizeCheck = result.complianceChecks.find((c) => c.rule === 'Data Size Limit');
      expect(sizeCheck?.status).toBe('failed');
    });

    it('warns (not blocks) when production_protection triggers on production targetSystem', async () => {
      const ctx: AgentExecutionContext = { ...baseContext, targetSystem: 'production-erp' };
      const result = await governance.validateInput({ payload: 'small' }, ctx);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('rule_production_protection_triggered');
      const prodCheck = result.complianceChecks.find((c) => c.rule === 'Production System Protection');
      // A triggered rule's check entry is recorded as status='failed'
      // regardless of action — `action: 'warn'` controls whether the
      // request is blocked, not the check entry's status field.
      expect(prodCheck?.status).toBe('failed');
    });

    it('warns when industry_compliance triggers on healthcare context', async () => {
      const ctx: AgentExecutionContext = { ...baseContext, industry: 'healthcare' };
      const result = await governance.validateInput({ payload: 'small' }, ctx);
      expect(result.approved).toBe(true);
      expect(result.flags).toContain('rule_industry_compliance_triggered');
    });

    it('does not record a check entry for a disabled rule (verifies !rule.enabled skip branch)', async () => {
      // Add a rule whose condition would always fire, but with
      // enabled:false. If the `!rule.enabled` skip branch in
      // applyGovernanceRules regressed, this rule would produce a
      // 'failed' check entry — so asserting its absence proves the
      // skip path is intact. (Previous version of this test used
      // removeGovernanceRule, which deletes the Map entry entirely
      // and bypasses the enabled-flag branch under test.)
      governance.addGovernanceRule({
        id: 'always_fires_but_disabled',
        name: 'Always Fires But Disabled',
        description: 'condition would fire on every input, but rule is disabled',
        enabled: false,
        scope: 'input',
        condition: () => true,
        action: 'block',
        message: 'should never be reached because enabled:false',
        severity: 'high',
      });
      const result = await governance.validateInput({ payload: 'anything' }, baseContext);
      // No flag emitted → skip branch held
      expect(result.flags).not.toContain('rule_always_fires_but_disabled_triggered');
      // No check entry → skip branch held (regression would push 'failed' check)
      expect(result.complianceChecks.find((c) => c.rule === 'Always Fires But Disabled')).toBeUndefined();
      // The rule still wouldn't have blocked the request
      expect(result.approved).toBe(true);
    });

    it('records a failed check when a rule.condition throws', async () => {
      governance.addGovernanceRule({
        id: 'throwing_rule',
        name: 'Throwing Rule',
        description: 'always throws',
        enabled: true,
        scope: 'input',
        condition: () => {
          throw new Error('boom');
        },
        action: 'block',
        message: 'should never see this',
        severity: 'high',
      });
      const result = await governance.validateInput({ payload: 'small' }, baseContext);
      const check = result.complianceChecks.find((c) => c.rule === 'Throwing Rule');
      expect(check?.status).toBe('failed');
      expect(check?.message).toContain('Rule evaluation error');
      // Block was never applied because condition threw
      expect(result.flags).not.toContain('rule_throwing_rule_triggered');
    });

    it('does NOT false-trigger on legitimate "ignore previous formatting" prose (no prompt-injection rule exists yet)', async () => {
      // Documents the current state: GovernanceService does NOT ship a
      // prompt-injection rule. Adding one is deferred to a future PR; this
      // test pins the absence so that adding such a rule will visibly
      // change behaviour and prompt explicit re-review.
      const result = await governance.validateInput(
        'Please ignore previous formatting and respond in JSON.',
        baseContext,
      );
      expect(result.flags.filter((f) => f.startsWith('rule_'))).toHaveLength(0);
      expect(result.approved).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Section 4: validateBusinessLogic (business hours + auth)
  // -------------------------------------------------------------------
  describe('validateBusinessLogic() — business hours + user auth', () => {
    it('does not flag outside_business_hours at 14:00', async () => {
      // beforeEach already mocked getHours() to 14
      const result = await governance.validateInput({ payload: 'x' }, baseContext);
      expect(result.flags).not.toContain('outside_business_hours');
    });

    it('flags outside_business_hours at 03:00', async () => {
      // Reuse the existing beforeEach spy rather than creating a new one.
      // Re-spying with jest.spyOn against an already-mocked method would
      // wrap our own spy as the "original", which makes restoreAllMocks
      // brittle and risks mock state leaking across tests.
      getHoursSpy.mockReturnValue(3);
      const result = await governance.validateInput({ payload: 'x' }, baseContext);
      expect(result.flags).toContain('outside_business_hours');
      const businessHoursCheck = result.complianceChecks.find((c) => c.rule === 'Business Hours');
      expect(businessHoursCheck?.status).toBe('warning');
    });

    it('flags no_user_authentication when context.userId is undefined', async () => {
      const ctx: AgentExecutionContext = { ...baseContext, userId: undefined };
      const result = await governance.validateInput({ payload: 'x' }, ctx);
      expect(result.flags).toContain('no_user_authentication');
      const authCheck = result.complianceChecks.find((c) => c.rule === 'User Authentication');
      expect(authCheck?.status).toBe('warning');
    });
  });

  // -------------------------------------------------------------------
  // Section 5: validateOutput symmetric + quality
  // -------------------------------------------------------------------
  describe('validateOutput() symmetric + quality checks', () => {
    it('flags output_pii_detected when PII appears in output', async () => {
      const result = await governance.validateOutput({ customerEmail: 'a@b.com' }, baseContext);
      expect(result.flags).toContain('output_pii_detected');
      expect(result.riskLevel).toBe('high');
    });

    it('blocks output containing PII when strictMode=true', async () => {
      governance.updateConfig({ strictMode: true });
      const result = await governance.validateOutput({ customerEmail: 'a@b.com' }, baseContext);
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('PII found in agent output');
    });

    it('blocks output matching a malicious content filter', async () => {
      const result = await governance.validateOutput('<script>alert(1)</script>', baseContext);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('output_malicious_detected');
      expect(result.reason).toContain('Output filtering');
    });

    it('flags empty_output for an empty object (validateOutputQuality completeness check)', async () => {
      const result = await governance.validateOutput({}, baseContext);
      expect(result.flags).toContain('empty_output');
      const check = result.complianceChecks.find((c) => c.rule === 'Output Completeness');
      expect(check?.status).toBe('failed');
    });

    it('flags incomplete_error_reporting on success=false output without errors field', async () => {
      const result = await governance.validateOutput({ success: false, result: 'whatever' }, baseContext);
      expect(result.flags).toContain('incomplete_error_reporting');
      const check = result.complianceChecks.find((c) => c.rule === 'Error Reporting');
      expect(check?.status).toBe('warning');
    });

    it('produces no quality flags on a well-formed successful output', async () => {
      const result = await governance.validateOutput({ success: true, data: { id: 1 } }, baseContext);
      expect(result.flags).not.toContain('empty_output');
      expect(result.flags).not.toContain('incomplete_error_reporting');
      expect(result.approved).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Section 6: detectPII shape routing
  // -------------------------------------------------------------------
  describe('detectPII() shape routing', () => {
    it('routes structured objects to DLPService.scanForPII', async () => {
      const scanForPIISpy = jest.spyOn(dlpService, 'scanForPII');
      const scanTextSpy = jest.spyOn(dlpService, 'scanText');
      await governance.detectPII({ email: 'user@example.com' });
      expect(scanForPIISpy).toHaveBeenCalledTimes(1);
      expect(scanTextSpy).not.toHaveBeenCalled();
    });

    it('routes raw strings to DLPService.scanText', async () => {
      const scanForPIISpy = jest.spyOn(dlpService, 'scanForPII');
      const scanTextSpy = jest.spyOn(dlpService, 'scanText');
      await governance.detectPII('contact user@example.com');
      expect(scanTextSpy).toHaveBeenCalledTimes(1);
      expect(scanForPIISpy).not.toHaveBeenCalled();
    });

    it('routes null to DLPService.scanText (via String() coercion)', async () => {
      const scanForPIISpy = jest.spyOn(dlpService, 'scanForPII');
      const scanTextSpy = jest.spyOn(dlpService, 'scanText');
      const result = await governance.detectPII(null);
      // String(null) → 'null' has no PII → hasPII false
      expect(result.hasPII).toBe(false);
      expect(scanTextSpy).toHaveBeenCalledWith('null', expect.any(Object));
      expect(scanForPIISpy).not.toHaveBeenCalled();
    });

    it('routes a primitive number through String() coercion (commit-2 P1 fix)', async () => {
      // Pre-commit-2 bug: a bare numeric like 123456789 would fall into
      // scanForPII → scanObject which silently ignores scalar primitives.
      // Commit 2 routes primitives via String() to scanText so detection
      // still fires. This test pins that behaviour.
      const scanTextSpy = jest.spyOn(dlpService, 'scanText');
      await governance.detectPII(123456789);
      expect(scanTextSpy).toHaveBeenCalledWith('123456789', expect.any(Object));
    });
  });

  // -------------------------------------------------------------------
  // Section 7: redactPIIFromData fallback path
  // -------------------------------------------------------------------
  describe('redactPIIFromData() fallback to legacy index-based path', () => {
    it('returns the input unchanged when hasPII=false', () => {
      const data = { name: 'Acme Corp' };
      const piiResult: PIIDetectionResult = {
        hasPII: false,
        piiTypes: [],
        confidence: 0,
        originalText: JSON.stringify(data),
      };
      const out = governance.redactPIIFromData(data, piiResult);
      expect(out).toBe(data);
    });

    it('walks the object via legacy redactDataRecursive when redactedData is absent', () => {
      // Hand-built PIIDetectionResult with REAL string-mode indices into a
      // single field's value. This is the only safe shape for the legacy
      // path; the commit-2 adapter never produces this shape (it always
      // populates redactedData), so this exercises the fallback in
      // isolation. The legacy path JSON-clones then walks each string field
      // and slices via redactPIIFromText().
      const data = { note: 'email: a@b.com' };
      const piiResult: PIIDetectionResult = {
        hasPII: true,
        piiTypes: [
          {
            type: 'email',
            value: 'a@b.com',
            confidence: 0.9,
            startIndex: 7,
            endIndex: 14,
            replacement: '[REDACTED]',
          },
        ],
        confidence: 0.9,
        originalText: JSON.stringify(data),
        // redactedData intentionally absent — forces fallback path
      };
      const out = governance.redactPIIFromData(data, piiResult);
      expect(out).not.toBe(data); // deep-cloned, not the same reference
      expect((out as { note: string }).note).toBe('email: [REDACTED]');
    });

    it('LIMITATION: string-root input returns unredacted via fallback (caller drops redactDataRecursive return value)', () => {
      // Pins a current production limitation surfaced by independent
      // review (Codex C1): when the input to redactPIIFromData is a
      // PRIMITIVE STRING (not wrapped in an object) AND the legacy
      // fallback path is taken (no piiResult.redactedData), the
      // returned value is UNREDACTED.
      //
      // Why: the implementation does
      //   const redactedData = JSON.parse(JSON.stringify(data));
      //   this.redactDataRecursive(redactedData, piiResult.piiTypes);
      //   return redactedData;
      // redactDataRecursive's typeof-string branch RETURNS the redacted
      // string, but the caller discards that return value. JavaScript
      // strings are primitives, so the `redactedData` local still
      // points at the original clone — never the redacted form.
      //
      // The production path through detectPII() always populates
      // piiResult.redactedData (via DLPService's value-based redactData),
      // which short-circuits BEFORE this fallback, so the bug is
      // unreachable through the supported public flow. It is only
      // observable when callers hand-construct a PIIDetectionResult
      // without redactedData and pass a primitive string — uncommon.
      //
      // If this assertion ever fails (i.e., the string returns redacted),
      // the underlying limitation has been fixed; remove this test +
      // the documenting comment together.
      const text = 'email: a@b.com';
      const piiResult: PIIDetectionResult = {
        hasPII: true,
        piiTypes: [
          {
            type: 'email',
            value: 'a@b.com',
            confidence: 0.9,
            startIndex: 7,
            endIndex: 14,
            replacement: '[REDACTED]',
          },
        ],
        confidence: 0.9,
        originalText: text,
        // redactedData intentionally absent — forces fallback path
      };
      const out = governance.redactPIIFromData(text, piiResult);
      expect(out).toBe(text); // currently UNREDACTED — see comment above
    });
  });

  // -------------------------------------------------------------------
  // Section 8: Mutator + stats lifecycle
  // -------------------------------------------------------------------
  describe('mutators + getGovernanceStats', () => {
    it('addGovernanceRule + removeGovernanceRule lifecycle', () => {
      const initialStats = governance.getGovernanceStats();
      governance.addGovernanceRule({
        id: 'test_rule',
        name: 'Test Rule',
        description: 'pinned by test',
        enabled: true,
        scope: 'input',
        condition: () => false,
        action: 'warn',
        message: 'test',
        severity: 'low',
      });
      expect(governance.getGovernanceStats().rulesCount).toBe(initialStats.rulesCount + 1);
      expect(governance.removeGovernanceRule('test_rule')).toBe(true);
      expect(governance.getGovernanceStats().rulesCount).toBe(initialStats.rulesCount);
      // Removing a non-existent rule returns false (Map.delete miss
      // returns false, which removeGovernanceRule passes through).
      expect(governance.removeGovernanceRule('nonexistent')).toBe(false);
    });

    it('addContentFilter adds to the filter registry', () => {
      const initialCount = governance.getGovernanceStats().filtersCount;
      governance.addContentFilter({
        name: 'test_filter',
        enabled: true,
        patterns: [/test/i],
        severity: 'low',
        action: 'warn',
      });
      expect(governance.getGovernanceStats().filtersCount).toBe(initialCount + 1);
    });

    it('updateConfig merges (does not replace) the config object', () => {
      const before = governance.getGovernanceStats().config;
      governance.updateConfig({ strictMode: true });
      const after = governance.getGovernanceStats().config;
      expect(after.strictMode).toBe(true);
      // Other fields preserved
      expect(after.enablePIIDetection).toBe(before.enablePIIDetection);
      expect(after.autoRedactPII).toBe(before.autoRedactPII);
      expect(after.retentionDays).toBe(before.retentionDays);
      expect(after.auditLevel).toBe(before.auditLevel);
    });

    it('getGovernanceStats returns the documented shape with all four fields', () => {
      const stats = governance.getGovernanceStats();
      expect(stats).toMatchObject({
        config: expect.any(Object),
        rulesCount: expect.any(Number),
        filtersCount: expect.any(Number),
        piiPatternsCount: expect.any(Number),
      });
      // Counts are >0 (the constructor seeds both via initializeFilters
      // and initializeRules). Exact-number assertions would be brittle —
      // adding a default rule or filter is a non-API change that
      // shouldn't break this test. The mutator-lifecycle test above
      // already covers add/remove correctness against a captured initial
      // count via initialStats.rulesCount.
      expect(stats.rulesCount).toBeGreaterThan(0);
      expect(stats.filtersCount).toBeGreaterThan(0);
    });

    it('reads piiPatternsCount from DLPService.getRegisteredPatterns() (single source of truth)', () => {
      // Drift guard: piiPatternsCount should track DLPService.getRegisteredPatterns().length,
      // not a parallel counter inside GovernanceService. Commit 2 unified the
      // pattern registry; this test pins that wiring.
      const statsCount = governance.getGovernanceStats().piiPatternsCount;
      const dlpCount = dlpService.getRegisteredPatterns().length;
      expect(statsCount).toBe(dlpCount);
      expect(statsCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------
  // Section 9: Error-handling paths (catch blocks in validate*)
  // -------------------------------------------------------------------
  describe('validateInput/validateOutput error-handling', () => {
    it('returns approved=false with validation_error flag when detectPII throws (validateInput catch)', async () => {
      jest.spyOn(dlpService, 'scanForPII').mockRejectedValueOnce(new Error('dlp boom'));
      const result = await governance.validateInput({ email: 'user@example.com' }, baseContext);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('validation_error');
      expect(result.reason).toContain('Validation error');
      expect(result.riskLevel).toBe('high');
    });

    it('returns approved=false with output_validation_error flag when detectPII throws (validateOutput catch)', async () => {
      jest.spyOn(dlpService, 'scanForPII').mockRejectedValueOnce(new Error('dlp boom'));
      const result = await governance.validateOutput({ customerEmail: 'a@b.com' }, baseContext);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('output_validation_error');
      expect(result.reason).toContain('Output validation error');
    });

    it('isolates rule.condition throws so later-added rules still produce checks', async () => {
      // Confirms applyGovernanceRules continues iterating after a thrown
      // rule (try/catch wraps each rule's condition evaluation
      // individually). We add BOTH a throwing rule AND a non-throwing
      // follow-up rule so the assertion
      // depends on post-throw evaluation — proving iteration continued past
      // the throw rather than simply observing rules that ran before it.
      // (Map iteration follows insertion order, so the after-throws rule is
      // guaranteed to run strictly after first-throws.)
      governance.addGovernanceRule({
        id: 'first_throws',
        name: 'First Throws',
        description: 'always throws',
        enabled: true,
        scope: 'input',
        condition: () => {
          throw new Error('boom');
        },
        action: 'warn',
        message: 'throwing rule',
        severity: 'low',
      });
      governance.addGovernanceRule({
        id: 'after_throws',
        name: 'After Throws',
        description: 'records a passing check; proves iteration continued after the throw',
        enabled: true,
        scope: 'input',
        condition: () => false,
        action: 'warn',
        message: 'after-throws never triggers',
        severity: 'low',
      });
      const result = await governance.validateInput({ payload: 'small' }, baseContext);
      // Throwing rule recorded as failed
      const throwing = result.complianceChecks.find((c) => c.rule === 'First Throws');
      expect(throwing?.status).toBe('failed');
      // After-throws rule MUST have a check entry — proves iteration continued
      // past the throw rather than terminating
      const afterThrows = result.complianceChecks.find((c) => c.rule === 'After Throws');
      expect(afterThrows).toBeDefined();
      expect(afterThrows?.status).toBe('passed');
    });
  });
});
