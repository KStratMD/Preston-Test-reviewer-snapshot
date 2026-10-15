# Shared agent workflow authority correction

Owner direction (2026-09-07): `AGENTS.md` owns the shared workflow; `CLAUDE.md` points to it. Codex and Claude exchange executor/reviewer roles per assignment. Independent paired review supplements the Copilot loop and final CI. Codex may read `CLAUDE.md`. Workstream C is separately assigned to Codex with Claude reviewing after this correction.

Base: `bc7ae71b4318df1646684f0e7da936c045067cea`. Executor: Codex, OpenAI, MSI, `C:\tmp\gacp-wsb2`, branch `codex/shared-agent-workflow`. Independent reviewer: Claude CLI; design and implementation verdicts belong in the PR record.

## Preservation crosswalk (before editing)

Line references below name the base commit. This change adds authority pointers and corrects obsolete mechanics; it does not slim Claude's technical references. Claude independently cleared all five rows at `cee46d87c6c8293e10c1539d6dc3cb30dcb880b3`; [PR #1262](https://github.com/KStratMD/Preston-Test/pull/1262) records that verdict and its verification limits. The row dispositions below report that completed review of the implementation candidate.

| Original heading and lines | Classification | Canonical destination | Adapter pointer | Preservation verification | Reviewer disposition |
|---|---|---|---|---|---|
| AGENTS.md legend, line 14; context sources, Guarded duplication | Shared authority | AGENTS.md Part 1 | CODEX-WORKING-NOTES is an exact guarded mirror; CLAUDE.md loads AGENTS.md | Sync guard equality and diagnostic repair direction | Claude: cleared at cee46d87c6 |
| AGENTS.md Repo orientation, lines 22–24 | Shared roles and paired review | AGENTS.md Part 1, Repo orientation | CLAUDE.md shared-workflow pointer; exact notes mirror | Inspect both role directions and before/after review requirements | Claude: cleared at cee46d87c6 |
| AGENTS.md Trigger mechanics, lines 101–124 | Shared operational recipe, partly superseded | AGENTS.md Part 1, PR review loop | CLAUDE.md shared-workflow pointer; exact notes mirror | Dedicated reviewer request, timeline/head verification, native UI fallback; keep findings disposition and CI/merge boundaries | Claude: cleared at cee46d87c6 |
| CLAUDE.md Commit Message Conventions; Key Documentation Links | Shared workflow pointers | AGENTS.md Part 1 | Update pointers to identify the authoritative source | Diff confirms technical reference sections remain | Claude: cleared at cee46d87c6 |
| scripts/check-shared-handoff.mjs protectedWorkflowStrings; shared-handoff.test.sh fixture | Guarded workflow preservation | Check the replacement dedicated-reviewer marker | Existing gate and existing shell harness | Valid replacement fixture accepted; missing marker rejected | Claude: cleared at cee46d87c6 |

## Evidence informing the recipe correction

- [PR #1259 disposition](https://github.com/KStratMD/Preston-Test/pull/1259#issuecomment-5571097962) records that a comment mention invoked the coding agent; its changes were rejected and reverted with history preserved.
- [PR #1261 finding disposition](https://github.com/KStratMD/Preston-Test/pull/1261#discussion_r3951472602) records the successful dedicated REST request and the review it produced. Subsequent repeat API requests in that session produced no new work-start event, even after an empty commit. A request response alone therefore proves neither dispatch nor clearance.
- [GitHub code review documentation](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review) documents the REST reviewer `copilot-pull-request-reviewer[bot]` and the Reviewers control for re-review. Replies to review comments are visible to people, not Copilot; put necessary review context in the PR description.

Existing subject-only CI suppression, local verification, independent review, user-opt-in Codex ultrareview, merge approval, and separate promotion/activation approval remain requirements. A reproduced and rejected finding is recorded as such, not called a new clean reviewer verdict.
