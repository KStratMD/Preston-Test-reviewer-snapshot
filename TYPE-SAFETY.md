# Type Safety Posture

This document explains how `any` / `as any` / `@ts-ignore` / `@ts-expect-error`
usage is distributed across the codebase and how it is enforced. It exists
because a raw repo-wide count of `any` (~510 at time of writing) is a
misleading signal on its own: it does not distinguish a benign cast in a demo
connector from one in the code that enforces a security decision. The two are
not the same risk, and this codebase treats them differently.

## TL;DR

- **The core governance surface — the files that enforce safety — holds zero
  `any` / suppression escape hatches** (`as any`, `: any`, `any[]`, generic
  `any`, `@ts-ignore`, `@ts-expect-error` are all at **0** across the 87 files
  in the set).
- That number is **enforced by a CI gate** (`scripts/check-core-type-safety.mjs`
  + `.core-type-safety-budget`, budget = `0`) that fails the build if a new
  escape hatch lands in the core surface, and is **fail-closed** — a renamed or
  deleted core file makes the gate exit non-zero rather than silently shrink its
  coverage.
- The repo-wide `as any` total is separately capped by `.any-budget` /
  `scripts/check-any-budget.mjs` so the global count cannot grow either.
- The residual repo-wide `any` usage lives in **demo connectors, AI feature
  services that type unstructured model output, library-interop middleware, the
  HTTP route edge, and test fixtures** — surfaces that do not carry production
  safety risk.

## What this gate counts (and what it does not)

This gate counts **`any` and suppression directives** — the escape hatches that
turn type checking *off*: `as any`, `: any`, `any[]`, generic `any` (`<any>` /
`, any`), `@ts-ignore`, `@ts-expect-error`. It does **not** count narrowed type
assertions like `as Record<string, unknown>` or `as DataRecord` — those keep the
type checker engaged on a concrete shape and are a normal, reviewable tool. So
the precise claim is **"zero any/suppression escape hatches in the core safety
set,"** not "zero type assertions."

**Counting technique, stated honestly:** this is *AST-assisted regex counting*,
the same approach as `scripts/check-any-budget.mjs` — **not** a true AST semantic
classifier. The script blanks comment and string/template spans via the
TypeScript scanner/parser (so a `// as any` comment or a `"… as any …"` log
string is not counted), then regex-matches the patterns on the stripped text.
`@ts-ignore` / `@ts-expect-error` live inside comments by definition, so those
two are matched on the raw source.

## Why a count of "~510 anys" is the wrong signal

`any` is a risk exactly where it sits on a decision that affects safety,
correctness, or data handling — and nearly irrelevant where it types a demo
fixture or a third-party library's awkward signature. A flat repo-wide count
weights those equally. The meaningful question is: **how many escape hatches sit
on the code that enforces governance?** This codebase answers that question
explicitly and enforces the answer in CI.

## The two budgets

| Gate | Scope | Caps | Purpose |
|---|---|---|---|
| `.any-budget` (`check-any-budget.mjs`) | Whole typecheck scope | Repo-wide `as any` and 5 related patterns can't *rise* | Global tripwire — the total can't grow |
| `.core-type-safety-budget` (`check-core-type-safety.mjs`) | Curated core governance file set (87 files) | Core any/suppression total (currently **0**) | Proves "zero where it matters," not merely "total isn't rising" |

Both follow the same ratchet philosophy as `.strict-null-budget`: lowering the
budget is always allowed and should happen in the same PR that removes a cast;
raising it requires reviewer sign-off with a note explaining why a core-surface
escape hatch was unavoidable.

## The core governance surface — and the categorical scope line

The set is **derived from the repo's own authoritative surfaces** — the
load-bearing file list in `jest.core.config.cjs:collectCoverageFrom` and the
WorkflowCentral custody audit (`scripts/audit-workflow-central-payload-custody.mjs`)
— restricted by a **categorical rule** so it can't be gamed by cherry-picking:

> **The core set is the governance/safety SERVICE layer + MIDDLEWARE gates +
> `src/governance/sourceOfTruth` + the governance-completing `FlowExecutor`
> slice. It EXCLUDES (a) all `src/routes/**` and (b) IO adapters (connectors,
> AI providers).**

Included (defined explicitly in `check-core-type-safety.mjs`, not a glob, so
adding to it is a deliberate reviewable act):

- `src/governance/sourceOfTruth/` — `guardedWrite` chokepoint + source-of-truth manifest + ownership resolver
- `src/services/security/` — DLP scanner + secret management
- `src/services/governance/` — approval queue, ownership-resume, write-descriptor encryption, identity context
- `src/services/tenants/` — tenant lifecycle + kill switch
- `src/services/workflowCentral/` + `src/services/WorkflowCentralService.ts` — durable workflow engine + reference-based payload custody (the service root file is named by the custody audit)
- `src/services/financeCentral/` — durable approve-to-apply loop
- `src/services/syncErrorAssist/` — AI-assisted sync-error operator loop
- `src/services/lineage/` — record-level lineage
- `src/services/reconciliationCenter/` — reconciliation engine + cadence handlers
- `src/services/cost/` — cost transparency
- `src/services/mcp/MCPAggregatorService.ts` — the DLP auto-redact egress path on every MCP tool result
- `src/database/repositories/TenantConfigurationRepository.ts` — encrypted / secret-bearing tenant config reads
- `src/services/ai/orchestrator/GovernanceService.ts` — the inbound AI governance decision point
- `src/flows/templates/FlowExecutor.ts` — the governance-completing flow execution slice (so named in `collectCoverageFrom`)
- `src/middleware/rbac.ts`, `tenantStatusGate.ts`, `workflowCentralReady.ts`, `syncErrorAssistWebhook.ts` — request-path access / tenant-status / readiness / webhook-verification gates

**Why the exclusions are principled, not convenient:**

- **`src/routes/**` (the HTTP edge)** — route handlers parse `req.query` (typed
  `string | string[] | ParsedQs`), and casting those to enums is the standard,
  low-risk Express-typing friction. The *decisions* those routes expose live in
  the service/middleware layer, which **is** in scope. Including only the
  zero-cast routes while excluding a route that happens to carry casts (e.g.
  `src/routes/workflowCentral.ts`) would be cherry-picking — so the rule excludes
  the route layer **as a category**, not file by file.
- **IO adapters (6 connectors + 5 AI providers + `IntelligentProviderRouter`)** —
  `any` around unstructured third-party HTTP payloads is expected and low-value
  to fight. These are part of `collectCoverageFrom` for *coverage-of-realness*,
  a different concern than *type-safety-of-decisions*.

`jest.core.config.cjs:collectCoverageFrom` is the sibling coverage-surface
source of truth; this type-safety set is its **service/decision subset** (it
drops the connectors, providers, and routes that the coverage surface keeps).

## Where the rest of the repo-wide `any` lives (and why it's acceptable)

- **AI feature services** (`src/services/ai/orchestrator/agents/**`) — forecasting,
  insights, compatibility analysis, mapping suggestion. These type the
  loosely-shaped output of AI providers, which is inherently unstructured. Lower
  risk; not part of the safety chokepoint set. A reasonable place for the *next*
  tranche of cleanup if the global number is driven down, but not a governance risk.
- **Library-interop middleware** — `helmet`, `express-rate-limit`, compression,
  observability. Casts around third-party Express signatures. Low value to fight.
- **HTTP route handlers** — `req.query as X` enum coercion at the edge (see the
  scope-line note above).
- **Demo connectors + scaffold** (demo-only connectors, `SampleTypedConnector`,
  fixtures) — not production code; not wired to real systems.
- **Test files** — excluded from the core gate by construction.

## For reviewers

If you are auditing type safety: run

```bash
node scripts/check-core-type-safety.mjs --list   # per-file core counts; expect total = 0
node scripts/check-core-type-safety.mjs           # enforce; exit 0 only when total == budget
```

and confirm the gate is wired into CI (`.github/workflows/ci-minimal.yml` and
`reviewer-mirror.yml`). The claim this document makes — *the safety surface holds
zero any/suppression escape hatches and is enforced* — is verifiable in one
command, not a matter of trust.
