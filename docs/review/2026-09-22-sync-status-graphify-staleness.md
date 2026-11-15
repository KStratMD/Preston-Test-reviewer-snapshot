# SessionStart graphify staleness report and bounded fetch — review and merge closeout

Date: 2026-09-22. Implementation, twenty-one review rounds across three independent
reviewers, Linux parity at exact SHAs, final CI and the owner-approved merge are
complete; this record holds their evidence. It is a dated record, not a fresh probe.

Executors: Codex (implementation through `865d250ca`) | Claude Fable 5.1 (rounds 17–21:
comment corrections, CI-gate fix, harness pin, description) | host MSI | worktree
`C:/Users/kstra/Repos/Preston-Test/.worktrees/graphify-staleness` | branch
`fix/sync-status-graphify-staleness` | base
`359731de990c26042cc40a088b5f1a90f1cc6175` | Linux gate locator
`/home/kstratmd/repos/Preston-Test-pr1317-r17` (removed after the merge).
Independent reviewers: Copilot (automatic), Codex glm-5.3 at high effort (the
owner-assigned gate for the rounds Claude executed), and Claude Opus 5 (owner-assigned
for the rounds Codex executed, and supplementary at round 17). No reviewer reviewed a
round it executed.

## What shipped

`scripts/sync-status.sh` gains a report-only graphify freshness check and a bounded
`git fetch`; `tests/scripts/sync-status.test.sh` grows from 20 scenarios to 53.
`scripts/check-inbound-links.mjs` and `tests/scripts/check-inbound-links.test.sh`
gain one exclusion entry and the scenario that pins it, both required by the first
CI run and by Copilot's review of it.

The freshness report fires when any **indexed** file under `src`, `tests`, `scripts`
or `public` is newer than `graphify-out/manifest.json`, scoped by extension and
anchored on the manifest so a deleted indexed file is also reported. It is
report-only; the harness asserts HEAD and the worktree are unchanged, and the check
is silent when the graph is absent or current.

The fetch bound is one absolute wall-clock deadline (`FETCH_BUDGET_SECONDS`, default
8s) computed once where the fetch starts, enforced on both the coreutils arm and the
polled arm that stock macOS uses, with the three pure-local reports moved above it so
a stalled fetch can no longer suppress every signal the script exists to emit.

## Review rounds

Rounds 1–16 are recorded in the [pull request description](https://github.com/KStratMD/Preston-Test/pull/1317),
which carries the per-round finding→fix tables, the mutation sweeps and the exit-code
measurements. Rounds 17–21 closed the review:

| Round | Reviewer | Head | Verdict |
| --- | --- | --- | --- |
| r17 | Claude Opus 5 (supplementary) | `865d250ca` | FINDINGS — 0 blocking, 0 medium, 4 low; 7 mutants (6 killed at named assertions, 1 survived by construction) plus a red-first proof that the pre-fix script fails the new sub-arm |
| r17 | Codex glm-5.3 (gate) | `865d250ca` | FINDINGS — the same four, each confirmed independently |
| r18 | Codex glm-5.3 | `5758ac6b9` | code cleared; two description defects, then `VERDICT: CLEAR` on the corrected description |
| r19 | Codex glm-5.3 | `5ce3d2c3c` | CI-gate fix judged correct; two record findings |
| r20 | Codex glm-5.3 | `b8008b23e` | `VERDICT: CLEAR` |
| r20 | Copilot | `5d99ab90e` | Findings: 1 — the new exclusion entry was pinned by no harness scenario |
| r21 | Codex glm-5.3 | `f4fa4bcef` | `VERDICT: CLEAR` — Scenario Y judged non-vacuous, its own red-first mutants both fail at Y |
| r21 | Copilot | `2a7ae8713` | **Findings: None**, zero new inline comments, 0 unresolved threads |

The round-17 findings that reached code, both confirmed by two independent reviewers:

1. **The residual paragraph overclaimed the clock discriminator.** `fetch_deadline` is
   a truncated `date +%s` second taken before `timeout` starts, so an external SIGKILL
   landing in the deadline second — up to about 1s before the budget truly expires —
   is still read as the deadline. Measured 3/3 at 7.155 / 7.233 / 7.551s of an 8s
   budget (Opus 5) and at 1.073s of a 2s budget (Codex). The comment now states the
   direction that was proved and discloses the truncation window as a residual. The
   load-bearing direction is unchanged: a genuine `-k 1` escalation lands at
   `fetch_deadline + 1` or later by construction, so it can never be misread as an
   interrupted fetch.
2. **The new sub-arm's comment named the wrong arms.** It credited the parked and
   slow-live arms with pinning the 137-as-deadline reading; those arms honour TERM and
   see rc 124. A mutant that broke only the escalation half passed them and the new
   sub-arm, and was caught only by the TERM-ignoring escalation arm.

## Verification

| Gate | Result |
| --- | --- |
| Windows Git Bash suite at `5758ac6b9` | 53 PASS / 0 FAIL / rc 0 (bash 5.2.37, git 2.50.1.windows.1, coreutils `timeout` 8.32) |
| Linux parity at `5758ac6b9` | 53 PASS / 0 FAIL / rc 0, detached at the exact SHA, Node v22.22.2 via `fnm`, bash 5.2.21, `gtimeout` absent |
| Linux parity at `5ce3d2c3c` | 53 PASS / 0 FAIL / rc 0, same bytes and hashes |
| `check-inbound-links.mjs` at #1317's final tree `81dc8547e` | PASS, 2670 files, 6772 repo-relative refs, 0 broken |
| `check-inbound-links.test.sh` at #1317's final tree `81dc8547e` | All 26 checks passed |
| Red-first on the harness pin | entry removed and entry mistyped both fail at Scenario Y after 25 PASS, rc 1 |

Both link-checker figures are measured on the tree #1317 merged, which is the subject
of this record. The scan totals move as files are added: this record is itself under a
scanned directory, so the tree that introduces it reports higher counts, which its own
pull request states rather than restating them here as if they described `81dc8547e`.

Suite counts are taken from the logs' `PASS` lines, never from the suite's own summary
line, because that line is a literal in the test file and can disagree with what ran. The
logs are machine-local and are not committed: Windows `C:\tmp\r18\suite-r18-win2.log`
(with `suite-r18-win2.rc`) and the disclosed first run `suite-r18-win.log`; Linux
`C:\tmp\r18\verify-wsl-suite-r18.log` and `verify-wsl-suite-r19.log` (each with its `.rc`
and a header recording the tested SHA, hashes and byte sizes); round-17 and round-21
verdicts `r17-review-verdict.md`, `r17-codex-review-verdict.md`, `r18-codex-review-verdict.md`,
`r18b-codex-review-verdict.md`, `r19-codex-review-verdict.md`, `r20-codex-review-verdict.md`,
`r21-codex-review-verdict.md`. A future reader without that machine has the summarized
results here plus the GitHub-side evidence (check runs, review IDs, SHAs), which is what
this record is auditable from; the logs themselves are not durable repository evidence.

A first Windows run at `5758ac6b9` exited 1 at the machine-global parked-sleeper delta
guard while a second copy of the same suite was running on the box; that is the
concurrency limit the guard's own failure text states. The re-run alone is the 53/53
above, and the identical bytes were 53/53 on Linux in the same window.

## PR, final CI, and merge closeout

The first unsuppressed head `63d3a021e` was 13 of 14 checks green and failed
`Build, Lint, and Test` at its blocking inbound-link audit: eleven path-shaped strings
in `tests/scripts/sync-status.test.sh` that are fixture inputs, not references. The
checker keeps an explicit exclusion list for exactly that shape of bash harness;
`5ce3d2c3c` added this file to it, `b8008b23e` corrected the comment describing how
those fixtures are produced, and `f4fa4bcef` added the harness scenario that pins the
entry after Copilot found it unpinned.

The third unsuppressed head `2a7ae8713d72b777ada92955ba0ed569dc180d8e` ran **14 of 14
checks green** and carried Copilot review `5275833474` with **Findings: None** and zero
unresolved threads. Owner-approved [PR #1317](https://github.com/KStratMD/Preston-Test/pull/1317)
merged at `2026-09-22T09:02:45Z` as `d8fcaad8f03d8ee16bea5330334efada0dfe613c`,
pinned with `--match-head-commit` to that head. The merge commit's tree
`81dc8547e574fbbfd47aafdae83fe04fe31f0b8d` is byte-identical to the tree that ran green
and cleared review.

**No `ci-minimal` matrix run exists on the merge SHA, by owner decision.** `gh pr merge
--squash` was run without an explicit message, so GitHub composed the squash message from
the PR title plus every commit subject; pre-review heads carry the repo's suppression
convention in their subjects by the rule in `AGENTS.md` Part 1, so the composed message
suppressed the event-triggered workflows on `d8fcaad8f0`. Stated precisely, because an
earlier draft of this paragraph said "no Actions run" and that is refuted: eight
`Blueprint verification` runs exist on `d8fcaad8f0`, all `workflow_dispatch`, all
successful, created between `12:08:37Z` and `12:30:38Z`. What is missing is the required
matrix, which is the substantive point. The owner accepted tree-equivalence to the
14/14-green head rather than push a commit to `Working-Branch` to manufacture a run:
`ci-minimal.yml` has no manual dispatch, and the next promotion PR to `main` runs the
full matrix over this content. Future merges pass the reviewed body explicitly and
check the composed message for the marker before merging.

The [merge-closeout comment](https://github.com/KStratMD/Preston-Test/pull/1317#issuecomment-5776058531)
carries the same evidence on the pull request; its wording was corrected in the same
pass as this record, because it originally carried the same refuted "no Actions run"
sentence and would otherwise have pointed readers at contradictory evidence.

## Follow-ups recorded, not fixed here

- **Polled-arm one-second budget.** With `FETCH_BUDGET_SECONDS=1` on a host without
  coreutils `timeout`, the arm TERMs one poll tick before the deadline and that tick is
  the whole budget, so a healthy fetch is cut and reported as deadline-cut. Reproduced:
  budget 1 → `fetch deadline (1s) reached` with the script done in 1.94s; budget 2 →
  3.65s. It needs an explicit operator override of 1 on a non-coreutils host; the
  shipped default is 8s, pinned by name, and every CI, Windows and WSL path takes the
  coreutils arm. Fix shape: TERM at the deadline when the budget is 1, or floor that
  arm at 2, pinned by a named scenario.
- **The worktree status loop is still unbounded** and runs above every other report, so
  a worktree on an unresponsive path suppresses the branch scan and the graphify check
  exactly as the pre-reorder fetch did. It is 8842ms of a 10421ms local total at 85
  worktrees; no bound in this work touches it.
- **`scripts/resolve-shared-handoff.mjs`** has the same unbounded-network-call shape
  (`execFileSync('git', ['fetch', ...])` with no timeout option), and
  `scripts/latest-handoff.sh` is its other consumer. A SessionStart-chain process was
  found parked about 5h57m in that shape during this work.
