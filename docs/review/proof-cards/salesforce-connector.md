# Proof Card: Salesforce Connector

**Status:** production_ready
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`SalesforceConnector` wires CRUD and query operations for the Salesforce REST API (`/services/data/v{N}`), using the resolved `instanceUrl` for data calls. Its authentication hook requests the OAuth2 password grant through AuthService and supplies username plus password/securityToken to that service. However, AuthService's current request builder sends `grant_type=password`, `client_id`, `client_secret` and scope to `${loginUrl}/services/oauth2/token` while omitting username/password from the wire payload. This is an incomplete live authentication flow; the fixture tests and HTTP wiring do not establish successful authentication to a live Salesforce org. The token endpoint defaults to `https://login.salesforce.com` unless a custom `loginUrl` is configured.

## Source

- Implementation: `src/connectors/SalesforceConnector.ts`
- Entry point: `BaseConnector.authenticate()` delegates to `SalesforceConnector.performAuthentication()`; see the [authentication implementation evidence](../2026-09-10-authentication-implementation.md).
- Dependencies:
  - `src/services/AuthService.ts` — `authenticateOAuth2()` token exchange
  - Base URL: `${instanceUrl}/services/data/${apiVersion}` (configured during initialization and updated after a returned instance URL)
  - Token endpoint: `${loginUrl}/services/oauth2/token` (requested by `performAuthentication`)

## Tests

- Unit: `tests/unit/__tests__/SalesforceConnector.test.ts` (38 passing tests)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** — Salesforce configures its instance URL and requests an OAuth2 exchange through AuthService. The password-grant payload omission below prevents treating this wiring as proof of a working live exchange.
- Demo-mode toggle? **Yes** — the connector retains its explicit demo fallback.
- Evidence presented here is **fixture-only**. The source's historical `statusEvidence` string is not a linked live credential test record.

## Known Gaps

- No live-credential evidence is on record: **no live evidence on record**. Existing fixture coverage demonstrates governance wiring, rate limiting and outbound DLP; it does not establish complete live authentication.

- AuthService's existing password-grant request builder drops `username` and `password` from the outgoing token parameters. A no-network characterization confirms the omission; correction requires a separate follow-up decision. See the [authentication implementation evidence](../2026-09-10-authentication-implementation.md#copilot-round-4-oauth2-cache-and-provider-boundaries).
- Connector authentication now bypasses AuthService's shared token/refresh cache and re-exchanges credentials on expiry or 401. Those boundaries are tested with real AuthService and mocked fetch; live vendor acceptance and refresh-token rotation remain unverified.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/SalesforceConnector.test.ts
grep -n "salesforce.com\|services/oauth2/token\|services/data\|grant_type" src/connectors/SalesforceConnector.ts | head -10
```

The grep shows intended endpoints and the password grant selection. String constants alone do not prove a complete token payload or live vendor acceptance.
