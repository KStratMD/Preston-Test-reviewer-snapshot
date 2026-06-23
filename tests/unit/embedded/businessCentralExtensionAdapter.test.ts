import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { businessCentralExtensionAdapter } from '../../../src/embedded/adapters/business-central-extension.adapter';
import { assertEmbeddedPlatformAdapter } from '../../../src/embedded/adapters/EmbeddedPlatformAdapter';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('businessCentralExtensionAdapter', () => {
  it('declares server-to-server HttpClient bootstrap and all embedded modules', () => {
    expect(businessCentralExtensionAdapter.platform).toBe('business_central');
    expect(businessCentralExtensionAdapter.hostBootstrap).toEqual({
      method: 'server_to_server',
      browserBearerExposed: false,
      platformApi: 'AL HttpClient',
    });
    expect(businessCentralExtensionAdapter.supportedModules).toEqual([
      'reconciliation',
      'lineage',
      'approvals',
      'sync_health',
      'compliance',
      'flow_templates',
      'sync_error_triage',
    ]);
    expect(() => assertEmbeddedPlatformAdapter(businessCentralExtensionAdapter)).not.toThrow();
  });

  it('ships extension artifacts referenced by the descriptor', () => {
    for (const artifactPath of businessCentralExtensionAdapter.artifactPaths) {
      expect(fs.existsSync(path.join(REPO_ROOT, artifactPath))).toBe(true);
    }
  });

  it('AL page extension declares server-to-server HttpClient and refuses ship without configured token, base URL, or environment id', () => {
    const pageExt = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/business-central-extension/src/SuiteCentralEmbeddedHost.PageExt.al'),
      'utf8',
    );
    expect(pageExt).toContain('Client: HttpClient');
    expect(pageExt).toContain('/api/embedded/host-bootstrap');
    // All three deployment-required values must fail loudly until configured —
    // base URL fails closed to prevent credential exfil if operator forgets it,
    // platformAccountId Error covers the BC environment id (validated against
    // service-token's platform_account_id at validateHostBootstrap), and the
    // service token Error covers the bearer secret.
    expect(pageExt).toContain("Error('Configure SuiteCentralBaseUrl before deployment')");
    expect(pageExt).toContain("Error('Configure SuiteCentralEmbeddedServiceToken before deployment')");
    expect(pageExt).toContain("Error('Configure SuiteCentralPlatformAccountId before deployment')");
    // platformAccountId is sourced from the configured getter, not CompanyName()
    expect(pageExt).toContain("GetSuiteCentralPlatformAccountId()");
    expect(pageExt).not.toMatch(/platformAccountId.*CompanyName\(\)/);
    // expectedHostOrigin is origin-only (matches server allowlist regex)
    expect(pageExt).toContain('GetCurrentHostOrigin()');
    // Body built via AL JsonObject, not string concat
    expect(pageExt).toContain('BodyObject: JsonObject');
    expect(pageExt).toContain('BodyObject.WriteTo');
    // embedSrc extracted from JSON response, not whole body passed to .Load()
    expect(pageExt).toContain("ResponseObject.Get('embedSrc'");
    expect(pageExt).toContain('CurrPage.SuiteCentralFrame.Load(BaseUrl + EmbedSrc)');
    // BaseUrl is normalized once before use so a trailing-slash configured value
    // doesn't produce double-slash request URIs or iframe URLs.
    expect(pageExt).toContain('NormalizeBaseUrl(GetSuiteCentralBaseUrl())');
    expect(pageExt).toContain('local procedure NormalizeBaseUrl');
    // NormalizeBaseUrl enforces https:// — a configured http:// value would
    // transmit the Authorization: Bearer <token> header over plaintext.
    expect(pageExt).toContain("not RawBaseUrl.StartsWith('https://') then");
    expect(pageExt).toContain('refusing to send bearer token over plaintext');
  });

  it('control add-in JS exposes Load via both top-level and window.SuiteCentralIframeControl namespaces', () => {
    const js = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/business-central-extension/Resources/SuiteCentralIframe.js'),
      'utf8',
    );
    expect(js).toMatch(/function Load\s*\(/);
    expect(js).toContain('window.Load = Load');
    expect(js).toContain('window.SuiteCentralIframeControl');
    expect(js).toContain('window.SuiteCentralIframeControl.Load = Load');
    // ControlAddInReady event is fired via the BC extensibility runtime
    expect(js).toContain("InvokeExtensibilityMethod(\"ControlAddInReady\", [])");
  });

  it('control add-in is defined so the page extension references resolve at compile time', () => {
    const controlAddIn = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/business-central-extension/src/SuiteCentralIframeControl.ControlAddIn.al'),
      'utf8',
    );
    expect(controlAddIn).toContain('controladdin SuiteCentralIframeControl');
    expect(controlAddIn).toContain('event ControlAddInReady()');
    expect(controlAddIn).toContain('procedure Load(EmbedSrcUrl: Text)');
    expect(controlAddIn).toContain("Scripts = 'Resources/SuiteCentralIframe.js'");
  });

  it('every requiredConfigKey in the descriptor has a matching placeholder Error() in the AL artifact', () => {
    // Drift guard: if a future edit adds/removes a deployment-required value
    // in either the descriptor or the AL, this test catches the mismatch.
    const pageExt = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/business-central-extension/src/SuiteCentralEmbeddedHost.PageExt.al'),
      'utf8',
    );
    for (const key of businessCentralExtensionAdapter.requiredConfigKeys) {
      expect(pageExt).toContain(`Error('Configure ${key} before deployment')`);
    }
    // Inverse direction: every placeholder Error in the AL must be declared
    // in requiredConfigKeys so operators reading the descriptor see the
    // complete list of values they must configure.
    const errorMatches = Array.from(
      pageExt.matchAll(/Error\('Configure (SuiteCentral\w+) before deployment'\)/g),
    ).map((m) => m[1]);
    expect(new Set(errorMatches)).toEqual(new Set(businessCentralExtensionAdapter.requiredConfigKeys));
  });

  it('app.json declares idRanges, dependencies, brief, description, and a runtime', () => {
    const appJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'platform/business-central-extension/app.json'), 'utf8'),
    );
    expect(appJson.brief).toEqual(expect.any(String));
    expect(appJson.description).toEqual(expect.any(String));
    expect(appJson.runtime).toBe('13.0');
    expect(Array.isArray(appJson.dependencies)).toBe(true);
    expect(Array.isArray(appJson.idRanges)).toBe(true);
    expect(appJson.idRanges.length).toBeGreaterThan(0);
    expect(appJson.idRanges[0]).toMatchObject({ from: expect.any(Number), to: expect.any(Number) });
  });
});
