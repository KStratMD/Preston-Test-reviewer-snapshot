# Reviewer Evaluation Prompt — Preston-Test / SuiteCentral 2.0 (v2)

**Audience:** outside reviewers (engineers, architects, AI assistants with repo access) doing an evidence audit and architecture review for executive evaluation.
**Repo:** [`KStratMD/Preston-Test-reviewer-snapshot`](https://github.com/KStratMD/Preston-Test-reviewer-snapshot) — curated public snapshot of a private B2B ERP integration platform. Auto-republished from upstream `main` on every merge; provenance pointer at `SOURCE_COMMIT`.
**Goal:** answer three evidence questions and produce a recommendation a non-technical partner can act on.

> **What changed from v1 (read this if you used the old prompt).** The platform has matured substantially since the original prompt was written. This version: (1) adds a **mandatory pre-flight** that tells you which test failures are snapshot-construction artifacts vs. real defects, so you don't file false findings; (2) replaces the binary supported/unsupported verdict with a **three-state scale** that distinguishes "proven in code" from "proven only by deployment"; (3) adds Pass A/B questions for the **architecture pillars that postdate v1** — reference-based data custody (ADR-019), the tenant kill switch, guarded-write ownership enforcement, record-level lineage, and the AI accuracy benchmark harness; (4) points the Squire lens at the **product cards and portfolio-evidence manifest that now exist in the repo**. If you are re-running an evaluation to compare against a prior one, note the snapshot `SOURCE_COMMIT` of both — findings are only comparable across known snapshots.

---

## ⚠️ Pre-flight — read before running any recipe

This is a **curated mirror**, not the full upstream repo. Some files referenced by tests and proof cards are intentionally excluded from the mirror by an allowlist. When you run the test suite or a 60-second recipe, you will see a small number of failures that are **snapshot-construction artifacts, not code defects**. Do not file these as findings against the code. As of this writing the known mirror-only gaps are:

- the shared governance test helper (`governanceTestUtils`) — may cause `MODULE_NOT_FOUND` in a handful of suites
- the AI-accuracy benchmark runner and its golden fixture — cause the benchmark data-leakage guard suite to fail to load
- the route-catches spec manifest under `tests/spec/` — manifest read at test-load time
- ADR documents 019 through 022 — referenced by proof cards; only ADR-018 is mirrored
- Generated artifacts (`openapi.yaml`, some static `*.html`) that exist upstream but may lag the mirror

**How to handle this correctly:**

1. Run the suite. Separate suites that **failed to load** (exec errors: `MODULE_NOT_FOUND`, `ENOENT`) from suites that **ran and had assertions fail** (real test-logic failures).
2. **Only test-logic failures are findings.** Exec errors that trace to a file in the gap list above are mirror artifacts — note them as "could not verify (mirror gap)," not as defects.
3. If you have access to the upstream private repo, run execution-tier questions there instead and say so at the top of your output.
4. **Treat a growing gap list as its own minor finding** against snapshot hygiene — but never as a finding against the product code. The distinction matters because this product's pitch is honesty discipline; a reviewer who reports mirror artifacts as code failures produces a misleading evaluation.

A reviewer who reports "the test suite has N failures" without separating these two classes has produced a wrong result. Always report the split.

---

## How to run this

Three tiers, in descending order of fidelity. **Note your tier at the top of your output.** Execution-tier questions you cannot run are marked **could not verify**, not guessed.

| Tier | Setup | What you can answer |
|---|---|---|
| **Best** | Clone the snapshot, `npm ci`, run recipes verbatim; ideally also have upstream repo access for the mirror-gap items | All of Pass A + all of Pass B |
| **Acceptable** | Browse the snapshot inside a tool with repo context (Claude Code, Codex CLI, Cursor, large-context Gemini) | Most of Pass A from `metrics.json` + proof cards + source reads; all of Pass B from source |
| **Minimum** | Paste this prompt + the snapshot URL into a chat AI, let it fetch what it can | Pass A questions about `metrics.json` and proof cards; Pass B answered structurally from named files |

---

## Mandate

Your job is **not** to grade code style or suggest refactors. Your job is to answer three questions:

1. **Are the project's production claims supported by source-level evidence?**
2. **Is the architecture coherent on its own terms?**
3. **Where, specifically, is the platform proven in code vs. proven only once it is deployed to a real client?**

Three passes, in order. Pass B's verdict should be grounded in what Pass A reveals. Pass C is one paragraph for leadership. The Squire lens (if applicable) comes last.

---

## The three-state verdict scale (use this, not binary)

The platform has matured to where most claims are *supported in code*. The interesting question is no longer "is this real?" but "is this proven by the code, or does proving it require a real deployment?" Use:

- **Proven-in-code** — a reviewer with the repo can verify it (a test runs, a chokepoint exists, a migration creates the table). Cite `file:line`.
- **Proven-by-deployment-only** — the mechanism exists and is tested, but the *claim* (accuracy %, "works against production NetSuite," "client trusts it") can only be confirmed by running it against a real client/instance. This is not a defect — it is the honest ceiling for a pre-pilot platform. Name it so leadership knows what the pilot is *for*.
- **Unsupported / gap** — claimed but neither proven-in-code nor credibly deferrable to deployment. This is a finding.

The most useful evaluations distinguish #1 from #2 crisply. A platform that is entirely proven-in-code except for the things that genuinely need a deployment is in excellent shape; saying so accurately is more valuable than hunting for a binary "unsupported."

---

## Ground truth — trust these over README/marketing prose

1. **`metrics.json`** (root) — deterministic snapshot: `connectors{}` (production/beta/demo_only/stub, verified by `npm run audit-status-claims`), `dlp_patterns{}` (drift-checked by `npm run verify-metrics`), `tests{}` (informational), `ai_accuracy{}` (mirrored from the benchmark report — note its `run_mode`).
2. **`docs/review/proof-cards/`** — per-component evidence cards (Status / Source / Tests / Live vs Fixture / Known Gaps / 60-second recipe). Structure enforced by `npm run audit-proof-cards`. There are ~18 service-level + ~7 connector cards; the count grows as features land.
3. **`docs/review/squire-product-cards/`** — per-SuiteCentral-product evidence index (used by the Squire lens). Backed by `public/portfolio-evidence.json` with a CI drift gate (`npm run audit-portfolio-evidence`).
4. **`SOURCE_COMMIT`** (root) — provenance pointer to upstream SHA + ref + run URL. **Record this at the top of your output** so the evaluation is reproducible against a known snapshot.
5. **`docs/connectors/CONNECTOR_STATUS.md`** — canonical connector partition.

The full CI audit-gate set (run all; each is a structural honesty check):
`audit-status-claims`, `audit-proof-cards`, `audit-portfolio-evidence`, `verify-metrics`, `check-system-identity-isolation`, `check-core-coverage-budget`, `check-any-budget`, `check-strict-null-budget`, `check-strategic-claims`, plus the governance/lineage/adapter/payload-custody audit gates wired in `package.json`.

For each component, run its proof card's "60-second verification" recipe verbatim. If it fails *and the cause is not a mirror gap*, that's a finding. If a claim has no proof card and no source in `metrics.json`, that's also a finding.

---

## ═══════════════════════════════════════════════════════════════════════
## PASS A — EVIDENCE AUDIT
## ═══════════════════════════════════════════════════════════════════════

Answer with `file:line` citations and a three-state verdict. No recommendations.

### Q1. Connector production status — real HTTP or demo fallback?
Does every connector declaring `productionStatus = 'production'` exercise real HTTP against the vendor (vs. demo fallback via `isDemoMode()` / `isTestEnvironment()` or `MockConnectorBase`)? Spot-check **2 of**: NetSuite, Salesforce, Business Central, HubSpot, ShipStation. For NetSuite specifically, note whether a **production-tier credential test** is on file or whether the proof card still caps at sandbox — that determines proven-in-code vs. proven-by-deployment-only.

### Q2. DLP pattern partition
DLP claims 14 patterns with 6 field-gated (`metrics.json:dlp_patterns`). In `src/services/security/DLPService.ts`, grep `requiresFieldContext: true,` (trailing comma — matches registry entries, not JSDoc/type lines). Expect exactly 6: `phone_intl`, `bank_account`, `date_of_birth`, `passport`, `drivers_license`, `name`. Does the count match and are the types correct?

### Q3. Outbound DLP egress completeness (was MCP-only in v1)
DLP is claimed to run at **every** egress chokepoint, not just MCP. Verify each: (a) AI provider requests — `src/services/ai/providers/BaseProvider.ts` (constructor throws if governance absent; scan before `fetch`); (b) connector writes — `src/core/BaseConnector.ts` `validateOutboundWrite`; (c) audit-log persistence — `src/services/ai/orchestrator/AuditService.ts`; (d) reference-data resolution — `src/services/workflowCentral/payload/WorkflowPayloadResolver.ts`. Is any egress path ungated? Also check the MCP false-positive guard (`tests/integration/MCPAutoRedact.fixture.test.ts`) actually pins its contract rather than passing for the wrong reason.

### Q4. Test pass count and skip discipline
Run `npm run test:ci` (unit profile, `jest.ci.config.cjs`). **Apply the pre-flight split**: report `passing / real-failures / mirror-artifact-exec-errors / skipped` as four separate numbers. Compare passing count to `metrics.json:tests`. Do skipped sites have justification (the skipped-tests registry may be a mirror gap — flag as such, not as a defect).

### Q5. AI accuracy claims — is there a harness now?
The benchmark harness exists: `docs/review/ai-accuracy-benchmark.md` + `.json`, mirrored into `metrics.json:ai_accuracy`. Phase B (2026-06-10) widened it to a provider×pair matrix — `--matrix` runs OpenAI + Anthropic against SFDC→NetSuite Customer (61-mapping fixture) and SFDC→Business Central Customer; the canonical headline cell stays openai×NetSuite. Verify: (a) Does the report exist and carry an explicit `run_mode`? The standing numbers are **live runs**, so validate the model(s), generated timestamp, cost, and hallucination count rather than treating them as dry-run plumbing signals. (b) Does a data-leakage guard test exist (`tests/unit/scripts/run-ai-accuracy-benchmark.dataLeakage.test.ts`) — i.e., is each fixture barred from containing the prompt's few-shot examples AND, where the runner supplies target schema context, is that schema broad with substantial distractors rather than just the fixture target answer-set (per-pair postures: NS distractor floor on the full 195-field schema; BC real-OData-schema parity pinned to the connector fixture)? (c) Are the remaining scope cuts (OpenAI + Anthropic only — no OpenRouter/LMStudio columns; top-1 metric; no nightly CI smoke; no confidence interval) honestly disclosed? Verdict should remain scoped to the measured matrix cells; flag any doc that generalizes a cell's number into a population-level absolute-% claim.

### Q6. Honesty discipline as load-bearing infrastructure
Run the full audit-gate set listed under Ground Truth. Then spot-check drift: pick one capability that changed status in git history (a connector demo→production, or an in-memory service that became DB-durable). Did the proof card, audit registry, `productionStatus`/migration, `metrics.json`, and (if a product is affected) the `squire-product-cards` + `portfolio-evidence.json` all move together in the same PR, or did one drift? This is the SOC-2-survivability question: can the project keep its own claims aligned with its own source?

### Q7. Data-custody model (NEW — most material for Squire)
Workflow data custody is governed by a tagged-union payload model (ADR-019; ADR file is a mirror gap, but the code is present). Verify in `src/services/workflowCentral/payload/`: (a) Is `external_reference` the **default** for new instances — i.e., does the platform store pointers and fetch live from the client ERP rather than hosting business data? (b) Is `ephemeral_hosted` opt-in per tenant AND does it require a mandatory `expiresAt`? (c) Is there a reaper that hard-deletes expired ephemeral payloads (`WorkflowPayloadRetentionJob`)? (d) Does the audit log record references, never values (`redactWorkflowPayloadForAudit`)? Also run the workflow-central payload-custody audit gate. This question determines whether the platform respects Squire's zero-data-hosting constraint.

### Q8. Tenant kill switch (NEW)
Verify a per-tenant revocation point exists and is enforced: `src/services/tenants/TenantLifecycleService.ts` (`setStatus`, `requireActive`), `src/middleware/tenantStatusGate.ts`, `src/routes/adminTenantStatus.ts`, and the tenants/status-audit migration. Confirm: (a) the gate is mounted on all Central API route families; (b) transition to a blocked state auto-revokes embedded session tokens; (c) status changes are audited. This is the application-level analogue of Squire's "revoke the Azure key" kill switch.

### Q9. Guarded-write ownership enforcement (NEW)
Verify `guardedWrite()` (`src/governance/sourceOfTruth/guardedWrite.ts`) is the single chokepoint for direct connector mutations, enforcing the source-of-truth manifest (`src/governance/sourceOfTruth/SourceOfTruthManifest.ts`, 11 entities). Confirm the four ownership policies exist (`source_wins`, `reject_with_alert`, `merge_field_level`, `queue_for_human`) and that `queue_for_human` encrypts the write descriptor. Run the governance-posture-reads audit gate.

### Pass A output format
Per finding:

| Field | Value |
|---|---|
| Claim text (verbatim) | *…* |
| Source you checked | `file:line` or command |
| Evidence | `file:line` excerpt or command output |
| Verdict | proven-in-code / proven-by-deployment-only (why) / unsupported (gap is X) |

---

## ═══════════════════════════════════════════════════════════════════════
## PASS B — ARCHITECTURE REVIEW
## ═══════════════════════════════════════════════════════════════════════

Evaluate against the project's own stated design principles:
1. **ERP-Native** (embedded sidecar, not separate app)
2. **AI-Assisted, Human-Approved** (approve-to-apply)
3. **Cost Transparency** (per-provider pricing visible)
4. **Dual-ERP** (NetSuite + Business Central equal citizens)
5. **Built for Ourselves First** (Squire is Customer #1)
6. **Explainable AI** (reasoning traces, lineage)
7. **Governance without data hosting** (NEW — reference-based custody)

### Read first (load-bearing)
- `src/services/workflowCentral/payload/` — the data-custody model (ADR-019)
- `src/governance/sourceOfTruth/guardedWrite.ts` + `src/governance/sourceOfTruth/SourceOfTruthManifest.ts` — ownership chokepoint
- `src/services/tenants/TenantLifecycleService.ts` + `src/middleware/tenantStatusGate.ts` — kill switch
- `src/services/security/DLPService.ts` + `src/services/governance/OutboundGovernanceService.ts` — egress gating
- `src/services/ai/orchestrator/GovernanceService.ts` — inbound AI governance + per-tenant posture
- `src/services/lineage/` — record-level lineage
- `src/services/cost/` — cost transparency (measured vs. estimated)
- `src/embedded/` — embedded surface contract + platform adapters
- `src/inversify/inversify.config.ts` — DI wiring is the architectural spine
- `jest.core.config.cjs` + `.core-coverage-budget.json` — the load-bearing files the project itself names

### Address each, citing `file:line`

**B1. Inbound + outbound AI governance boundary.** Is the `/api/ai/proxy/*` (governed) vs. retired `/api/ai/*` split clean (check the route manifest + `aiRouteGovernance.inventory.test.ts`, `ungoverned: 0`)? What happens at runtime if a production credential goes missing — graceful degrade, hard fail, or silent demo fallthrough?

**B2. Connector extensibility.** Adding a 19th connector: count the surface (interface, DI binding, route registration, `connectorRegistry` entry, proof card, audit registry, tests). Coherent or accreted? Note whether `connectorRegistry` is now the single source of truth.

**B3. Approve-to-apply governance loop.** Trace one approval end-to-end: UI/API affordance → service → OCC lease → connector write (through `guardedWrite`/`validateOutboundWrite`) → audit log. Is it a real gated loop with durable state, or a button that writes directly? Check at least one of: FinanceCentral, WorkflowCentral, SyncErrorAssist operator services. Confirm state survives restart (DB-durable, not in-memory).

**B4. AI cost transparency.** How is cost computed and surfaced (`src/services/cost/`)? Are rollups labeled `measured` vs. `estimated` per cell, and is silent fallback prohibited (ADR-022)?

**B5. DLP/governance egress surfaces.** List every egress path (AI providers, connector writes, audit-log persistence, reference resolution) and its gating. Is any ungated? (This is the Pass A Q3 question viewed architecturally — does the chokepoint set actually cover the surface?)

**B6. Test pyramid honesty.** Two coverage profiles (broad CI vs. core ratchet — now ~60 files, was 15). Look at `jest.core.config.cjs` `collectCoverageFrom` + `.core-coverage-budget.json` + `tests/COVERAGE-EXCLUSIONS.md`. Is "core" a legitimate focus on load-bearing files or a way to dodge hard surfaces? Is the budget ratcheted (floors only go up)?

**B7. Data custody architecture (NEW).** Does the reference-based model (B/Pass-A Q7) actually keep client business data out of the platform's own store by default? Where is the residual custody (ephemeral opt-in, the approval queue, audit details), and is it bounded (reaper, redaction)? Name the largest residual-custody surface.

**B8. Seven principles — enforcement vs. documentation.** For each principle, point to the code that **structurally enforces** it (DI binding, middleware, audit gate, CI drift gate, migration, type, test) vs. where it's documented but not pinned. Aspirational ≠ bad — flag the gap with `file:line` and stop. Don't propose alternatives.

### Pass B output format
Per area, **two paragraphs max**: what the architecture commits to, where it's structurally enforced vs. merely documented, and the largest concrete risk if shipped to a real Squire production deployment. Cite `file:line`. Name the risk and stop.

---

## ═══════════════════════════════════════════════════════════════════════
## PASS C — ONE PARAGRAPH FOR LEADERSHIP
## ═══════════════════════════════════════════════════════════════════════

One paragraph (**≤150 words**): *would you recommend Squire sponsor a 30-day evaluation pilot?* Ground it in the most material Pass A finding (claim alignment) and the most material Pass B finding (structural commitment vs. documentation), and state explicitly **what the pilot would prove that the code cannot** — i.e., which proven-by-deployment-only items the pilot converts to proven. Yes/no with reasoning a non-technical partner can act on. No whole-codebase summary, no "overall solid" wrapper.

---

## ═══════════════════════════════════════════════════════════════════════
## SQUIRE-SPECIFIC LENS — SuiteCentral Decision Framing (optional)
## ═══════════════════════════════════════════════════════════════════════

Add this AFTER Pass A–C only if reviewing for Squire & Company / Squire Technology. Skip otherwise.

Decision-maker: **Reuben Cook** (CSO/Partner, Squire & Company; President, Squire Technology). His filter is **per-product, not per-codebase**: for each SuiteCentral product his portfolio ships, does this repo's evidence support **integrate**, **enhance**, or **replace**? He allocates budget per portfolio decision.

**Use the in-repo evidence now available:** the per-product cards under `docs/review/squire-product-cards/` and the drift-gated `public/portfolio-evidence.json` (run `npm run audit-portfolio-evidence`). If a product card asserts evidence, verify it against source rather than trusting the card.

### The six SuiteCentral products
| Product | Owner | What it does | Where it lives today | Status |
|---|---|---|---|---|
| **PaymentCentral** | Preston / Andy / Dave | Stripe ↔ NetSuite + customer payment portal | Inside NetSuite | Sold |
| **CustomerCentral** | TBD | Customer portal into NetSuite | Inside NetSuite | Sold |
| **VendorCentral** (was SupplierCentral) | Lee | Vendor portal into NetSuite | Inside NetSuite | Sold |
| **SyncCentral** | Preston | Generic ERP integration platform | Inside NetSuite + Azure (pass-through only) | ~40+ deployments |
| **Payout Rec** | Sam Dean | Merchant reconciliation tool | Celigo + Azure (not in NetSuite) | Oldest |
| **Elastic Suite** | Connor Bailey | NetSuite ↔ Elasticsearch 2-way | TBD | Sold |

### Three scenarios (per product)
- **Integrate** — keep the product; add this repo's governance/AI/DLP layer as an overlay. Lowest risk.
- **Enhance** — keep the product; replace specific workflow components (cite both the existing product surface and the repo component). Mid risk.
- **Replace** — this repo supersedes the product. Highest risk; only where the repo shows parity AND a migration story.

Mark any product with no relevant repo evidence as **"insufficient evidence — out of scope for this pilot."** Don't guess.

### Squire hard constraints (gates, not preferences) — now answerable from code
Mark any violation a hard finding. Crucially, several of these are now **proven-in-code**, not open questions — verify, don't assume:

1. **Zero data hosting (Squire side).** Verify against the reference-based payload model (Pass A Q7). Default `external_reference` = pointers, not hosted data. Confirm ephemeral hosting is opt-in + reaped. This is the constraint the data-custody work was built to satisfy — check whether it actually does.
2. **Liability split.** Client owns NetSuite; Squire owns the control plane. Does the architecture keep client business data in the client's ERP (reference model) rather than in Squire's store?
3. **Kill-switch enforcement.** Verify against `TenantLifecycleService` + `tenantStatusGate` (Pass A Q8). Is there a per-tenant revocation point comparable to revoking the Azure key?
4. **SOC 2 readiness.** Does the governance/audit/DLP/identity-propagation/lineage work double as SOC 2 acceleration (audit retention, DLP enforcement, traceable identity, record lineage), or create new surface area? Note what is proven-in-code vs. what still needs the attestation itself (proven-by-deployment-only).
5. **"Ready, fire, aim" culture + budget ceiling.** Preston has ~20 hrs/yr for SyncCentral. Pilot proposals must assume **no Squire-side dev budget**. Frame as minimal-effort overlay-on-existing-deployment, not replacement-from-scratch.

### Squire lens output
**Part 1 — Per-product table:**

| Product | Repo evidence today (`file:line` / product card / proof card) | Recommendation (integrate / enhance / replace) | Pilot risk (low / mid / high) | Largest gap to close before pilot |
|---|---|---|---|---|

**Part 2 — One paragraph for Reuben (≤200 words):** the budget-allocation question, not the code-quality question. *Across these six products, where does a 30-day pilot get the highest signal at lowest risk?* Name **one product** + **one specific repo module/component** + **the smallest evidence-gap to close before that pilot starts**. If nothing has sufficient evidence, say so and name the smallest gap that unlocks the first credible pilot. A decision a non-technical partner can act on.

---

## Final deliverable
Fidelity tier + `SOURCE_COMMIT` at top. Pre-flight test split. Pass A findings table (three-state verdicts) + Pass B area review + Pass C paragraph. If Squire is the audience, append the Squire lens (per-product table + Reuben paragraph). Cite line numbers throughout.

---

## Quick gut-check (10-minute version)
Paste into any chat AI with the snapshot URL:

> Review `github.com/KStratMD/Preston-Test-reviewer-snapshot` — curated public snapshot of an AI integration governance product for executive evaluation. Don't grade code style. First, note: this is a curated mirror, so a few test suites fail to *load* due to intentionally-excluded files — separate those from real assertion failures and don't report mirror gaps as code defects. Then answer, citing `file:line`:
>
> 1. Does `metrics.json`'s connector partition match what the source does? Spot-check NetSuite + HubSpot.
> 2. Are the proof cards under `docs/review/proof-cards/` real evidence (Status / Tests / Live vs Fixture / Known Gaps) or dressed-up prose?
> 3. The pitch is "AI governance for ERP integration that doesn't host client data." Does the codebase structurally enforce that — DLP at every egress chokepoint, `guardedWrite` ownership, reference-based workflow payloads (ADR-019), tenant kill switch — or only claim it?
>
> One paragraph: recommend a 30-day pilot? Yes/no, grounded in findings, and say what the pilot would prove that the code alone cannot.
