# ADR-020: Source-of-Truth Manifest with Flow-Layer Enforcement

**Status:** Accepted · **Date:** 2026-05-24 · **PR:** PR 13

## Context

The evaluation flagged that SuiteCentral's wedge claim — governed ERP-native operations layer — required declaring ownership for every canonical entity, with explicit conflict-resolution policy, before audit-grade A could be defended. Without this, two flows could silently overwrite each other's writes to the same record and the system's "opinionated governance" framing degrades to "another iPaaS."

The canonical PR-13 spec in `docs/plans/2026-05-01-a-grade-remediation-plan-merged.md` was written before PR 12 (record-level lineage) and PR 14 (narrow flow templates + executor) shipped. The current PR has visibility into both shipped surfaces.

## Decision

**1. Declaration-as-code, not runtime config.** The manifest lives in `src/governance/sourceOfTruth/SourceOfTruthManifest.ts` as typed TypeScript. CI-enforced; auditable via git blame; no drift surface from a per-tenant override admin UI. The same ownership rules apply across every tenant by design — they describe canonical system-of-record relationships, not customer preferences.

**2. Flow-layer enforcement, not connector-layer.** `OwnershipResolver.validateWrite()` is called from `FlowExecutor.execute()` as a pre-flight step before `OutboundGovernanceService.validateConnectorWrite()`. Connector-layer enforcement would require either:
   - Extending `IConnector.create/update/delete` to accept a context channel carrying `callerSystem` (a signature change touching every connector and every connector caller — out of scope), or
   - Threading `callerSystem` through an invisible thread-local / AsyncLocalStorage (anti-pattern — governance decisions become invisible state).

Both options grow the review surface far beyond what the wedge claim earns. Flow-layer enforcement covers every governed-flow write — which IS the wedge claim's scope. Direct connector writes (route handlers, sync jobs, `ConnectorManager` direct calls) are audited but not policy-gated this PR; they close in PR 13b.

**3. Three implemented policies, two deferred via CI hard-fail.** `source_wins`, `target_wins`, and `reject_with_alert` ship in this PR. `merge_field_level` and `queue_for_human` are declared in the `ConflictPolicy` enum so future PRs extend behavior without extending the type surface, but the CI gate hard-fails on any manifest entry using them. The resolver also throws `PolicyNotYetImplementedError` at runtime as defense-in-depth.

The "hard-fail not warn" choice closes [[feedback-symmetric-posture-flip-leak-class]]: extending the gate's behavior later is the loosening direction, which is the dangerous one. Failing-closed now means PR 13b's diff to land `merge_field_level` is: add the policy implementation, then remove the gate's failure for that policy value. Nothing silently flips.

**4. Narrow wedge-claim language.** Proof card, this ADR, and the Crosswalk row all say "ownership enforced on governed-flow writes" — not "every connector write consults OwnershipResolver." The narrower claim matches what the implementation actually delivers.

**5. New repository method for `detectLoop`, not reuse of `chainForRecord`.** The shipped `LineageRepository.findLatestChainForRecord` returns only the most-recent chain seeded at a given source — a false-negative hazard for loop detection if `targetSystem` read the record twice in the window. PR 13 adds `LineageRepository.findReciprocalChainSeeds`, which finds all chains in the window where both the reciprocal source_read AND target_write exist. The repository method addition is small but correctness-preserving.

## Alternatives considered

- **Connector-layer enforcement via IConnector signature change.** Rejected because the change radius is every connector (8 production) + every call site (routes, sync jobs, FlowExecutor) + every fixture connector in tests. The wedge claim already lands cleanly at the flow layer; the broader coverage is a PR 13b follow-up.
- **Thread-local callerSystem via AsyncLocalStorage.** Rejected — invisible state for governance decisions is the wrong abstraction. Any audit reviewer asking "where is callerSystem set?" wants to see the explicit pass, not chase a runtime context.
- **Per-tenant manifest via TenantConfigurationRepository.** Rejected — see Decision #1. Ownership is a property of the system-of-record relationships, not a customer preference.
- **Reuse `chainForRecord` for detectLoop.** Rejected — false-negative semantics; the spec analysis surfaced this during Codex round 3.

## Consequences

**Positive**
- Wedge claim "every governed-flow write consults declared ownership" is defensible with concrete files + CI gate + tests.
- CI gate prevents an undeclared entity or deferred-policy use from reaching main.
- New flows opt-in to ownership automatically — they have to declare `target.canonicalEntity` or the gate fails their PR.
- Loop detection has a real implementation against PR 12 lineage, not a stub.

**Negative**
- Direct connector writes are NOT enforced. Operator-facing route handlers and sync jobs that call `connector.create/update/delete` bypass ownership rules this PR. Documented residual risk in proof card + crosswalk row; closes in PR 13b.
- Two policy values (`merge_field_level`, `queue_for_human`) exist in the enum but cannot be used. Manifests must avoid them.
- The new `findReciprocalChainSeeds` method runs two queries (seed + matching writes) per `detectLoop` call. For high-frequency flows with declared `knownLoops`, this is two extra round-trips per write. Acceptable for the current pilot scale; consider a single CTE query if benchmark data later shows it matters.

## Open questions for PR 13b

- Should direct-connector-write enforcement extend `IConnector` signature, accept thread-local context, or rely on per-route handler resolution? Decide before PR 13b kickoff.
- Where does `queue_for_human` policy fit in the approval-queue's existing UI? Approvals from ownership violations may need a different review surface than DLP approvals.
- Should the manifest gain a per-entity `description` field for operator-facing context, or is that better surfaced from outside the manifest?
