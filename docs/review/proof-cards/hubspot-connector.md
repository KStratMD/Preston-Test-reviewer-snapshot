# Proof Card: HubSpot Connector

**Status:** production_ready
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`HubSpotConnector` is a real client for HubSpot CRM v3 (`https://api.hubapi.com/crm/v3`) with bearer-token authentication. CRUD is wired against the four core CRM object types — contacts, companies, deals, tickets — using the live `/crm/v3/objects/{type}` REST endpoints.

## Source

- Implementation: `src/connectors/HubSpotConnector.ts`
- Entry point: `BaseConnector.authenticate()` delegates to `HubSpotConnector.performAuthentication()`; see the [authentication implementation evidence](../2026-09-10-authentication-implementation.md).
- Dependencies:
  - `src/core/BaseConnector.ts` — shared lifecycle and scoped `/objects/contacts` credential probe
  - Base URL: `https://api.hubapi.com/crm/v3` (set by `HubSpotConnector.initialize()`)

## Tests

- Contract: `tests/unit/contract/HubSpotConnector.contract.test.ts` (14 passing tests)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets `api.hubapi.com` and routes every CRUD call through the `/crm/v3/objects/{type}` path (visible in `create`/`read`/`update`/`delete` at lines 205-285).
- Demo-mode toggle? **No** — no `isDemoMode()` branch in this connector.
- Production credential test on file? **No live evidence on record**; source wiring and adapter fixtures do not prove vendor acceptance.

## Known Gaps

- No live-credential evidence is on record: **no live evidence on record**. Readiness checklist met: governance wiring, rate limiting, outbound DLP, unit and contract suites, docs.

- HubSpot's tier-based rate limits (10 req/sec on the free tier, higher on paid tiers) are not enforced inside the connector; rate-limit handling lives in the shared `BaseConnector` retry logic, not in HubSpot-specific code.
- Custom-object support (HubSpot allows tenant-defined object schemas) is not exercised — the connector hardcodes the four core object types in its capability set.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/contract/HubSpotConnector.contract.test.ts
grep -n "api.hubapi.com\|/crm/v3" src/connectors/HubSpotConnector.ts | head -5
```

The grep should show the `api.hubapi.com` host and the `/crm/v3` path prefix at multiple call sites.
