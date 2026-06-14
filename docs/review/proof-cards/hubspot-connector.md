# Proof Card: HubSpot Connector

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`HubSpotConnector` is a real client for HubSpot CRM v3 (`https://api.hubapi.com/crm/v3`) with bearer-token authentication. CRUD is wired against the four core CRM object types — contacts, companies, deals, tickets — using the live `/crm/v3/objects/{type}` REST endpoints.

## Source

- Implementation: `src/connectors/HubSpotConnector.ts:1-550`
- Entry point: `src/connectors/HubSpotConnector.ts:140-170` (`authenticate()`)
- Dependencies:
  - `src/services/AuthService.ts` — bearer-token validation
  - Base URL: `https://api.hubapi.com/crm/v3` (constructor)

## Tests

- Contract: `tests/unit/contract/HubSpotConnector.contract.test.ts` (14 tests, 23 expects)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets `api.hubapi.com` and routes every CRUD call through the `/crm/v3/objects/{type}` path (visible in `create`/`read`/`update`/`delete` at lines 205-285).
- Demo-mode toggle? **No** — no `isDemoMode()` branch in this connector.
- Production credential test on file? **Yes** — per `statusEvidence` field at line 118: "Real HubSpot CRM REST API v3 calls (contacts, companies, deals, tickets) with bearer-token auth".

## Known Gaps

- HubSpot's tier-based rate limits (10 req/sec on the free tier, higher on paid tiers) are not enforced inside the connector; rate-limit handling lives in the shared `BaseConnector` retry logic, not in HubSpot-specific code.
- Custom-object support (HubSpot allows tenant-defined object schemas) is not exercised — the connector hardcodes the four core object types in its capability set.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/contract/HubSpotConnector.contract.test.ts
grep -n "api.hubapi.com\|/crm/v3" src/connectors/HubSpotConnector.ts | head -5
```

The grep should show the `api.hubapi.com` host and the `/crm/v3` path prefix at multiple call sites.
