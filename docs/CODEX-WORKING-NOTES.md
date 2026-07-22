# Codex Working Notes — Preston-Test

## Repo orientation

- TypeScript Node app. Main branch: `main`. Latest stable SHA at last update: `1d6cfb9a9`.
- Unit suite: ~12,187 passing, 100% on the unit profile (`jest.ci.config.cjs`).
- Primary AI agent is Claude Code; Codex is invoked for second-opinion review, rescue, or specific implementation handoffs.
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

## Implementation mode

**Commit message conventions**
- Do not include the bracketed CI suppression token in commit messages unless the explicit goal is to suppress CI.
- When discussing that behavior in prose, use "skip-ci marker" instead of spelling the token literally.
- The final commit before merge must run CI so required checks are green on the merge commit.

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
- `verify-metrics` — deterministic blocks of `metrics.json` match regen (the `tests` and `loc.total_*` blocks are tolerant; everything else is exact)
- `check-inbound-links` — informational, not blocking. Baseline ~325 historical broken refs; only fix what's in scope for the PR.

## PR review loop (Copilot auto, Codex opt-in)

**Copilot** is the standard auto-reviewer on every PR. **Codex `/ultrareview`** is user-opt-in — agents do NOT engage it proactively, do NOT include it in PR opening summaries, and do NOT block merge approval on it unless the user has explicitly launched it on this PR. Merge gate is Copilot clean + CI green.

### Copilot side — always run (driveable from CLI)

- 3–5 rounds per non-trivial PR is normal — bugs → edge cases → consistency → nits.
- Recurring feedback shapes are captured as patterns A–G in `project_session_handoff_2026_04_28_evening.md`. Apply preventively to save 2–4 rounds.
- Doc-only fixup commits may carry a skip-ci marker to save ~10 min/round, BUT the **last commit before merge must run CI** so the merge commit has green required checks. The literal marker (square-bracket "skip ci") matches as a substring anywhere in the commit message, including paragraphs explaining you're not using it. Refer to it as "skip-ci marker" in prose.

**Trigger mechanics — Copilot review fires only when a `copilot_work_started` event appears in the PR timeline. Verify via:**
```bash
gh api 'repos/<owner>/<repo>/issues/<n>/timeline?per_page=100' --paginate \
  | jq '.[] | select((.event=="mentioned" and .actor.login=="Copilot") or .event=="copilot_work_started" or .event=="copilot_work_finished" or .event=="reviewed")'
```
- **First request on a PR**: REST API with login `Copilot` (the slug `copilot-pull-request-reviewer` is rejected as not-a-collaborator):
  ```bash
  gh api -X POST repos/<owner>/<repo>/pulls/<n>/requested_reviewers --input - <<< '{"reviewers":["Copilot"]}'
  ```
- **Re-trigger after Copilot has already reviewed once**: the same REST POST silently no-ops (returns `requested_reviewers: []`, no `review_requested` event fires). The GitHub MCP `request_copilot_review` tool also silently no-ops after the first review. Push events alone also do NOT re-trigger Copilot once it has been removed from `requested_reviewers`.
- **Working re-trigger**: PR comment with an `@copilot` mention AND a directive ask for review in the first few words. Weak status-style comments are ignored.
  ```bash
  gh pr comment <n> --body "$(cat <<'EOF'
  @copilot please review this PR again and post any new findings, or confirm there are none. Fixups for round N are in commit <sha>. Crosswalk:
  | # | Finding | Where it landed |
  ...
  EOF
  )"
  ```
- Strong openers that work: `@copilot please review`, `@copilot please re-review`, `@copilot please post any new findings`, `@copilot please confirm clean or comment`.
- Weak phrasings that get treated as status updates: `@copilot ready for review`, `@copilot addressed your comments`, `@copilot fixes pushed in <sha>`, `@copilot heads up, new commit landed`.
- Successful re-trigger timeline: `mentioned` (actor `Copilot`) → `copilot_work_started` within ~5–10s → `copilot_work_finished` ~2–5m later → `reviewed` event with a new timestamp. If `mentioned` appears but `copilot_work_started` does not appear within ~30s, repost with a stronger directive.
- The crosswalk table is optional but recommended — gives Copilot and the human reviewer a clear map of finding-to-fix without manual diffing.
- A `copilot_work_started → copilot_work_finished` cycle in <90 s with no new comments is a silent clean — Copilot found nothing to flag.

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

- User memory dir: `~/.claude/projects/-mnt-c-Users-kstra-Repos-Preston-Test/memory/`
- `MEMORY.md` is the index. The most recent `project_session_handoff_<date>_<topic>_done.md` is the latest pointer.
- Tiny doc fixes deferred to next `/update-docs` run live in `project_deferred_doc_fixes.md`.

## Multi-environment dev workflow

- WSL-native `~/repos/Preston-Test` is the primary development clone; the Windows `%USERPROFILE%\Repos\Preston-Test` clone is secondary for Windows-specific checks.
- Never share `node_modules` between Windows and WSL. Native dependencies such as `better-sqlite3` must be installed per OS clone.
- Code syncs through git. `npm run sync` is an explicit, report-only helper that fetches and reports ahead/behind status.
- Claude `SessionStart` hooks and `.claude/commands/*.md` are Claude-specific. Codex does not run those hooks or slash commands; if Codex needs the same signal, run `npm run sync` manually.
- Codex sandboxing may make `git fetch` report offline even when the remote is configured correctly. Treat that as an environment limitation unless an unsandboxed fetch also fails.
- **Pick the right clone:** default to the WSL-native clone for implementation, tests, bash scripts, and CI parity; use the Windows clone only for Windows-specific native-module / PowerShell / GUI checks. The `/mnt/c/...` path is for doc review or quick inspection **only** — do not run dependency installs or builds there. Call out when operating from `/mnt/c`.
- **WSL Node is 22 via `fnm`** (`v22.22.2` default); the system `/usr/bin/node` is 20.19.6 and surfaces in non-login / non-fnm shells (e.g. `wsl -e bash -lc`). Run `eval "$(fnm env)"` before any `npm`/build in WSL — in restricted/sandbox shells where `/run/user/1000` is read-only (e.g. the Codex sandbox), use `export XDG_RUNTIME_DIR=/tmp; eval "$(fnm env)"` instead — then confirm `node -v` is v22, or `node_modules` (incl. `better-sqlite3`) builds for Node 20 and the `ensure:runtime` guard thrashes the ABI against the user's Node 22.
- **Latest handoff:** when a task benefits from current-state context, read the newest `*session_handoff*` file from the shared Claude memory dir (`~/.claude/projects/<slug>/memory/`, OneDrive-backed; newest by filename date). Skip it for narrow / self-contained tasks to avoid context bloat. Claude's `latest-handoff.sh` SessionStart hook is Claude-only.
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
5. **Regenerate metrics + run audit** — `npm run metrics:generate` then
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
