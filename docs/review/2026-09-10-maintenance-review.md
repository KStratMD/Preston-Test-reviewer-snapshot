# Maintenance review evidence

Verified 2026-09-10 UTC. Executor: Codex / OpenAI / MSI; worktree `C:\tmp\gacp-wsb2`; branch `codex/maintenance-review-plan`; source base `494a184e9cd0710071e9b05b77824ba50a164647`. Reviewer: Claude Fable, requested high effort through `--effort high`. Effective provider effort is not exposed. This is a review and planning record, not implementation or deployment clearance.

## Authentication findings

The retained finding in [Workstream C's disposition](https://github.com/KStratMD/Preston-Test/pull/1263#discussion_r3952989169) still reproduces. The current [base connector](../../src/core/BaseConnector.ts) gives the request wrapper ownership of `isAuthenticating`, while direct `authenticate()` and `ensureAuthenticated()` enter differently. [HubSpot](../../src/connectors/HubSpotConnector.ts) probes through `makeRequest` without taking that guard. [ShipStation](../../src/connectors/ShipStationConnector.ts) takes the same guard and returns early when the base wrapper has already taken it.

Fresh no-network characterization on the source base, Windows Node v22.23.1:

| Connector / entry on a fresh instance | Credential probe calls | Business calls | Authenticated afterward |
| --- | --- | --- | --- |
| HubSpot direct `authenticate()` | 2 | 0 | true |
| HubSpot `ensureAuthenticated()` | 2 | 0 | true |
| HubSpot request wrapper | 1 | 1 | true |
| ShipStation direct `authenticate()` | 1 | 0 | true |
| ShipStation `ensureAuthenticated()` | 1 | 0 | true |
| ShipStation request wrapper | 0 | 1 | false |

This is evidence of duplicate/missing credential probes, not evidence that a vendor accepted unauthenticated requests. The stub replaces the HTTP transport; no live credentials or business writes were used. Adyen, Shopify and connector-specific `ensureAuthenticated` overrides need preservation tests; this six-case run does not cover them or concurrency.

Reproduce from the Windows worktree by saving this as a temporary `.cjs` file outside the repository and running `node <file>`:

```javascript
process.env.NODE_ENV = 'test';
require(process.cwd() + '/node_modules/ts-node').register({
  transpileOnly: true, project: process.cwd() + '/tsconfig.json',
});
require(process.cwd() + '/node_modules/reflect-metadata');
const { HubSpotConnector } = require(process.cwd() + '/src/connectors/HubSpotConnector');
const { ShipStationConnector } = require(process.cwd() + '/src/connectors/ShipStationConnector');
const logger = new Proxy({}, { get: (_, key) => key === 'child' ? () => logger : () => {} });
(async () => {
  for (const [name, Connector, credentials, probe] of [
    ['HubSpot', HubSpotConnector, { accessToken: 'fixture-token' }, '/objects/contacts'],
    ['ShipStation', ShipStationConnector, { apiKey: 'fixture-key', apiSecret: 'fixture-secret' }, '/carriers'],
  ]) {
    for (const entry of ['direct', 'ensure', 'request']) {
      const connector = new Connector(logger, {});
      await connector.initialize({ type: 'apiKey', credentials });
      const calls = [];
      connector.httpClient.request = async config => {
        calls.push(config.url);
        return { status: 200, data: [], headers: {}, config };
      };
      if (entry === 'direct') await connector.authenticate();
      else if (entry === 'ensure') await connector.ensureAuthenticated();
      else await connector.makeRequest({ method: 'GET', url: '/business-fixture' });
      console.log(JSON.stringify({ name, entry,
        probeCount: calls.filter(url => url === probe).length,
        calls, authenticated: connector.isAuthenticated }));
    }
  }
})().then(() => process.exit(0), error => {
  console.error(error.message); process.exit(1);
});
```

The temporary JavaScript deliberately accesses protected members for characterization. The eventual regression suite must use a typed test harness and transport adapter, not add production bypasses or weaken type budgets.

## Dependency findings

Fresh `npm audit --package-lock-only --json` reports two high findings, zero critical/moderate/low. `npm audit --omit=dev --package-lock-only --json` reports zero. Both affected nodes are marked development-only in this lockfile; this does not establish absence of all production risk.

- `@istanbuljs/load-nyc-config/node_modules/js-yaml` 3.15.1: excessive CPU use with empty merge sources; patch 3.15.2. [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
- `smol-toml` 1.7.0: denial of service on malformed input; the proposed 1.7.2 is outside the reported affected range. [GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).

All twelve open dependency PRs target `main`. The following is a dated inventory, not permission to merge. Eleven reported successful checks; #1224 reported failures. Recheck reviews, required checks, base/head and the actual dependency graph at execution time.

| PR | Observed head | Semantic dependency changes versus current Working-Branch | Disposition |
| --- | --- | --- | --- |
| [#1279](https://github.com/KStratMD/Preston-Test/pull/1279) | `a9538a8240` | smol-toml 1.7.0 → 1.7.2; one node | First security patch |
| [#1269](https://github.com/KStratMD/Preston-Test/pull/1269) | `e6f2d10f51` | nested js-yaml 3.15.1 → 3.15.2 **and root 5.2.2 → 5.2.3** | First security patch; review both changes |
| [#1270](https://github.com/KStratMD/Preston-Test/pull/1270) | `042bebb0d7` | pg 8.22.0 → 8.23.0; pg-protocol 1.15.0 → 1.16.0 | PostgreSQL compatibility lane |
| [#1226](https://github.com/KStratMD/Preston-Test/pull/1226) | `6fc0c85b58` | @types/commander 2.12.0 → 2.12.5 | Review removal instead: installed commander 15 already exposes `typings/index.d.ts`; prove typecheck/CLI compatibility first |
| [#1225](https://github.com/KStratMD/Preston-Test/pull/1225) | `d285e620c3` | papaparse 5.5.4 → 5.7.0 | CSV upload compatibility lane |
| [#1224](https://github.com/KStratMD/Preston-Test/pull/1224) | `c92246ea7e` | chalk 4.1.2 → 6.0.0; 24 version/add/remove changes including nested Chalk copies | Hold; incompatible type resolution is reproduced in CI |
| [#1223](https://github.com/KStratMD/Preston-Test/pull/1223) | `c3351a378b` | prettier 3.9.5 → 3.9.6 | Small tooling lane; no whole-tree formatting |
| [#1222](https://github.com/KStratMD/Preston-Test/pull/1222) | `151320b00a` | @azure/identity 4.13.1 → 4.13.2; adds @azure/core-process | Secret-provider compatibility lane |
| [#1221](https://github.com/KStratMD/Preston-Test/pull/1221) | `a7772bca55` | Secrets Manager 3.1119.0 → 3.1127.0; four credential/Smithy transport nodes | Secret-provider compatibility lane |
| [#1220](https://github.com/KStratMD/Preston-Test/pull/1220) | `61bc7f6712` | eslint 10.8.0 → 10.10.0; 16 changed/added/removed nodes | Tooling lane; lint and plugin compatibility, not just version edit |
| [#1144](https://github.com/KStratMD/Preston-Test/pull/1144) | `f0ca16e18e` | ioredis 5.11.1 → 6.0.0; commands major bump; removes redis-parser | Separate major migration with real Redis/BullMQ tests |
| [#1139](https://github.com/KStratMD/Preston-Test/pull/1139) | `9caca26f1c` | express-rate-limit 7.5.1 → 8.7.0; two nested support nodes | Separate major migration with proxy/IPv6/header/tenant tests |

Lockfile PRs contain large whitespace diffs. Semantic comparison parsed each fetched PR lockfile and compared package paths/versions against the source base; an execution review must additionally compare integrity/resolved/dependency metadata and preserve unrelated lockfile repairs. Version-only counts above are not full semantic clearance.

The [Chalk CI job](https://github.com/KStratMD/Preston-Test/actions/runs/34303633742/job/102315636385) fails TS2307 in `src/cli.ts:4` and `src/cli/configValidator.ts:6`. The log locates Chalk's declarations but cannot resolve them with the current module-resolution setting. `tsconfig.json` uses CommonJS. Do not convert the entire application module system just to clear a color-library update; evaluate retaining Chalk 4 or replacing these CLI uses before a separately scoped migration.

## Documentation findings and verification

The shared handoff resolver is verified on `origin/Working-Branch`. Its six-file delta from `origin/main` is documentation only: AGENTS.md, CLAUDE.md, the working-notes mirror, current handoff, Blueprint activation record, and rollout closeout. Promotion of those files alone will not resolve older active-document drift.

Confirmed examples:

1. [README](../../README.md) still advertises 13,577 unit tests and five production connectors. `metrics.json` records 15,458 passing tests and `production=0`, `production_ready=5`, `beta=1`, `demo_only=11`, `stub=1`. The report's 728 total suites includes the skipped suite; do not label it as 728 passing suites. The badge and body need provenance-aware wording, not blind number replacement.
2. README recommends shared Windows/WSL `node_modules` auto-repair while AGENTS.md requires separate per-OS clones/dependencies. Replace the active setup guidance with the canonical Windows-session/Linux-parity workflow.
3. [Testing report](../reports/TESTING-QUALITY-REPORT.md) is still an actively consumed July 29 baseline with 14,112 passing tests and 71.15% lines. It needs an explicit dated-baseline versus current-result distinction and coordinated canonical/packaged updates; do not substitute the unit count for a multi-profile total.
4. `node scripts/check-verification-date-drift.mjs --include-ai-bundle` exits 1: generated `public/wiki/llms-full.txt:4832` carries 2026-07-06 while the current canonical stamp is 2026-07-29. Repair the upstream wiki source and rebuild; date-only editing generated output would conceal the stale content.
5. Searches for Blueprint/RetryPolicy/order-to-cash references in README, docs/INDEX.md, docs/README.md, architecture overview and developer API reference returned no matches. The CLI has a [consumer guide](../blueprint/README.md); add appropriate discovery links and a concise current-capability summary. A file-based CLI must not be documented as a new HTTP API.
6. `public/js/exec-metrics.js:3-7` still distributes 14,112 passing tests / 707 suites to its HTML consumers. Fixing only README would leave the executive/demo surfaces inconsistent. Inspect hardcoded numbers in executive-hub, technical-proof, media-demo and manifest-listed Markdown as well as token consumers.
7. `docs/ai/README.md:8` claims three production providers while line 227 says four. Its model claims, README's provider table and `docs/review/proof-cards/ai-providers.md:13-14` name older defaults. Compare active claims against actual provider configuration (`src/services/ai/SecureAIService.ts` and the provider configuration guide), preserving older dated benchmark evidence rather than rewriting it as a fresh live test.
8. `docs/strategic/value-proposition.md:208` claims 14 production connectors; `docs/tutorials/11-connector-ecosystem.md:41` and `docs/squire/PRODUCTION_READINESS_CHECKLIST.md:19` claim six. These conflict with the audited registry partition. AGENTS.md's connector-addition example also omits `production_ready` among allowed values; repair it and its mirror together during the documentation lane.
9. `docs/CHANGELOG.md` has no Blueprint/GACP/RetryPolicy entry for the recently completed tranche. Add concise source-linked current entries while preserving historical entries. Old verification dates alone are not proof a claim is false; re-verify the underlying claim before restamping.
10. `docs/operations/NOTEBOOKLM-OPERATIONS.md` promises automatic synchronization every few minutes in its opening paragraph but later records unreliable synchronization and requires explicit refresh. Align the active guidance with the required per-source refresh; do not present a repository correction as proof the live notebook was refreshed.
11. Five broken link occurrences are independently reproduced: three in `docs/README.md:32,33,35` target absent AI-feature, AI-agent-dashboard and feature-showcase guides; `GETTING-STARTED.md:223` targets absent `ARCHITECTURE.md` directly under the docs directory; `docs/user-guides/getting-started.md:1094` repeats the absent AI-feature guide. `scripts/check-inbound-links.mjs` scans only named subdirectories and skips Markdown hrefs not starting with a scan-directory prefix. A temporary fixture with root `README.md` linking an absent `root-missing.md` under docs, and `docs/README.md` linking `user-guides/relative-missing.md`, reports PASS, one scanned file, zero checked references, exit 0. Both targets are absent. This requires regression-backed gate repair, not merely link edits.
12. `docs/blueprint/README.md:29` says the terminology gate scans both singular and plural subtrees, but the gate's fixed scope only includes the singular Markdown directory (plus named specs/plans and opted-in documents). Its rollout paragraph at lines 134–137 still describes a future required-check activation, which the dated activation record shows completed. Update those active statements without widening the gate's scope implicitly.
13. The NotebookLM manifest names packaged `NETSUITE_SUITEAPP_READINESS.md` and `BUSINESSCENTRAL_DYNAMICS_READINESS.md`, but both package paths are absent; their originals under `docs/strategic/` exist. Verify the actual sync source mapping, then either generate the intended copies or correct the manifest mapping. Do not remove live notebook sources based only on missing packaged copies.
14. The hosted build copies only selected doc trees while shipping the full local index, and its deployment path filter omits some copied docs. This is a source-level delivery mismatch requiring a built-artifact link crawl and trigger-path test; no claim is made that a particular current live URL was fetched. `docs/architecture/ARCHITECTURE.md` also describes a six-provider factory including Gemini/Grok, inconsistent with the four configured provider implementations; normalize the actual architecture, not just model names.

Commands run on the source base plus the planning-only In-flight entry:

| Check | Result |
| --- | --- |
| Inbound links | PASS: 3,148 files, 5,690 references, zero broken |
| Baseline drift | PASS: 3,109 files, zero recognized-pattern violations |
| Verification-date drift, normal | PASS: canonical 2026-07-29, 170 files |
| Verification-date drift, AI bundle included | FAIL: wiki bundle stamp above |
| Agent notes mirror | PASS |
| Shared handoff | PASS |
| Proof-card structure | PASS: 7 connector-tagged + 19 service cards |
| Connector status audit | PASS: 18 connectors and exact status partition above |

These gates test structural consistency and recognized patterns. They do not prove narrative completeness, live-vendor evidence, fresh testing totals or external publication. No new full test profile, hosted build, deployment, external-document sync or live customer probe was run for this planning pass.

## External surfaces and completion limits

The [NotebookLM manifest](../../public/Squire-Executive-Package-v2/27-NOTEBOOKLM-SOURCE-MANIFEST.md) defines individual Drive-backed source files. The [hosted workflow](../../.github/workflows/hosted-deploy.yml) and [builder](../../scripts/build-hosted-artifacts.sh) identify Brain1-quartz as the editable wiki source. The workflow prepares an offline package and has path filters; a docs-only main merge does not necessarily trigger Cloudflare publication. Verify the actual build/redirect path rather than assuming older OneDrive instructions apply universally.

Drive, NotebookLM, OneDrive distribution and current deployed contents are **not verified** by this review. Keep existing Railway/Cloudflare demo configuration. Do not add production infrastructure to make a documentation claim look complete. External freshness must be evidenced separately during the authorized publication phase.

## Independent documentation review disposition

Claude Fable completed a broad, source-selecting documentation review on 2026-09-10. Its structural-gate passes align with the table above; the executor additionally ran the AI-bundle date mode and reproduced its failure. The executor reproduced the concrete metric/provider/connector discrepancies, broken links, gate blind spots, Blueprint wording and missing packaged sources before adding them to this record. The review's scan is broad but not a per-document completeness certificate; its grep output had limits.

Recommendations adopted: coordinated source/metric refresh, architecture/provider correction, navigation/manifest fixes, generated/external freshness separation and gate coverage. Recommendations qualified: do not replace a multi-profile total with 15,458 blindly; do not restamp old evidence based on age alone; treat executive-package manifest inputs as active unless a specific artifact is explicitly frozen; do not automatically promote before the substantive fixes; do not infer open product work from unchecked historical plans. Potential omissions concerning older rollout hatches or PostgreSQL migration plans require a separate status disposition, not automatic implementation. Machine-local full review: `C:\tmp\maintenance-doc-review.json` and `%USERPROFILE%\.claude\plans\you-are-claude-fable-sunny-glacier.md`.

Claude's separate combined-plan review cleared the auth/dependency evidence and staged execution plan, independently reproduced all six auth cases, checked PR/lockfile observations and verified named commands/files. It noted that the temporary auth script needs `NODE_ENV=test`; the self-contained reproduction printed above already sets it. No source fix, broad semantic-completeness certificate or external publication was claimed. Machine-local verdict: `C:\tmp\maintenance-plan-review.json`.

The final follow-up independently cleared commit `b6df796eeac9b41b31d394c5a9980ec9f86b6ef4` against the source base, including items 11–14, Task 4A, hosted/manifest boundaries and the final handoff. It reproduced the false-pass fixture, verified the five broken-link occurrences and terminology/rollout statements, and hand-checked links in all three planning documents. Inbound links reported 3,149 files / 5,711 references / zero recognized broken references; handoff and normal date gates passed, while the AI-bundle mode reproduced the documented wiki-stamp failure. Verdict: **FINAL MAINTENANCE PLAN CLEARED**, no blocking findings. Machine-local record: `C:\tmp\maintenance-final-review.json`. This paragraph records that verdict only; execution and publication remain pending owner approval.
