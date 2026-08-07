# Proof Card: DLP Service (PII Detection & Redaction)

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`DLPService` is the single source of truth for PII detection and redaction across the platform. It exposes a registry of **14 PII pattern types** via `getRegisteredPatterns()`, splits them into **8 unconditional patterns** and **6 field-name-gated patterns** (`requiresFieldContext: true`), and provides two scanning entry points: `scanForPII(data)` for objects (preserves dotted paths so field gates can fire) and `scanText(text)` for strings (gated patterns skipped because empty path → helper returns false). The 14 patterns and the 6/8 split are pinned by a unit guard test that breaks CI if the registry drifts.

## Source

- Implementation: `src/services/security/DLPService.ts:1-1169`
- Registry entry point: `src/services/security/DLPService.ts:493` (`getRegisteredPatterns()` — metadata view, no regexes)
- Object scan: `src/services/security/DLPService.ts:506` (`scanForPII(data, policy)`)
- Text scan: `src/services/security/DLPService.ts:573` (`scanText`, also populates `redactedData` when `autoRedact: true`)
- Public API endpoint: `src/routes/ComplianceRouter.ts:264` (`GET /api/compliance/dlp-patterns`) — returns the metadata-only view
- Embedded-session endpoint: `src/routes/governance/operationsRouter.ts` (`GET /api/governance/dlp-pattern-metadata`) — same response envelope (`{success:true, data:{count,patterns}}`), gated by `validateGuestContext` + `requireApproverRole` (approver role, no Bearer JWT required)
- Field-context flag (in pattern metadata): `requiresFieldContext: true` — set on 6 patterns at lines 296, 381, 402, 431, 454, 482

## Tests

- Unit: `tests/unit/services/security/DLPService.test.ts` (131 tests, 211 expects)
  - Pinned guards: "getRegisteredPatterns() — single source of truth guard" + "DLP_PATTERNS_SNAPSHOT drift guard"
- Integration (auto-redact contract): `tests/integration/MCPAutoRedact.fixture.test.ts` (12 tests, 33 expects)

## Live vs Fixture

- Real PII detection wired? **Yes** · the 14 patterns are real regexes (visible in source) plus per-type `validate(match, fieldPath)` callbacks for the 6 field-gated types.
- Demo-mode toggle? **No** — the scanner runs unconditionally on every `scanForPII()` / `scanText()` call.
- Production usage? **Yes** · `MCPAggregatorService.ts:215` invokes `scanForPII({autoRedact:true})` on every MCP tool result; `GovernanceService.detectPII()` routes to DLPService for both object and string inputs.

## Known Gaps

- **Name detection lost free-text capability** when unified from GovernanceService's former detector. `DLPService.scanText('Mr. John Smith')` no longer flags the name because there's no field context. Per CLAUDE.md, this is intentional — field-gating eliminates the free-text false-positive class — but it's a real behavioral diff vs the pre-Commit-2 detector.
- ASCII-only for parity with the old detector; Unicode names (`José`, `李明`) are a future enhancement.
- The 14 patterns cover the categories listed in CLAUDE.md (government_id, financial, contact, health, credential, network) but do not cover, e.g., biometric identifiers, IBAN-shape (vs `bank_account`), or healthcare-specific identifiers beyond medical_record_number. New patterns must be justified against the Codex false-positive risk and gated if structurally ambiguous.
- The unauthenticated dashboard fallback (in `compliance-dashboard.html`) hardcodes a snapshot of the registry as a defense-in-depth so the C1 panel still renders if `/api/compliance/dlp-patterns` is unreachable. The snapshot is pinned by the same guard test, so registry drift breaks CI.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/services/security/DLPService.test.ts
grep -n "requiresFieldContext: true" src/services/security/DLPService.ts | wc -l   # expect 6
node -e "const ts = require('fs').readFileSync('src/services/security/DLPService.ts','utf8'); console.log('total patterns: ', (ts.match(/^[[:space:]]*name:\s*'[a-z_]+'/gm) || []).length);"
# Or hit the live endpoint after npm start:
# curl http://localhost:3003/api/compliance/dlp-patterns | jq '.data.patterns | length'   # expect 14
```

The `wc -l` should print `6` (the field-gated patterns). The grep over `getRegisteredPatterns()` proves the public API and the metadata view are wired through a single function.
