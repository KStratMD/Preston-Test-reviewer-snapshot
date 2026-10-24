# Documentation maintenance closeout

**Execution base:** `8f12323e8d25bc80d2ee0f4f57add18bbb9720f4` on `origin/Working-Branch`  
**Executor:** Codex | **Independent reviewer:** Claude Fable
**Scope:** Tasks 4–7 of the [maintenance and documentation plan](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md).

## Outcome

Implementation is complete on merged PR #1308; review, CI, and merge finished on 2026-09-15. The inventory records 1,781 repository documentation, generated, hosted, workflow, and build surfaces with their source/build owner, evidence source, verification path, and publication boundary. Dated archive content is preserved. Canonical navigation, provider wording, Blueprint activation and freshness wording, current measured test evidence, and missing readiness-package copies are repaired. Root and document-relative Markdown links now fail closed.

The repository can establish that its active canonical sources and structural gates are current at the tested SHA. It cannot claim every mounted API operation is present in `openapi.full.yaml`: the route gate reports 807 mounted operations, 783 shrink-only baseline entries, and 45 operations in the generated Swagger surface, of which 44 are absent from `openapi.full.yaml`. Every baseline entry is dispositioned in [the route classification](2026-09-15-openapi-route-coverage-classification.csv). Rows marked `active documentation gap` require a scoped API-contract lane; the green ratchet prevents growth but is not a completeness certificate.

## Fresh evidence

| Evidence | Result |
| --- | --- |
| Unit profile | 15,616 passed, 10 skipped; 733 suites passed and one skipped |
| Integration profile | 935 passed, 16 skipped; 90 suites passed |
| Portal E2E | 20 passed; 2 suites passed |
| Aggregate | 16,571 executed tests passed; 26 skipped; zero failures |
| Jest coverage | 72.47% statements, 62.16% branches, 74.74% functions, 72.97% lines |
| Core ratchet | 2,696 tests passed; all 87 matched files satisfied their per-file budgets |
| Connector audit | 18 total: 5 production-ready, 1 beta, 11 demo-only, 1 stub, 0 live-verified |
| Inbound links | 2,670 files and 6,772 repository-relative references; zero broken |
| OpenAPI route coverage | 807 mounted, 783 baselined, 45 generated-document operations |

These are repository and fixture results, not live-vendor, customer, or production-deployment evidence.

## Publication provenance and retained boundaries

- `docs/reports/TESTING-QUALITY-REPORT.md` is the canonical measured report; its executive-package copy and `public/js/exec-metrics.js` carry the same totals.
- The two manifest-listed ERP readiness briefs now have packaged copies sourced byte-for-byte from `docs/strategic/`.
- Brain1-quartz source PR #40 was independently reviewed at `03dcff46220551f9fe3abb3ef85c94b9c7948967`; its 84 pages rebuild into 525 files, and the checked-in hosted wiki was regenerated from that reviewed tree. Historical wiki snapshots remain outside the baseline-drift number scan because the wiki build has separate source, link, and artifact verification.
- Drive documents, NotebookLM sources, the OneDrive artifact, Cloudflare, and Railway were not written during repository repair. Their current freshness remains unverified until the owner approves the concrete publication set. NotebookLM operations now require explicit source refresh and verification after Drive writes.
- `blueprint-verify` is required as recorded in the activation evidence. Green means structurally valid; `assertFresh` remains the authority before consumption or execution.

## Verification and next actions

Structural audits passed for baseline drift, connector status, proof cards, terminology, shared handoff, CLI-agent mirror, and inbound links. API Markdown regenerated cleanly. The served-spec drift check requires a running application and remains a retained follow-up. Linux-only link regression passed at exact SHA 9a8886f4c51373a8e8ac791acaedad31733f5275; metric verification passed at exact SHA 863be330082801194dd6e0bca6ad0cbc52e23112. Claude independently surveyed the source and identified corrections; its final confirmation attempt hit its session limit after the last four fixes, and Copilot independently reviewed the resulting Brain head with no new findings.

The served-spec drift check subsequently passed against a local application and matched
`openapi.full.yaml`. Claude Fable's first two source-selecting attempts exhausted their turn
limits without verdicts; a tool-free review of the immutable diff returned seven findings.
The two medium parser findings were fixed: `./` is always document-relative, while an
unprefixed scan-directory path retains the documented repository-root convention. Placeholder
fragments no longer exempt a missing target, and new regressions cover those cases plus the
repository-escape guard. The metrics payload moved to schema version 2 because `build_sha`
changed semantics; repository search found no non-test consumer coupled to version 1. The
generated/gitignored-target observation is retained as low-risk follow-up because the expanded
Markdown scan intentionally checks repository files outside the five scan directories; CI in a
clean checkout remains the authoritative run. Whole-file exclusions remain limited to named
historical/template evidence and generated wiki output, whose own build runs separate link and
artifact verification.

External publication and Working-Branch/main merges retain their separate approval boundaries under the plan.


## Exact-SHA Linux verification

WSL Node v22.22.2 verified Preston `098f40ce588a9466dd9f682e1853751bf3725f47` with Brain1-quartz `03dcff46220551f9fe3abb3ef85c94b9c7948967`. The inbound-link harness passed all 24 checks; the hosted build completed, AI-bundle verification passed, hosted artifact verification passed, and hosted smoke checks passed. A byte-for-byte comparison of regenerated public/wiki remains non-deterministic across Windows and Linux for generated source maps, archives, PDFs, and one alias redirect; those generated bytes are therefore not claimed as reproducible evidence.
