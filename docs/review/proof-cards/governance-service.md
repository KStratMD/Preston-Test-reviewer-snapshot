# Proof Card: Governance Service

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`GovernanceService` is the policy layer that wraps DLP scanning into the platform's authorization, audit, and SOC 2 disclosure surface. After Commit 2 (PR #589), the service no longer maintains its own PII pattern Map — `detectPII()` routes by input shape to `DLPService.scanForPII(data)` (objects) or `DLPService.scanText(text)` (strings), so PII detection has a single registry. The SOC 2 mapping endpoint (`GET /api/compliance/soc2-mapping`) returns Trust Services Criteria coverage with a machine-readable scope disclosure stating that audit log events persist to `audit_logs` and that audit details are redacted or omitted before persistence.

## Source

- Implementation: `src/services/ai/orchestrator/GovernanceService.ts:1-923`
- DI binding: `src/inversify/inversify.config.ts:619` (`.to(GovernanceService).inSingletonScope()` — was a manual `toDynamicValue` factory before Commit 2)
- DLP injection: `src/services/ai/orchestrator/GovernanceService.ts:155` (`@inject(TYPES.DLPService)`)
- SOC 2 endpoint: `src/routes/ComplianceRouter.ts:187` (`GET /api/compliance/soc2-mapping`)
- Scope disclosure block: `src/routes/ComplianceRouter.ts:200-203`

## Tests

- Unit (Commit 2 unification): `tests/unit/services/ai/orchestrator/GovernanceService.commit2.test.ts` (16 tests, 39 expects)
- Compliance integration: `tests/integration/ComplianceRouter.integration.test.ts` (pins the `scopeDisclosure` block surfaces in the SOC 2 response)

## Live vs Fixture

- Real DLP routing wired? **Yes** · `detectPII()` delegates to `DLPService.scanForPII(data)` or `DLPService.scanText(text)` based on input shape (lines 187+). No private regex map.
- SOC 2 mapping endpoint live? **Yes** · `/api/compliance/soc2-mapping` returns Trust Services Criteria + the inline scope disclosure. The C1 confidentiality panel on `compliance-dashboard.html` also surfaces the caveat inline (was tooltip-only before Phase 3).
- Demo-mode toggle? **No** — there's no demo branch. Permission check (`hasCompliancePermission`) gates the endpoints.

## Known Gaps

- Some audit callers still use `SYSTEM_IDENTITY` until route-level tenant authentication is fully threaded. This affects attribution precision, not persistence durability.
- The placeholder `startIndex=0`/`endIndex=0` on adapter-built `PIIType[]` entries is never consumed on the normal path (`redactPIIFromData()` short-circuits to `redactedData`), but a future caller that bypasses the adapter could trip the placeholder. The 11-scenario fixture test guards against accidental exercise of the index-based path.
- Hallucination detection (a separate concern under processingIntegrity in the SOC 2 mapping) lives in this file but is out of scope for this card — covered by separate ReasoningTraceEngine evidence.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/services/ai/orchestrator/GovernanceService.commit2.test.ts
grep -n "scanForPII\|scanText\|@inject(TYPES.DLPService)" src/services/ai/orchestrator/GovernanceService.ts | head -10
grep -n "scopeDisclosure" src/routes/ComplianceRouter.ts
# Or hit the live endpoint after npm start:
# curl http://localhost:3003/api/compliance/soc2-mapping | jq '.data.scopeDisclosure'
```

The first grep proves the routing — both `scanForPII` and `scanText` are called, and DLPService is injected (no private pattern map). The second grep proves the SOC 2 honesty disclosure ships in the response (not just in docs).
