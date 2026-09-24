/**
 * Unit tests for the findings→display-name mapper + redaction summarizer
 * shared by the embedded approvals UI (PR 4, Phase D).
 *
 * The module under test is plain browser JS with a CommonJS export guard, so
 * it loads directly into jest's node environment — no jsdom needed (the
 * functions are pure).
 */
const { mapFindings, summarizeRedactions } = require('../../../public/embedded/findings-display.js');

describe('findings-display.js', () => {
  describe('mapFindings', () => {
    const patternMeta = {
      count: 14,
      patterns: [
        { type: 'ssn', displayName: 'Social Security Number' },
        { type: 'credit_card', displayName: 'Credit Card Number' },
        { type: 'email', displayName: 'Email Address' },
      ],
    };

    it('maps finding type keys to display names and reports matched/total', () => {
      const result = mapFindings(['ssn', 'credit_card'], patternMeta);
      expect(result.names).toEqual(['Social Security Number', 'Credit Card Number']);
      expect(result.matched).toBe(2);
      expect(result.total).toBe(14);
    });

    it('passes unknown finding keys through verbatim', () => {
      const result = mapFindings(['ssn', 'future_pattern_type'], patternMeta);
      expect(result.names).toEqual(['Social Security Number', 'future_pattern_type']);
      expect(result.matched).toBe(2);
    });

    it('returns raw keys and total=null when pattern metadata is unavailable', () => {
      const result = mapFindings(['ssn', 'credit_card'], null);
      expect(result.names).toEqual(['ssn', 'credit_card']);
      expect(result.total).toBeNull();
    });

    it('dedupes repeated finding keys', () => {
      const result = mapFindings(['ssn', 'ssn', 'email'], patternMeta);
      expect(result.names).toEqual(['Social Security Number', 'Email Address']);
      expect(result.matched).toBe(2);
    });

    it('ignores non-string finding entries and non-array findings input', () => {
      expect(mapFindings(['ssn', 42, null] as unknown as string[], patternMeta).names)
        .toEqual(['Social Security Number']);
      expect(mapFindings(undefined as unknown as string[], patternMeta))
        .toEqual({ names: [], matched: 0, total: 14 });
    });

    it('falls back to patterns.length when meta carries no count', () => {
      const meta = { patterns: patternMeta.patterns };
      expect(mapFindings(['ssn'], meta).total).toBe(3);
    });

    it('does not let inherited Object.prototype keys map as pattern names', () => {
      // 'constructor' is not a registered pattern type — it must pass
      // through raw, not resolve to Object.prototype.constructor.
      const result = mapFindings(['constructor'], patternMeta);
      expect(result.names).toEqual(['constructor']);
    });
  });

  describe('summarizeRedactions', () => {
    it('collects dotted paths of star-masked values', () => {
      const payload = JSON.stringify({
        customer: { ssn: '***-**-****', name: 'ok value' },
        card: '**** **** **** 1234',
      });
      const result = summarizeRedactions(payload);
      expect(result.count).toBe(2);
      expect(result.fields).toEqual(['customer.ssn', 'card']);
    });

    it('detects bracketed REDACTED markers (JWT / name redactions)', () => {
      const payload = JSON.stringify({ token: '[REDACTED JWT]', who: '[NAME_REDACTED]' });
      const result = summarizeRedactions(payload);
      expect(result.fields).toEqual(['token', 'who']);
    });

    it('walks arrays with indexed paths', () => {
      const payload = JSON.stringify({ rows: [{ dob: '****-**-**' }, { dob: '1999-01-01' }] });
      expect(summarizeRedactions(payload).fields).toEqual(['rows[0].dob']);
    });

    it('returns zero for clean payloads, non-JSON strings, and non-strings', () => {
      expect(summarizeRedactions(JSON.stringify({ a: 'clean', n: 5 }))).toEqual({ count: 0, fields: [] });
      expect(summarizeRedactions('not json {')).toEqual({ count: 0, fields: [] });
      expect(summarizeRedactions(undefined)).toEqual({ count: 0, fields: [] });
    });

    it('does not false-positive on a single asterisk', () => {
      expect(summarizeRedactions(JSON.stringify({ note: 'rated 5* by ops' })).count).toBe(0);
    });

    it('labels a bare masked string payload as (value)', () => {
      expect(summarizeRedactions(JSON.stringify('***-**-****')).fields).toEqual(['(value)']);
    });
  });
});
