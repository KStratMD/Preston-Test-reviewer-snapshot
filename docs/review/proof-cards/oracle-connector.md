# Proof Card: Oracle Connector

**Status:** beta
**Last verified:** 2026-07-07 · git sha `af5796ad`

## Claim

`OracleConnector` is a real client for Oracle ORDS (Oracle REST Data Services) at `/ords/{schema}/` endpoints. The `IConnector` interface is fully satisfied with Basic-auth and API-key authentication paths, and CRUD against ORDS REST resources is wired. Status is intentionally **beta** — not **production** — because API depth is currently limited to basic CRUD (list/search/create/read/update/delete); webhook setup, transaction batching, and richer ORDS feature coverage (procedure invocation via `/ords/{schema}/{module}/{procedure}`) are not yet implemented.

## Source

- Implementation: `src/connectors/OracleConnector.ts:1-1021`
- Entry point: `src/connectors/OracleConnector.ts:430` (`authenticate()`)
- Demo-mode toggle: `src/connectors/OracleConnector.ts:122` (`if (isDemoMode())`) and `src/connectors/OracleConnector.ts:408` (`this.enableDemoMode()` when no credentials supplied)
- Outbound-DLP chokepoint (PR #958): `validateOutboundWrite` on all three write paths — create (line 565), update (line 616), delete (line 642) — placed BEFORE the demo-mode branch so demo writes are scanned too; the constructor throws if `OutboundGovernanceService` isn't injected. Enforced by the blocking CI gate `npm run audit-connector-outbound-governance` (per write method).
- Dependencies:
  - `src/services/AuthService.ts` — Basic + API-key authentication
  - `src/services/governance/OutboundGovernanceService.ts` — required constructor dependency (via `connectorRegistry.ts` factory)
  - Base URL: `${getDemoBaseUrl()}/ords/${schema}` in demo path; production base URL is built from supplied credentials

## Tests

- Unit: `tests/unit/__tests__/OracleConnector.test.ts` + `tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts` (62 tests combined, incl. the constructor governance-guard throw)
- Demo-mode: `tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts`
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets ORDS endpoints under `/ords/{schema}` and routes CRUD through real HTTP via `httpClient`. Authentication accepts Basic or API-key credentials at line 430.
- Demo-mode toggle? **Yes** · the connector has a demo path (line 122, line 408) that backs CRUD with an in-process store — present specifically because API depth is thin and the demo path is what dashboards exercise today.
- Production credential test on file? **No** — per `statusEvidence` field at line 88: "ORDS REST scaffolding present, API depth thin (basic CRUD only)".
- Outbound writes DLP-scanned? **Yes** (since PR #958) — create/update/delete all route through `validateOutboundWrite` before any HTTP or demo-store write.

## Known Gaps

- **API depth is the gating reason for `beta` rather than `production`.** Production-grade ORDS use cases need procedure invocation, batch transaction submission, and at-source error mapping for ORA-NNNNN codes — none of which are wired today.
- Promotion to `production` requires (a) widening the API surface beyond CRUD, AND (b) a credential test on file against a real Oracle ORDS instance.
- Throws on non-CRUD verbs (lines 573, 598, 622, 644, 702, 742, 796, 816 are the `throw new Error('Failed to ...')` sites — most surface upstream errors as-is rather than typed Oracle errors).

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/__tests__/OracleConnector.test.ts
grep -n "/ords/\|isDemoMode\|enableDemoMode" src/connectors/OracleConnector.ts | head -10
```

The grep proves the ORDS path prefix is real (multiple sites), and shows the demo-mode branch is gated explicitly — which is the structural reason this card carries `Status: beta` rather than `Status: production`.
