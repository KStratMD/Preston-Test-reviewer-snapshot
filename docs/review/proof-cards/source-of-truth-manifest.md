# Proof Card: Source-of-Truth Manifest

**Status:** production
**Last verified:** 2026-05-28

## Claim

`SOURCE_OF_TRUTH_MANIFEST` declares ownership for 11 canonical entities (`customer`, `contact`, `vendor`, `invoice`, `payment`, `payout_batch`, `product`, `inventory_level`, `sales_order`, `deal`, `ticket`) with explicit conflict-resolution policies. `OwnershipResolver` enforces these rules through `guardedWrite()`, including the `FlowExecutor` dispatch path before connector mutation. Non-owner writes either:

- short-circuit with a typed `FlowBlockedResult { status: 'blocked', reason: 'ownership', ownership: {...} }` (for `source_wins`, `reject_with_alert`, and `merge_field_level` block paths),
- enqueue encrypted write descriptors and throw `OwnershipPendingApprovalError(queueId)` for `queue_for_human`, or
- proceed with a field-filtered update for `merge_field_level` when the caller owns at least one exact field path and the callsite supplies `fieldLevelPayload`.

`OwnershipResolver.detectLoop` is wired against `LineageRepository.findReciprocalChainSeeds` and is invoked by `guardedWrite()` after ownership allow for `SourceSystem` callers, including the `FlowExecutor` unified write path. `OwnershipResumeHandler` also re-runs loop detection at approval-apply time for queued ownership writes.

CI gate `scripts/check-source-of-truth-coverage.mjs` hard-fails on manifest shape drift, registry-key mismatches, undeclared canonical entities used by flow templates, unimplemented conflict policies, `merge_field_level` entries without `fieldOverrides`, and `guardedWrite({...})` contexts that supply `fieldPaths` without sibling `fieldLevelPayload`.

## Source

- Manifest + types: `src/governance/sourceOfTruth/SourceOfTruthManifest.ts`
- Field-level payload helper: `src/governance/sourceOfTruth/fieldLevelPayload.ts`
- Conflict policy errors: `src/governance/sourceOfTruth/ConflictResolutionPolicy.ts`
- Resolver: `src/governance/sourceOfTruth/OwnershipResolver.ts`
- Lineage query (new): `src/services/lineage/LineageRepository.ts` (`findReciprocalChainSeeds`)
- Wrapper: `src/services/lineage/LineageQueryService.ts` (`findRecentReciprocalActivity`)
- Integration: `src/flows/templates/FlowExecutor.ts` (ownership pre-flight block)
- FlowResult shape: `src/flows/templates/FlowResult.ts` (`FlowBlockedResult` with `reason: 'ownership'`)
- CI gate: `scripts/check-source-of-truth-coverage.mjs`
- Gate regression: `tests/scripts/check-source-of-truth-coverage.test.sh`
- ADR: `docs/adr/ADR-020-source-of-truth-manifest.md`
- Architecture doc: `docs/architecture/source-of-truth-model.md`

## Tests

- Unit (manifest shape, 5 tests): `tests/unit/governance/sourceOfTruth/SourceOfTruthManifest.test.ts`
- Unit (resolver, 23 tests covering ownerFor + validateWrite + detectLoop): `tests/unit/governance/sourceOfTruth/OwnershipResolver.test.ts`
- Unit (field-level payload helper, 12 tests): `tests/unit/governance/sourceOfTruth/fieldLevelPayload.test.ts`
- Unit (lineage repo, 7 tests for `findReciprocalChainSeeds` including the same-record-mismatch negative): `tests/unit/services/lineage/LineageRepository.findReciprocalChainSeeds.test.ts`
- Compile-time type contract (5 tests, @ts-expect-error pattern): `tests/unit/flows/templates/FlowTemplate.typeContract.test.ts`
- FlowExecutor integration with ownership (3 tests, mandatory per Codex round 2: short-circuit + no side effects + FlowResult shape): `tests/unit/flows/templates/FlowExecutor.ownership.test.ts`
- CI gate regression (10 synthetic + 1 live-repo smoke): `tests/scripts/check-source-of-truth-coverage.test.sh`

## Live vs Fixture

- Real enforcement wired? **Yes** at the flow layer. `FlowExecutor.execute()` consults `OwnershipResolver` for every dispatch attempt; non-owner writes short-circuit without touching DLP, the approval queue, or the connector.
- Real lineage query wired? **Yes** — `detectLoop` queries the production `lineage_events` table via `LineageRepository.findReciprocalChainSeeds`. Tests exercise the query against an in-memory sqlite database using the same `migration` import the production code uses.
- Demo-mode toggle? **No** — the manifest is declarative TypeScript loaded at module init; no per-tenant or per-environment branching.
- Production credential test on file? **N/A** — the resolver consults in-process state and database lineage rows; there are no external credentials.

## Known Gaps

- **No production manifest entry currently declares `merge_field_level`.** Runtime support and CI allowlist are implemented, but Option A deliberately leaves production behavior unchanged until a follow-up chooses the first entity/callsite rollout and response semantics.

### PR 13b extension (closed gaps)

The four "lands in PR 13b" gaps listed in the PR 13 version of this card are now closed; see [proof card: guarded-write Ownership Enforcement](./guarded-write-ownership-enforcement.md) for the new wedge surface. Specifically:

- ✅ **Direct connector writes ARE now policy-gated.** `guardedWrite()` is the single chokepoint for every direct mutation; CI gate `scripts/check-guarded-writes.mjs` hard-fails on any unguarded mutating IConnector call. 29 callsites + the FlowExecutor unified write path migrated. The `CallerSystem` union (13 identities) is the new `callerSystem` channel — distinct from `SourceSystem` (8 connector identities) because `operator_action`, `webhook_relay`, `sync_error_remediation`, `integration_engine`, and `sync_orchestrator` can never be owners.
- ✅ **`queue_for_human` policy IS live.** `guardedWrite` enqueues encrypted write descriptors and throws `OwnershipPendingApprovalError(queueId)`; approval apply decrypts and dispatches via `OwnershipResumeHandler`.
- ✅ **HTTP 409/202 mapping for ownership errors IS now in place.** `approvalQueueErrorHandler` middleware maps `WriteBlockedError` subclasses, including `OwnershipFieldLevelMergeBlockedError`, to 409 with structured detail. The distinct `OwnershipPendingApprovalError` (NOT a `WriteBlockedError` — write is in progress, not blocked) maps to **202** with `{pendingApprovalId, pollUrl}`.
- ✅ **Ownership decisions ARE now persisted via `AuditService`.** `logGovernanceCheck` widened to carry `ownership.policy / .queueId / .loopBreakingCondition / .resumeFromQueue / .governanceOverride / .allowedFieldPaths / .blockedFieldPaths`. Decision + outcome + override + resume rows all persist to `audit_logs`.

The manifest itself grows from 9 → **11 canonical entities** in PR 13b: adds `deal` and `ticket` (HubSpot-owned, `source_wins` policy) to cover the HubSpot deals/tickets direct-write callsites. The PR 13 version of this card said "9 canonical entities"; the live count is now 11.
- **AGENTS.md "How to add canonical entity #N" walkthrough deferred.** Defer until the manifest stabilizes through pilot use; today's 11 entries (Copilot R17 on PR #851) are the wedge subset and may be revised based on technical-owner review during pilot kickoff.

## Verification

```bash
# 1. Manifest + resolver + lineage repo unit tests (28 tests)
npm test -- tests/unit/governance/sourceOfTruth/ tests/unit/services/lineage/LineageRepository.findReciprocalChainSeeds.test.ts

# 2. FlowExecutor ownership integration (3 tests)
npm test -- tests/unit/flows/templates/FlowExecutor.ownership.test.ts

# 3. CI gate regression net (10 synthetic + 1 live-repo smoke)
bash tests/scripts/check-source-of-truth-coverage.test.sh

# 4. Live CI gate
npm run audit-source-of-truth-coverage
```

Expected: every command exits 0; final command prints `[source-of-truth-coverage] PASS — 11 entities declared, 1 flow templates checked` (numbers track manifest + registry).
