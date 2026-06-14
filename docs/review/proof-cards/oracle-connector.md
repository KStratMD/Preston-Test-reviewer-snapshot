# Proof Card: Oracle Connector

**Status:** beta
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`OracleConnector` is a real client for Oracle ORDS (Oracle REST Data Services) at `/ords/{schema}/` endpoints. The `IConnector` interface is fully satisfied with Basic-auth and API-key authentication paths, and CRUD against ORDS REST resources is wired. Status is intentionally **beta** — not **production** — because API depth is currently limited to basic CRUD (list/search/create/read/update/delete); webhook setup, transaction batching, and richer ORDS feature coverage (procedure invocation via `/ords/{schema}/{module}/{procedure}`) are not yet implemented.

## Source

- Implementation: `src/connectors/OracleConnector.ts:1-1006`
- Entry point: `src/connectors/OracleConnector.ts:421-452` (`authenticate()`)
- Demo-mode toggle: `src/connectors/OracleConnector.ts:113` (`if (isDemoMode())`) and `src/connectors/OracleConnector.ts:399` (`this.enableDemoMode()` when no credentials supplied)
- Dependencies:
  - `src/services/AuthService.ts` — Basic + API-key authentication
  - Base URL: `${getDemoBaseUrl()}/ords/${schema}` in demo path (line 144); production base URL is built from supplied credentials

## Tests

- Unit: `tests/unit/__tests__/OracleConnector.test.ts` (24 tests, 40 expects)
- Demo-mode: `tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts`
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets ORDS endpoints under `/ords/{schema}` and routes CRUD through real HTTP via `httpClient`. Authentication accepts Basic or API-key credentials at line 421.
- Demo-mode toggle? **Yes** · the connector has a demo path (line 113, line 399) that backs CRUD with an in-process store — present specifically because API depth is thin and the demo path is what dashboards exercise today.
- Production credential test on file? **No** — per `statusEvidence` field at line 87: "ORDS REST scaffolding present, API depth thin (basic CRUD only)".

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
