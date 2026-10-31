# Dependabot lane: ten Working-Branch PRs

Executor Claude Opus 5.5 | provider Anthropic | host Windows desktop, Node v22.23.1,
npm 10.9.8 (lockfiles regenerated with npm 11 to match Dependabot) | reviewer Codex,
provider OpenAI, requested gpt-6-sol at High; the runtime did not report the effective
model or effort, so it is recorded as unknown. Copilot was the automatic reviewer on
every merged head. Owner KStratMD approved the plan and its execution on 2026-09-22
(America/Denver).

Authority at start: `origin/Working-Branch` `ee201849fcb384eaaa7b2adfb6a4f58172d34226`
(resolver `verified`). `npm run deps:inventory` at 2026-09-23T02:30Z reported status
`complete`: ten open Dependabot PRs, all targeting Working-Branch, none already
represented. Chalk #1224 was already closed. The procedure is the
[dependency-maintenance runbook](../operations/DEPENDENCY-MAINTENANCE.md).

## Plan consensus

Claude drafted the plan; Codex reviewed it adversarially. Round 1 was DISAGREE with
five blocking findings, all adopted or answered:

- **Mixed batches.** The draft mixed package families. Resolution: the original
  Dependabot PRs were merged one at a time.
- **Playwright.** #1325 bumped only the bare `playwright` package; the image guard
  checks `@playwright/test`. Resolution: a replacement PR bumps both packages and the
  image.
- **Order of review and CI.** Resolution: Copilot clearance comes before the merge.
- **Unverified PR state.** Resolution: re-verified. The "pending" check was a query
  artifact, not a real status.
- **Unsanitised Markdown output.** Codex first called this blocking for marked. It
  withdrew that for the patch after reading the 18.0.12 and 18.0.13 release notes, and
  the item was tracked as a separate follow-up.

Round 2 was AGREE-WITH-CHANGES. It added an explicit consumer-evidence requirement for
zod and for the two secret SDKs.

## Results

| PR | Change | Merged head | Copilot on that head | Merge SHA | Merge-SHA `CI` |
|---|---|---|---|---|---|
| [#1335](https://github.com/KStratMD/Preston-Test/pull/1335) | jest, @jest/globals 30.5.2 | `a40ce05546` | approval recommended, no findings | `8d3a55b6cb` | success (run 35811860136) |
| [#1318](https://github.com/KStratMD/Preston-Test/pull/1318) | eslint 10.11.0 | `409f7cccda` | approval recommended, no findings | `b6e27c39b9` | success (run 35814087709) |
| [#1324](https://github.com/KStratMD/Preston-Test/pull/1324) | prettier 3.9.8 | `dd1d2b70f5` | approval recommended, no findings | `192f34e869` | success (run 35814529044) |
| [#1338](https://github.com/KStratMD/Preston-Test/pull/1338) | @faker-js/faker 10.6.0 | `8d1b1b210c` | approval recommended, no findings | `297628b091` | success (run 35815052217) |
| [#1322](https://github.com/KStratMD/Preston-Test/pull/1322) | marked 18.0.13 | `d3cc30be6f` | approval recommended, no findings | `0d1bd7a7d4` | success (run 35815499501) |
| [#1320](https://github.com/KStratMD/Preston-Test/pull/1320) | @aws-sdk/client-secrets-manager 3.1136.0 | `7a84de9f5e` (fix) | approval recommended, after one finding was fixed | `edfa80f42c` | success (run 35817954667) |
| [#1321](https://github.com/KStratMD/Preston-Test/pull/1321) | @azure/identity 4.13.3 (msal-node 6.0.1) | `b129833fb1` (fix) | "needs a closer look", no findings; answered with evidence | `489ea0e3b8` | success (run 35820350415) |
| [#1336](https://github.com/KStratMD/Preston-Test/pull/1336) | zod 4.6.5 | `1cffbc82cb` | approval recommended, no findings | `fe5d9dc385` | success (run 35820826885) |
| [#1337](https://github.com/KStratMD/Preston-Test/pull/1337) | bullmq 6.3.8 | `69d52bd9a1` | "needs a closer look", no findings (generic human-validation note) | `cdb561d05c` | success (run 35821373065) |
| [#1325](https://github.com/KStratMD/Preston-Test/pull/1325) | playwright only | not merged | — | superseded by the replacement PR that carries this record | — |

Every merged head had 14 of 14 checks green. Every squash used an explicit subject and
body, and none carries the CI-suppression marker. `--match-head-commit` refused the
first #1318 attempt because Dependabot had rebased the branch in the meantime; the
rebased head was reviewed again before it merged.

## Findings fixed during execution

- **Optional SDKs recorded as required (#1320 and #1321).** Copilot flagged this on
  #1320 at `26ea020138`, and Codex noted it independently. The Dependabot lockfile added
  each optional SDK to the root package's required `dependencies` map, although
  `package.json` lists it only under `optionalDependencies`. The cause is npm 11: it
  writes the same entry on an explicit install of an optional package, and a second
  plain `--package-lock-only` pass removes it. Each branch received a merge of
  Working-Branch plus a lockfile rebuilt that way: `7a84de9f5e` and `b129833fb1`. Each
  resulting diff is the single upgraded package tree, with the root entry kept in
  `optionalDependencies` only.
- **Playwright version split (#1325).** Superseded by the replacement PR, which moves
  `@playwright/test` and `playwright` to 1.63.0 and pins the e2e image to
  `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`.
  The same MCR query reproduces the previous v1.62.0 pin digest exactly. The lockfile
  holds a single `playwright-core` at 1.63.0. The darwin-only optional `fsevents`
  entry nested under `playwright` is gone because `playwright@1.63.0` no longer
  declares it; 1.62.0 declared `fsevents` 2.3.2, per `npm view`. The guard
  `tests/scripts/e2e-smoke-environment.test.sh` passes on the new pin and exits 1 on a
  deliberate version mismatch.
- **Keeping the split from recurring.** Copilot flagged this while reviewing the
  replacement PR, and two changes answer it. First, the guard now also requires every
  `playwright` and `playwright-core` entry in the lockfile, top-level or nested, to
  match the image. Red-first: the previous guard passes #1325's lockfile, while the new
  one fails it on `node_modules/playwright` 1.63.0 against image v1.62.0. The guard
  script now proves this on every run. It re-runs itself against two lockfile fixtures,
  one with the root `playwright` and one with a nested `playwright-core` off the image
  version, and requires both to fail with the version-mismatch message. With the
  per-entry check disabled, the self-test fails. Second,
  `.github/dependabot.yml` gains a `playwright` group, so Dependabot proposes both
  packages in one PR. The group is limited to minor and patch updates, like the other
  routine groups; a major stays a separate migration that includes the image move.
  Dependabot does not update the workflow's image pin, so a grouped Playwright PR fails
  the guard until its image digest is updated. The
  [runbook](../operations/DEPENDENCY-MAINTENANCE.md#classify-before-editing) records
  that step.

## Consumer evidence

These probes ran in scratch installs, not in the repository.

- **zod.** Five schemas were parsed with `safeParse`: a strict object, `.strict()`, a
  union, and an env-like schema using coerce, enum and url, plus a success case. The
  `flatten()`, `issues` and `message` output was byte-identical on 4.4.3 and 4.6.5
  (13 issues), and the probe confirmed both versions actually loaded.
- **marked.** All 774 `docs/**/*.md` files were parsed with 18.0.11 and 18.0.13. Six
  differ, and only in whitespace: an empty code block collapses onto one line, and
  leading spaces after `<br>` are trimmed. Six hostile inputs rendered byte-identically
  on both versions: an image with `onerror`, a `javascript:` link, a script inside an
  HTML block, a raw anchor, an autolink containing `<`, and an angle-bracket reference.
- **AWS SDK.** All six command classes that `SecretManager` uses are exported. Both
  load paths work: ESM `import()` and CommonJS `require()` (tsconfig uses
  `module: commonjs`). A send to an unreachable endpoint rejects with `ECONNREFUSED`.
- **Azure identity.** Managed identity was tested against mock App Service and IMDS
  endpoints. `ManagedIdentityCredential` returned a token, and so did
  `DefaultAzureCredential` when run alone. Results on 4.13.3 with msal-node 6.0.1
  matched the control, 4.13.2 with msal-node 5.6.0. With no identity configured,
  `getToken` rejects with `AggregateAuthenticationError`. The evidence is posted
  [on the PR](https://github.com/KStratMD/Preston-Test/pull/1321#issuecomment-5789296578).
- **bullmq.** Codex's verdict was MERGE: the changelog covers Worker reconnect fixes,
  and `src` has no job-scheduler consumer. The real-Redis batch-processing job passed on
  the merged head.

## Deviations and limits

- **CI ran before Copilot on the same head.** For unrebased Dependabot heads, CI
  finished before the Copilot review of that same SHA. The plan's re-run clause was not
  applied: AGENTS.md scopes clearance to the reviewed tree, which was identical. Heads
  that were not rebased merged onto a newer base, and the merge-SHA `CI` runs listed
  above cover the combined tree.
- **Replacement PR pushed without the marker.** The auto-mode classifier refused a push
  carrying the CI-suppression marker, so each head of the replacement PR ran CI before
  Copilot reviewed it. After Copilot clears the final content head, an empty
  tree-identical commit triggers the final CI run, as AGENTS.md prescribes.
- **No live cloud reads.** No authenticated AWS, Entra ID or Key Vault read was
  performed, because no credentials were available.
- **DLQ coverage.** The Dead Letter Queue has no real-Redis round-trip test; its unit
  tests mock BullMQ.

## Follow-ups

- **Unsanitised Markdown.** The docs routes (`src/routes/docs.ts` and its unmounted
  `docsAsync.ts` twin) insert marked output without sanitising it. The next step
  is to establish where the rendered Markdown comes from, then either document that
  trust boundary or add sanitisation. *Resolved by
  [PR #1343](https://github.com/KStratMD/Preston-Test/pull/1343), which sanitises the
  output, documents the trust boundary and deletes `docsAsync.ts`.*
- **Local OTel bump (corrected 2026-09-23).** An earlier revision of this record said
  a local checkout held an uncommitted `@opentelemetry/sdk-trace-base` 2.11.0 bump. That
  was wrong. Working-Branch already pins `^2.11.0`, so the two unpushed local commits on
  `feat/otel-update` are already represented. The uncommitted change in that checkout is
  an unrelated `openai` dependency addition that nothing in `src` uses, and it is left to
  its owner. No OTel work is outstanding from this lane.
