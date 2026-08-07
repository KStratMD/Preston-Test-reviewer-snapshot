/**
 * Findings display helpers — pure functions shared by the embedded
 * approvals UI (approvals.js).
 *
 * Two responsibilities, both presentation-only:
 *
 *   - mapFindings(findings, patterns): map raw `policyFindings` type keys
 *     (e.g. 'ssn', 'credit_card') to human display names using the pattern
 *     metadata from GET /api/compliance/dlp-patterns. The pattern list is
 *     NEVER hardcoded here (CLAUDE.md rule: counts/lists derive from
 *     DLPService via the endpoint); when the metadata is unavailable the
 *     raw finding strings pass through unchanged and no count suffix is
 *     produced.
 *
 *   - summarizeRedactions(redactedPayloadRaw): best-effort summary of which
 *     fields in the server-redacted payload carry masked values, so the
 *     operator sees "N fields masked: …" without expanding the payload
 *     <details>. HEURISTIC by design — DLPService redaction tokens are
 *     heterogeneous ('***-**-****', '**** **** **** 1234', '[REDACTED JWT]',
 *     '[NAME_REDACTED]', 'MRN: ******', …) so detection keys on runs of
 *     asterisks or [..REDACTED..] markers. Formats without either marker
 *     (the api_key 'abcd...wxyz' truncation) are not counted; the payload
 *     <details> below the summary always remains the source of truth.
 *
 * Served as an external script — `script-src 'self'` covers it, no inline
 * blocks, no CSP hash regen needed. The UMD-ish wrapper also exposes the
 * functions via module.exports so the jest unit test
 * (tests/unit/public/findings-display.test.ts) can require this file
 * directly.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FindingsDisplay = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * Map policy-finding type keys to display names.
   *
   * @param {string[]} findings raw finding type keys from the approval row
   * @param {{patterns: Array<{type: string, displayName: string}>, count: number}|null} patternMeta
   *        the `data` object from GET /api/compliance/dlp-patterns, or null
   *        when the fetch failed / hasn't completed.
   * @returns {{names: string[], matched: number, total: number|null}}
   *        names — display names (raw key passes through when unmapped),
   *        matched — number of distinct findings,
   *        total — registered pattern count, or null when metadata is
   *        unavailable (callers omit the "(2/14)" suffix in that case).
   */
  function mapFindings(findings, patternMeta) {
    var list = Array.isArray(findings) ? findings : [];
    // Null-prototype maps so finding keys like 'constructor' can't collide
    // with inherited Object.prototype members.
    var byType = Object.create(null);
    var total = null;
    if (patternMeta && Array.isArray(patternMeta.patterns)) {
      for (var i = 0; i < patternMeta.patterns.length; i++) {
        var p = patternMeta.patterns[i];
        if (p && typeof p.type === 'string' && typeof p.displayName === 'string') {
          byType[p.type] = p.displayName;
        }
      }
      total = typeof patternMeta.count === 'number'
        ? patternMeta.count
        : patternMeta.patterns.length;
    }
    var seen = Object.create(null);
    var names = [];
    for (var j = 0; j < list.length; j++) {
      var key = list[j];
      if (typeof key !== 'string' || seen[key]) continue;
      seen[key] = true;
      names.push(key in byType ? byType[key] : key);
    }
    return { names: names, matched: names.length, total: total };
  }

  // Masked-value heuristic: a run of 2+ asterisks (covers '***-**-****',
  // '**** **** **** 1234', 'MRN: ******', '+**-***-***-1234', …) OR a
  // bracketed REDACTED marker ('[REDACTED JWT]', '[NAME_REDACTED]').
  var MASKED_VALUE_REGEX = /\*{2,}|\[[^\]]*REDACTED[^\]]*\]/;

  function walk(value, path, fields) {
    if (typeof value === 'string') {
      if (MASKED_VALUE_REGEX.test(value)) {
        fields.push(path || '(value)');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        walk(value[i], path + '[' + i + ']', fields);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        walk(value[key], path ? path + '.' + key : key, fields);
      }
    }
  }

  /**
   * Summarize masked fields in a server-redacted payload.
   *
   * @param {string} redactedPayloadRaw the JSON-stringified redactedPayload
   *        column value as stored (approvals.js receives it verbatim).
   * @returns {{count: number, fields: string[]}} dotted paths of fields
   *        whose values look masked. `{count: 0, fields: []}` when nothing
   *        looks masked OR the payload isn't parseable JSON (the heuristic
   *        never blocks rendering the payload itself).
   */
  function summarizeRedactions(redactedPayloadRaw) {
    if (typeof redactedPayloadRaw !== 'string') {
      return { count: 0, fields: [] };
    }
    var parsed;
    try {
      parsed = JSON.parse(redactedPayloadRaw);
    } catch (e) {
      return { count: 0, fields: [] };
    }
    var fields = [];
    walk(parsed, '', fields);
    return { count: fields.length, fields: fields };
  }

  return {
    mapFindings: mapFindings,
    summarizeRedactions: summarizeRedactions
  };
});
