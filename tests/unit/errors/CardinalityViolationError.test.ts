import { CardinalityViolationError } from '../../../src/errors/CardinalityViolationError';
import { AppError } from '../../../src/errors/AppError';
import { makeFinding, makeReport } from '../../helpers/cardinalityTestDoubles';
import type { CardinalityFinding, PreflightRunResult } from '../../../src/types/cardinality';

/**
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * ("Error contract"). The 422 body must carry the report fingerprint,
 * sanitized findings (row indexes + report-local collision-group IDs only),
 * and the unavailable-checks list — and must never carry sample values, raw
 * key values, or credentials, even if a caller's finding object is corrupted
 * with extra properties.
 */
describe('CardinalityViolationError', () => {
  function makeResult(overrides: Partial<PreflightRunResult> = {}): PreflightRunResult {
    return {
      reports: [makeReport()],
      blocking: true,
      combinedFingerprint: 'combined-fp-1',
      ...overrides,
    };
  }

  it('is an AppError with status 422 and code CARDINALITY_VIOLATION', () => {
    const finding = makeFinding();
    const error = new CardinalityViolationError(makeResult(), [finding]);

    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(422);
    expect(error.errorCode).toBe('CARDINALITY_VIOLATION');
  });

  it('exposes the combined report fingerprint from the preflight result', () => {
    const result = makeResult({ combinedFingerprint: 'combined-fp-xyz' });
    const error = new CardinalityViolationError(result, [makeFinding()]);

    expect(error.reportFingerprint).toBe('combined-fp-xyz');
    expect(error.toResponseBody().reportFingerprint).toBe('combined-fp-xyz');
  });

  it('aggregates deduplicated unavailableChecks across every report', () => {
    const result = makeResult({
      reports: [
        makeReport({ direction: 'source_to_target', unavailableChecks: ['key_uniqueness', 'target_key_uniqueness'] }),
        makeReport({ direction: 'target_to_source', unavailableChecks: ['key_uniqueness'] }),
      ],
    });
    const error = new CardinalityViolationError(result, [makeFinding()]);

    expect(error.toResponseBody().unavailableChecks.sort()).toEqual(
      ['key_uniqueness', 'target_key_uniqueness'].sort(),
    );
  });

  it('serializes only the allow-listed finding fields, dropping hostile extra properties', () => {
    const hostileFinding = makeFinding({
      relationshipPath: ['Account', 'Contacts'],
    }) as CardinalityFinding & Record<string, unknown>;
    // Simulate a corrupted/attacker-controlled finding object carrying fields
    // that must never reach an HTTP response.
    hostileFinding.sampleValue = 'SECRET_SAMPLE_VALUE';
    hostileFinding.rawKey = 'customer-ssn-123-45-6789';
    hostileFinding.credentials = { apiKey: 'sk-hostile-credential' };

    const error = new CardinalityViolationError(makeResult(), [hostileFinding]);
    const body = error.toResponseBody();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain('SECRET_SAMPLE_VALUE');
    expect(serialized).not.toContain('customer-ssn-123-45-6789');
    expect(serialized).not.toContain('sk-hostile-credential');

    expect(Object.keys(body.findings[0]).sort()).toEqual(
      ['key', 'type', 'severity', 'overrideable', 'direction', 'mappingIndexes', 'relationshipPath', 'message', 'resolutionOptions'].sort(),
    );
  });

  it('never includes a samples or sampleDigest field anywhere in the response body', () => {
    const finding = makeFinding();
    const error = new CardinalityViolationError(makeResult(), [finding]);
    const serialized = JSON.stringify(error.toResponseBody());

    expect(serialized.toLowerCase()).not.toContain('sample');
    expect(serialized.toLowerCase()).not.toContain('credential');
  });

  it('copies mappingIndexes/relationshipPath into new arrays rather than sharing references', () => {
    const mappingIndexes = [0, 1];
    const relationshipPath = ['Account', 'Contacts'];
    const finding = makeFinding({ mappingIndexes, relationshipPath });

    const error = new CardinalityViolationError(makeResult(), [finding]);
    const [sanitized] = error.toResponseBody().findings;

    expect(sanitized.mappingIndexes).toEqual([0, 1]);
    expect(sanitized.mappingIndexes).not.toBe(mappingIndexes);
    expect(sanitized.relationshipPath).toEqual(['Account', 'Contacts']);
    expect(sanitized.relationshipPath).not.toBe(relationshipPath);
  });

  it('omits relationshipPath entirely when the source finding has none', () => {
    const finding = makeFinding();
    delete (finding as { relationshipPath?: string[] }).relationshipPath;

    const error = new CardinalityViolationError(makeResult(), [finding]);
    expect(error.toResponseBody().findings[0]).not.toHaveProperty('relationshipPath');
  });

  it('reports the count of remaining blocking findings in the message without leaking content', () => {
    const findings = [makeFinding({ key: 'a' }), makeFinding({ key: 'b' })];
    const error = new CardinalityViolationError(makeResult(), findings);

    expect(error.message).toContain('2');
    expect(error.toResponseBody().findings).toHaveLength(2);
  });
});
