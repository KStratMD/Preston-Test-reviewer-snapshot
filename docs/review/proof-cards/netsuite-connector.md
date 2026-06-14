# Proof Card: NetSuite Connector

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`NetSuiteConnector` is a real client for the NetSuite SuiteTalk REST Web Services API. It signs every request with OAuth 1.0a HMAC-SHA256 using the shared `oauth1Helper.ts` primitive (no library wrapper around fixtures), targets the live `*.suitetalk.api.netsuite.com` host, and has been exercised against sandbox account `TSTDRV2698307`. CRUD on records (`create`, `read`, `update`, `delete`) and SuiteQL search are all wired to the live REST API — there is no demo-mode fallback inside this connector.

## Source

- Implementation: `src/connectors/NetSuiteConnector.ts:14-440`
- Entry point: `src/connectors/NetSuiteConnector.ts:81-115` (`authenticate()`)
- Dependencies:
  - `src/utils/oauth1Helper.ts` — HMAC-SHA256 signature primitive (`crypto.createHmac` at line 90)
  - `src/services/AuthService.ts` — `authenticateOAuth1()` token exchange
  - Base URL is built dynamically from `accountId`: `https://${accountId}.suitetalk.api.netsuite.com` (line 75)

## Tests

- Unit: `tests/unit/__tests__/NetSuiteConnector.test.ts` (9 tests, 21 expects)
- Contract: `tests/unit/contract/NetSuiteConnector.contract.test.ts` (25 tests, 29 expects)
- Demo-mode toggle: `tests/unit/connectors/__tests__/NetSuiteConnectorDemoMode.test.ts`
- OAuth1 primitive: `tests/unit/utils/oauth1Helper.test.ts` (17 tests, 28 expects)
- Live CRUD: `tests/integration/netsuite.connector.live.crud.test.ts` (8 jest cases — testConnection+getSystemInfo, list, create, read, update, search, delete, read-after-delete — plus an afterAll tag-prefix cleanup sweep; credential-gated via `NETSUITE_LIVE_TESTS=1`)
- Smoke (2-case): `tests/integration/netsuite.connector.live.test.ts` (`testConnection`, `list customer`; same skip-guard)

## Live vs Fixture

- Real HTTP wired? **Yes** · `NetSuiteConnector.ts:77` (`this.httpClient.defaults.baseURL = this.baseUrl`) and `getAuthHeaders()` at line 369 producing OAuth1 Authorization headers signed via `oauth1Helper.getOAuth1AuthorizationHeader()`.
- Demo-mode toggle? **No** — the connector itself has no `isDemoMode()` branch. Demo-mode for NetSuite is provided by sibling fixture connectors (`SuiteCentralConnector`, `SquireConnector`) that extend `MockConnectorBase`.
- Production credential test on file? **Yes** — sandbox `TSTDRV2698307` per `statusEvidence` field at line 16.

## Known Gaps

- Live CRUD is exercised on demand via `npm run test:netsuite:live` or the `netsuite-live.yml` manual-dispatch workflow (which is also wired to a weekly cron at Monday 14:00 UTC so the proof-card claim doesn't go stale). Required env: `NETSUITE_LIVE_TESTS=1` + 5 `NETSUITE_*` secrets. **Behavior on missing creds differs by environment**: a local `npm run test:netsuite:live` collapses to `describe.skip` (clean exit, 0 failures) since the local runner has no opinion about whether the operator meant to run live; the GitHub workflow explicitly fails fast in its "Verify credential envs present" step before reaching Jest, so a misconfigured workflow surfaces as a red run instead of a misleading green-skip.
- No replay-cassette test (e.g. `nock` or `polly.js`) for the live HTTP path — the unit tests stub at the `httpClient` layer rather than the wire layer.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/NetSuiteConnector.test.ts
npm test -- tests/unit/utils/oauth1Helper.test.ts
grep -n "suitetalk.api.netsuite.com\|getOAuth1AuthorizationHeader" src/connectors/NetSuiteConnector.ts src/utils/oauth1Helper.ts
```

The grep proves NetSuite isn't a fixture wrapper: the base URL is the live SuiteTalk host, and every request goes through the OAuth1 signing primitive that lives in a separately-tested utility module.

For the live-credential proof itself (requires sandbox secrets):

```bash
NETSUITE_LIVE_TESTS=1 \
NETSUITE_ACCOUNT_ID=... NETSUITE_CONSUMER_KEY=... NETSUITE_CONSUMER_SECRET=... \
NETSUITE_TOKEN_ID=... NETSUITE_TOKEN_SECRET=... \
  npm run test:netsuite:live
```

Or trigger the credential-gated CI workflow: `gh workflow run netsuite-live.yml`.
