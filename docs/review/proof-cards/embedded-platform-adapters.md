# Proof Card: Embedded Platform Adapters

**Status:** production
**Last verified:** 2026-05-23

## Claim

The embedded SuiteCentral surface can be launched from NetSuite and Business Central platform shells without exposing the SuiteCentral embedded service token to browser JavaScript. Both platform adapters declare a `hostBootstrap.method = 'server_to_server'` descriptor and ship platform artifacts that call `/api/embedded/host-bootstrap` server-to-server (NetSuite via `N/https`, Business Central via AL `HttpClient`), rendering only the iframe URL returned in the bootstrap response.

## Source

- Descriptor contract: [`src/embedded/adapters/EmbeddedPlatformAdapter.ts`](../../../src/embedded/adapters/EmbeddedPlatformAdapter.ts)
- NetSuite adapter: [`src/embedded/adapters/netsuite-suiteapp.adapter.ts`](../../../src/embedded/adapters/netsuite-suiteapp.adapter.ts)
- NetSuite Suitelet artifact: [`platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js`](../../../platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js)
- NetSuite SuiteApp manifest: [`platform/netsuite-suiteapp/manifest.xml`](../../../platform/netsuite-suiteapp/manifest.xml)
- Business Central adapter: [`src/embedded/adapters/business-central-extension.adapter.ts`](../../../src/embedded/adapters/business-central-extension.adapter.ts)
- Business Central AL page extension: [`platform/business-central-extension/src/SuiteCentralEmbeddedHost.PageExt.al`](../../../platform/business-central-extension/src/SuiteCentralEmbeddedHost.PageExt.al)
- Business Central app manifest: [`platform/business-central-extension/app.json`](../../../platform/business-central-extension/app.json)
- Pairing gate: [`scripts/check-adapter-conformance.mjs`](../../../scripts/check-adapter-conformance.mjs)

## Tests

- Descriptor contract: [`tests/unit/embedded/EmbeddedPlatformAdapter.test.ts`](../../../tests/unit/embedded/EmbeddedPlatformAdapter.test.ts) — happy path + runtime assertion checks for invalid descriptors (bearer exposure, empty artifacts, empty modules)
- NetSuite adapter: [`tests/unit/embedded/netsuiteSuiteAppAdapter.test.ts`](../../../tests/unit/embedded/netsuiteSuiteAppAdapter.test.ts) — descriptor shape, artifact file existence, Suitelet source-text bearer-leak guards
- Business Central adapter: [`tests/unit/embedded/businessCentralExtensionAdapter.test.ts`](../../../tests/unit/embedded/businessCentralExtensionAdapter.test.ts) — descriptor shape, artifact file existence, AL source-text guards
- Conformance pairing: [`tests/playwright/embedded/adapter-conformance.spec.ts`](../../../tests/playwright/embedded/adapter-conformance.spec.ts)

## Live vs Fixture

- Real HTTP wired? Yes — NetSuite Suitelet uses `N/https`, Business Central AL page uses `HttpClient`. Both build a real POST against `/api/embedded/host-bootstrap` with the embedded service token in the `Authorization` header at the SERVER side.
- Demo-mode toggle? No production browser-bearer code path exists in either adapter artifact. The NetSuite Suitelet hard-throws on missing script parameters; the BC AL `GetSuiteCentralEmbeddedServiceToken()` placeholder hard-throws with an explicit "Configure before deployment" error.
- Production credential test on file? No. The first pilot deployment must record installation evidence and a real host-bootstrap trace through a configured tenant.

## Known Gaps

- The repo stores **source artifacts and descriptor-shape conformance tests**, not signed NetSuite SuiteApp packages or Microsoft AppSource publisher submissions. PR 10b proves the contract; a real platform install is pilot-stage work tracked by PR 15.
- The conformance tests in `tests/playwright/embedded/adapter-conformance.spec.ts` are **descriptor-shape assertions**, not runtime page tests. The original PR 10a placeholder listed four runtime scenarios (bootstrap handshake completes without browser-side bearer; session-expiring fast-forward triggers proactive refresh within 60s; frame-ancestors blocks parent origins outside the NetSuite/BC allowlist; module nav surfaces all `EmbeddedModule` enum members). PR 10b satisfies the descriptor + module-nav scenarios at the type level; the live-page scenarios require a mock-host harness and are deferred to a future runtime-conformance PR.
- Production deployment requires tenant-specific service tokens provisioned through PR 15's `provision-pilot-tenant.mjs`.

## Verification

```bash
npm test -- tests/unit/embedded/EmbeddedPlatformAdapter.test.ts tests/unit/embedded/netsuiteSuiteAppAdapter.test.ts tests/unit/embedded/businessCentralExtensionAdapter.test.ts
npm run check:adapter-conformance
grep -nE "browserBearerExposed: false|N/https|HttpClient" src/embedded/adapters/*.ts platform/netsuite-suiteapp/*.js platform/business-central-extension/src/*.al
```

Expected output: all 3 test suites green (the per-suite test count is not hardcoded here to avoid drift; see `Tests:` line in jest output), `[check-adapter-conformance] OK — 2 adapter(s) verified`, and at least one `browserBearerExposed: false` hit in each adapter file plus `N/https` in the Suitelet and `HttpClient` in the AL page extension.
