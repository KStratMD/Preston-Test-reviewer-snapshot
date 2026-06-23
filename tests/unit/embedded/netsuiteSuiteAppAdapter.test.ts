import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { netsuiteSuiteAppAdapter } from '../../../src/embedded/adapters/netsuite-suiteapp.adapter';
import { assertEmbeddedPlatformAdapter } from '../../../src/embedded/adapters/EmbeddedPlatformAdapter';

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
    expect(suitelet).toContain("define(['N/https'");
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
