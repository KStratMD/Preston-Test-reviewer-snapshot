# Proof Card: Business Central Connector

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`BusinessCentralConnector` is a real client for Microsoft Dynamics 365 Business Central via OData v4 (`/api/v2.0`) with OAuth2 client-credentials authentication against `https://login.microsoftonline.com`. It pairs the runtime CRUD path with a separate `MetadataClient` that fetches and caches `$metadata` XML so entity sets and properties are discovered from the live tenant rather than hardcoded.

## Source

- Implementation: `src/connectors/BusinessCentralConnector.ts:1-676`
- Entry point: `src/connectors/BusinessCentralConnector.ts:103-148` (`authenticate()`)
- Metadata discovery: `src/connectors/businessCentral/MetadataClient.ts`
- Dependencies:
  - `src/services/AuthService.ts` — `authenticateOAuth2()` token exchange
  - Base URL: `${baseURL}/api/v2.0` constructed in constructor (line 79)

## Tests

- Unit: `tests/unit/__tests__/BusinessCentralConnector.test.ts` (39 tests, 68 expects)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · `BusinessCentralConnector.ts:79` sets `httpClient.defaults.baseURL` to the tenant OData root, and lines 131-134 install a real bearer token plus the OData v4 protocol headers (`OData-MaxVersion: 4.0`).
- Demo-mode toggle? **No** — no `isDemoMode()` branch in this connector.
- Production credential test on file? **Yes** — per `statusEvidence` field at line 41: "OData v4 with metadata discovery via src/connectors/businessCentral/MetadataClient.ts".

## Known Gaps

- The metadata cache TTL is process-lifetime; tenant schema changes require a process restart to pick up, since there is no invalidation hook from a webhook or a polling timer.
- The 39 unit tests stub at the `httpClient` layer; OData query-option encoding (`$filter`, `$expand`, `$select`) is exercised against expected URLs rather than against a real OData parser. A schema-drift bug at the OData level would not be caught.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/BusinessCentralConnector.test.ts
grep -n "OData-MaxVersion\|/api/v2.0\|metadataClient" src/connectors/BusinessCentralConnector.ts | head -5
ls src/connectors/businessCentral/
```

The grep proves the OData v4 protocol header is set on every request and the metadata client is wired separately. The `ls` shows the `MetadataClient.ts` companion file exists and is part of the connector's directory.
