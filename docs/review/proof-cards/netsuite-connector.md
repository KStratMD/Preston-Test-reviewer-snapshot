# Proof Card: NetSuite Connector

**Status:** production_ready
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`NetSuiteConnector` wires CRUD and SuiteQL requests to the NetSuite SuiteTalk REST API and signs each physical business dispatch with OAuth 1.0a HMAC-SHA256 using `oauth1Helper.ts`. The default host is `*.suitetalk.api.netsuite.com`; explicit base-URL overrides are supported. The static `statusEvidence` string asserts a historical sandbox exercise (`TSTDRV2698307`); this card does not verify that run. The current stamp covers source and fixture checks only.

## Source

- Implementation: `src/connectors/NetSuiteConnector.ts` (`class NetSuiteConnector`)
- Entry point: `BaseConnector.authenticate()` delegates to `NetSuiteConnector.performAuthentication()`; see the [authentication implementation evidence](../2026-09-10-authentication-implementation.md).
- Dependencies:
  - `src/utils/oauth1Helper.ts` — HMAC-SHA256 signature primitive (its `crypto.createHmac` call)
  - `src/services/AuthService.ts` — `authenticateOAuth1()` validates and returns supplied OAuth1 credentials
  - `initialize()` derives the base URL from `accountId` when no explicit `base_url`/`baseUrl` is supplied: `https://${dnsNormalizedAccountId}.suitetalk.api.netsuite.com`. The hostname lowercases the account ID and swaps underscores for hyphens (`1234567_SB1` → `1234567-sb1`); the stored account ID retains its original form for the OAuth1 realm.

## Tests

- Unit: `tests/unit/__tests__/NetSuiteConnector.test.ts` (14 passing tests)
- Contract: `tests/unit/contract/NetSuiteConnector.contract.test.ts` (39 passing tests)
- Demo-mode toggle: `tests/unit/connectors/__tests__/NetSuiteConnectorDemoMode.test.ts` (25 passing tests)
- OAuth1 primitive: `tests/unit/utils/oauth1Helper.test.ts` (17 passing tests)
- Live CRUD: `tests/integration/netsuite.connector.live.crud.test.ts` (8 jest cases — testConnection+getSystemInfo, list, create, read, update, search, delete, read-after-delete — plus an afterAll tag-prefix cleanup sweep; credential-gated via `NETSUITE_LIVE_TESTS=1`)
- Smoke (2-case): `tests/integration/netsuite.connector.live.test.ts` (`testConnection`, `list customer`; same skip-guard)

## Live vs Fixture

- Real HTTP wired? **Yes** · `NetSuiteConnector.ts` sets `this.httpClient.defaults.baseURL = this.baseUrl`, and its private `getAuthHeaders()` produces OAuth1 Authorization headers signed via `oauth1Helper.getOAuth1AuthorizationHeader()`.
- Demo-mode toggle? **No** — the connector itself has no `isDemoMode()` branch. Demo-mode for NetSuite is provided by sibling fixture connectors (`SuiteCentralConnector`, `SquireConnector`) that extend `MockConnectorBase`.
- Live credential test record verified here? **No** — no live CRUD run is on record, so this card is not live-verified. Partial live evidence does exist: on 2025-10-17, `scripts/test-netsuite-connection.ts` connected to Squire's NetSuite sandbox (`TSTDRV2698307`) and OAuth authentication, system-info retrieval and a customer list passed; customer search returned 405 because that endpoint is disabled in the sandbox ([release notes, Test Results](../../archive/root-historical/RELEASE-NOTES-2025-10-17.md#3-test-results-october-17-2025)). That establishes sandbox connectivity and reads, not CRUD, sandbox acceptance or production acceptance.

## Known Gaps

- No live-credential evidence is on record for CRUD: **no live evidence on record** of a live create, update or delete run, or of a production-tier credential test. Connectivity and reads do have live evidence: the 2025-10-17 sandbox connection recorded under Live vs Fixture. Source and fixture coverage do not establish live acceptance.

- A credential-gated live CRUD command (`npm run test:netsuite:live`) and `netsuite-live.yml` workflow exist; the workflow declares manual dispatch and a Monday 14:00 UTC cron. No run evidence is recorded on this card. Required env: `NETSUITE_LIVE_TESTS=1` plus five `NETSUITE_*` secrets. Missing credentials skip the local suite; the workflow checks credentials before Jest. These are configured capabilities, not evidence of a successful run.
- No replay-cassette test (e.g. `nock` or `polly.js`) for the live HTTP path — the unit tests stub at the `httpClient` layer rather than the wire layer.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/NetSuiteConnector.test.ts
npm test -- tests/unit/utils/oauth1Helper.test.ts
grep -n "suitetalk.api.netsuite.com\|getOAuth1AuthorizationHeader" src/connectors/NetSuiteConnector.ts src/utils/oauth1Helper.ts
```

The source search identifies the default host and signing primitive. The tests use fixtures and controlled transports; neither proves live vendor acceptance.

For the live-credential proof itself (requires sandbox secrets):

```bash
NETSUITE_LIVE_TESTS=1 \
NETSUITE_ACCOUNT_ID=... NETSUITE_CONSUMER_KEY=... NETSUITE_CONSUMER_SECRET=... \
NETSUITE_TOKEN_ID=... NETSUITE_TOKEN_SECRET=... \
  npm run test:netsuite:live
```

Or trigger the credential-gated CI workflow: `gh workflow run netsuite-live.yml`.
