# Blueprint discovery: local branch and diagnostic checkpoint

Date: 2026-09-26 (America/Denver). This is a dated, machine-local evidence
record, not a merge, a product acceptance, or a live quality evaluation. The
shared authority was verified as `origin/Working-Branch` with
`node scripts/resolve-shared-handoff.mjs` after a fetch on this date. The
branches below were inspected locally; neither was present as a remote head
at this check. Their heads are evidence for this checkpoint, not maintained
current-state pointers.

## Discovery implementation and review

`codex/blueprint-discovery-f1-f3` at `3d108b6ceccdd15d381645073908f32b5a144d23`
contains F1–F3: extraction for TXT, Markdown, CSV, PDF, DOCX and XLSX;
bounded immutable evidence packets; a typed read-only DiscoveryAgent; scripted
screening replays; and an offline evaluator. Its dated F3 offline evaluator
record is on that branch. The local development labels and scripted replays are contract
evidence, not independent screening-quality evidence.

The same branch contains the L1 synthetic Cheaper Inference transport, session,
ledger and bounded diagnostic work. The most recent repriced Luna design and
implementation plan are on that branch. Claude Opus 5.5 implemented the repriced runtime, and Codex
independently reviewed its boundaries and final diff. At the exact head above,
the Windows unit profile passed 819 suites and 18,651 tests (one suite and ten
tests skipped); the core profile passed 114 suites and 2,696 tests with its
87-file coverage budget. The WSL exact-SHA run used Node v22.22.2 and passed
82 focused unit suites / 2,850 tests, ten Blueprint L1 integration suites /
378 tests, build, typecheck and metrics verification. This records local gates,
not hosted CI or a PR review.

`codex/blueprint-l1-holdout` at `db5bd1ea9efc3c68d378bad8c10cc4e8c638e024`
holds a provisional, digest-pinned synthetic holdout slate. Kerry's private-key
adjudication has not happened; no held-out provider dispatch or measured quality
comparison is claimed. The earlier L1 readiness record is on both local
Blueprint branches; its Jev route proposal predates the DeepSeek and Luna
diagnostics.

The following defining artifacts are **local Git objects only**. Their names
are basenames under the shown directory at the pinned branch head; they are
not links to `Working-Branch` or claims of publication.

| Local branch at pinned head | Directory | Artifact basename |
| --- | --- | --- |
| `codex/blueprint-discovery-f1-f3` | `docs/superpowers/specs/` | `2026-09-23-blueprint-discovery-assistance-contracts.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/review/` | `2026-09-23-blueprint-discovery-e-impact.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/review/` | `2026-09-24-blueprint-discovery-f3-offline-evaluator.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/review/` | `2026-09-24-blueprint-discovery-l1-readiness.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/review/` | `2026-09-26-blueprint-l1-batch-probe-results.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/superpowers/specs/` | `2026-09-26-blueprint-l1-luna-repriced-continuation-design.md` |
| `codex/blueprint-discovery-f1-f3` | `docs/superpowers/plans/` | `2026-09-26-blueprint-l1-luna-repriced-continuation.md` |
| `codex/blueprint-l1-holdout` | `docs/review/` | `2026-09-24-blueprint-discovery-l1-readiness.md` |

## Guarded development probes and latest Luna continuation

Two earlier one-shot synthetic DeepSeek v4.1 Flash probes each sent one POST
and failed: the 30-second probe reached its client observation cap, and the
60-second probe received HTTP 503. Neither produced a model answer or a
screening-quality result. Each was conservatively charged 19,662 micro-USD
because the local bill was unknown, while the provider dashboard showed
USD 0.00 at the dated inspection. Their guards remain spent. The F1–F3
branch also records earlier Luna attempts and smoke guards, including a
`price_changed` index-2 refusal with zero POST and zero charge. Each saved
one-shot guard controls only its own design; none is reusable.

After offline clearance and read-only preflight, one synthetic six-pair
**repriced** Luna invocation sent one POST on the ZDR route. The local receipt
reports `failed / bill_unknown`, HTTP 200, one ordered answer, 2,172 input
tokens, 86 output tokens and 3,293 ms attempt duration. It records no valid
`withinScreenCallMs`, so this is not a successful latency or screening
measurement. There was no retry. The one-shot guard exists and must not be
removed or reused.

The response did not supply a usable provider bill. The append-only local
ledger therefore settled this reservation with `billing: unknown` and charged
the full conservative 49,972 micro-USD against the USD 20 cap. A read-only
chain check found eleven records, a valid SHA-256 predecessor chain, five
reservations and five settlements, no open reservation, and no anomaly.
Across those records, the local conservative charged total was 148,280
micro-USD (USD 0.148280), leaving 19,851,720 micro-USD (USD 19.851720)
against the cap at inspection. The aggregate includes other development
attempts; it is not a provider invoice. On the authenticated Cheaper Inference
Requests page, the most recent settled Luna request had the same 2,172 → 86
token counts and displayed approximately USD 0.0003 cost. That is an
observational correlation by model, recency and token counts, not an
identifier-level match; uniqueness was not checked. The displayed amount is
rounded and is not a replacement for the absent bill on the diagnostic wire.
The ledger was not edited to match it. No provider request identifier, credential,
prompt, response, or local profile path is recorded here.

The repriced design allowed one guard and at most one POST. Any new paid
invocation, changed bound, rate or bill-handling behavior needs a separately
reviewed design and owner decision. Before any assisted mode advances, its
measured arm must meet the manual baseline under the discovery contracts;
an inconclusive pilot retains manual mode. Even a passing pilot permits only
consideration of W1's bounded advisory slice, not its automatic start. W1
needs feature-lineage reconciliation and a reviewed E impact matrix. T1 needs
a settled workflow and revised criteria; A1 needs a frozen runbook, a human
acceptance owner assigned by Kerry, and fresh human observations. The
existing evidence does not authorize customer files, automatic approval,
tutorial completion or deployment. No E row was filled by these probes.
