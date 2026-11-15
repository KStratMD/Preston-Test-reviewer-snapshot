# Proof Card: Business Central Connector

**Status:** production_ready
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`BusinessCentralConnector` wires OData CRUD requests and requests OAuth2 client-credentials exchanges through AuthService against `https://login.microsoftonline.com`. Its separate `MetadataClient` parses and caches fixture XML. The production-mode metadata path currently checks base URL/company configuration and falls back to fixtures; it does not fetch live tenant metadata. Company discovery now rebuilds that client with the resolved company ID, as verified in the [authentication correction evidence](../2026-09-10-authentication-implementation.md#copilot-round-5-credential-redaction-and-raw-expiry).

## Source

- Implementation: `src/connectors/BusinessCentralConnector.ts`
- Entry point: `BaseConnector.authenticate()` delegates to `BusinessCentralConnector.performAuthentication()`.
- Metadata companion: `src/connectors/businessCentral/MetadataClient.ts` — `fetchFromAPI()` is a fixture fallback; `fetchMetadata()` parses/caches schemas.
- Dependencies:
  - `src/services/AuthService.ts` — fresh `authenticateOAuth2()` exchange with cache bypass
  - `initialize()` sets the current code's base URL to `https://api.businesscentral.dynamics.com/${apiVersion}/${tenantId}/${environment}`, with `apiVersion = 'v2.0'`.
  - `performAuthentication()` installs the bearer token and OData protocol headers, then discovers the company if omitted.

## Tests

- Unit: `tests/unit/__tests__/BusinessCentralConnector.test.ts` (39 passing tests)
- Authentication boundaries: `tests/unit/core/ConnectorAuthentication.oauthCache.test.ts` (35 passing tests across the shared OAuth connectors; includes Business Central company-discovery metadata configuration)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** — ordinary API requests use the configured Axios transport and authentication requests a token through AuthService. This wiring alone does not establish vendor acceptance.
- Demo/test behavior? The metadata client selects fixture mode with `isDemoMode() || isTestEnvironment()`; its production-mode path also currently falls back to fixtures. AuthService retains its explicit OAuth simulation policy.
- Evidence presented here is **fixture-only**. The static `statusEvidence` string is not a live credential test record.

## Known Gaps

- No live-credential evidence is on record: **no live evidence on record**. Governance, rate limiting, outbound DLP and authentication boundaries have fixture coverage, not live tenant acceptance evidence.
- Live metadata retrieval remains unimplemented. Fixture schemas cannot establish a particular tenant's entities, fields or schema changes.
- Metadata cache entries use a 24-hour TTL checked on access; the client exposes `clearCache()`. No live schema-change webhook or background refresh is wired by this connector.
- The unit tests stub HTTP responses and assert query shapes; a live OData service has not validated query-option encoding here.

## Verification (60-second AI-reviewer recipe)

```bash
npx jest --config=jest.fast.config.cjs --runInBand --runTestsByPath tests/unit/__tests__/BusinessCentralConnector.test.ts tests/unit/core/ConnectorAuthentication.oauthCache.test.ts
rg -n 'initializeMetadataClient|OData-MaxVersion|baseURL' src/connectors/BusinessCentralConnector.ts
rg -n 'fetchFromAPI|falling back to fixture|cacheTTLMs|clearCache' src/connectors/businessCentral/MetadataClient.ts
```

The tests exercise fixtures and controlled transports; the source search identifies metadata fallback and cache behavior. Neither step proves live authentication or tenant metadata retrieval.
