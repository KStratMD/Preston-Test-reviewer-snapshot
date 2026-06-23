# Reviewer Guide

Use this guide to verify the project from source. Start with quick checks, then inspect the evidence files.

## Quick Check

```bash
npm ci
bash scripts/bootstrap-review-tools.sh   # installs cloc + gitleaks + trufflehog (required by verify-metrics)
npm run typecheck
npm run check:any-budget
npm run check:strict-null-budget
npm run verify-metrics
```

`verify-metrics` regenerates `metrics.json` into a tmpdir and compares it
against the committed file. Regeneration shells out to `cloc`, so the
bootstrap step above is required on a fresh machine. Skip the bootstrap
only if the three tools are already present on `PATH`.

## Metrics

`metrics.json` is generated from source and local build artifacts. It currently reports:

- DLP patterns: <!-- METRIC:dlp_patterns.count -->14<!-- /METRIC -->
- Connector partition: <!-- METRIC:connectors.production -->5<!-- /METRIC --> production, <!-- METRIC:connectors.beta -->1<!-- /METRIC --> beta, <!-- METRIC:connectors.demo_only -->11<!-- /METRIC --> demo-mode, <!-- METRIC:connectors.stub -->1<!-- /METRIC --> stub (verify with `npm run audit-status-claims`)
- Production TypeScript coverage scope LOC: <!-- METRIC:loc.production_ts -->191561<!-- /METRIC -->
- Total Markdown LOC: <!-- METRIC:loc.total_md -->233857<!-- /METRIC -->

Regenerate and validate:

```bash
npm run metrics:generate
npm run metrics:sync-tokens
npm run verify-metrics
```

Coverage interpretation note:

- `COVERAGE.md` explains how to read blended repo coverage versus safety-surface coverage, with a named per-file branch table for governance chokepoints.

## Source Evidence

High-signal files to inspect first:

- `src/connectors/NetSuiteConnector.ts`
- `src/connectors/SalesforceConnector.ts`
- `src/connectors/BusinessCentralConnector.ts`
- `src/connectors/HubSpotConnector.ts`
- `src/connectors/ShipStationConnector.ts`
- `src/services/ai/providers/OpenAIProvider.ts`
- `src/services/ai/providers/ClaudeProvider.ts`
- `src/services/ai/providers/OpenRouterProvider.ts`
- `src/services/ai/providers/LMStudioProvider.ts`
- `src/services/mcp/MCPAggregatorService.ts`
- `src/services/security/DLPService.ts`
- `src/utils/oauth1Helper.ts`

## Proof Cards

Each load-bearing component has a one-page proof card under `docs/review/proof-cards/` with a fixed schema (Status / Source / Tests / Live vs Fixture / Known Gaps / 60-second verification recipe). The audit script `npm run audit-proof-cards` (CI-gated) verifies every connector's `static readonly proofCard` path resolves to a Markdown file with the required sections, and that the card's `Status:` value matches the source-level `productionStatus`.

**Production connectors:** [NetSuite](docs/review/proof-cards/netsuite-connector.md) · [Salesforce](docs/review/proof-cards/salesforce-connector.md) · [Business Central](docs/review/proof-cards/business-central-connector.md) · [HubSpot](docs/review/proof-cards/hubspot-connector.md) · [ShipStation](docs/review/proof-cards/shipstation-connector.md)

**Beta / stub:** [Oracle (beta)](docs/review/proof-cards/oracle-connector.md) · [PayQuicker (stub)](docs/review/proof-cards/payquicker-connector.md)

**Service-level (18):** [AI Providers](docs/review/proof-cards/ai-providers.md) · [Audit Service](docs/review/proof-cards/audit-service.md) · [Cost Transparency](docs/review/proof-cards/cost-transparency.md) · [DLP Service](docs/review/proof-cards/dlp-service.md) · [Embedded Platform Adapters](docs/review/proof-cards/embedded-platform-adapters.md) · [Ephemeral Payload Retention](docs/review/proof-cards/ephemeral-payload-retention.md) · [Finance Central Operator](docs/review/proof-cards/finance-central-operator.md) · [Flow Templates](docs/review/proof-cards/flow-templates.md) · [Governance Service](docs/review/proof-cards/governance-service.md) · [Guarded-Write Ownership](docs/review/proof-cards/guarded-write-ownership-enforcement.md) · [MCP Aggregator](docs/review/proof-cards/mcp-aggregator.md) · [OAuth1 Helper](docs/review/proof-cards/oauth1-helper.md) · [Reconciliation Center](docs/review/proof-cards/reconciliation-center.md) · [Record Lineage](docs/review/proof-cards/record-lineage.md) · [Source-of-Truth Manifest](docs/review/proof-cards/source-of-truth-manifest.md) · [Strategic Positioning](docs/review/proof-cards/strategic-positioning.md) · [Sync Error Assist](docs/review/proof-cards/sync-error-assist.md) · [Workflow Central Operator](docs/review/proof-cards/workflow-central-operator.md)

Run the per-card verification block to reproduce its load-bearing claim from a fresh clone in under a minute. Run all cards with:

```bash
npm run audit-status-claims
npm run audit-proof-cards
```

## Full Verification

```bash
npm test
npm run test:integration
npm run test:coverage:ci -- --json --outputFile=test-summary.json
npm run metrics:generate
npm run metrics:sync-tokens
npm run verify-metrics
```

The coverage command may take materially longer than the quick check. It is the path that populates both Jest summary counts and `coverage/coverage-summary.json`.

## Reviewer Command Card

A single block that reproduces every load-bearing claim from a fresh clone. Static checks (~60 seconds, no server needed) plus a live-endpoint probe (~30 seconds, boots a demo server in the background).

```bash
# Static verification — no server required (~60 seconds)
npm ci                              # lockfile-faithful install
npm test                            # unit suite
npm run typecheck                   # zero errors
npm run check:any-budget            # current ≤ cap
npm run check:strict-null-budget    # current == cap (monotonic)
npm run test:coverage:core          # load-bearing files; restamp on improvement
npm run audit-status-claims
npm run audit-proof-cards

# Live verification — boots demo server in the background (~30 seconds)
npm run demo:start-detached
npm run demo:wait
curl -s http://localhost:3000/api/metrics/review | jq '{schema_version, build_sha, proof_cards: (.proof_cards | length)}'
curl -sI http://localhost:3000/api/metrics | head -n 3   # Prometheus exposition
npm run demo:stop-detached
```

The `/api/metrics/review` JSON payload is the AI-reviewer evidence surface: it returns `metrics.json` content plus a build SHA, the proof-card index with each card's `Status:` value, and pointers to `EVALUATION.md` and `/api/compliance/dlp-patterns`. Cached for 60 seconds in-process so repeated calls do not spam the disk read or directory walk.
