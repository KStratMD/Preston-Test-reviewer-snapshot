# Proof Card: Salesforce Connector

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`SalesforceConnector` is a real client for the Salesforce REST API (`/services/data/v{N}`). It authenticates via the OAuth2 **Resource Owner Password Credentials grant** — also known as the username-password flow — by POSTing `grant_type=password` along with `client_id`/`client_secret`/`username`/`password+securityToken` to `${loginUrl}/services/oauth2/token` (`SalesforceConnector.ts:469-475`). It targets `https://login.salesforce.com` (or a custom `loginUrl`) for token exchange and the resolved `instanceUrl` for data calls. The connector implements full CRUD plus query operations against live Salesforce orgs.

## Source

- Implementation: `src/connectors/SalesforceConnector.ts:1-991`
- Entry point: `src/connectors/SalesforceConnector.ts:448-507` (`authenticate()`)
- Dependencies:
  - `src/services/AuthService.ts` — `authenticateOAuth2()` token exchange
  - Base URL: `${instanceUrl}/services/data/${apiVersion}` (line 439)
  - Token endpoint: `${loginUrl}/services/oauth2/token` (line 469)

## Tests

- Unit: `tests/unit/__tests__/SalesforceConnector.test.ts` (17 tests, 25 expects)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · `SalesforceConnector.ts:439-440` sets `httpClient.defaults.baseURL` to the resolved Salesforce instance URL; `authenticate()` POSTs to `${loginUrl}/services/oauth2/token` at line 469.
- Demo-mode toggle? **Yes** · `SalesforceConnector.ts:422` (`if (this.shouldUseDemoMode(config)) { this.enableDemoMode(...); }`) — but unlike the demo-only connectors, Salesforce has a production credential test on file separate from the fallback path.
- Production credential test on file? **Yes** — per `statusEvidence` field at line 94: "OAuth2 Resource Owner Password Credentials grant (grant_type=password) against real Salesforce REST API".

## Known Gaps

- The demo-mode fallback at `SalesforceConnector.ts:422` is the same pattern used by the demo-only connectors (Adyen, Stripe, etc.). The distinction "production vs demo_only" rests on the operator-attested production credential test, not on the source-level presence/absence of demo mode.
- Refresh-token rotation is not exercised by unit tests — the username-password grant produces short-lived tokens; long-running deployments would need a re-auth path that's currently only loosely tested.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/SalesforceConnector.test.ts
grep -n "salesforce.com\|services/oauth2/token\|services/data\|grant_type" src/connectors/SalesforceConnector.ts | head -10
```

The grep should show the Salesforce login host, the OAuth2 token endpoint path, the REST API version path, and `grant_type: 'password'` (line 470) — the four load-bearing string constants that pin both the wire format AND the specific OAuth2 flow (Resource Owner Password Credentials, not client_credentials).
