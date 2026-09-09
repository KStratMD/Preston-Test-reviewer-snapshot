# Coverage Posture

This document explains the test-coverage numbers and how to read them. It exists
because the blended, repo-wide coverage figure (lines ~67.75%, branches ~56.21%
at time of writing) is a weak signal on its own: it averages the load-bearing
governance code together with demo connectors, AI feature scaffolding, and
generated surface, weighting every line equally. The number that matters for a
governance product is not the average file - it is the **code that enforces
safety**, and that surface is measured and held to a much higher bar.

## TL;DR

- **Blended (whole repo, ~189k lines):** ~67.75% line / ~56.21% branch. Diluted by
  demo connectors, AI feature services, and scaffold that carry no production risk.
- **Core governance surface (the safety chokepoints):** 73-100% branch, median
  ~87%; most files 90%+ line. The per-file table is below.
- The core surface is held to a floor by `.core-coverage-budget.json` /
  `npm run check:core-coverage-budget` (a ratchet - floors only rise).
- The remaining uncovered branches on the core surface are a small, named set of
  mostly-benign error-logging and defensive-guard arms (enumerated below), not
  untested safety decisions.

## Why the blended number misleads

A line in `SampleTypedConnector` (an in-process demo fixture wired to nothing)
counts exactly as much toward the blended figure as a line in `guardedWrite.ts`
(the single chokepoint every connector mutation passes through). They are not the
same risk. The meaningful question is: **how well-covered is the code that makes a
safety decision?** This codebase answers that explicitly via the core-coverage
budget and the table below - and a large fraction of the blended dilution is the
demo/feature surface that a narrowed v1 product would not even ship.

## Core governance surface - per-file branch coverage

Weakest branch first. "Branch" coverage is the meaningful metric here because it
exercises the error/rejection/failure paths, which for a governance platform are
the paths that matter most.

| Branch % | Line % | File |
|---:|---:|---|
| 73.3 | 100.0 | `services/lineage/LineageRecorder.ts` |
| 75.0 | 97.2 | `services/workflowCentral/WorkflowPayloadRetentionJob.ts` |
| 77.3 | 100.0 | `services/cost/CostTransparencyService.ts` |
| 80.6 | 91.1 | `services/governance/handlers/OwnershipResumeHandler.ts` |
| 81.5 | 100.0 | `services/syncErrorAssist/SyncErrorAssistOperatorService.ts` |
| 81.8 | 97.7 | `services/reconciliationCenter/reconcilers/NetSuiteBusinessCentralInvoiceReconciler.ts` |
| 84.6 | 97.3 | `services/governance/ApprovalQueueService.ts` |
| 85.5 | 100.0 | `services/financeCentral/FinanceCentralOperatorService.ts` |
| 86.0 | 95.2 | `services/governance/OutboundGovernanceService.ts` |
| 86.7 | 99.1 | `services/workflowCentral/WorkflowCentralOperatorService.ts` |
| 89.5 | 96.3 | `middleware/rbac.ts` |
| 90.6 | 98.6 | `services/tenants/TenantLifecycleService.ts` |
| 90.9 | 96.4 | `governance/sourceOfTruth/OwnershipResolver.ts` |
| 92.3 | 100.0 | `services/workflowCentral/payload/WorkflowPayloadResolver.ts` |
| 92.8 | 100.0 | `services/reconciliationCenter/ReconciliationCenterService.ts` |
| 93.0 | 96.9 | `services/security/DLPService.ts` |
| 93.9 | 100.0 | `services/workflowCentral/payload/WorkflowPayloadCache.ts` |
| 94.3 | 100.0 | `services/ai/orchestrator/GovernanceService.ts` |
| 96.3 | 97.9 | `governance/sourceOfTruth/guardedWrite.ts` |
| 98.3 | 100.0 | `services/workflowCentral/payload/WorkflowPayload.ts` |
| 100.0 | 100.0 | `governance/sourceOfTruth/SourceOfTruthManifest.ts` |
| 100.0 | 100.0 | `middleware/tenantStatusGate.ts` |

(Numbers are from the snapshot's committed `coverage/coverage-summary.json`;
regenerate with the coverage run to refresh.)

## The residual uncovered branches on the core surface (named)

These are the specific arms not yet exercised, with an honest assessment of each:

- **`WorkflowPayloadRetentionJob.ts` (the two `logger.error` catch paths)** -
  what the ephemeral-payload reaper does when the DB call throws. Worth covering
  because reaper failure behavior is part of the data-liability story (it must not
  crash the interval and must not report a successful sweep on failure). **Covered
  by the companion test `WorkflowPayloadRetentionJob.errorPaths.test.ts`** (ships
  with this posture update).
- **`CostTransparencyService.detectAnomaly` line 49 guard** (`history.length <
  MIN_HISTORY_FOR_ANOMALY`) - the "not enough data to judge" path. **Already
  covered** by the existing `detectAnomaly` test ("returns false with fewer than 8
  rows").
- **`CostTransparencyService.detectAnomaly` line 52 guard** (`trailing.length ===
  0`) - a **deliberate defensive guard that the line-49 check makes unreachable**:
  if `history.length >= 8`, `slice(1, 8)` always yields >=7 elements, so
  `trailing.length === 0` cannot occur via the public API. Left uncovered by
  design; testing it would require contorting input to reach dead-defensive code.
- **`LineageRecorder.ts` (the `canonicalStringify` replacer arms)** - the
  object-sorting / `Array.isArray` branches inside deterministic JSON
  canonicalization. **Benign serialization plumbing, not a safety decision.** Left
  uncovered by design; this is why the lowest-coverage core file by percentage has
  the *least* safety-relevant uncovered code - a concrete illustration of why the
  raw percentage misleads.
- **The remaining 80-90% files** (operator services, approval queue, outbound
  governance) have small numbers of uncovered arms, predominantly secondary
  error-logging and lost-race branches. `OutboundGovernanceService` (the DLP egress
  gate) is the highest-value next target because its error paths are the most
  safety-relevant of the group; pushing it toward the 90s is the recommended next
  increment.

## What we deliberately do NOT do

- We do not raise the blended number by adding tests to demo connectors or
  scaffold. That is effort spent on code that carries no production risk, purely to
  move an average - and on an honesty-discipline product, optimizing the metric
  instead of the thing it measures is the wrong move.
- We do not test unreachable defensive guards or benign serialization plumbing
  to chase 100%. We document them as deliberate instead (above).

## For reviewers

The claim this document makes - *the safety surface is strongly covered; the
blended figure is diluted by demo code we do not claim* - is verifiable: regenerate
coverage, read `coverage/coverage-summary.json`, and filter to the files in the
table above. The core-coverage budget (`.core-coverage-budget.json`,
`npm run check:core-coverage-budget`) enforces the floor in CI so the core surface
cannot silently regress.