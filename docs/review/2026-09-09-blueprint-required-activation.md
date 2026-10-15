# Blueprint required-check activation

Activated `2026-09-09T23:57:44Z`, after the owner accepted the recommendation
to require structural Blueprint verification on Working-Branch and protect main
with the same check. This is later authorization than the historical
[rollout closeout](2026-09-09-blueprint-rollout-closeout.md), which correctly
records activation as unapproved at its own checkpoint.

Executor: Codex / OpenAI / MSI / `C:\tmp\gacp-wsb2` /
`codex/blueprint-required-activation`, base
`03ced5d83465ba74e5d2ffeb634457fc86a8d239`. Reviewer: Claude Fable.
Linux gate locator and Linux tested SHA: not applicable; this change updates
GitHub settings and documentation, with no source or workflow changes.
Review and final documentation CI evidence belong to the accompanying PR.

## Settings applied

| Branch | Required checks after activation | Other policy |
| --- | --- | --- |
| Working-Branch | `Production image smoke (blocking)`, `Build, Lint, and Test`, `blueprint-verify` | Existing checks and all other protection controls preserved |
| main | `blueprint-verify` | New protection rule; enforced for administrators; force pushes and branch deletion prohibited by the rule defaults |

Every listed check is bound to GitHub Actions app ID `15368`. Both branches
retain `strict: false`: this change does not require a branch to be brought up
to date before every merge. No review-count, code-owner, linear-history or
additional production-check requirement was added to main. Main's new rule
does not automatically inherit Working-Branch's two existing CI requirements.
The normal paired review, Copilot and CI workflow in AGENTS.md still applies.

Working-Branch was changed through the required-status-checks PATCH endpoint
only. Main previously returned 404 from the protection endpoint and now has the
new minimal rule. Fresh GET responses verified both app-bound requirements.
Comparing the complete Working-Branch response, excluding its required-checks
object, proved its other protection settings unchanged. The repository ruleset
list was empty before activation; no ruleset was created.

## Verification

Claude Fable cleared the exact payloads before application, independently
checking live settings, source behavior, main/Working-Branch workflow equality,
and the prerequisite live event evidence. The review required a post-change check
to prove that the Actions-published commit status satisfies the pinned source.

Immediately after activation, `gh pr checks --required` reported:

| Existing PR into main | Required `blueprint-verify` result |
| --- | --- |
| [#1279: ordinary dependency PR](https://github.com/KStratMD/Preston-Test/pull/1279) | `SUCCESS` |
| [#1280: synthetic fork Blueprint probe](https://github.com/KStratMD/Preston-Test/pull/1280) | `FAILURE` |
| [#1281: synthetic fork non-Blueprint probe](https://github.com/KStratMD/Preston-Test/pull/1281) | `SUCCESS` |

Before activation, the same command on #1280 reported no required checks.
The two probes stayed closed without merge. These reads verify required-status
classification and recognition of the existing producer; no merge was attempted
to demonstrate blocking. The next real main promotion must satisfy the new
requirement. The accompanying documentation PR supplies a fresh required-status
verification on Working-Branch, recorded in its PR evidence.

Machine-local evidence is under `C:\tmp\blueprint-activation-*`: reviewed
payloads, before/after protection snapshots, required-check results, application
timestamp, and Claude review JSON. The application script re-read protection
and refused to proceed on baseline drift before mutating settings.

## Meaning and operational boundaries

This gates structural draft quality. Missing approvals, insufficient evidence,
unresolved blockers or golden-case mismatches can leave a structurally valid
draft green while `executable: false`. Execution approval and freshness remain
separate, as defined by the [consumer guide](../blueprint/README.md) and
[B4 contract](../superpowers/plans/2026-09-02-tranche-2-mapping-contract-blueprint-retry-fixtures.md).
Forks touching Blueprints fail; PRs touching none pass after verification.
Deleted Blueprints produce no executable envelope.

New unverified heads can be blocked if Actions or GitHub cannot publish the
required status. A failed review-event dispatcher can leave an older status
visible on the same head; requiring the status does not turn it into execution
authority. Consumers still use `assertFresh`. Administrators are subject to
the checks; use the normal PR promotion flow. This is not an assertion that
every direct push is impossible: commits already satisfying required checks
can be treated differently by GitHub's protection rules.

No provider settings, demo infrastructure, approver registry, runtime behavior,
workflow permissions or executable-approval policy changed. Railway and
Cloudflare retain their demo posture.

Rollback, if an unintended lockout is reproduced: first re-read settings to
exclude concurrent changes, restore only Working-Branch's saved required-check
object, and remove only the newly created main protection rule. Saved payload:
`C:\tmp\blueprint-activation-wb-rollback.json`. No rollback was needed during
activation. Future settings changes remain an owner decision.
