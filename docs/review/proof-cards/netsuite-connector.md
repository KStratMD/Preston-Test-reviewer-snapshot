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
- Integration: `none — credential-gated; sandbox testing performed manually`

## Live vs Fixture

- Real HTTP wired? **Yes** · `NetSuiteConnector.ts:77` (`this.httpClient.defaults.baseURL = this.baseUrl`) and `getAuthHeaders()` at line 369 producing OAuth1 Authorization headers signed via `oauth1Helper.getOAuth1AuthorizationHeader()`.
- Demo-mode toggle? **No** — the connector itself has no `isDemoMode()` branch. Demo-mode for NetSuite is provided by sibling fixture connectors (`SuiteCentralConnector`, `SquireConnector`) that extend `MockConnectorBase`.
- Production credential test on file? **Yes** — sandbox `TSTDRV2698307` per `statusEvidence` field at line 16.

## Known Gaps

- The `TSTDRV2698307` sandbox test record is operator-attested in `statusEvidence`, not pinned by an automated CI job. A reviewer who wants a stronger guarantee should check whether `HAS_NETSUITE_CREDENTIALS=1` is set in any CI workflow (currently it is not — credential-gated tests are run locally on demand).
- No replay-cassette test (e.g. `nock` or `polly.js`) for the live HTTP path — the unit tests stub at the `httpClient` layer rather than the wire layer.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/NetSuiteConnector.test.ts
npm test -- tests/unit/utils/oauth1Helper.test.ts
grep -n "suitetalk.api.netsuite.com\|getOAuth1AuthorizationHeader" src/connectors/NetSuiteConnector.ts src/utils/oauth1Helper.ts
```

The grep proves NetSuite isn't a fixture wrapper: the base URL is the live SuiteTalk host, and every request goes through the OAuth1 signing primitive that lives in a separately-tested utility module.
