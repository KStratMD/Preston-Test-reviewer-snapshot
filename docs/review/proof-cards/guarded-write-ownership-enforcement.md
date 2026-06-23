# Proof Card: guarded-write Ownership Enforcement (PR 13b + PR 13c-3 + PR 13d)

**Status:** production
**Last verified:** 2026-06-11

## Claim

`guardedWrite()` is the single chokepoint for every direct connector mutation in the application. It gates 29 callsites (12 HubSpot routes + 6 fixture/finance/syncErrorAssist callsites + 11 services migrated in Stage A2.5: IntegrationService, IntegrationExecutor, SyncCentralOrchestrator, FlowExecutor.dispatch, SyncErrorAssistService) plus the `FlowExecutor` unified write path. The helper:

1. Calls `OwnershipResolver.validateWrite` and throws `OwnershipViolationError` (reject_with_alert), `OwnershipBlockedError` (source_wins + non-owner caller), or `OwnershipFieldLevelMergeBlockedError` (merge_field_level block) for non-owner writes. The `queue_for_human` policy is **live as of PR 13c-2** — `guardedWrite` encrypts `WriteDescriptor.args` via the global `EncryptionService` (AES-256-GCM, same key + AAD as AI-provider API-key storage), persists the encrypted envelope into `governance_approvals.write_descriptor`, and throws `OwnershipPendingApprovalError(queueId)` so the route layer maps to 202 with `pollUrl`. `OwnershipResumeHandler` decrypts on operator approval before re-dispatching the original mutation.
2. After ownership allow AND for SourceSystem callers only, calls `OwnershipResolver.detectLoop` and throws `LoopDetectedError` on a reciprocal-write hazard. Non-SourceSystem callers (operator_action, sync_error_remediation, webhook_relay, integration_engine, sync_orchestrator) skip loop detection — explicit by design via the `isSourceSystem` type guard.
3. Permits operator override of `reject_with_alert`, `source_wins`, and `merge_field_level` policies when caller is `operator_action` and `override.permitted === true`. **Loop detection gating is precise**: `LoopDetectedError` is non-overridable WHEN it fires — but the `detectLoop` check itself only runs for SourceSystem callers (`isSourceSystem` gate), because lineage events are keyed by SourceSystem and `operator_action` is not in that set by construction. So override-initiated writes (always `operator_action` callers) skip the loop check entirely — there's no chain for `detectLoop` to find since operator_action isn't in any reciprocal-write lineage. Copilot R19 on PR #851 flagged the prior "never bypasses loop detection" phrasing as imprecise. `queue_for_human` is non-overridable; PR 13c-2 still routes through the enqueue path even when an override is present, because the policy decision is "policy-mandated human approval" rather than "policy-mandated block" — operator override is the mechanism for the OPERATOR to act on the queued write, not a bypass that skips the queue. Future enhancement: thread a synthetic lineage identity for operator writes if we want override-initiated writes to participate in loop detection.
4. Applies `merge_field_level` payload filtering only when the callsite supplies `fieldLevelPayload`: owner/non-merge/override paths receive the original payload, while field-level merge paths receive the exact-leaf allowed subset or fail closed. Field names may be audited; field values are never logged in ownership metadata.
5. Emits a decision audit row + outcome audit row on every path; override paths emit a third "override" row (decision → override → outcome).

A CI gate (`scripts/check-guarded-writes.mjs`) walks the TypeScript AST for every `src/` file outside `connectors/`, `migrations/`, `tests/`, `scripts/`, and the two legitimate dispatcher exemptions, and fails any call to a mutating `IConnector` method that is not nested inside a `guardedWrite()` do-callback. The receiver is type-checked against the `IConnector` interface — string-name matches on `.create/update/delete/bulk*` against unrelated types are not false-positives.

The source-of-truth coverage gate also enforces the PR 13d field-level contract: any `guardedWrite({...})` context with `fieldPaths` must supply sibling `fieldLevelPayload`, and any manifest entry declaring `merge_field_level` must define at least one `fieldOverrides` entry.

Queue-path durability is LIVE as of PR 13c-2: migration 050 added `governance_approvals.write_descriptor` (TEXT NULLABLE) in PR 13b. `OwnershipResumeHandler.apply()` is registered as the default for `operationType='ownership_write'` by the `ApprovalResumeRegistry` Inversify factory (the registration runs at registry construction time, not as a side-effect of resolving the handler binding — Copilot R1 cluster-A4). On operator approval the handler:

1. Parses the persisted JSON and asserts the `version: 1` discriminator (forward-compat for per-tenant envelope encryption later).
2. Calls `decryptDescriptor` to recover the original `WriteDescriptor.args` via AES-256-GCM (fails closed on tamper / unknown version / shape mismatch).
3. Re-runs `OwnershipResolver.detectLoop` for SourceSystem callers — approval may have arrived minutes/hours after enqueue and a reciprocal lineage chain may have formed in the interim. On `loopDetected: true` the handler throws `LoopDetectedError` and the worker records the approval as `apply_failed`.
4. If the descriptor carries `integrationConfigId`, looks up the tenant-bound `IntegrationConfig` via `ConfigurationService.getConfigurationForTenant(tenantId, configId)` and calls `ConnectorManager.initializeConnectorsForConfig(config)` so the dispatched connector has the correct auth + base URL. Falls back to legacy `getConnector(targetSystemId, targetSystemId)` when no id is supplied (backward compat with descriptors persisted before this PR).
5. Dispatches the original mutation (create/update/delete/bulk*) and emits a `resume_from_queue` audit row.

A CI gate (`scripts/check-write-descriptor-equivalence.mjs`) walks the TypeScript AST for every `src/` file outside `connectors/`, `migrations/`, `tests/`, `scripts/` and asserts that any `guardedWrite({...})` site with both `do` and `resume` has matching `(operation, entityType)` between the closure body and the descriptor — preventing the class of bug where the closure creates a `Contact` but the descriptor describes a `Customer` update.

The operator surface ships at `/api/governance/ownership-rejections`, `/api/governance/loop-detections`, and `/api/governance/approvals?reason=ownership&status=pending`. All three are gated by `validateGuestContext + requireApproverRole`. A static demo dashboard renders at `/governance-operations.html`.

## Source

- Helper: `src/governance/sourceOfTruth/guardedWrite.ts`
- Error hierarchy: `src/governance/sourceOfTruth/ConflictResolutionPolicy.ts` (`WriteBlockedError` + 5 subclasses + 2 sibling errors)
- Field-level payload helper: `src/governance/sourceOfTruth/fieldLevelPayload.ts`
- Type guard: `src/governance/sourceOfTruth/SourceOfTruthManifest.ts` (`isSourceSystem`, derived from `SOURCE_SYSTEM_TO_CONNECTOR_KEY` keys)
- Connector recordType mapping: `src/governance/sourceOfTruth/connectorRecordType.ts`
- Resolver `queue_required`, `merge_field_level`, and `detectLoop`: `src/governance/sourceOfTruth/OwnershipResolver.ts`
- AuditService widening: `src/services/ai/orchestrator/AuditService.ts` (`logGovernanceCheck` accepts `ownership.policy / .queueId / .loopBreakingCondition / .resumeFromQueue / .governanceOverride / .allowedFieldPaths / .blockedFieldPaths`; new `queryGovernanceChecks` method bypasses queryAuditLogs and pushes tenantId down to `findByAuditFilters`)
- Approval queue persistence: `src/database/migrations/050-add-write-descriptor-to-governance-approvals.ts`, `src/database/migrations/051-add-apply-lifecycle-to-governance-approvals.ts`, `src/services/governance/ApprovalQueueRepository.ts` (`write_descriptor` field + apply lifecycle fields), `src/services/governance/ApprovalQueueService.ts` (`EnqueueArgs` discriminated union: `governance | ownership`)
- Encrypted-args envelope: `src/services/governance/writeDescriptorEncryption.ts` (`encryptDescriptor` / `decryptDescriptor`, `EncryptedWriteDescriptorPayload`, `WriteDescriptorEncryptionError` with `unknown_version | shape_invalid | decrypt_failed | encrypt_failed | serialize_failed | metadata_tampered` codes). The encrypted cleartext carries `{args, metadataDigest}` where `metadataDigest` is the SHA-256 of canonical-JSON of the plaintext metadata fields (`version`, `targetSystemId`, `operation`, `entityType`, `ownership`, `integrationConfigId`); decryptDescriptor recomputes the digest from the persisted plaintext and fails closed on mismatch (DB-tier tamper protection — closes Copilot R3 on PR #853).
- Resume handler: `src/services/governance/handlers/OwnershipResumeHandler.ts` + `src/services/governance/ApprovalResumeWorker.ts` (exports `ApprovalResumeRegistry`; default `'ownership_write'` handler registered in the Inversify factory at `src/inversify/inversify.config.ts`). The handler injects `EncryptionService`, `ConfigurationService` (for per-tenant connector init), and `OwnershipResolver` (for resume-time `detectLoop`).
- FlowExecutor unification: `src/flows/templates/FlowExecutor.ts:430-510` (catches `OwnershipViolationError`, `OwnershipBlockedError`, `OwnershipFieldLevelMergeBlockedError`, `LoopDetectedError` and maps to `FlowBlockedResult` variants)
- Route-layer 409 mapping: `src/middleware/governance/approvalQueueErrorHandler.ts` (`WriteBlockedError` → HTTP 409)
- Operator API: `src/routes/governance/operationsRouter.ts`, `src/routes/governance/_governanceAuth.ts` (shared embedded-session helpers), `src/routes/governance/approvalsRouter.ts` (`?reason=ownership` filter)
- Operator UI: `public/governance-operations.html` (static demo data; live API is embedded-session-gated)
- CI gate: `scripts/check-guarded-writes.mjs` (TS-checker AST walk; exits 1 on any unguarded mutating IConnector call outside the exempt set)
- CI gate (PR 13c-2): `scripts/check-write-descriptor-equivalence.mjs` (TS-AST walk; for every `guardedWrite({...do, resume...})` call site, asserts the closure body's connector method matches `resume.operation` and the closure's entityType arg matches `resume.entityType` — bails to skipped on dynamic closures with a clear log)
- Exemption set: `guardedWrite.ts` (the chokepoint helper itself) + `OwnershipResumeHandler.ts` (post-approval dispatcher; ownership decision was made + audited at enqueue time, operator has explicitly approved)

## Tests

- Unit (field-level payload helper, 12 tests): `tests/unit/governance/sourceOfTruth/fieldLevelPayload.test.ts`
- Unit (helper): `tests/unit/governance/sourceOfTruth/guardedWrite.test.ts` — Stage A1 skeleton + Stage B queue/override (incl. PR 13c-2 queue-lift, MissingWriteDescriptor, missing-approvalQueueService dep, and integrationConfigId propagation) + Stage C detectLoop + Stage D merge_field_level payload filtering.
- Unit (error hierarchy, 1 suite): `tests/unit/governance/sourceOfTruth/ConflictResolutionPolicy.errorHierarchy.test.ts` (covers typed ownership errors including `OwnershipFieldLevelMergeBlockedError`, `QueueForHumanNotYetSafeError` retained as defensive scaffolding, `OwnershipPendingApprovalError`, `PolicyNotYetImplementedError`)
- Unit (writeDescriptorEncryption): `tests/unit/services/governance/writeDescriptorEncryption.test.ts` — round-trip (incl. absent + undefined `integrationConfigId`/`args`), plaintext-PII-leakage smoke check, fail-closed on `unknown_version` / ciphertext tamper / missing version / missing argsEncrypted / null / non-object input / `serialize_failed` on circular refs and function args, tightened `isPayloadShape` checks (missing `algorithm`, missing ownership fields, non-string `integrationConfigId`), and the `metadata_tampered` binding (mutated targetSystemId / operation / entityType / ownership.declaredOwner / integrationConfigId, plus the asymmetric present-vs-absent integrationConfigId case).
- Unit (resolver ownership decisions, 33 scenarios incl. 10 demo-tenant-override): `tests/unit/governance/sourceOfTruth/OwnershipResolver.test.ts`
- Unit (audit widening, 4 scenarios): `tests/unit/services/ai/orchestrator/AuditService.logGovernanceCheck.test.ts`
- Unit (queryGovernanceChecks, 7 scenarios): `tests/unit/services/ai/orchestrator/AuditService.queryGovernanceChecks.test.ts`
- Unit (operationsRouter, 6 scenarios): `tests/unit/routes/governance/operationsRouter.test.ts`
- Unit (approvals reset-claim, 6 scenarios): `tests/unit/routes/governance/approvalsRouter.resetClaim.test.ts`
- Unit (409 middleware, 1 suite): `tests/unit/middleware/governance/approvalQueueErrorHandler.writeBlocked.test.ts`
- Unit (HubSpot route migration, 12 callsites): `tests/unit/routes/hubSpot.test.ts`
- Integration (guardedWrite end-to-end, 7 scenarios): `tests/integration/guardedWrite.endToEnd.test.ts` — owner write, queue+enqueue, queue+missing descriptor, operator approve→resume dispatch, reject_with_alert throw, override permitted, loop hazard.
- Integration (FlowExecutor unification, 3 scenarios): `tests/integration/FlowExecutor.guardedWriteUnification.test.ts` — `OwnershipViolationError` / `OwnershipBlockedError` / `LoopDetectedError` → `FlowBlockedResult` variants.
- Integration (approvals reason filter, 7 scenarios): `tests/integration/governanceApprovalsRouter.test.ts` (Reason filter describe block) — pending+ownership filter, no-reason baseline, invalid reason 400, empty=omitted, history view, counts_only filtered total, limit+filtered total pin, tenant isolation.
- Integration (approvals admin recovery, 5 scenarios): `tests/integration/governanceApprovalsRouter.test.ts` (admin apply-claim recovery describe block) — admin reset succeeds, approver-only role rejected, unknown approval 404, claim-not-failed 409, whitespace id 400.
- CI gate regression (11 scenarios): `tests/scripts/check-guarded-writes.test.sh` — live-repo baseline + 10 synthetic projects covering basic violation, in-do-callback, optional-chain receiver, optional-method, both-optional, multi-line AST, block-comment, tests/ exempt, connectors/ exempt, OwnershipResumeHandler.ts exempt.
- Source-of-truth coverage regression (10 synthetic + 1 live-repo smoke): `tests/scripts/check-source-of-truth-coverage.test.sh` — includes implemented `queue_for_human`, implemented `merge_field_level`, required field overrides, and the guardedWrite `fieldPaths`/`fieldLevelPayload` AST lint.
- Coverage: per-file rows for the 6 new production files in `.core-coverage-budget.json`. The Phase-5b ratchet enforces no regressions.

## Live vs Fixture

- Real enforcement wired? **Yes**. Every `src/` mutating IConnector call outside the exempt set is gated by `guardedWrite`; CI gate hard-fails on drift. Non-owner writes throw before `connector.create/update/delete` is invoked.
- Real audit-row persistence? **Yes** — `AuditService.logGovernanceCheck` persists to the `audit_logs` table via `AuditPersistenceMapper` envelope. The integration test verifies decision + outcome + resume_from_queue rows by reading rows back from the test sqlite DB.
- Real queue persistence? **Yes** — migration 050 ships the `write_descriptor` column. The integration test inserts via `ApprovalQueueService.enqueue` and the operator-approve path reads back via `OwnershipResumeHandler.apply`.
- Real connector dispatch on resume? **Yes** in production; the integration test uses a stub `IConnector` via `container.rebind(TYPES.ConnectorManager).toConstantValue(...)` to assert that the original mutation arguments flow through OwnershipResumeHandler unchanged.
- Real loop detection wired? **Yes** — `detectLoop` queries the production `lineage_events` table via `LineageRepository.findReciprocalChainSeeds`. The integration test spies `LineageQueryService.findRecentReciprocalActivity` to inject a chain seed.
- Demo-mode toggle? **No**. `guardedWrite` is module-local TypeScript invoked on every governed-flow + every migrated direct-write callsite at runtime; no per-environment branching.
- Production credential test on file? **N/A** — `guardedWrite` operates on in-process state. The connectors it gates each have their own production-credential proof cards.

## Known Gaps

- **Demo-tenant override env escape hatch (`OWNERSHIP_DEMO_TENANT_ID`, 2026-06-11).** An operator-designated demo tenant's non-owner writes under `reject_with_alert` (and ONLY that policy) are allowed instead of thrown, so the SuiteCentral→NetSuite demo sync flow can run end-to-end. **Tenant-scoped, NOT flow-scoped — accepted risk** (Codex review on PR #897): ANY write path running as the designated tenant is covered, across all 5 reject_with_alert manifest entities, because the designated tenant is a demo sandbox identity. NEVER designate a production tenant's id. Mitigations: fail-closed default (unset/empty → no override anywhere); the SYSTEM tenant (`__system__`) is un-designatable so background/system writes can never be blanket-whitelisted; **production requires a double opt-in** (`OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION=1`, else the override stays inactive and rejection logs carry a `demoOverrideStatus: production_blocked` hint); loop detection still applies. Not silent: the resolver returns the distinct `demo_tenant_override` decision reason and warn-logs every bypass; guardedWrite records the `ownership_demo_tenant_override` flag on BOTH the decision and outcome audit rows — the decision row at HIGH risk, the outcome row at the uniform `low` all `write_succeeded` rows share (incl. operator `governance_override` writes), so risk-based triage keys on decision rows and flag-based queries catch both. Helper: `src/config/runtimeFlags.ts:ownershipDemoTenantStatus`. Tests: resolver demo-override describe (10 scenarios incl. production gating), guardedWrite demo-override describe (4 scenarios), and the real-chain integration proof `tests/integration/src/integrations/SuiteCentralNetSuiteSync.demoOverride.test.ts` (override succeeds + env-unset stays blocked).
- **Live operator dashboard is a static-data placeholder.** `public/governance-operations.html` renders static demo data for the executive package; the live API endpoints (`/api/governance/approvals`, `/api/governance/ownership-rejections`, `/api/governance/loop-detections`) are embedded-session-gated and not reachable from a static page. A future build can swap the bottom render calls to try-fetch-then-fallback once the embedded-session injection flow is wired for this page.
- **HubSpot mutation routes are intentionally block-by-default without override.** All 12 HubSpot routes in `src/routes/hubSpot.ts` (POST/PATCH/DELETE for `contacts`, `companies`, `deals`, `tickets`) use `callerSystem: 'operator_action'`; without the governance override role + reason they return 409 (`ownership_blocked` for HubSpot-owned `source_wins` entities; `ownership_violation` for the NetSuite-owned `customer` entity hit via the `companies` route). The route tests also pin the authorized override path.
- **`queue_for_human` is LIVE as of PR 13c-2** with AES-256-GCM-encrypted descriptor storage via the global `EncryptionService` (same key + AAD as AI-provider API-key encryption — same blast radius). The persisted JSON shape carries a `version: 1` discriminator + plaintext manifest vocabulary (queryable: `targetSystem`, `operation`, etc.) + `argsEncrypted` envelope. Per-tenant envelope encryption is a separate follow-up hardening lift (tracked in `docs/superpowers/plans/2026-05-27-pr-13c-deferred-scope-followups.md` under "Out-of-scope"); compromise of `AI_CONFIG_ENCRYPTION_KEY` exposes queued descriptors with the same blast radius as queued connector credentials.
- **No production manifest entry currently opts into `merge_field_level`.** The policy is implemented and CI-allowed when field overrides exist, but this PR deliberately does not flip `customer` or any other entity. A follow-up should pick the first SourceSystem-identified update callsite and response semantics before changing production behavior.
- **Coverage regression in `SyncErrorAssistService.ts`** (functions 90% → 87.09%, lines 95.54% → 95.25%) traces to Stage A2's defensive `NOOP_GOVERNANCE_DEPS` object. Three of the four noop arrow functions are exercised by existing tests; `enqueue` is not because the noop validateWrite returns allowed:true and the queue path is never taken. Removing the noop and making the deps strictly required (extending testHelpers + integration fixture to pass approvalQueueService) is the right cleanup; deferred to keep this PR scoped to the wedge claim.
- **Operator approval UI doesn't yet expose ownership-rejection details inline.** The three-panel dashboard at `/governance-operations.html` is read-only. Approve/reject for ownership rows is done through the existing embedded approvals UI; the dashboard links to it implicitly by sharing the same `?reason=ownership` filter contract. A unified approve-from-the-dashboard surface is a Tier-3 follow-up.
- **ConfigurationService in-memory tenant isolation — CLOSED in PR 13c-4; durable same-id-across-tenants on-disk storage DEFERRED.** Previously the `Map<id, IntegrationConfig>` in memory and `${id}.json` on disk both collided if two tenants picked the same id. PR 13c-4 rekeys the in-memory map to `Map<\`${tenantId}::${id}\`, IntegrationConfig>`, so reads are tenant-isolated (`getConfigurationForTenant(tenantId, id)` is the canonical lookup; cross-tenant reads return undefined/404). `getConfiguration(id)` is deprecated and throws `ConfigurationLookupAmbiguousError` (→ 409) when two tenants share an id. **The on-disk layout stays flat `${configDirectory}/${id}.json` (top-level only).** A tenant-subdir on-disk layout (`${tenantId}/${id}.json`) plus boot migration was attempted in this PR but REVERTED: the runtime config dir (`integrations/`) is overloaded — it holds top-level `*.json` configs PLUS subdirectories of ERP connector artifacts (`business_central/*.al`, `dynamics365/*.al`, `netsuite/*.js`), and the tenant-subdir walk both fail-closed on the legacy tenant-less configs and tried to load `business_central/app.json` as a config, crashing the server at boot (caught by the Docs/E2E smoke tests). `loadConfigurations()` now reads top-level `*.json` only and ignores subdirs, matching the pre-PR contract. Because flat `${id}.json` cannot durably hold the same id for two tenants (the second writer would clobber the first), `saveConfiguration` rejects a cross-tenant same-id write at the write boundary (`ConfigurationLookupAmbiguousError` → 409) rather than silently losing data. The 8 legacy `integrations/*.json` configs were backfilled with `tenantId`. Durable same-id-across-tenants on-disk storage is deferred until the config store is separated from the connector-artifact directory.
- **Anonymous-caller bypass via `SYSTEM_IDENTITY` fallback — CLOSED in PR 13c-4.** Previously `/api/configurations` and `/api/integrations` were mounted behind `optionalAuthMiddleware` + `mountCentralTenantGate`, both PERMISSIVE on missing credentials, so an unauthenticated caller fell through to the deployment-global `getConfiguration(id)` / `runIntegration(id)` paths and bypassed the tenant-scoped prechecks. PR 13c-4 mounts both route groups behind `authMiddleware` (mandatory auth, like `/api/admin/*`); handlers narrow `req.user?.tenantId` (401 if missing) and resolve via `getConfigurationForTenant` (404 on cross-tenant id collisions). The ~20 route-unit-test fixtures were refactored to inject an authenticated identity.
- **~10 internal `getConfiguration(id)` callsites still use the deprecated tenant-agnostic lookup.** `IntegrationService`, `IntegrationOrchestrator`, `AINaturalLanguageService`, and `SecureConfigurationService` still call the deprecated `getConfiguration(id)` rather than `getConfigurationForTenant(tenantId, id)`. Migrating these callsites + a CI lint enforcing route-layer abstention from `getConfiguration` are deferred to a follow-up PR.
- **Integration stop/status/webhook/mapping tenant scoping — CLOSED in PR 13c-4.** These handlers now narrow `req.user.tenantId` (401 if missing) AND check the requested integration id with `ConfigurationService.getConfigurationForTenant(tenantId, id)` before dispatching to the legacy tenantless service method. Cross-tenant id probes return 404 and do not call `stopIntegration`, `getIntegrationStatus`, or optional webhook/mapping aliases. `GET /api/integrations/status` filters the global status list to the caller's tenant-owned config ids before returning it. Regression coverage lives in `tests/unit/routes/__tests__/integration.test.ts`.

## Verification (60-second AI-reviewer recipe)

```bash
# 1. CI gate — 0 violations, 11 regression scenarios
node scripts/check-guarded-writes.mjs
bash tests/scripts/check-guarded-writes.test.sh

# 2. Helper + encryption + handler unit tests pass
npx jest --config=jest.fast.config.cjs \
  tests/unit/governance/sourceOfTruth/fieldLevelPayload.test.ts \
  tests/unit/governance/sourceOfTruth/guardedWrite.test.ts \
  tests/unit/governance/sourceOfTruth/OwnershipResolver.test.ts \
  tests/unit/services/governance/writeDescriptorEncryption.test.ts \
  tests/unit/services/governance/handlers/OwnershipResumeHandler.test.ts

# 3. queryGovernanceChecks + operationsRouter unit tests — 13 scenarios pass
npx jest --config=jest.fast.config.cjs \
  tests/unit/services/ai/orchestrator/AuditService.queryGovernanceChecks.test.ts \
  tests/unit/routes/governance/operationsRouter.test.ts

# 4. Integration tests — 10 scenarios pass (real services, mocked connector)
npx jest --config=jest.slow.config.cjs \
  tests/integration/guardedWrite.endToEnd.test.ts \
  tests/integration/FlowExecutor.guardedWriteUnification.test.ts

# 5. Migration 050 applied
sqlite3 .db "PRAGMA table_info(governance_approvals)" | grep write_descriptor

# 6. Coverage budget green
node scripts/check-core-coverage-budget.mjs

# 7. Source-of-truth policy gate green
npm run audit-source-of-truth-coverage
```

Expected: every command exits 0. Step 1 prints `✓ guarded-write coverage: 0 violations`. Step 5 prints `8|write_descriptor|TEXT|0||0` (column index may vary). Step 6 prints `Core coverage budget OK (60 files matched)`.
