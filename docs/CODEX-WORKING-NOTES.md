# Codex Working Notes

## Repo orientation

- TypeScript Node app. `Working-Branch` is the feature/task integration branch; promotion to `main` is a separate user-approved PR. Read the current shared handoff for verified heads and test counts instead of embedding volatile values here.
- Executor and independent reviewer are assigned per task: when Codex executes, Claude reviews; when Claude executes, Codex reviews. Neither agent is permanently the primary executor. A substitute independent reviewer requires an explicit assignment; record the executor/reviewer handoff in the PR or session notes.
- **Paired-agent workflow:** the agent executing a non-trivial plan must not be the sole reviewer of its own work. Claude or another independent reviewer reviews Codex-executed plans and implementations; Codex or another independent reviewer reviews Claude-executed plans and implementations. Apply this before implementation (design/plan review) and after implementation (diff/adversarial/verification review), and record the executor/reviewer handoff in the PR or session notes. This rule does not authorize agents to launch the user-opt-in `/ultrareview` command.
- Karpathy principles apply: think-before-coding, simplicity first, surgical changes, goal-driven execution. Spelled out in `CLAUDE.md`.
- **WorkflowCentral governance-without-hosting-data Phase 1 (ADR-019)**: payload is now a `WorkflowPayload` tagged union (refs into the client ERP by default; gated `ephemeral_hosted` exception requires EITHER env `WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD` OR per-tenant setting `workflow.allow_ephemeral_payload = 'true'`). Operator render at `GET /api/workflow-central/tasks/:id/render`. Audit emits via `redactWorkflowPayloadForAudit` — refs only, never ephemeral `data`. Plan: `docs/plans/2026-05-17-governance-without-hosting-data-plan.md`.

## Review mode

**What good review looks like here**
- Find root cause, not symptom. Produce a failing repro before proposing a fix.
- Verify empirically. "The code looks right" ≠ a CI claim. Run the actual `npm` / `node` script and read the output.
- Distinguish required CI checks from advisory ones. `gh pr merge --auto` blocks only on required.
- Surface the smallest possible regression test alongside the fix.

**Failure modes this repo has hit**
- *Silent CI incident (PRs #683–#711, ~30 PRs)*: required checks went green because `test-summary.json` was empty and unverified. Closed in PR #713 with a workflow-level guard. Other artifacts may have the same shape — audit before trusting "CI was green."
- *Plausible-from-code wrong diagnosis*: the silent-CI root cause was first blamed on `jest.teardown.js` `setTimeout`. Empirical bisect proved `forceExit: true` reliably wins. Producing a failing repro would have caught this in one round.
- *Adyen recursion (PR #715)*: bug was `authenticate() → getSystemInfo() → makeRequest() → authenticate()` because Adyen had its own `makeRequest` override that skipped `BaseConnector`'s guard. When a connector's auth path looks safe "via the base class," grep the connector for a class-local `makeRequest` first.

## Status claims and handoff integrity

Added 2026-08-14 after the 08-13 handoff shipped two stale "still open" claims (A6, A8) that the Tranche A checkpoint had already resolved. The claims were copied forward from an earlier handoff; the structural gate passed; a curated fact-check whose prompt supplied the ground truth confirmed them. Both halves of that failure now have rules.

**Select evidence by claim type.** A status claim's authority depends on what kind of claim it is; do not cite a layer below the claim's own, and never copy a prior handoff's status bullet forward without re-verifying it at its authority layer.

1. **Scope / intended behavior** → plans and specs (`docs/superpowers/plans/`, `docs/superpowers/specs/`).
2. **Completion at a specific time** → checkpoints, merged PRs, commits, test records.
3. **Live operational state** → current probes only; a checkpoint is itself stale for live state.
4. **Current synthesis and assignments** → the canonical handoff, downstream of all three.

**Handoff "Still open" entries must carry evidence.** Each entry needs a markdown evidence link and a `verified YYYY-MM-DD` stamp; `scripts/check-shared-handoff.mjs` fails on entries missing either and on repo-relative evidence links that do not resolve. The section's list grammar is deliberately narrow and fail-closed — single-line `- ` entries at column zero carrying their own citation, `  - ` children indented two or more spaces (inert), each dash followed by exactly one space and content, `###` subheadings allowed; any other column-zero content closes the open entry, and star/plus/numbered markers, tabs, extra marker padding, and one-space-indented content of any kind are errors rather than guesses, because an interpretive parser lost an adversarial round per edge case. The gate cannot prove semantic truth — it forces the citation to exist, not to be right. **The heading itself is required**, written exactly as `## Still open` — an absent heading is an error rather than an empty section, and leaving the section empty is how a handoff records that nothing is open (there is no compliant "none" entry, since every entry needs a citation). Requiring the canonical spelling to be PRESENT is what closes the heading-shaped bypasses: a Setext underline, a multiline Setext heading, a raw `<h2>`, or any styled spelling all render as a heading while leaving the canonical line unmatched, which previously skipped the entire section in silence.

**Open-scope adversarial review is mandatory for status artifacts.** A curated fact-check verifies only what the prompt points at, so the prompt author's blind spots survive it. Any review of a handoff or status-claim artifact — by Codex, Copilot, or another agent — must include a pass where the reviewer independently surveys the plans/specs directories and current repository state and attempts to refute each status claim, choosing its own sources. Reviewer ≠ prompt author's mirror.

## Implementation mode

**Commit message conventions**
- Do not include the bracketed CI suppression token in commit message subjects or bodies unless the explicit goal is to suppress CI.
- When discussing this behavior in commit messages, use "skip-ci marker" instead of spelling the token literally — the pre-push hook treats literal occurrences in commit bodies as actual CI-skip directives. The same caution applies to PR titles and descriptions: GitHub uses them as the squash-merge commit message and GitHub Actions parses that final commit, so a literal token there can silently kill CI on the merge SHA. (Documentation files like this one are out of scope; the Enforcement bullet below spells the variants intentionally.)
- The final commit before merge must run CI so required checks are green on the merge commit.
- **Enforcement**: `.husky/pre-push` rejects commit bodies containing any of the five variants GitHub Actions honors (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`). Subject line is allowed (intentional suppression); body is blocked (prose mention there would silently kill CI). Hook bound via `package.json`'s `prepare` script. Bypass with `--no-verify` only when you really mean to skip. Regression: `tests/scripts/pre-push-skip-ci.test.sh`.

**Branch + worktree**
- `main` is the only long-lived branch. The user's `Working-Branch` is never deleted — rebase and force-push, never `--delete-branch`.
- Use git worktrees for parallel work.
- Commits should be logical units. The PR description carries the narrative; the commit message doesn't have to.

**Verification before claiming done**
- Tests: run the relevant profile (not "all tests"), capture pass count.
- Types: `npm run typecheck` exits 0.
- Coverage: `npm run test:coverage:core` then `node scripts/check-core-coverage-budget.mjs`.
- UI: actually exercise the page in a browser. Type checks ≠ feature checks.
- Never claim "passing" / "fixed" / "done" without command-output evidence.

**Budget ratchets — do not silently regress**
- `.any-budget` — caps 6 forms of `any` usage. Prefer `unknown` + narrowing over `as any` / `@ts-expect-error`.
- `.strict-null-budget` — caps `strictNullChecks` errors. Prefer early returns and `??` over `!` non-null assertions or generic `as` casts.
- `.core-coverage-budget.json` — per-file floor for 61 load-bearing files. **Both directions are tracked**: regressions fail CI; improvements without a re-stamp also fail. Re-stamp via the script's `--write` in the same PR.
- Tightening is welcome. Loosening requires reviewer sign-off + a PR-body note.

**Audit scripts that gate CI** (in `ci-minimal.yml`)
- `audit-status-claims` — connector `productionStatus` static fields match the documented 5/1/11/1 partition
- `audit-proof-cards` — proof cards in `docs/review/proof-cards/` match schema; connector cards' `Status:` line matches source-level `productionStatus`
- `audit-skipped-tests` — every `it.skip` / `test.skip` under `tests/` has a heading entry in `tests/SKIPPED-TESTS.md`
- `verify-metrics` — deterministic blocks of `metrics.json` match regen (tests/coverage are tolerance-checked in strict mode; numeric LOC totals are exact when cloc is available)
- `check-inbound-links` — blocking; the historical broken-reference baseline is cleared, so every active reference must resolve.

## PR review loop (Copilot auto, Codex opt-in)

**Copilot** is the standard auto-reviewer on every PR. **Codex `/ultrareview`** is user-opt-in — agents do NOT engage it proactively, do NOT include it in PR opening summaries, and do NOT block merge approval on it unless the user has explicitly launched it on this PR. Merge gate is Copilot clean + CI green.

### Copilot side — always run (driveable from CLI)

- 3–5 rounds per non-trivial PR is normal — bugs → edge cases → consistency → nits.
- Recurring feedback shapes are captured as patterns A–G in `project_session_handoff_2026_04_28_evening.md`. Apply preventively to save 2–4 rounds.
- **Ask reviewers to attack the justifying prose, not only the diff** (rule added 2026-08-11). Comments, PR bodies, and handoff entries carry falsifiable claims (line citations, "cannot fail", "already covered by X") and are where implementer defects repeatedly announce themselves — #1072 had four, #1148's line citations were wrong twice. A round that is clean on code can still overclaim in prose; request an explicit pass on the claims.
- **CI runs ONCE per PR: on the final head, after Copilot has cleared it** (and Codex too, if the user launched `/ultrareview`). **Every earlier pushed head — including the PR-open push and every review fixup, code or docs — carries a skip-ci marker in its SUBJECT.** Reviewers do not need a CI run to review; the pre-push green baseline comes from the local gate sweep (typecheck, lint, suites, audit gates). *(Rule tightened 2026-07-18, superseding the earlier "doc-only fixups may suppress" guidance: each full matrix is ~20 min of paid Actions minutes across ~10 jobs, and running CI on every round exhausted the account's Actions/Copilot budget mid-review, blocking BOTH review loops for hours. Copilot review jobs bill too — when a review returns a spending-limit message, do NOT auto-retrigger on a timer; notify the user.)*
- **The final head must still run CI** so required checks are green on the merge commit. After the last reviewer clears, push one unsuppressed commit (an empty `chore: trigger CI for merge` is fine); if its tree is byte-identical to what the reviewers approved, no re-review is needed. If that run fails, the fix commits are suppressed again, the reviewer re-clears, then one new unsuppressed head.
- The literal marker (square-bracket "skip ci") matches as a substring anywhere in the commit message, including paragraphs explaining you're not using it. Refer to it as "skip-ci marker" in prose. It goes in the SUBJECT only — `.husky/pre-push` rejects the five variants in a commit BODY, and it must never appear in a PR title or description, which GitHub reuses as the squash-merge commit message.

**Trigger mechanics — Copilot review fires only when a `copilot_work_started` event appears in the PR timeline. Verify via:**
```bash
gh api 'repos/<owner>/<repo>/issues/<n>/timeline?per_page=100' --paginate \
  | jq '.[] | select((.event=="mentioned" and .actor.login=="Copilot") or .event=="copilot_work_started" or .event=="copilot_work_finished" or .event=="reviewed")'
```
- **Request the dedicated code reviewer** using GitHub's [documented REST API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review):
  ```bash
  gh api -X POST repos/<owner>/<repo>/pulls/<n>/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
  ```
- **Verify dispatch and completion separately.** GitHub may normalize the reviewer login to `Copilot` in timeline events. An accepted POST or `requested_reviewers: []` proves neither success nor failure. Check for a new `copilot_work_started`, then inspect the resulting review's author, `commit_id`, timestamp, body and inline comments. A `copilot_work_finished` event or short elapsed time alone is not a clean verdict. Clearance applies to the reviewed tree; an empty final CI commit needs no new review when its tree is identical.
- **Re-request after fixes:** update the PR description with the finding-to-fix crosswalk and head, then request the dedicated reviewer. If no new work-start event appears after a bounded wait, use GitHub's native **Reviewers → Re-request review** control. Repeated REST/MCP calls and pushes have silently no-oped; do not invent empty commits or repeatedly bill requests to force dispatch. If the native control is unavailable, report the missing review and request that specific user action. Do not alter automatic-review settings to work around it.
- **Do not use a PR-comment mention to request code review.** In [PR #1259](https://github.com/KStratMD/Preston-Test/pull/1259#issuecomment-5571097962), that recipe launched the cloud coding agent and produced unwanted commits; independent review rejected them and they were reverted with history preserved. The dedicated REST route did produce reviews, including [PR #1261](https://github.com/KStratMD/Preston-Test/pull/1261#discussion_r3951472602), while subsequent repeat requests in that session silently no-oped. This replaces the historical comment recipe.
- **Reproduce findings before fixing them.** Reply in the inline thread with the fix SHA or evidence for rejection, and resolve addressed threads. GitHub documents that replies to Copilot comments are not visible to Copilot; put context needed for re-review in the PR description. A rejected finding is a recorded disposition, not a fresh zero-findings review. Do not call unresolved review delivery or billing failure clearance; preserve the merge gate below.

### Codex side — opt-in only, never proactive

`/ultrareview <PR#>` is user-triggered, billed (3 free runs/session), and **agents cannot launch it** via Bash or any other path. The defaults:
- **Do not suggest** the user run `/ultrareview` after creating a PR. Do not include it in PR opening summaries.
- **Do not block on Codex** for merge approval unless the user has explicitly launched `/ultrareview` on this PR.
- **When the user does run `/ultrareview`**: findings arrive via task-notification autonomously. Treat them like Copilot findings — apply or push back with reasoning, commit, push.
- **Codex does not auto-re-review on push.** After addressing findings, do NOT prompt the user to re-run unless they ask. They'll re-run it themselves if they want another pass.
- Codex's `Verification` section may flag tools it could not run (e.g. `actionlint` not on npm). **Treat that as a gap to fill yourself** — download the binary directly (avoid `curl|bash` patterns) and run it locally.

### Loop exit

Ask the user for merge approval when:
- Copilot's latest review has zero new inline comments since your latest push, AND
- All required CI checks are green (`skipping` is OK for jobs gated by `if:` conditions — e.g. publish jobs gated to `refs/heads/main` won't run on PRs), AND
- IF the user has launched Codex `/ultrareview` on this PR, the latest Codex pass reports nothing actionable. Otherwise Codex is not part of the gate.

User merges manually after explicit approval. Never run `gh pr merge` unless the user has said "merge it."

## Reviewer-mirror snapshot

`reviewer-mirror.yml` builds an outside-reviewer-reproducible snapshot. Some paths are deliberately excluded (`tests/{e2e,load,performance,playwright,provider}/**`, `tests/SKIPPED-TESTS.md`, `docs/archive/**`). Audit scripts that read excluded paths are themselves excluded from the mirror — running them there produces false drift.

When adding a new audit, decide explicitly whether it runs in the mirror. Default: include in `scripts/reviewer-mirror.allowlist.json`. Exclude only if mirror execution would produce false positives (`tests/SKIPPED-TESTS.md` precedent).

## Memory + handoff conventions

- `AGENTS.md` points to the one repository-canonical current handoff. Read that file's Current state and In-flight sections before starting work that depends on live project state.
- **Live handoff authority:** `origin/Working-Branch` is the sole current-state stream between promotions. Before state-dependent work, run `node scripts/resolve-shared-handoff.mjs`; use its `verified` result and named handoff, or stop/escalate if it reports `degraded` or fails. The checkout's `AGENTS.md` pointer remains a local consistency contract, not proof that the checkout is current.
- Claude's platform-generated project memory directory may be junctioned to the OneDrive shared store. `MEMORY.md` and dated memory handoffs are historical indexes or pointers only; they must not duplicate volatile branch, PR, assignment, or deployment state.
- Before work begins, add the assignment to the canonical handoff's In-flight section. Remove it after completion. A handoff written mid-task must receive a closing pass after the work lands so completed work cannot remain current by accident.
- **Lane records and reports carry provenance** (rule added 2026-08-19). Every In-flight lane entry uses the provenance schema in [docs/operations/AGENT-CONTEXT-SOURCES.md](https://github.com/KStratMD/Preston-Test/blob/Working-Branch/docs/operations/AGENT-CONTEXT-SOURCES.md) §"Lane and report provenance": executor, provider, host, absolute worktree, branch, base SHA, Linux gate locator, tested SHA, live process/log evidence when applicable, and reviewer — unknown values written as `unknown`, never inferred. Pickup messages open with `Agent | Provider | Host | absolute worktree | base <sha>`; final reports open with `Clone/worktree: <absolute worktree> | PR head <sha>`; Linux evidence names the exact tested SHA and Node version. This does not replace the background-work evidence tuple (PID, host, log path, mtime, ETA) for "running in background" claims.
- **Link, don't paraphrase** (rule added 2026-08-11). When the handoff summarizes a defining artifact — a plan's lane list, a spec's scope, a decision record — it must link the artifact. An unlinked paraphrase becomes a competing source of truth: the "B2–B6 were never written down" false claim happened because the handoff said "Tranche B is B1–B8" without linking the plan that defines them, and a session searched only the handoff.
- **Volatile claims carry a verification stamp** (rule added 2026-08-11). Any handoff statement about live state that can change without a commit to this repo — production health, a clone's dependency state, "X is still open" — carries `verified YYYY-MM-DD` and, where practical, how. A stale or missing stamp marks a hypothesis to re-verify, not a fact to build on. Two such claims (a clone's `node_modules` state, the B7 memory posture) went stale silently and were caught only by re-probing.
- **Lane numbers come from the plan, never from branch names** (rule added 2026-08-11). A branch named `readiness-b2-*` asserts nothing; the plan in `docs/superpowers/plans/` is the sole authority for what a lane number means, and In-flight entries cite the plan section. The "B2" collision — a mislabeled smoke branch vs the real DLP lane — came from trusting a branch name.
- Buzz canvases may retain durable channel policy and the canonical handoff pointer, but not current SHAs, open-PR counts, promotion status, or deployment-health claims.
- Placement and preservation rules live in [docs/operations/AGENT-CONTEXT-SOURCES.md](docs/operations/AGENT-CONTEXT-SOURCES.md).
- Tiny doc fixes deferred to next `/update-docs` run live in the Claude memory file `project_deferred_doc_fixes.md`.

## Multi-environment dev workflow

- The Windows `%USERPROFILE%\Repos\Preston-Test` clone is the primary session clone for CLI agents (Codex Desktop / phone remote view track Windows-side sessions only); the WSL-native `~/repos/Preston-Test` clone is the Linux-parity executor (bash harnesses, `cloc`/metrics, CI-parity runs), invoked from the Windows session via the default distro (`wsl -e bash -c "..."`). (Flipped from WSL-primary 2026-08-01 for remote-visibility; the parity carve-outs below are unchanged.)
- Never share `node_modules` between Windows and WSL. Native dependencies such as `better-sqlite3` must be installed per OS clone.
- Code syncs through Git. `npm run sync` is the universal report-only helper. Claude exposes it through `/sync`; Codex exposes it through the repo-local `preston-repo-sync` skill. Mutating reconciliation still requires an explicit user sync request.
- For explicit Windows-to-WSL parity, run `npm run sync:wsl` only after committing coherent work; it is fail-closed and uses `git merge --ff-only`.
- Environment parity uses the shared read-only `npm run sync:env` engine. Claude's `env-parity` skill and Codex's repo-local `preston-env-parity` skill call that engine directly; dual-discovery surfaces select the agent-scoped adapter.
- Claude `SessionStart` hooks and `.claude/commands/*.md` remain Claude-specific. Codex does not run those hooks or slash commands and uses the `preston-*` skills or universal npm fallbacks instead.
- Codex sandboxing may make `git fetch` report offline even when the remote is configured correctly. Treat that as an environment limitation unless an unsandboxed fetch also fails.
- **Pick the right clone:** run agent sessions and day-to-day implementation (edits, `npm test`, typecheck, lint) from the Windows clone; shell into the WSL clone only for Linux-only gates — `tests/scripts/*.test.sh` bash regression harnesses, `cloc`-dependent metrics generation, and CI-parity verification runs. Do NOT relocate a session's work into WSL-native clones/worktrees. The `/mnt/c/...` path is for doc review or quick inspection **only** — do not run dependency installs or builds there. Commit agent-owned, coherent session work to a feature branch before ending — never sweep unrelated user changes into the commit; if something must stay uncommitted, report it and why. State which clone/worktree you worked in as the first line of your final report.
- **Linux-parity runs test the exact SHA, not "the WSL clone":** the WSL checkout may be stale or on another branch. Transfer the exact commit under review through git first (a WSL worktree with the Windows clone as a local remote — `git fetch winclone <branch>` — or via origin), check out that SHA, run the gate there, and report the tested SHA alongside the results.
- **WSL Node is 22 via `fnm`** (`v22.22.2` default); the system `/usr/bin/node` is 20.19.6 and surfaces in non-login / non-fnm shells (e.g. `wsl -e bash -lc`). Run `eval "$(fnm env)"` before any `npm`/build in WSL — in restricted/sandbox shells where `/run/user/1000` is read-only (e.g. the Codex sandbox), use `export XDG_RUNTIME_DIR=/tmp; eval "$(fnm env)"` instead — then confirm `node -v` is v22, or `node_modules` (incl. `better-sqlite3`) builds for Node 20 and the `ensure:runtime` guard thrashes the ABI against the user's Node 22.
- **Latest handoff:** when a task benefits from current-state context, follow the `AGENTS.md` link to the repository-canonical handoff. Skip it for narrow, self-contained tasks to avoid context bloat. Claude's `scripts/latest-handoff.sh` SessionStart hook reads that same repo link and appends checkout provenance; it never selects current state from Claude memory.
- **Codex state sharing:** share via git (this file, `AGENTS.md`, plans, runbooks) and via OneDrive **curated text notes only** (`Code-Memory/Preston-Test/codex/*.md`). Keep per-device and never live-sync `~/.codex/{auth.json, config.toml, *.sqlite(+wal/shm), sessions, logs, attachments, cache, plugins}` — syncing live SQLite/session/secret state risks corruption and leakage.

## Tier-B scheduled services

PR 10a (`EmbeddedRetentionJob`) ships the canonical pattern for long-lived
scheduled services in Tier-B. PR 11+ schedulers MUST follow this shape:

- **Service class** with `@injectable()` + DI-bound dependencies (NOT a
  free function in app boot).
- **Idempotent `start(intervalMs?)`**: stores the `setInterval` handle in
  a private field; double-start emits a warning log and returns early
  (no crash, no double-scheduling).
- **`stop(): Promise<void>`**: clears the interval AND awaits the
  in-flight tick before resolving. Process exit (SIGTERM/SIGINT) gates
  on this resolving so an in-flight DB cleanup batch isn't cut off.
- **`tick()`**: exposed for tests + manual invocation. Wraps each query
  in its own try/catch with structured-log on failure so one query can
  fail without poisoning the others.
- **App boot wiring** (`src/index.ts`): `start()` called AFTER the DB
  connection is ready and BEFORE the HTTP listener binds. `stop()`
  called at the START of `Server.stop()` — before HTTP close — so the
  retention loop stops scheduling new ticks while the in-flight one drains.
- **Multi-replica safety via idempotent queries** — NOT leader election.
  `pg_advisory_lock`/distributed cron is a Tier-C follow-up. Queries
  must be safe to run concurrently across replicas (idempotent UPDATE/
  DELETE on time-window bounds).

Reference implementation: `src/services/embedded/EmbeddedRetentionJob.ts`.
Reference test: `tests/integration/EmbeddedSessionLifecycle.test.ts`
("start()/stop() lifecycle is idempotent").

## How to add connector #19

The canonical connector registry lives at `src/connectors/connectorRegistry.ts`
(see ADR-015). It's both the source of truth for what connectors ship AND
the canonical wiring — `ConnectorManager.createConnector()`,
`inversify.config.ts` DI bindings, `IntegrationService.getConnector()`, and
every other production instantiation site read the per-entry `factory(systemId, deps)`
closure. The audit gate enforces both consistency (registry ↔ AST ↔ proof-card)
AND wiring drift (no `new <ClassName>(` outside the registry for any class
with a `factory` closure, in `src/`).

Adding a new connector is a 5-step PR:

1. **Create the connector class** — `src/connectors/<Name>Connector.ts`
   extending `BaseConnector` (or `MockConnectorBase` for in-process mocks).
   The class MUST declare three static fields so the AST audit recognizes it:
   ```ts
   static readonly productionStatus = 'demo_only' as const;  // or 'beta' / 'production' / 'stub'
   static readonly statusEvidence = 'Real <vendor> API scaffolding (...); ...';
   static readonly proofCard = 'docs/review/proof-cards/<name>-connector.md'; // required if production
   ```
2. **Add the registry entry** — append to `CONNECTOR_REGISTRY` in
   `src/connectors/connectorRegistry.ts`. Match the keys/className contract,
   and include a `factory` closure if the connector should be reachable
   through `ConnectorManager.createConnector()` (required for production):
   ```ts
   {
     key: '<lowercase_ascii>',
     className: '<Name>Connector',
     classRef: <Name>Connector,
     productionStatus: 'demo_only',  // must match the class's static field
     proofCardPath: 'docs/review/proof-cards/<name>-connector.md', // required for production
     credentialRequirements: ['<VENDOR>_API_KEY'],
     factory: (systemId, deps) =>
       new <Name>Connector(systemId, deps.logger, deps.authService /* + outboundGovernance if needed */),
     diBindingAvailable: false,           // flip true if you also add an inversify binding below
     bulkRollbackStrategy: 'unsupported', // PR 14 will revise as bulkUpsert lands
     notes: 'Optional free-form context: legacy naming, mock-only path, etc.',
   },
   ```
   If the connector is DI-only (mock or test fixture, not reachable through
   `ConnectorManager`), omit the `factory` field. Squire and
   SuiteCentralConnectorProd are the precedent.
3. **(Optional) Wire DI binding** — if other services need to `@inject` this
   connector, add a `toDynamicValue` binding in `src/inversify/inversify.config.ts`
   that calls `registryFactoryFor('<key>')(...)` (NOT `new <Name>Connector(...)`
   directly — the wiring-drift gate would reject that). Set
   `diBindingAvailable: true`.
4. **Add a proof card** (required for `productionStatus: 'production'`) —
   `docs/review/proof-cards/<name>-connector.md` following the schema in
   `docs/review/proof-cards/_template.md` (Status / Source / Tests / Live
   vs Fixture / Known Gaps / 60-second verification recipe). The
   `audit-proof-cards` gate enforces structure.
5. **Regenerate metrics + run audit** — `npm run metrics:generate:authoring` then
   `npm run audit-status-claims`. The audit's `--check-wired-connectors`
   mode verifies (a) registry ↔ AST ↔ proof-card consistency, (b) production
   tier has a factory closure + proof card, and (c) no rogue
   `new <Name>Connector(` lurks elsewhere in `src/`. Error messages name
   the specific drift; fix and re-run.

The registry is consumed by:
- `audit-status-claims --check-wired-connectors` (CI gate, every PR)
- PR 13's `OwnershipResolver` (cross-checks `SourceSystem` references)
- PR 14's `FlowExecutor` (uses `bulkRollbackStrategy` for `bulk_upsert` dispatch)

Reference implementation: every existing entry in
`src/connectors/connectorRegistry.ts`.

## Drift signals for this doc

This doc rots when the workflow changes. Suspected staleness:
- Budget file or audit script named here but absent from `ci-minimal.yml`
- The SHA reference above more than ~10 PRs behind `main`
- Handoff filename that no longer exists in memory

When in doubt, grep `.github/workflows/ci-minimal.yml` for the actual gate list and trust that over this doc.
