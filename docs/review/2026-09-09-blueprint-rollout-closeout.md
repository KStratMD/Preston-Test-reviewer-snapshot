# Blueprint promotion and live fork verification closeout

Verified 2026-09-09 UTC. Executor: Codex / OpenAI / MSI /
`C:\tmp\gacp-wsb2`, branch `codex/blueprint-fork-closeout`, base
`c2a1e1798062ffa5a7c39bb48c25d632f9b76726`. Reviewer: Claude Fable;
closeout review is recorded in the integration PR. Linux locator:
MSI / Ubuntu `/tmp/preston-full-promotion-linux`, Node v22.22.2.

## Promotion

The owner approved [PR #1278](https://github.com/KStratMD/Preston-Test/pull/1278)
and its subsequent Working-Branch integration, demo verification and disposable
fork retests. It merged at `2026-09-09T22:44:50Z` as
`c2a1e1798062ffa5a7c39bb48c25d632f9b76726`. Parents are prior main
`f60267254714e3f92053e9a870941503f42a063b` and final PR head
`b1d54805386fd4e1ee752b3a4cc42b41d8da4151`. Tree
`eaa69e4e6e078ba3effc345184578c7e18954cee` equals the reviewed and tested tree.

Claude Fable cleared the candidate; Copilot review `5160269787` inspected
13/13 files and generated zero new comments, while advising final human review
of the trusted-verifier boundary. That advisory was presented before owner
approval. [Final PR CI](https://github.com/KStratMD/Preston-Test/actions/runs/34409547241)
passed 15,458 tests / 727 suites, with 10 tests and one suite skipped and one
snapshot passed; core passed 2,565 tests / 110 suites and the 87-file ratchet.
All 18 applicable checks succeeded; public mirror publication was intentionally
skipped on the PR. These are PR-head results, not a merge-SHA CI claim.
[Final handoff comment](https://github.com/KStratMD/Preston-Test/pull/1278#issuecomment-5609539587).

## Repeated live fork cases

Both disposable draft PRs were authored by Fivrik from the private fork
`Fivrik/Preston-Test-blueprint-probe`, against main at the promoted SHA above.
Each had one synthetic file and a new head with no reused status history.
Neither contained attestations, credentials or customer data. Both are now
closed without merge; their branches and fork were retained. GitHub's PR API
confirms that neither PR has a merge timestamp.

| Case | Exact head | Live workflow | Fresh `blueprint-verify` status |
| --- | --- | --- | --- |
| [#1280: Blueprint](https://github.com/KStratMD/Preston-Test/pull/1280) | `576a449170ac821695af3febf78d2770ef9772bf` | [34413934104](https://github.com/KStratMD/Preston-Test/actions/runs/34413934104) | ID `53864128379`, `2026-09-09T22:48:19Z`, **failure**, `blueprints from forks are not verified` |
| [#1281: no Blueprint](https://github.com/KStratMD/Preston-Test/pull/1281) | `683c361d88df130422e35c6321247176b1f81890` | [34413972530](https://github.com/KStratMD/Preston-Test/actions/runs/34413972530) | ID `53864154217`, `2026-09-09T22:48:49Z`, **success**, `no blueprint changes` |

Both workflow logs show the trusted checkout at
`c2a1e1798062ffa5a7c39bb48c25d632f9b76726`; the job-step API
records `Checkout PR head as data only` as skipped. The Blueprint verifier
exited 1 after publishing its expected refusal, rather than failing in checkout.
The non-Blueprint verifier exited 0. Neither verifier emitted an envelope.
Local raw logs and head-status responses are `C:\tmp\blueprint-retest-{fork,empty}.log`
and `C:\tmp\blueprint-retest-{fork,empty}-statuses.json`.

These results close the two failures recorded in the
[earlier event matrix](2026-09-09-blueprint-event-verification.md).
That record supplies same-repository push, approval, dismissal, reapproval and
old-head approval invalidation evidence. Those earlier cases were not rerun
here; the two repaired fork paths were. No fork review-event dispatcher result
is claimed.

## Existing demo verification

Railway's GitHub deployment `6360784888` is attached to the promoted SHA and
reported success at `2026-09-09T22:47:01Z` in the existing Squire Demo environment.
[Deployment status evidence](https://api.github.com/repos/KStratMD/Preston-Test/deployments/6360784888/statuses).
At `2026-09-09T22:50:11Z`, the live API health response was healthy, readiness
returned 200, and sample configuration counts remained expected 3, persisted 3,
active 0, inactive 3. Local response: `C:\tmp\blueprint-closeout-demo.json`.

Cloudflare's latest hosted release remains the successful
[34303351385 run](https://github.com/KStratMD/Preston-Test/actions/runs/34303351385)
at prior main `f60267254714e3f92053e9a870941503f42a063b`. This promotion changes
none of the paths watched by `hosted-deploy.yml`, so no new hosted deployment
was triggered. Fresh browser inspection of the live review hub showed five
READY connector badges and the 15 verified / 5 ready component ledger.

The actual `scripts/smoke-hosted.sh` passed all 31 checks against the existing
Cloudflare and Railway URLs, including assets, content, API responses and auth
guards. It ran from transferred SHA
`fa9fa379143ad6271cd089c15ebc348c66ff377e`, Ubuntu Node v22.22.2;
log `C:\tmp\blueprint-closeout-smoke.log`. This is fresh live probe evidence,
not a claim that Cloudflare deployed the new source SHA. No provider settings
or production infrastructure requirements were changed.

## Remaining boundary

The [B4 rollout contract](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md)
still requires separate owner approval before activating the required context.
The live event matrix is complete for its listed cases; activation is not.
Working-Branch protection still names only `Production image smoke (blocking)`
and `Build, Lint, and Test`; main's branch-protection endpoint returns 404 and
the repository ruleset list is empty. No protection setting was changed.
The production approver registry was unchanged. Keep the existing demo posture;
customer discovery, platform choices and retained v1 limits remain governed by
the spec and consumer guide, not by this rollout closeout.
