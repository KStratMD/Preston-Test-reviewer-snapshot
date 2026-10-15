# Proof Card: Oracle Connector

**Status:** beta
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`OracleConnector` wires Basic-auth and API-key authentication and CRUD requests to configured Oracle ORDS (Oracle REST Data Services) endpoints under `/ords/{schema}/`. It also contains `/rest-handlers/` webhook scaffolding and an in-process demo path. Its declared status remains **beta**. The current source and fixture checks establish this wiring, not live ORDS compatibility or complete API coverage.

## Source

- Implementation: `src/connectors/OracleConnector.ts`
- Entry point: `BaseConnector.authenticate()` delegates to `OracleConnector.performAuthentication()`; see the [authentication implementation evidence](../2026-09-10-authentication-implementation.md).
- Demo-mode selection: `initialize()` calls `shouldUseDemoMode()`, which consults `isDemoEnvironment()` (`isDemoMode()` or `isTestEnvironment()`) and the supplied credentials. A matching demo case calls `enableDemoMode()`; the constructor checks the governance dependency.
- Outbound-DLP chokepoint: `create()`, `update()` and `delete()` call `validateOutboundWrite` before their demo-mode branches; the constructor requires `OutboundGovernanceService`. The gate `npm run audit-connector-outbound-governance` checks each write method.
- Dependencies:
  - `src/core/BaseConnector.ts` — shared lifecycle and scoped `/metadata-catalog/` probe; `performAuthentication()` constructs Basic or bearer headers locally
  - `src/services/governance/OutboundGovernanceService.ts` — required constructor dependency (via `connectorRegistry.ts` factory)
  - Base URL: `${getDemoBaseUrl()}/ords/${schema}` in demo path; production base URL is built from supplied credentials

## Tests

- Unit: `tests/unit/__tests__/OracleConnector.test.ts` + `tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts` (62 tests combined, incl. the constructor governance-guard throw)
- Demo-mode: `tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts`
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets ORDS endpoints under `/ords/{schema}` and routes CRUD through `httpClient`. `performAuthentication()` accepts Basic or API-key credentials. These are source-wiring claims, not live acceptance evidence.
- Demo-mode toggle? **Yes** · `enableDemoMode()` configures an in-process store for the CRUD demo branches.
- Production credential test verified here? **No** — the current stamp covers source and fixture checks only.
- Outbound writes DLP-scanned? **Yes** (since PR #958) — create/update/delete all route through `validateOutboundWrite` before any HTTP or demo-store write.

## Known Gaps

- The static status evidence describes limited API depth. No live ORDS acceptance is verified here, including for the `/rest-handlers/` webhook scaffolding. This card does not establish complete procedure or batch-transaction support.
- Any status promotion requires a separate readiness decision and supporting evidence; this source/fixture refresh does not change the beta classification.
- CRUD catch paths wrap failures in generic operation errors; this does not implement typed ORA-NNNNN mapping.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/OracleConnector.test.ts
grep -n "/ords/\|isDemoMode\|enableDemoMode" src/connectors/OracleConnector.ts | head -10
```

The source search identifies the configured ORDS paths and demo branches. It does not establish live credential acceptance or change the connector's declared beta status.
