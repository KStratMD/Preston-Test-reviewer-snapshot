# ADR-015 — Canonical Connector Registry

**Status:** Accepted (PR 6A, 2026-05-04). Consumption rewiring landed in
PR 6A-2, 2026-05-04 — `ConnectorManager.createConnector()`,
`inversify.config.ts`, `IntegrationService.getConnector()`, and three
ancillary route/integration sites all now route construction through the
registry's per-entry `factory(systemId, deps)` closure. The `factoryAvailable`
boolean is gone; presence of a `factory` closure is the canonical signal.
**Decision drivers:** New-connector contributor friction; reviewer-evidence
drift between source-level claims, factory wiring, DI bindings, and proof
cards; PR 13 (Source-of-Truth Manifest) needs an authoritative connector list
to cross-reference owners against.

## Context

Before this PR, "what connectors do we have?" required cross-referencing
four locations:

1. **Source AST scan** — `src/connectors/*Connector.ts` (and the
   `*ConnectorProd.ts` legacy naming exception): each connector's
   `static readonly productionStatus` field is the per-class tag, scanned by
   `scripts/lib/connector-scan.mjs`.
2. **`ConnectorManager.createConnector()` switch** — the integration-flow
   factory in `src/services/integration/ConnectorManager.ts`. Knew about 11
   of the 18 connector classes via a hand-maintained `switch (systemType)`.
3. **`inversify.config.ts` bindings** — `TYPES.<Name>Connector` symbol
   bindings using `toDynamicValue` factory closures. Bound a different
   subset of 7 connectors. A long-standing TODO in the config noted "Once
   all connector constructors and `@inject`/`@unmanaged` annotations are
   uniform, we can revert to plain `.to(...)` factory bindings."
4. **Proof cards** — `docs/review/proof-cards/<name>-connector.md` for
   every production connector + 1 beta + 1 stub (PR 4).

Each location drifted at its own pace. The CI gate
`audit-status-claims --check-proof-cards` already covers the source AST ↔
proof-card axis, but not the source ↔ factory ↔ DI axes. PR 13 (Source-of-
Truth Manifest) needs (3) — every `OwnershipDeclaration.owner: SourceSystem`
must reference a connector that exists; without an authoritative list, the
manifest's CI gate has no anchor.

## Decision

We collapse *ownership* of "what connectors do we have, and what's true
about each" to a single declarative file: `src/connectors/connectorRegistry.ts`.
The `CONNECTOR_REGISTRY` array is the source of truth.

**What the audit gate enforces** (registry ↔ source-AST ↔ proof-card
consistency, AND wiring drift after PR 6A-2): every connector class file has
a registry entry, every registry entry references a real connector source
file, `productionStatus` and `proofCardPath` agree between class and
registry, registry-declared keys and classNames are unique and well-shaped,
AND any connector with a registry `factory` closure is instantiated only
inside `connectorRegistry.ts` (no `new <ClassName>(` elsewhere under `src/`).

Per-entry fields:

| Field | Why it exists |
|---|---|
| `key` | Stable identifier used in routes, configs, and `AuthService`. Must be unique. |
| `className` / `classRef` | Lets the audit gate cross-check filename ↔ exported class identity at compile + AST time. |
| `productionStatus` | Mirrors the per-class `static productionStatus` tag; CI fails on drift. |
| `proofCardPath` | Mirrors the per-class `static proofCard`; required for production-tier entries. |
| `credentialRequirements` | Doc-form list of fields needed at `initialize()` time. Used by onboarding docs and the production-readiness checklist. |
| `factory` (PR 6A-2) | Optional `(systemId, deps) => IConnector` closure that encapsulates this connector's exact constructor pattern. Presence of the closure replaces the old declared `factoryAvailable: boolean` — production tier requires it; consumers (`ConnectorManager`, DI bindings, `IntegrationService`) read it instead of `new XxxConnector(`. |
| `diBindingAvailable` | Whether `inversify.config.ts` binds this connector under a `TYPES.<Name>Connector` symbol. Most paths run without DI; this stays a declared boolean because DI bindings retain hand-rolled wrapping concerns (`wrapWithDecorator`, `TYPES` symbols) that aren't generic enough to derive from registry shape alone. |
| `bulkRollbackStrategy` | Forward-looking field consumed by PR 14's `FlowExecutor` for `bulk_upsert` dispatch. Today every entry is `'unsupported'`; PR 14 revises as bulk-write methods land. |
| `notes` | Free-form note for legacy naming exceptions, mock-only paths, etc. |

The audit gate (`audit-status-claims --check-wired-connectors`, baked into
the `audit-status-claims` npm alias and run in `ci-minimal.yml` +
`reviewer-mirror.yml`) fails CI on:

- A connector class without a registry entry.
- A registry entry referencing a non-existent class.
- `productionStatus` or `proofCardPath` drift between class and registry
  (incl. asymmetric cases — class declares one, registry omits, or vice versa).
- A `'production'` entry without a `factory` closure or no `proofCardPath`.
- Duplicate registry keys or classNames.
- Bad key shape (must match `/^[a-z][a-z0-9_]*$/`).
- Invalid `productionStatus` literal (must be one of `production`, `beta`,
  `demo_only`, `stub`).
- `proofCardPath` outside `docs/review/proof-cards/`, in a subdirectory, with
  `..` traversal segments, or without a `.md` extension (mirrors the
  class-level `static proofCard` validation).
- **Wiring drift** (PR 6A-2): any registry-factory-wired class is
  instantiated outside `src/connectors/connectorRegistry.ts`. Tests and
  `scripts/` (run-by-hand diagnostic tools) are exempt — the gate's purpose
  is preventing production code from bypassing the registry.

The gate is now both a *consistency* gate (registry ↔ source-AST ↔ proof-card)
AND a *wiring* gate (registry ↔ actual `new` sites in production code). The
`factory` closure presence replaces the old `factoryAvailable: boolean`
because a stale boolean could drift from the actual closure presence.

Adding connector #19 is documented in AGENTS.md → "How to add connector #19"
as a one-stop walkthrough.

## Scope split: PR 6A vs PR 6A-2 (both shipped 2026-05-04)

PR 6A delivered the registry data structure, the consistency audit gate, and
the docs. Five days of constructor-variance discovery in PR 6A surfaced a
fifth distinct shape (SuiteCentral's 5-arg form) — splitting the consumer
rewire to PR 6A-2 kept each PR to ≤2 review rounds (the loop-discipline
recipe in `feedback_ai_review_loops.md`).

PR 6A-2 then made the consumers read from the registry:

- `ConnectorManager.createConnector()` — switch replaced with
  `getConnectorRegistration(systemType.toLowerCase())?.factory(systemId, deps)`.
- `inversify.config.ts` — five connector bindings (NetSuite, Shopify,
  ShipStation, HubSpot, SuiteCentral) now construct via `entry.factory(...)`;
  the binding still applies `wrapWithDecorator` and the `TYPES` symbol,
  preserving DI-side concerns. Squire and SuiteCentralConnectorProd remain
  hand-rolled because they have no `factory` closure (DI-only by design,
  not reachable through `ConnectorManager`).
- `IntegrationService.getConnector()` — its parallel switch was deleted; it
  now maps PascalCase systemTypes ('NetSuite', 'Dynamics365', ...) to
  registry keys and routes construction through the registry factory.
- Three additional drift sites caught by the new wiring-drift scan
  (`src/integrations/SuiteCentralNetSuiteSync.ts`,
  `src/routes/connectorTest.ts`, `src/routes/fullPipelineDemo.ts`) — all
  rewired to call `entry.factory(...)`.

The `factoryAvailable: boolean` field was dropped from the registry shape
in PR 6A-2 because the closure's presence/absence is now the canonical
signal — no boolean to drift.

The five constructor shapes (BC/NS/SF 4-arg, Dynamics/Oracle/SAP 3-arg,
HubSpot/ShipStation 2-arg, Shopify 2-arg-with-id, SuiteCentral 5-arg) are
each captured in the per-entry `factory` closure, ending the
`@inject`/`@unmanaged` annotation drift the original `inversify.config.ts`
TODO called out.

## Alternatives considered

- **Decorator-driven registration** — `@RegisterConnector({...})` on each
  connector class, collected at module load time. Rejected: requires
  `reflect-metadata` runtime, which `tsconfig.json:experimentalDecorators`
  controls; coupling the registry to runtime initialization order also
  makes audit-time inspection harder (the AST scan would need to evaluate
  decorator calls).
- **JSON registry** — `connector-registry.json` checked in alongside the
  source files. Rejected: loses `classRef` cross-reference (the unit test's
  "constructor.name === className" guard catches accidental misalignment),
  and JSON has no place to attach explanatory `notes` that survive
  deduplication tooling.
- **Live registry generated from AST scan** — derive the registry on every
  CI run rather than checking it in. Rejected: the registry has fields that
  AST scan can't infer (`credentialRequirements`, `bulkRollbackStrategy`,
  `notes`); it would be a cache of class state, not a contract.

## Consequences

**Positive**:
- New-connector contributor has one obvious file to update (`connectorRegistry.ts`)
  + the per-class static fields, both caught by CI.
- Reviewer-evidence drift between source / factory / DI / proof cards is
  caught at PR-time, not at audit-time.
- PR 13's `OwnershipResolver` can `import { CONNECTOR_REGISTRY }` directly
  to validate that every `OwnershipDeclaration.owner` references a real
  connector.

**Negative**:
- Two registry-vs-class fields (`productionStatus`, `proofCardPath`) are now
  declared in two places. The CI gate enforces equality, but the redundancy
  itself is friction — easier to drift, easier to merge a "fix one, miss
  the other" PR. PR 6A-2's consumption of the registry as the read path
  (replacing AST scan calls) is the natural place to single-source these.
- `bulkRollbackStrategy` is forward-looking and not exercised today. Risk:
  values become stale before PR 14 lands. Mitigation: PR 14's `FlowExecutor`
  is the consumer; it will fail loudly if any value disagrees with the
  connector's actual bulk-write capability when the dispatch wires up.

## References

- Plan: `docs/plans/2026-05-01-a-grade-remediation-plan-merged.md` § PR 6A
- Audit script: `scripts/audit-status-claims.mjs` (`--check-wired-connectors` flag)
- Helper: `scripts/lib/connector-scan.mjs` (`parseConnectorRegistry()`)
- Tests: `tests/scripts/audit-status-claims-wired.test.sh`,
  `tests/unit/connectors/connectorRegistry.test.ts`
- Walkthrough: AGENTS.md § "How to add connector #19"
