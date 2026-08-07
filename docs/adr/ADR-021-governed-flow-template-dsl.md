# ADR-021 — Governed Flow Template DSL

**Status:** Accepted (2026-05-20, narrow scope shipped via PR 14).
**Decision drivers:** completing the HITL bundle's wedge claim end-to-end (route layer + connector layer + flow layer all honour the governance pipeline); avoiding the iPaaS framing ("we ship connectors, you assemble integrations"); keeping the executor's surface minimal enough that PR 14b can add Lineage + Ownership + bulk dispatch without churning the contract.

## Context

The HITL approval-queue bundle (PR 3A schema + PR 3B route catches + resume worker + PR 3C operator API + UI) closed the governance loop for **route-driven** and **connector-driven** writes. The remaining gap was **flow-driven** writes — integrations composed as a "transform an inbound event into an outbound write" sequence, where the orchestration is owned by Preston rather than the client's ERP.

The merged remediation plan (`docs/plans/2026-05-01-a-grade-remediation-plan-merged.md` §PR 14) specifies a full "Prebuilt Governed Flow Templates" surface — a declarative DSL (`FlowTemplate`), a runtime (`FlowExecutor.execute()` + `executeBulk()`), three sample templates (OTC, PTP, Payouts), and three CI gates (instrumentation, bulk-compensation, decision-provenance). That spec has hard dependencies on PR 12 (`LineageRecorder` + `record_lineage` table) and PR 13 (`OwnershipResolver` + `SOURCE_OF_TRUTH_MANIFEST`), neither of which is on `main` today.

We need the governance-completing portion of PR 14 to land BEFORE the Lineage / Ownership surfaces — without breaking the broader spec.

## Decision

Ship **PR 14 narrowed** — a minimal `FlowTemplate` + `FlowExecutor` slice that:

1. **Owns one canonical execution path.** `FlowExecutor.execute(template, event, ctx)` walks every template through `transform → validate → governance scan → dispatch`. Templates carry data only — no orchestration code in user space.

2. **Honours the governance pipeline end-to-end.**
   - `OutboundGovernanceService.validateConnectorWrite(...)` runs the DLP scan inside the executor BEFORE the connector call.
   - `decision.approvalRequired` ⇒ `ApprovalQueueService.enqueue(...)` ⇒ `FlowResult{status: 'pending_approval', approvalId, pollUrl}`.
   - `!decision.approved` ⇒ `FlowResult{status: 'blocked', reason: 'governance'}`.
   - Approved ⇒ dispatch the `decision.redactedPayload` (fall back to raw record if no redaction was needed).
   - The enqueue contract mirrors the route-layer's `handleApprovalQueueError` helper — same `ApprovalQueueService.enqueue` args (`tenantId`, `requesterUserId`, `operationType: 'connector_write'`, `resourceType`, `resourceId`, `decision`). Route + flow paths converge on a single queue contract.

3. **Single-row dispatch only.** `target.operation ∈ {create, update, delete}` in the narrow scope; `bulk_upsert` is rejected by the CI gate until PR 14b lands the per-row scan loop + the connector's `bulkRollbackStrategy`-driven rollback path.

4. **No Lineage / Ownership coupling yet.** `FlowContext` carries `{tenantId, userId, correlationId, connector}` only. The merged-plan's `lineageRecorder` and `ownershipResolver` fields are deferred to PR 14b's context extension once PR 12 + PR 13 surfaces exist. Today's audit trail is the OutboundGovernanceService's `auditMetadata`.

5. **Caller owns connector resolution + initialization.** `FlowContext.connector` carries a pre-initialized `IConnector` instance — the route handler / orchestrator invoking `execute()` resolves it via `ConnectorManager.getConnector(systemType, configId)` and calls `connector.initialize(authConfig)` first. FlowExecutor verifies `connector.systemType.toLowerCase() === template.target.system.toLowerCase()` at the top of `execute()` and rejects with `{status: 'failed'}` on mismatch (Codex 5.5 HIGH on PR #825). The case-insensitive comparison bridges a real-world asymmetry: connector classes set display-case `systemType` (`'NetSuite'`, `'HubSpot'`, `'BusinessCentral'`) via `super('NetSuite', ...)` in their constructor, while the canonical registry keys (and the template authoring convention) are lowercase (`'netsuite'`, `'hubspot'`, `'businesscentral'`). Templates SHOULD declare `target.system` in lowercase registry-key form, but the executor accepts either case so the safety net survives a typo on either side. This shape avoids two failure modes the prior "executor resolves the connector" design admitted: (a) silent dispatch via an uninitialized connector that fails at first HTTP call, and (b) wrong connector for a template (HubSpot connector against NetSuite-targeted template). The merged plan's `ConnectorRegistry` abstraction in FlowContext — which would resolve + initialize as part of injection — is the natural PR 14b extension.

   **5a. Update + delete dispatches use pre-captured target ids, not redacted-payload ids** (Codex 5.5 HIGH follow-up landed in this PR). `execute()` captures `originalUpdateId = readId(record)` BEFORE the governance scan (analogous to `preResolvedDeleteId` for delete), and the dispatch step passes that value as the LOOKUP arg to `connector.update`/`.delete` even when the DLP scan rewrites the `id` field inside the redacted body. The update dispatch path additionally ALWAYS returns `originalUpdateId` from the executor (the connector's `update` response is dropped) — a connector that echoes the request body's `id` would otherwise hand back the MASKED id, propagating the redaction placeholder as `FlowResult.targetRecordId` and breaking downstream chaining on the canonical id (Copilot R10 on PR #827 caught this connector-echo bug class). The pre-fix contract read the lookup id from `decision.redactedPayload ?? record`, which would have sent a MASKED id (e.g. `'[REDACTED]'`) to the connector whenever low/medium PII was approved-with-redaction AND the record's `id` field happened to be PII-shaped (email, phone, name-like external id) — either missing the target row or, worse, hitting an unrelated row that happened to collide with the redaction placeholder. The body still carries the redacted form; only the lookup id is preserved raw. The `governance_approvals.resource_id` field (in the queue path) uses the REDACTED id when present and the `'unknown'` placeholder when the DLP scan STRIPS the id field entirely (some redaction policies drop PII fields rather than mask them) — the raw record id is NEVER used here, so raw PII can't land in audit storage (Copilot R4 on PR #827). The asymmetry between the two surfaces is intentional: the connector needs the real id to find the right row; the audit table needs the redacted id (or placeholder) to honour the "no raw PII in approval records" goal. The `Logger.info('FlowExecutor dispatch succeeded', ...)` line also omits `targetRecordId` for the same reason: logger sinks aggregate searchable text, so emitting the raw id there would re-leak it (Copilot R3 on PR #827). The `FlowResult.targetRecordId` return value still carries the raw id for downstream callers, since the result is consumed inside the trusted execution context.

6. **Single sample template** (`samples/SampleHubSpotToNetSuiteContact.ts`) — HubSpot contact → NetSuite Contact `create`. Exists so the executor + CI gate have a real consumer to walk end-to-end. The three production templates the merged plan calls for (Squire→NS OTC, HubSpot→NS PTP, Squire→NS Payouts) land in PR 14b alongside the bulk path.

7. **One CI gate** (`scripts/check-flow-template-instrumentation.mjs`):
   - Registry ↔ source consistency: every entry references a real file; no orphan template files.
   - Template id uniqueness within the registry.
   - `target.operation` ∈ {create, update, delete} (rejects `bulk_upsert` until PR 14b).
   - `target.operation === 'delete'` ⇒ `resolveTargetRecordId` callable.
   - `retryPolicy.idempotencyKey` callable (PR 14b reads this).
   - The merged plan's other two gates (`check-bulk-compensation-coverage.mjs`, `check-decision-provenance.mjs`) are deferred — neither has a real surface to enforce against today.

8. **Single-validation contract deferred.** The merged plan's `precomputedDecision` parameter on `BaseConnector.write(...)` does not yet exist; `BaseConnector` is still abstract `create`/`update`/`delete`. PR 14 narrowed sends the redacted payload through those existing methods. Concrete connectors that re-scan via `BaseConnector.validateOutboundWrite` produce a redundant-but-correct second scan in the happy path (same payload, same policy, same outcome). PR 14b's `precomputedDecision` plumbing closes this overhead loop.

## Consequences

**Easier:**

- HITL bundle's wedge claim is credible end-to-end across all three write paths (route, connector, flow).
- New flow contributors edit ONE template file + ONE registry entry; the executor + governance pipeline are invisible.
- PR 14b ships into a stable contract — `FlowTemplate` + `FlowExecutor` + registry + CI gate already in place; PR 14b only adds the new operation variant + the per-row loop + the lineage/ownership context fields.

**Harder:**

- A redundant second DLP scan runs in concrete connectors that already invoke `BaseConnector.validateOutboundWrite`. Measurable overhead, never a correctness issue (deterministic policy means the second decision matches the first). Resolved in PR 14b.
- The narrow surface is intentionally under-featured against the merged plan's spec — operators reading the executor source will see TODOs / "PR 14b" markers around bulk dispatch and lineage hops. Documented in `docs/review/proof-cards/flow-templates.md` "Known gaps."
- `FlowContext.lineageRecorder` and `ownershipResolver` are absent today. Templates that need lineage hops or ownership checks before PR 14b lands cannot be written via this DSL — they should stay in the existing hand-rolled per-flow files under the `src/flows/` directory (the `runSquireInstallerSync`, `runSquireSupplierSync`, `runSuiteCentralPayoutSync` shape) until PR 14b.

## Alternatives considered

**A. Wait for PR 12 + PR 13 to ship before any of PR 14 lands.** Rejected — it kept the HITL wedge claim incomplete for the flow path indefinitely (Lineage and Ownership are both Tier-B Week 6-7 work that has not started). Shipping the governance-completing slice now AND committing to PR 14b once dependencies land is a smaller blast radius than blocking the bundle on un-started work.

**B. Skip the FlowExecutor and let the existing hand-rolled per-flow files (the run-sync shape under the `src/flows/` directory) call `OutboundGovernanceService` directly.** Rejected — three problems: (a) every new flow has to re-implement the governance + enqueue branching, increasing the surface where one developer forgets a catch; (b) no declarative registry means we cannot enumerate "flows that ship" the way `connectorRegistry.ts` enumerates connectors; (c) the merged plan's "adding template #N+1 is one file + one registry entry" affordance disappears.

**C. Ship a richer DSL today (transform DSL, retry policy enforcement, lineage hops as no-ops, etc).** Rejected — every additional surface is one more place where PR 14b's eventual integration of real Lineage + Ownership has to backfill. Keeping the DSL minimal means PR 14b's churn is additive ONLY (new fields, new operation variant), not refactor-and-add.

**D. Bind `FlowExecutor` straight to the per-connector `validateOutboundWrite` (no executor-level governance scan).** Rejected — the executor is the layer that knows which `ApprovalQueueService` enqueue args to construct (resourceType from the template, resourceId from the resolver, etc). Pushing that into the connector layer would have meant every connector re-implementing the enqueue arg construction OR a parallel error class for connectors to throw with the template metadata attached.

## Links

- Implementation: `src/flows/templates/{FlowTemplate.ts, FlowExecutor.ts, FlowResult.ts, registry.ts, samples/SampleHubSpotToNetSuiteContact.ts}`
- Tests: `tests/unit/flows/templates/FlowExecutor.test.ts` + `tests/integration/FlowExecutor.test.ts`
- CI gate: `scripts/check-flow-template-instrumentation.mjs` + `tests/scripts/check-flow-template-instrumentation.test.sh`
- Proof card: `docs/review/proof-cards/flow-templates.md`
- Merged remediation plan: `docs/plans/2026-05-01-a-grade-remediation-plan-merged.md` §PR 14 (full spec; PR 14 narrowed picks the smallest slice that closes the HITL wedge claim).
- Route-layer catch parallel: `src/middleware/governance/approvalQueueErrorHandler.ts` (HTTP shape of the same pipeline).
- Connector-layer catch parallel: `src/core/BaseConnector.ts:529-554` (`validateOutboundWrite` throws `PendingApprovalError` / `GovernanceBlockedError`).
