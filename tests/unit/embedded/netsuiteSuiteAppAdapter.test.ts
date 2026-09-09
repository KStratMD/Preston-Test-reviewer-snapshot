import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { netsuiteSuiteAppAdapter } from '../../../src/embedded/adapters/netsuite-suiteapp.adapter';
import { assertEmbeddedPlatformAdapter } from '../../../src/embedded/adapters/EmbeddedPlatformAdapter';
import {
  ASSERTION_CONFORMANCE_VECTOR,
  EXPECTED_HEADER,
  EXPECTED_HMAC_HEX,
  EXPECTED_MATERIAL,
} from '../../../src/embedded/userAssertionVector';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('netsuiteSuiteAppAdapter', () => {
  it('declares server-to-server Suitelet bootstrap and all embedded modules', () => {
    expect(netsuiteSuiteAppAdapter.platform).toBe('netsuite');
    expect(netsuiteSuiteAppAdapter.hostBootstrap).toEqual({
      method: 'server_to_server',
      browserBearerExposed: false,
      platformApi: 'N/https',
    });
    expect(netsuiteSuiteAppAdapter.supportedModules).toEqual([
      'reconciliation',
      'lineage',
      'approvals',
      'sync_health',
      'compliance',
      'flow_templates',
      'sync_error_triage',
    ]);
    expect(() => assertEmbeddedPlatformAdapter(netsuiteSuiteAppAdapter)).not.toThrow();
  });

  it('ships SuiteApp artifacts referenced by the descriptor', () => {
    for (const artifactPath of netsuiteSuiteAppAdapter.artifactPaths) {
      expect(fs.existsSync(path.join(REPO_ROOT, artifactPath))).toBe(true);
    }
  });

  it('Suitelet source never exposes the bearer token to browser JavaScript', () => {
    const suitelet = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'),
      'utf8',
    );
    // The define list is multi-line now that the producer needs N/crypto and
    // N/encode, so assert the DEPENDENCIES rather than how the list is wrapped.
    expect(suitelet).toContain('define([');
    expect(suitelet).toContain("'N/https'");
    // Token is read from server-side script parameter, not from a window/request param
    expect(suitelet).toContain('custscript_sc_embedded_token');
    // Iframe src comes from the server-side response payload, not from a raw token
    expect(suitelet).toContain('payload.embedSrc');
    expect(suitelet).not.toMatch(/window\.\w*token/i);
    // baseUrl is normalized once at the top so neither the request URL nor the
    // iframe URL produces a double-slash when an operator configures a trailing slash.
    expect(suitelet).toContain('function normalizeBaseUrl(rawBaseUrl)');
    expect(suitelet).toContain('normalizeBaseUrl(getScriptParameter');
    // normalizeBaseUrl enforces https:// — a configured http:// value would
    // transmit the Authorization: Bearer <token> header over plaintext.
    expect(suitelet).toContain("rawBaseUrl.indexOf('https://') !== 0");
    expect(suitelet).toContain('refusing to send bearer token over plaintext');
    // The iframe URL no longer re-strips the trailing slash (it relies on the
    // single normalization at the top — drift guard catches accidental duplicate).
    expect(suitelet).not.toMatch(/absoluteSrc = baseUrl\.replace/);
    // accountIdToHostSegment normalizes '_' to '-' so NetSuite sandbox account
    // IDs (e.g. '1234567_SB1' → '1234567-sb1') yield a valid DNS hostname
    // matching window.origin in the browser.
    expect(suitelet).toContain('function accountIdToHostSegment(accountId)');
    expect(suitelet).toContain('accountIdToHostSegment(runtime.accountId)');
    expect(suitelet).toMatch(/replace\(\/_\/g,\s*['"]-['"]\)/);
    // JSON.parse is wrapped in try/catch so a non-JSON 200 response yields a
    // clearer error than a raw SyntaxError.
    expect(suitelet).toContain("'SuiteCentral host-bootstrap returned non-JSON response'");
    // iframe is sandboxed (defense-in-depth around embedded content) and
    // attribute set matches integrations/netsuite/SuiteLet_Embed.js.
    expect(suitelet).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"');
    expect(suitelet).toContain('loading="lazy"');
  });

  describe('user-assertion producer', () => {
    const suiteletSource = (): string =>
      fs.readFileSync(path.join(REPO_ROOT, 'platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'), 'utf8');

    /**
     * Extract a pure helper from the Suitelet and run it as plain JavaScript,
     * with no NetSuite runtime present.
     *
     * Sliced rather than matched with a regex: the pattern would need four
     * levels of backslash escaping to survive the source, and a subtly wrong
     * pattern here would silently extract the wrong function — the test would
     * still pass while verifying nothing. The helpers sit at two-space indent
     * inside the define() body, so the closing brace is the first `\n  }`.
     */
    function extract(name: string): (...args: unknown[]) => string {
      const src = suiteletSource();
      const start = src.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThan(-1);

      const end = src.indexOf('\n  }', start);
      expect(end).toBeGreaterThan(start);

      const fnSrc = src.slice(start, end + '\n  }'.length);
      // Prove the slice really is the whole function before executing it.
      expect(fnSrc).toContain(`function ${name}(`);
      expect(fnSrc.trimEnd().endsWith('}')).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function(`${fnSrc}; return ${name};`)() as (...a: unknown[]) => string;
    }

    it('builds the exact material SuiteCentral signs', () => {
      // This is the half of the producer that CAN be verified here. If the
      // field order or delimiter ever drifts from userAssertion.ts, every
      // assertion fails closed and looks identical to a wrong secret — so the
      // check belongs in CI, not in a runbook.
      const buildAssertionMaterial = extract('buildAssertionMaterial');
      const v = ASSERTION_CONFORMANCE_VECTOR;

      expect(
        buildAssertionMaterial(v.grantId, v.tenantId, v.platform, v.platformAccountId, v.userId, v.ts, v.nonce),
      ).toBe(EXPECTED_MATERIAL);
    });

    it('assembles the header and lowercases the digest', () => {
      const buildAssertionHeader = extract('buildAssertionHeader');
      const v = ASSERTION_CONFORMANCE_VECTOR;

      expect(buildAssertionHeader(v.grantId, v.ts, v.nonce, EXPECTED_HMAC_HEX)).toBe(EXPECTED_HEADER);
      // NetSuite's digest casing is not something this repository can observe,
      // so the producer normalises rather than trusting it: an uppercase hex
      // string would be a silent mismatch, not an error.
      expect(buildAssertionHeader(v.grantId, v.ts, v.nonce, EXPECTED_HMAC_HEX.toUpperCase())).toBe(EXPECTED_HEADER);
    });

    it('sends the user id unconditionally and the assertion header only when enrolled', () => {
      const src = suiteletSource();

      // userId travels on every bootstrap — it identifies who is looking, which
      // the guest UI may use, and confers nothing on its own.
      expect(src).toContain('userId: userId,');

      // The header is set INSIDE the enrolment branch. Setting it outside would
      // send an unsigned or stale assertion, which SuiteCentral answers 401 —
      // turning every un-enrolled user's bootstrap into a hard failure.
      const branch = src.indexOf('if (enrolment !== null) {');
      const headerAt = src.indexOf("headers['X-Squire-User-Assertion']");
      expect(branch).toBeGreaterThan(-1);
      expect(headerAt).toBeGreaterThan(branch);

      // Both halves of the enrolment are required: a grant id with no
      // credential cannot be signed for, and a credential with no grant id has
      // nothing to name.
      expect(src).toContain('if (!grantId || !grantGuid) return null;');
    });

    it('never renders the credential guid into the page', () => {
      const src = suiteletSource();

      // The plaintext secret is resolved inside N/crypto from the GUID and is
      // never materialised here. The GUID itself is not a secret, but it names
      // one, so it must not reach browser-visible output.
      //
      // Anchored on createForm, where page construction actually begins — the
      // define() list also mentions serverWidget, and slicing from there would
      // cover the whole file and make this assertion vacuous.
      const renderStart = src.indexOf('serverWidget.createForm');
      expect(renderStart).toBeGreaterThan(-1);
      expect(src.slice(renderStart)).not.toContain('grantGuid');

      // And it is used only to read the enrolment and to build the secret key.
      expect(src.slice(0, renderStart)).toContain('guid: enrolment.grantGuid,');
    });
  });

  it('accountIdToHostSegment normalizes sandbox underscores so the URL is DNS-valid', () => {
    // Re-execute the script in a sandbox to verify the helper logic without
    // pulling the whole NetSuite runtime. We test the function definition by
    // sourcing the relevant fragment.
    const suitelet = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'),
      'utf8',
    );
    // Find the function body and exec it as plain JS (no NetSuite dependencies).
    const match = suitelet.match(/function accountIdToHostSegment\(accountId\) \{[\s\S]*?\n\s{2}\}/);
    expect(match).not.toBeNull();
    const fnSrc = match![0];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(fnSrc + '; return accountIdToHostSegment;')() as (a: string) => string;
    expect(fn('1234567')).toBe('1234567');
    expect(fn('1234567_SB1')).toBe('1234567-sb1');
    expect(fn('TSTDRV2698307')).toBe('tstdrv2698307');
    expect(fn('ACME_SB_2')).toBe('acme-sb-2');
  });
});
