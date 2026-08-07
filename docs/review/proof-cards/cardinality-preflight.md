# Proof Card: Cardinality preflight and activation gate

**Status:** beta
**Last verified:** 2026-07-26 · git sha `f4a0bc4d26`

## Claim

The cardinality preflight surface analyzes a trusted mapping-plan projection and optional bounded samples before activation. The same coordinator is used by the editor preflight route and the authoritative configuration activation gate; blocking findings require a current durable audited override, while an inability to determine evidence fails closed as a service-unavailable outcome. Runtime fan-out, aggregation, and select-one resolutions are not advertised as executable in this delivery.

## Source

- Implementation: `src/services/cardinality/CardinalityAnalysisService.ts`, `src/services/cardinality/CardinalityPreflightService.ts`, `src/services/cardinality/sampleSafety.ts`
- Entry point: `POST /api/configurations/cardinality-preflight` in `src/routes/configuration.ts:259-309`; activation boundary in `src/services/ConfigurationService.ts`
- Dependencies: `src/services/cardinality/RelationshipEvidenceProvider.ts`, `src/services/ai/orchestrator/AuditService.ts`, `src/errors/CardinalityViolationError.ts`

## Tests

- Unit: `tests/unit/services/cardinality/` and `tests/unit/services/ConfigurationService.cardinalityGate.test.ts`
- Integration: `tests/integration/aiMappingCardinalityAdvisory.routes.test.ts`, `tests/integration/configurationTenantStatusGate.routes.test.ts`
- Browser: `tests/e2e/ai-field-mapping-editor.spec.ts` (blocking, warning, unavailable-evidence, sample-observed, and HTTP failure states)
- Coverage: not yet measured separately for this proof card

## Live vs Fixture

- Real HTTP wired? **Yes** · evidence: `src/routes/configuration.ts:259-309` registers the tenant-gated internal preflight endpoint; external ERP credentialed evidence is not claimed here.
- Demo-mode toggle? **Yes** · the editor can load fixture/sample data, but fixture mode never authorizes activation and the server gate remains authoritative.
- Production credential test on file? **No** · this beta delivery has no credentialed live ERP proof for the relationship-evidence providers.

## Known Gaps

- Runtime resolution capabilities remain disabled: no executable fan-out, separate-record, aggregate, or select-one strategy is advertised.
- NetSuite relationship evidence is limited to the trusted static catalog; Salesforce requires API metadata; Business Central and unsupported systems return unavailable evidence.
- Existing active configurations are grandfathered until their next active save; there is no retroactive bulk sweep.
- The editor presents preflight results but does not provide the activation override workflow; activation remains server-side and durable.
- Sample conclusions are bounded to submitted rows; samples and collision values are never persisted or rendered.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/services/cardinality tests/unit/services/ConfigurationService.cardinalityGate.test.ts
npm run typecheck
npm run audit-proof-cards
npm run audit-html-whitelist-sync
PLAYWRIGHT_SKIP=0 npx playwright test -c tests/e2e ai-field-mapping-editor.spec.ts --grep "cardinality preflight"
```

Review the endpoint and gate with:

```bash
rg -n "cardinality-preflight|runForPlan|saveConfiguration" src/routes/configuration.ts src/services/ConfigurationService.ts
```