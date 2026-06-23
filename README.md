# Preston-Test — Reviewer Snapshot

This is an **auto-generated snapshot** of the Preston-Test / SuiteCentral 2.0 source tree, published for outside review. The canonical repository is private; this mirror exists so AI reviewers and outside engineers can read the source, run audit scripts, and verify the project's production claims without requiring private-repo access.

**Do not commit here.** Every push to upstream `main` force-pushes a fresh snapshot — local commits to this repo will be silently overwritten. File issues and pull requests against the upstream private repo if you have access; otherwise contact the maintainer.

---

## What's in this snapshot

| Path | Why |
|---|---|
| `docs/review/REVIEWER-PROMPT.md` | **The evaluation prompt (v2) — start here.** Three-pass evidence audit + architecture review + one-paragraph leadership call, with a mandatory pre-flight that separates mirror-construction artifacts from real defects and a three-state verdict scale (proven-in-code / proven-by-deployment-only / gap). Paste it into an AI with snapshot access, or follow it directly. Includes an optional Squire decision lens and a 10-minute gut-check. |
| `REVIEWER-GUIDE.md` | Step-by-step verification recipes (the commands `REVIEWER-PROMPT.md` tells you to run) |
| `EVALUATION.md` | Independent-review framing and the proof-card evidence index |
| `metrics.json` | Deterministic source-of-truth: connector counts, DLP patterns, test counts, LOC |
| `docs/review/proof-cards/*.md` | Per-component evidence (Status / Source / Tests / Live vs Fixture / Known Gaps / 60-second verification) |
| `src/**` | Full production source |
| `tests/unit/**`, `tests/integration/**` | Unit + integration suites (e2e/load/performance/playwright are excluded — they require infrastructure) |
| `scripts/audit-*.mjs`, `scripts/check-*.mjs` | The audit scripts CI runs on every PR |
| `.any-budget`, `.strict-null-budget`, `.core-coverage-budget.json` | Ratchet budgets — CI fails if these regress |

## What's excluded (by design)

- `docs/archive/**` — historical and superseded documents
- `docs/strategic/`, `docs/presentations/` — marketing/exec material, not source-of-truth
- `tests/{e2e,load,performance,playwright,provider}/**` — require live infrastructure
- `public/Squire-Executive-Package-v2/`, `public/wiki/` — generated build artifacts
- `tests/SKIPPED-TESTS.md` and the skip-discipline audit machinery — internal CI gate, would produce false drift against this excluded test set

The full include/exclude contract is in `scripts/reviewer-mirror.allowlist.json`.

## How to verify

Quick check (60s):

```bash
npm ci
bash scripts/bootstrap-review-tools.sh   # installs cloc + gitleaks + trufflehog
npm run typecheck
npm run check:any-budget
npm run check:strict-null-budget
npm run verify-metrics
npm run audit-status-claims
npm run audit-proof-cards
```

> **Note:** `bash scripts/bootstrap-review-tools.sh` is Linux-only. On macOS/Windows, install `cloc`, `gitleaks`, and `trufflehog` manually (e.g. `brew install cloc gitleaks trufflehog`) or skip that step — only `npm run verify-metrics` actually needs `cloc`. The other audits (`typecheck`, `check:any-budget`, `check:strict-null-budget`, `audit-status-claims`, `audit-proof-cards`) are pure-Node and run cross-platform.

Every audit above is what CI runs on the upstream repo. If any fails on this snapshot, that's a real finding — file an issue or note it in your review.

Full verification (15–20 min): see `REVIEWER-GUIDE.md`.

## Snapshot provenance

Each snapshot is one orphan commit. The commit message includes the upstream SHA — cross-reference against the private repo if you have access. Snapshot freshness is the upstream `main` branch as of that commit's timestamp.

## License & access

Source code license follows the upstream repository. Outside reviewers received this URL as part of a specific evaluation engagement — public visibility does not imply general redistribution rights.
