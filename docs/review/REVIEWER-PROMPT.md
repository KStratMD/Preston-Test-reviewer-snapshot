# Reviewer Evaluation Prompt — Preston-Test / SuiteCentral 2.0

**Audience:** outside reviewers (engineers, architects, AI assistants with repo access) doing an evidence audit and architecture review for executive evaluation.
**Repo:** [`KStratMD/Preston-Test-reviewer-snapshot`](https://github.com/KStratMD/Preston-Test-reviewer-snapshot) — curated public snapshot of a private B2B ERP integration platform. Auto-republished from upstream `main` on every merge; provenance pointer at `SOURCE_COMMIT`.
**Goal:** answer two evidence questions and produce a one-paragraph recommendation a non-technical partner can act on.

---

## How to run this

Three tiers, in descending order of fidelity. Note which tier you used at the top of your output; some Pass A questions require code execution and will be marked **could not verify** if you couldn't run them.

| Tier | Setup | What you can answer |
|---|---|---|
| **Best** | Clone the snapshot locally, `npm ci`, run recipes verbatim | All of Pass A + all of Pass B |
| **Acceptable** | Browse the snapshot inside a tool with repo context (Claude Code, Codex CLI, Cursor, Gemini large-context) | Most of Pass A from `metrics.json` + proof cards; all of Pass B from source |
| **Minimum** | Paste this prompt + the snapshot URL into Claude.ai or ChatGPT, let it fetch what it can | Pass A questions about `metrics.json` and proof cards; Pass B answered structurally from named files |

---

## Mandate

Your job is **not** to grade code style or suggest refactors. Your job is to answer two questions:

1. **Are the project's production claims supported by source-level evidence?**
2. **Is the architecture coherent on its own terms?**

Two passes, in order. Pass B's verdict should be grounded in what Pass A reveals about what the repo actually ships vs. what it claims. Then write Pass C — one paragraph for leadership.

---

## Ground truth — trust these over README/marketing prose

1. **`metrics.json`** (root) — deterministic snapshot:
   - `connectors{}` — partitioned by status (production / beta / demo_only / stub) — verified by `npm run audit-status-claims`
   - `dlp_patterns{}` — total pattern count — drift-checked by `npm run verify-metrics`
   - `tests{}` — populated from `jest --json` output; informational only (excluded from mirror drift check)

2. **`docs/review/proof-cards/*.md`** — per-component evidence cards (Status / Source / Tests / Live vs Fixture / Known Gaps / 60-second verification recipe). Structure enforced by `npm run audit-proof-cards`. Template: `_template.md`.

3. **`SOURCE_COMMIT`** (mirror root) — provenance pointer to upstream SHA + ref + run URL.

4. **`docs/connectors/CONNECTOR_STATUS.md`** — canonical connector partition with file paths and status evidence.

For each component, run its proof card's "60-second verification" recipe verbatim. If it fails, that's a finding. If a claim has no proof card and no source in `metrics.json`, that's also a finding.

---

## ═══════════════════════════════════════════════════════════════════════
## PASS A — EVIDENCE AUDIT
## ═══════════════════════════════════════════════════════════════════════

Answer with `file:line` citations. No recommendations.

### Q1. Connector production status — real HTTP or demo fallback?

Does every connector declaring `productionStatus = 'production'` actually exercise real HTTP against the vendor (vs. demo fallback via `isDemoMode()` / `isTestEnvironment()` or `MockConnectorBase`)? Spot-check **2 of**: NetSuite, Salesforce, Business Central, HubSpot, ShipStation.

### Q2. DLP pattern partition

DLP claims a total of 14 patterns with 6 field-gated (see `metrics.json:dlp_patterns.count`). In `src/services/security/DLPService.ts`, grep for `requiresFieldContext: true,` (with trailing comma — this matches only pattern-registry object entries, not JSDoc header or type-definition lines). The result should be exactly 6 lines. The six field-gated patterns are: `phone_intl`, `bank_account`, `date_of_birth`, `passport`, `drivers_license`, `name`. Does the grep count match, and are the matched entries these six types?

### Q3. MCP auto-redaction false-positive guard

`MCPAggregatorService.ts` (~line 215) auto-redacts MCP tool output. Field-name gating is supposed to prevent false-positive redaction of phone-shaped tokens (e.g., `+12.3456.7890` in non-phone fields). Read the gating logic and the fixture test at `tests/integration/MCPAutoRedact.fixture.test.ts`. Does the test actually pin this contract, or pass for the wrong reason (e.g., wrong assertion target, fixture too loose)?

### Q4. Test pass count and skip discipline

The README badge claims a unit-test pass count. **Don't trust the badge** — run `npm run test:ci -- --json` (unit profile, `jest.ci.config.cjs`) and compare. Do all skipped sites have entries in `tests/SKIPPED-TESTS.md`? (The skipped-tests file is excluded from this snapshot — flag if a skip lacks visible justification on its own line.)

### Q5. AI accuracy claims

Are claims about "production AI accuracy" (look for percentages in README, executive package, strategic docs) backed by a benchmark, evaluation harness, or only marketing prose? Look for: a deterministic test set, a measurement script, repeatable scoring. Absence is a finding.

### Q6. Honesty discipline as load-bearing infrastructure

The repo treats honesty discipline as enforced infrastructure: `productionStatus` static fields, proof cards with structural audit (`audit-proof-cards`), source-claim audit (`audit-status-claims`), `.core-coverage-budget.json` ratchet, `tests/SKIPPED-TESTS.md` discipline, public reviewer mirror with `SOURCE_COMMIT` provenance.

**Spot-check:** pick one connector that *changed status* in git history (e.g., demo → production). Did the proof card, audit registry, `productionStatus` field, and `metrics.json` all move together in the same PR? Or did one drift?

This question matters because the project's pitch is governance — if the project can't keep its own claims aligned with its own source, the pitch doesn't survive contact with a SOC 2 audit.

### Pass A output format

Per finding:

| Field | Value |
|---|---|
| Claim text (verbatim) | *…* |
| Source you checked | `file:line` or command |
| Evidence | `file:line` excerpt or command output |
| Verdict | supported / partially supported, gap is X / unsupported |

---

## ═══════════════════════════════════════════════════════════════════════
## PASS B — ARCHITECTURE REVIEW
## ═══════════════════════════════════════════════════════════════════════

Evaluate the architecture against the project's own stated design principles (listed below):

1. **ERP-Native** (embedded sidecar, not separate app)
2. **AI-Assisted, Human-Approved** (approve-to-apply workflow)
3. **Cost Transparency** (per-provider pricing visible)
4. **Dual-ERP** (NetSuite + Business Central equal citizens)
5. **Built for Ourselves First** (Squire is Customer #1)
6. **Explainable AI** (reasoning traces, hallucination detection)

### Read first (load-bearing, don't skip)

- `docs/adr/ADR-004-DUAL-AI-SYSTEM-DESIGN.md` — production AI proxy vs. demo fallback split
- `src/connectors/` — base class hierarchy + `MockConnectorBase` / `DemoConnectorDecorator` / direct-throw patterns
- `src/services/ai/` — provider abstraction, `IntelligentProviderRouter`
- `src/services/security/` — `DLPService`
- `src/services/ai/orchestrator/` — `GovernanceService`
- `src/middleware/` — auth, rate limiting, demo-mode gating
- `src/inversify/inversify.config.ts` — DI wiring is the architectural spine
- `jest.core.config.cjs` + `.core-coverage-budget.json` — the 15 load-bearing files the project itself names as "what we make production claims about"

### Address each, citing `file:line`

**B1. Production-AI vs demo-fallback boundary**
Boundary between `/api/ai/proxy/*` (production) and `/api/ai/*` (demo fallback). Is the split clean? What happens at runtime if a production credential goes missing — graceful degrade, hard fail, or silent demo fallthrough?

**B2. Connector extensibility**
Adding a 19th connector — count the surface area (interface, DI binding, route registration, demo decorator, proof card, audit registry, tests). Coherent or accreted?

**B3. Approve-to-apply governance loop**
Trace one approval path end-to-end: UI affordance → service call → audit log entry → ERP write. Is it actually a loop with a gate, or a button that calls a write directly?

**B4. AI cost transparency**
How is cost computed at request time? Where does it surface to the user? Estimate or measured?

**B5. DLP/governance-as-middleware — egress surfaces**
`MCPAggregatorService` auto-redacts via `DLPService`. Is that the only choke point, or are there other egress paths (direct ERP writes, AI provider calls, audit log persistence) that bypass DLP? List the egress surfaces and their gating.

**B6. Test pyramid honesty**
The repo uses two coverage profiles (broad CI vs. core 15-file). Look at `jest.core.config.cjs`'s `collectCoverageFrom` + `tests/COVERAGE-EXCLUSIONS.md`. Is the "core" framing legitimate or a way to dodge coverage on hard surfaces?

**B7. Six design principles — enforcement vs documentation**
For each of the six principles, point to the code that **structurally enforces** it (DI binding, middleware, audit gate, type, test) versus where it's documented but not pinned. Aspirational ≠ bad — flag the gap with `file:line` evidence and let leadership decide. Don't propose alternatives.

### Pass B output format

Per area, **two paragraphs max**: what the architecture commits to, where the commitment is structurally enforced vs. merely documented, and the largest concrete risk if shipped to a real Squire production deployment. Cite `file:line`. Don't propose alternatives unless asked — name the risk and stop.

---

## ═══════════════════════════════════════════════════════════════════════
## PASS C — ONE PARAGRAPH FOR LEADERSHIP
## ═══════════════════════════════════════════════════════════════════════

After Pass A and Pass B, write one paragraph (**≤150 words**) answering: *would you recommend Squire sponsor a 30-day evaluation pilot?*

Ground the answer in:
- The most material **Pass A finding** (claim alignment with source)
- The most material **Pass B finding** (structural commitment vs. documentation)

No executive summary of the codebase as a whole. No "overall the project is solid" wrapper. A yes-or-no with reasoning a non-technical partner can act on.

---

## ═══════════════════════════════════════════════════════════════════════
## SQUIRE-SPECIFIC LENS — SuiteCentral Decision Framing (optional)
## ═══════════════════════════════════════════════════════════════════════

If you're reviewing this for Squire & Company / Squire Technology specifically (vs. as a generic outside engineer), add this lens AFTER Pass A and Pass B. Skip it for any other audience.

The primary decision-maker for SuiteCentral 2.0 evaluation is **Reuben Cook** (Chief Strategy Officer | Partner at Squire & Company, and President of Squire Technology). His filter is **per-product, not per-codebase**: for each SuiteCentral product his portfolio already ships, does this repo's evidence support **integrate**, **enhance**, or **replace**? He allocates budget via spreadsheet — anything that doesn't tie to a specific portfolio decision doesn't get funded.

### The six SuiteCentral products

| Product | Owner | What it does | Where it lives today | Status |
|---|---|---|---|---|
| **PaymentCentral** | Preston / Andy / Dave | Stripe ↔ NetSuite + customer payment portal | Inside NetSuite | Sold to clients |
| **CustomerCentral** | TBD | Customer portal into NetSuite | Inside NetSuite | Sold |
| **VendorCentral** (was SupplierCentral) | Lee | Vendor portal into NetSuite | Inside NetSuite | Sold |
| **SyncCentral** | Preston | Generic ERP integration platform | Inside NetSuite + Azure (pass-through transformations only) | ~40+ deployments |
| **Payout Rec** | Sam Dean | Merchant reconciliation tool | Celigo + Azure (NOT inside NetSuite) | Built first; oldest |
| **Elastic Suite** | Connor Bailey | NetSuite ↔ Elasticsearch 2-way | TBD | Sold |

If `docs/review/squire-product-cards/<product>.md` exists in the repo, use it as the per-product evidence index. If not, work from `metrics.json`, the connector partition, and the proof cards directly.

### The three scenarios (per product)

For each product where the repo has relevant evidence, the reviewer should pick one. If evidence is absent, mark **"insufficient evidence — out of scope for this pilot"** rather than guessing.

- **Integrate** — keep the existing Squire product as-is; add this repo's governance/AI/DLP layer alongside as an overlay. Lowest pilot risk.
- **Enhance** — keep the product; replace specific workflow components, provided the reviewer can cite both the existing Squire product surface and the repo component with supporting evidence. Mid risk.
- **Replace** — this repo's stack supersedes the existing product entirely. Highest risk; only credible where the repo demonstrates parity AND a migration story.

### Squire hard constraints (apply as gates, not preferences)

The repo's pitch must survive Squire's stated architectural constraints. Mark any constraint the repo violates as a hard finding.

1. **Zero data hosting (Squire side).** Squire does not host client data — non-negotiable. Azure is permitted only as pass-through. Does this repo's per-tenant model respect that? Inspect the secret-manager design, audit-log persistence, and any data-staging surfaces.
2. **Liability split.** Client owns the NetSuite instance → liable for what's there. Squire owns Azure → carries that liability. Any proposed architecture must preserve this division — Azure as zero-data-hosting control plane, not data-holding middleware.
3. **Kill-switch enforcement.** Squire's enforcement mechanism for non-paying clients is revoking the Azure API key → data flow stops. Any SuiteCentral 2.0 architecture must preserve a comparable per-tenant revocation point. Does the per-tenant identity / service-token model retain that?
4. **SOC 2 readiness.** Squire is preparing to attempt SOC 2. Does this repo's governance/audit/DLP/identity-propagation work double as SOC 2 acceleration evidence (audit log retention, DLP policy enforcement, traceable identity context), or does it create new SOC 2 surface area?
5. **"Ready, fire, aim" dev culture + budget ceiling.** Squire's stated dev culture is products sold before stable; always firefighting. Preston Stratford has 20 hrs/year for SyncCentral work, and pilot proposals should not assume Squire-side dev budget. Frame as minimal-effort overlay-on-existing-deployment patterns, not replacement-from-scratch.

### Squire-Specific Lens output format

**Part 1 — Per-product table (one row per product):**

| Product | Repo evidence today (`file:line` or proof card) | Recommendation (integrate / enhance / replace) | Pilot risk (low / mid / high) | Largest gap to close before pilot |
|---|---|---|---|---|

Mark any product with no relevant repo evidence as **"insufficient evidence — out of scope for this pilot"** rather than guessing.

**Part 2 — One paragraph for Reuben (≤200 words):**

Answer the budget-allocation question, not the code-quality question: *Across these six products, where would a 30-day pilot get the highest signal at lowest risk?* Name **one specific product** + **one specific module or component** in this repo + **the smallest evidence-gap that would need to close for that pilot to start**. If no product has sufficient evidence to support any pilot recommendation, say so explicitly and name the smallest gap that would unlock the first credible pilot — don't manufacture a recommendation. Frame as a budget-allocation decision a non-technical partner can act on, not a code review.

---

## Final deliverable

Pass A findings table + Pass B area-by-area review + Pass C paragraph. If Squire is the explicit audience, append the Squire-Specific Lens (per-product table + Reuben paragraph). Cite line numbers throughout. Note your fidelity tier at the top.

---

## Quick gut-check (10-minute version)

For reviewers without time for the full audit. Paste into any chat-only AI tool with the snapshot URL:

> Review `github.com/KStratMD/Preston-Test-reviewer-snapshot` — a curated public snapshot of an AI integration governance product built for executive evaluation. Don't grade code style. Answer three questions, citing `file:line`:
>
> 1. Does `metrics.json`'s connector partition match what the source actually does? Spot-check NetSuite and HubSpot.
> 2. Are the proof cards in `docs/review/proof-cards/` real evidence (Status / Tests / Live vs Fixture / Known Gaps) or marketing prose dressed up?
> 3. The pitch is "AI governance for ERP integration" — does the codebase structurally enforce that (`DLPService`, `GovernanceService`, audit logs, approve-to-apply) or only claim it?
>
> One paragraph at the end: would you recommend a 30-day pilot evaluation? Yes/no, grounded in your findings.
