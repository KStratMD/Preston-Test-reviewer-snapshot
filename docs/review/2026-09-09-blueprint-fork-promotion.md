# Blueprint fork repair promotion candidate

## Scope and provenance

This candidate promotes accepted Working-Branch work through
`8e998e03fafcd662eabe6c2765bcbdb8f7fe829b` to main, whose inspected base is
`f60267254714e3f92053e9a870941503f42a063b`. Main is an ancestor of that
Working-Branch head. Promotion itself requires separate owner approval;
the owner's latest approval merged repair PR #1277 into Working-Branch.

Executor: Codex / OpenAI / MSI / `C:\tmp\gacp-wsb2` /
`codex/blueprint-fork-promotion`, base `8e998e03fafcd662eabe6c2765bcbdb8f7fe829b`.
Reviewer: Claude Fable. Linux locator: MSI / Ubuntu /
`/tmp/preston-full-promotion-linux`. Promotion-tested SHA:
`cce526baa5e683a211d1b0d8edd8d3265fa407b7`, Node v22.22.2.

The inherited changes are limited to these accepted PRs:

- [#1271](https://github.com/KStratMD/Preston-Test/pull/1271): earlier promotion
  closeout and portable connector-chip shell test edits.
- [#1273](https://github.com/KStratMD/Preston-Test/pull/1273): live Blueprint
  event evidence and the reproduced fork-checkout blocker.
- [#1277](https://github.com/KStratMD/Preston-Test/pull/1277): the
  [fork status repair](2026-09-09-blueprint-fork-repair.md), tests and metrics.

The new candidate changes only closeout/handoff documentation. The inherited
production delta is the single conditional workflow checkout and relocated CLI
checkout precondition. No open dependency PR, registry change, business feature,
provider configuration, permission widening or unsafe checkout option is added.

## Verification and rollout

1. Verify the full main-to-candidate diff against the accepted PRs and preserve
   main ancestry. Review status prose independently with Claude Fable.
2. Run the actual Blueprint and portable connector-chip shell harnesses on an
   exact transferred Linux commit, plus focused workflow tests and doc gates.
3. Obtain dedicated Copilot clearance and one final CI run on the reviewed tree.
4. Request owner approval for the concrete promotion PR. No main merge or
   deployment settings mutation is authorized by this preparation.
5. After approved promotion, check the existing Railway/Cloudflare demo rollout
   without expanding their production requirements. Repeat disposable fork
   Blueprint and non-Blueprint PR cases against trusted repaired refs; verify
   new statuses on exact heads, then close those test PRs without merge.
6. Required-check activation remains a separate owner decision after the live
   evidence succeeds. Local and PR-head tests cannot substitute for it.

Both shell harnesses passed at that exact transferred SHA; focused tests passed
78 tests / eight suites / one snapshot. Workflow lint, handoff, inbound links
(3,146 files, 5,689 references, zero broken), agent mirror, terminology and
metrics gates passed. Local log: `C:\tmp\blueprint-promotion-gates.log`.
Review and final CI results are tracked in
[promotion PR #1278](https://github.com/KStratMD/Preston-Test/pull/1278).
No repaired live fork outcome or current deployment health is claimed here.
