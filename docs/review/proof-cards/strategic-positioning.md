# Proof Card: Strategic Positioning (Wedge Statement + Claim Cleanup Gate)

**Status:** production
**Last verified:** 2026-05-18 · git sha `feat/pr-16-strategic-claim-cleanup`

## Claim

The wedge statement — *"SuiteCentral 2.0 is an embedded ERP operations layer for NetSuite and Business Central — governance-grade middle-market integration delivered as workflows inside the ERP, not a separate iPaaS to operate alongside it"* — is the canonical positioning across product-positioning surfaces (`CLAUDE.md`, `docs/strategic/competitive-positioning.md`). Every numerical claim in these surfaces carries an inline classification tag (`<!-- claim:evidence|benchmark|pilot-result|labeled-projection -->`) or matches an allowlist pattern in `scripts/strategic-claims.allowlist.json`. CI fails (via `scripts/check-strategic-claims.mjs`) on any unclassified number, preventing the "unqualified 95-99%" drift class that motivated PR 8-OptB.

## Source

- Wedge statement (canonical): `docs/strategic/competitive-positioning.md:7` (lede block)
- Mirrored in CLAUDE.md Strategic Vision section: `CLAUDE.md:237-264` (the existing six-principle framing tracks the wedge)
- Gate script: `scripts/check-strategic-claims.mjs`
- Allowlist: `scripts/strategic-claims.allowlist.json`
- Scan targets (PR 16 initial scope): `CLAUDE.md`, `docs/strategic/competitive-positioning.md`
- Tier-B decision #11 (hybrid framing — category-split lede + earned TCO subsection): `docs/plans/2026-05-01-a-grade-remediation-plan-merged.md` PR 16 section

## Tests

- Unit: `tests/scripts/check-strategic-claims.test.sh` (9 scenarios A-I — synthetic fixtures covering tagged-pass, untagged-fail, allowlist-year/version, code-block-skip, URL-skip, HTML-comment-skip)
- Integration: `none — gate runs on real product-positioning files in CI; the regression test exercises the gate's logic against synthetic fixtures via --root.`
- Coverage: `not yet measured — gate is a node script outside the Jest scope`

## Live vs Fixture

- Real CI gate wired? **Yes** · evidence: `.github/workflows/ci-minimal.yml` (the `check-strategic-claims` step runs `node scripts/check-strategic-claims.mjs` on every PR)
- Demo-mode toggle? **No** · gate runs identically in CI and locally; no environment branching
- Production credential test on file? **N/A** · gate is a static-analysis script; no credentials involved

## Known Gaps

- **Scan target scope is initial, not exhaustive.** PR 16 ships with `CLAUDE.md` + `docs/strategic/competitive-positioning.md` as the scan targets. `README.md`, `docs/01_VISION_DOCUMENT.md`, and the Squire executive package (`public/Squire-Executive-Package-v2/**`) are scheduled for a follow-up sweep PR — the gate is live and tested here, the follow-up just appends those files to `DEFAULT_SCAN_TARGETS` and tags the existing numerical claims.
- **Regex is claim-shape targeted, not all-numbers.** The gate flags percentages (`95%`), currency (`$50`), and comma-grouped counts (`11,847`) — the high-value drift surfaces. Bare integers (ordinals, section refs, port numbers, PR/issue refs) are intentionally not flagged because tagging every digit would create review noise without catching new claim drift. If a number warrants classification (e.g., "5 production connectors") the author can voluntarily add `<!-- claim:evidence -->` — the gate doesn't punish over-classification.
- **TCO numbers in `competitive-positioning.md` are labeled-projection.** No pilot has yet produced measured TCO data. The category-split lede earns the cheaper-than conclusion; specific cost ratios will move to `pilot-result` only after PR 15 ships a real pilot.
- **`benchmark` classification has no current artifact.** The post-PR-8-OptA accuracy harness is Tier-C deferred, so no claim in scanned files currently uses `<!-- claim:benchmark -->`. The tag is reserved for when that harness ships.
- **Reviewer-mirror exposes the gate scripts but not the production-enforcement targets.** PR #828 added the gate's scripts + regression test + allowlist to `scripts/reviewer-mirror.allowlist.json`. The scan targets themselves — `CLAUDE.md` and `docs/strategic/competitive-positioning.md` — remain upstream-only by design (CLAUDE.md contains environment-specific paths that the mirror's forbidden-content scanner rejects; `docs/strategic/**` is broad-excluded since most files there are commercially sensitive). External reviewers running the gate against the mirror snapshot get `OK — 0 file(s) scanned` (the gate soft-skips missing targets). The verification recipe below has separate "Mirror" and "Upstream" stanzas so reviewers in either context can reproduce the relevant checks.

## Verification (60-second AI-reviewer recipe)

### Mirror snapshot (works in `KStratMD/Preston-Test-reviewer-snapshot` + upstream)

```bash
# Confirm the gate scripts are present:
ls scripts/check-strategic-claims.mjs scripts/strategic-claims.allowlist.json
# Expected: both files listed.

# Run the regression test (9 synthetic-fixture scenarios — exercises the
# gate's logic end-to-end against fixtures, mirror-resident):
bash tests/scripts/check-strategic-claims.test.sh
# Expected: "All 9 scenarios passed."

# Confirm the allowlist is bounded (not an escape hatch):
grep -c '"reason"' scripts/strategic-claims.allowlist.json
# Expected: 4 (year stamps, ISO date stamps, version numbers, HTTP status placeholders).
```

### Upstream (private repo only — production-enforcement targets are upstream-only)

```bash
# Run the gate against the actual production-positioning targets:
node scripts/check-strategic-claims.mjs
# Expected: "[strategic-claims] OK — 2 file(s) scanned, all numerical claims classified."

# Confirm the wedge statement lede exists where claimed:
grep -n "embedded ERP operations layer" docs/strategic/competitive-positioning.md
# Expected: a line in the lede block around line 7.
```

If any check in either stanza fails for the relevant context, the wedge claim cleanup has regressed (upstream) or the gate's exposure has degraded (mirror).

---

<!--
Authoring notes:

This proof card differs slightly from connector cards in shape — there is no
`productionStatus` class member to drift against, because the artifact is a
script + a doc, not a connector class. The `Status: production` line above is
manually maintained; the audit `scripts/audit-proof-cards.mjs` does not enforce
the productionStatus match for service-level cards (per existing cards in
`docs/review/proof-cards/` like `audit-service.md` and `dlp-service.md`).

The "Known Gaps" section is intentionally explicit about scope limits — PR 16's
initial scan targets are 2 files, the follow-up sweep adds 2-3 more. A hostile
AI reviewer should see the current scope and the named follow-up without
having to dig.
-->
