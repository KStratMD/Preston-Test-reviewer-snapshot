# Evaluation Evidence

This page is the reviewer-facing index for claims that should be checked against code, not against historical wiki prose.

## Current Metrics

- DLP pattern registry: <!-- METRIC:dlp_patterns.count -->14<!-- /METRIC --> patterns, extracted from `src/services/security/DLPService.ts`.
- Connector status partition (Phase 3 honest scope labeling, audited by `npm run audit-status-claims`): <!-- METRIC:connectors.production -->5<!-- /METRIC --> production, <!-- METRIC:connectors.beta -->1<!-- /METRIC --> beta, <!-- METRIC:connectors.demo_only -->11<!-- /METRIC --> demo-mode, <!-- METRIC:connectors.stub -->1<!-- /METRIC --> stub, <!-- METRIC:connectors.unknown -->0<!-- /METRIC --> awaiting tags.
- Production TypeScript coverage scope LOC: <!-- METRIC:loc.production_ts -->178517<!-- /METRIC -->.
- Total TypeScript LOC: <!-- METRIC:loc.total_ts -->332837<!-- /METRIC -->.
- Total Markdown LOC: <!-- METRIC:loc.total_md -->205133<!-- /METRIC -->.

The authoritative machine-readable source is `metrics.json`. Update it with:

```bash
npm run metrics:generate
npm run metrics:sync-tokens
npm run verify-metrics
```

## Evidence Pointers

- NetSuite OAuth1 HMAC-SHA256 signing: `src/connectors/NetSuiteConnector.ts:371` and `src/utils/oauth1Helper.ts:59`.
- Salesforce OAuth2 token flow and authenticated API calls: `src/connectors/SalesforceConnector.ts:432`, `src/connectors/SalesforceConnector.ts:465`, `src/connectors/SalesforceConnector.ts:489`.
- Business Central OData v4 wiring: `src/connectors/BusinessCentralConnector.ts:74`, `src/connectors/BusinessCentralConnector.ts:111`, `src/connectors/BusinessCentralConnector.ts:127`.
- HubSpot CRM API wiring: `src/connectors/HubSpotConnector.ts:127`, `src/connectors/HubSpotConnector.ts:141`, `src/connectors/HubSpotConnector.ts:210`.
- ShipStation API wiring: `src/connectors/ShipStationConnector.ts:177`, `src/connectors/ShipStationConnector.ts:178`, `src/connectors/ShipStationConnector.ts:203`.
- AI provider HTTP calls: `src/services/ai/providers/OpenAIProvider.ts:284`, `src/services/ai/providers/ClaudeProvider.ts:301`, `src/services/ai/providers/OpenRouterProvider.ts:312`, `src/services/ai/providers/LMStudioProvider.ts:271`.
- MCP auto-redaction path: `src/services/mcp/MCPAggregatorService.ts:215`.
- DLP registry and redaction path: `src/services/security/DLPService.ts:181`, `src/services/security/DLPService.ts:506`, `src/services/security/DLPService.ts:526`.

## Proof Cards

Per-component evidence in a fixed schema (Status / Source / Tests / Live vs Fixture / Known Gaps / 60-second verification recipe). One short Markdown file per load-bearing component; a hostile reviewer can run the verification block from any card and reproduce the load-bearing claim. The schema is enforced by `npm run audit-proof-cards` (CI-gated).

**Production connectors:**
- [NetSuite Connector](docs/review/proof-cards/netsuite-connector.md) — OAuth1 HMAC-SHA256, sandbox `TSTDRV2698307` tested
- [Salesforce Connector](docs/review/proof-cards/salesforce-connector.md) — OAuth2 Resource Owner Password Credentials (`grant_type=password`), REST API
- [Business Central Connector](docs/review/proof-cards/business-central-connector.md) — OData v4 + metadata discovery
- [HubSpot Connector](docs/review/proof-cards/hubspot-connector.md) — CRM v3 (contacts, companies, deals, tickets)
- [ShipStation Connector](docs/review/proof-cards/shipstation-connector.md) — 3PL v2 API (orders, shipments, warehouses)

**Beta / stub:**
- [Oracle Connector](docs/review/proof-cards/oracle-connector.md) — `Status: beta`; ORDS REST scaffolding, API depth thin
- [PayQuicker Connector](docs/review/proof-cards/payquicker-connector.md) — `Status: stub`; explicit "not yet implemented" throw

**Service-level:**
- [AI Providers](docs/review/proof-cards/ai-providers.md) — OpenAI, Claude, OpenRouter, LMStudio + IntelligentProviderRouter
- [MCP Aggregator](docs/review/proof-cards/mcp-aggregator.md) — auto-redact path at `MCPAggregatorService.ts:215`
- [DLP Service](docs/review/proof-cards/dlp-service.md) — 14-pattern registry + 6/8 field-gating split
- [Governance Service](docs/review/proof-cards/governance-service.md) — Commit-2 unification + SOC 2 scope disclosure
- [OAuth1 Helper](docs/review/proof-cards/oauth1-helper.md) — HMAC-SHA256 signing primitive

Authoring template: `docs/review/proof-cards/_template.md`. To add a card: copy the template, fill in the sections, set the production connector's `static readonly proofCard = '...'` field on its class, and re-run `npm run audit-status-claims && npm run audit-proof-cards`.

## Known Gaps

The metrics system is now wired, but it is still honest about missing upstream evidence:

- Test pass/fail/skip counts are marked missing until Jest is run with `--json --outputFile=test-summary.json`.
- Coverage percentages are marked missing until `jest.ci.config.cjs` produces `coverage/coverage-summary.json`.
- Module count remains missing until Phase 8 adds `src/modules/registry.ts`.
