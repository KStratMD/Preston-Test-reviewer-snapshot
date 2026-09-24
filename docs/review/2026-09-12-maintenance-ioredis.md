# ioredis maintenance evidence

## Initial assignment (2026-09-12 America/Denver)

Executor Codex | provider OpenAI | host MSI | absolute worktree
`C:\tmp\preston-maintenance-sqlite-precision` | branch
`codex/maintenance-ioredis-6` | base
`4978fdecfbaf496fee291be620ee58595c67a0f6` | Linux gate locator unknown |
tested SHA unknown | live process/log evidence: no unattended executor claimed |
reviewer owner-selected Claude Opus, requested High, effective effort unreported.

The live resolver verified origin/Working-Branch at this base after owner-approved
#1294 merged. This isolated Windows worktree is reused sequentially with its own
Windows dependencies; no parallel writer shares it. The bounded assignment is
the ioredis row of [maintenance Task 3](../superpowers/plans/2026-09-10-maintenance-and-documentation-plan.md#task-3-disposition-the-remaining-ten-dependency-prs).
Inspect #1144 against the current lock, independently review the migration plan,
and verify real Redis/BullMQ lifecycle behavior before proposing a replacement PR.
No dependency change, merge, original-PR closure or deployment is yet claimed.

## Baseline and design findings

At `da32a7b81170e0a500492bf3dc05f84ed27333f2`, Windows Node v22.23.1 passed
build/typecheck, 168 focused tests in six suites, and the existing real-Redis
profile (three tests / two suites, natural exit). Logs:
`C:/tmp/ioredis-baseline-build.log`, `C:/tmp/ioredis-baseline-typecheck.log`,
`C:/tmp/ioredis-baseline-unit.log`, `C:/tmp/ioredis-baseline-redis.log`.
The focused files were QueueService, CacheService, DistributedCache, both
DeadLetterQueueService suites and the environment-validation suite. These do not
establish that every cache path uses a live Redis instance.

BullMQ 6.0.6 declares optional peer `ioredis >=5.0.0`, not a nested v5 dependency.
Both consumers currently resolve the same 5.11.1 module; a scratch 6.0.0 install
also resolves one shared copy. The adopted plan must reflect that the peer upgrade
affects BullMQ. Its options-based Redis connections supply their own retry policy:
the executor's real-server probe read installed retry-policy outputs (not observed
reconnect timing) of 1,000 / 1,000 / 1,000 / 20,000 ms for
attempts 1 / 2 / 3 / 10 with both ioredis versions
(`C:/tmp/ioredis-queue-policy.log`). The direct unbound DLQ client instead inherits
ioredis's changed default retry policy. No all-defaults-unchanged claim is made.

The [v6 release](https://github.com/redis/ioredis/releases/tag/v6.0.0) and published
source add default RESP3 with legacy reply shapes; default TCP keepalive delay
changes from 0 to 30 seconds. Runtime compatibility still requires real-server
tests; source intent alone is not proof of application behavior.

### Pre-existing credential precedence defect

With both 5.11.1 and scratch 6.0.0, a synthetic password embedded in the URL wins
over a separately supplied password. With no password in the URL, the explicit
option is used. The current `src/config/env.ts` comment claims the opposite
precedence for embedded credentials. This can make a separate-password rotation
ineffective when a URL also carries credentials. Executor probe:
`C:/tmp/ioredis-auth-precedence.cjs`, log `C:/tmp/ioredis-auth-precedence.log`.
It uses lazy clients, synthetic strings, no server authentication or real secrets.

Reproduction: construct `new Redis('redis://:url-synthetic@127.0.0.1:16394',
{password: 'explicit-synthetic', lazyConnect: true})`, inspect whether
`options.password` equals each synthetic value, then disconnect. The URL value
wins on both versions. This migration must correct the false prose, preserve
current behavior explicitly and retain a separate credential-precedence repair
for owner KStratMD after the dependency lanes. No secret rotation fix is claimed
(verified 2026-09-12 America/Denver against both published packages).

### Pre-existing DistributedCache fallback and shutdown failure

On the compiled 5.11.1 baseline, a child with `NODE_ENV=test`,
`USE_REAL_REDIS=1`, `DISABLE_REDIS=0` and a reachable loopback Redis constructs
`DistributedCache({redisUrl: 'redis://127.0.0.1:16394', enableFallback: true})`.
After 500 ms, `getHealth()` reports `fallback: true` and one error while also
reporting `status: healthy`, `redis: true` and one connected node. This misleading
health surface is exposed by the operations routes. Calling
`shutdown()` does not allow the child to exit within its 15-second bound; the
probe terminates that child. Source auto-connects the client and then calls
`connect()` again; independent constructor reproduction reports
`Redis is already connecting/connected`. The fallback replacement/shutdown path
needs its own lifecycle investigation; no exact leak mechanism is claimed here.

Executor script/log: `C:/tmp/ioredis-cache-baseline.cjs` and
`C:/tmp/ioredis-cache-baseline.log`. The server was reachable and the separate
queue lifecycle tests passed. This is a pre-existing application defect, not
evidence of a v6 regression, and this lane does not claim to repair or live-verify
that cache path. Owner KStratMD; follow-up after the dependency lanes is a bounded
cache lifecycle repair with real-client success/fallback/shutdown regressions
(verified 2026-09-12 America/Denver at the baseline above).

### Local Redis fixture

Docker was unavailable and no Redis server was installed in WSL. A task-owned
Redis 7.4.8 build used upstream commit
`3c2f227822c358df4b7d4840d0a9b6a5ac1d20c4`, archive SHA-256
`ee72a4cfb39acb71b884cf26b34748ae604b3bf55d40548da5aa96d5079fa9d3`.
Source/build root: `/home/kstratmd/tmp/preston-redis-7.4.8-imhyGe`.
The fixture binds only `127.0.0.1:16394`, disables persistence and uses task-local
PID/log files. At startup PID 36786 answered PONG and DBSIZE 0; this is historical
startup evidence, not proof of a later running process. Logs:
`C:/tmp/ioredis-server-build.log`, `C:/tmp/ioredis-server-start.log`.
Test invocation explicitly sets `REDIS_URL=redis://127.0.0.1:16394`,
`DISABLE_REDIS=0`, `NODE_ENV=test`. Port 6399 was checked unused for the outage test.
This local fixture supports iteration before the separate final hosted CI gate.

## Implementation candidate (before independent diff review)

The [implementation plan](../superpowers/plans/2026-09-12-ioredis-compatibility.md)
was cleared by Claude Opus 5 in round 2, requested High, effective effort
unreported; session `d961aaec-83a5-42e0-94a2-d4e52c3c735f`, local review log
`C:/tmp/ioredis-plan-opus-r2.json`. It independently selected sources and tested
both clients against Redis. Initial incorrect review claims about a nested peer
and BullMQ retry defaults were corrected with source and live-client evidence.

Test-first evidence: `C:/tmp/ioredis-red.log` records two compatibility cases
passing on 5.11.1 and the intended protocol assertion failing with server-reported
`resp=2`. The five new queue-options characterizations also passed on baseline.
The candidate upgrades the single shared app/BullMQ peer to 6.0.0; it changes
only ioredis, its commands package (1.10.0 to 2.0.0), and removes redis-parser.
The lock's indentation was preserved after npm rewrote it. BullMQ remains 6.0.6
and existing security overrides are preserved. Source changes remove two obsolete
connection casts/comments and correct the credential-precedence prose; no cache
or authentication implementation changed.

Windows Node v22.23.1 working-tree checks before the candidate commit: real Redis
six tests / three suites with natural exit (`C:/tmp/ioredis-green-redis.log`),
173 focused tests / seven suites (`C:/tmp/ioredis-unit.log`), typecheck/build/lint,
core coverage 2,696 tests / 114 suites and all 87 floors unchanged
(`C:/tmp/ioredis-core.log`, `C:/tmp/ioredis-core-budget.log`). Type budgets,
handoff/agent-note sync, terminology, mirror, inbound links and skipped-test gates
passed. Exact committed-SHA parity and independent implementation review remain
pending; these working-tree checks are not a final CI claim.

The real tests cover server-observed RESP3, legacy string/hash/scan/pipeline and
error replies, direct-client reconnect, BullMQ job processing and completion
events after killing only its test-owned blocking socket. A forced socket kill
may emit `read ECONNRESET` on Windows; the test accepts only this or the closed
connection error after the kill, and rejects unrelated errors.

`C:/tmp/ioredis-transport.cjs` / `.log` passed a Redis PING through a local Node TLS
proxy with a trusted temporary test CA and rejected the same certificate without
trust; normal verification stayed enabled. This is client transport evidence,
not a Redis TLS-server or production probe. A second owned Redis on loopback
16395 accepted a synthetic password and rejected an incorrect one. Temporary CA
keys stayed outside Git. Resource cleanup is pending the Linux/review checks.

Limits: standalone Redis 7.4.8 evidence does not establish cluster, Sentinel,
vendor or production acceptance. The documented Redis 6+ application floor is
retained; automatic HELLO downgrade below Redis 6 is not exercised. The cache
fallback/lifecycle and mixed-password findings above remain open. The measured
retry policy values do not measure reconnect timing.

## Independent implementation review and Linux evidence

Claude Opus 5 approved `76d1c7618bcb07b5b44129fd774c01f33aec7ff8` against base
`4978fdecfbaf496fee291be620ee58595c67a0f6`, with no blocking findings. Review:
`C:/tmp/ioredis-diff-opus.json`. It independently ran the real Redis profile,
173 focused units, typecheck and lint, compared lock entries and tarball integrity,
and surveyed plans/specs and current state to refute status claims. It did not run
build, core coverage, Linux or hosted CI and did not rerun the transport probe.

Finding dispositions (changes accompany this record):

- F1 reproduced by the reviewer: the pre-existing fixed-name QueueService
  lifecycle fixture leaves keys behind. This lane's new unique-name tests clean
  their own keys. Owner KStratMD; follow-up in the bounded cache/Redis-test
  lifecycle lane after dependencies. No test-isolation repair is claimed here.
- F2 executor reran the omitted `tests/unit/cacheService.unit.test.ts`: five tests
  pass (`C:/tmp/ioredis-cache-extra.log`), bringing focused validation to 178 tests
  across eight files over two invocations. `tests/fastMocks.ts` mocks ioredis:
  these units characterize application behavior, not wire compatibility.
- F3 strengthened the new test to use graceful `worker.close()` with an emergency
  disconnect in finally. Real profile again passed six / three with natural exit
  (`C:/tmp/ioredis-graceful-redis.log`). Claude's final pass cleared the follow-up
  at c50f7bc994; review scope and limitations are recorded below.
- F4 pushed back with fresh process/socket evidence: the auth fixture had not
  stopped. WSL `ss` and PID 36855 still showed owned loopback port 16395 listening
  after the review. Cleanup remains pending until explicitly verified below.

Linux-native gate checkout `/home/kstratmd/tmp/maintenance-sqlite-precision`
received exact SHA `76d1c7618bcb07b5b44129fd774c01f33aec7ff8` through Git from the
Windows clone, with Node v22.22.2 and its own fresh `npm ci`. Real Redis six / three,
typecheck/build and the broad CI profile passed: 15,606 tests / 732 passing suites,
10 tests / one suite skipped, zero failed tests or suites. Logs:
`C:/tmp/ioredis-linux-{install,redis,typecheck,build,ci}.log` and
`C:/tmp/ioredis-linux-verify.log`. No failed/empty JSON result was accepted.

Metrics were regenerated there only after the fresh broad JSON/coverage reports,
using cloc. The first verifier found stale generated metric tokens; syncing the
two token files made strict verification pass (`C:/tmp/ioredis-metrics-diff.log`).
The three generated files were transferred as a Git patch. Their `git_sha` records
the tested source, not the later documentation commit. This does not repair the
separately retained no-BUILD_SHA build identity defect. Hosted CI remains pending.

### Follow-up verification and fixture closeout

Linux Node v22.22.2 tested the graceful-shutdown refinement at exact transferred
SHA `a23a5d575faaf3b112aa1e5739b6a812bbe6d470`: six real-Redis tests / three suites,
natural exit, strict metrics and generated-token verification passed
(`C:/tmp/ioredis-linux-graceful.log`). The broader result above remains evidence
at 76d1c7618b; only test cleanup and generated/status documents changed afterward.

After verification, the executor checked both PID executables against the owned
Redis build and stopped PID 36855 (auth fixture) and 36786 (plain fixture) using
SHUTDOWN NOSAVE. Both ports 16395/16394 were verified closed. The TLS proxy had
already exited naturally; both temporary CA/server private keys were removed
from the named task directory, leaving public certificates and logs. A combined
recursive-cleanup command was rejected by automatic policy review, so cleanup
used separate service shutdown and explicit deletion of the two private files.
No shared service or unrelated file was changed. Final verification:
`C:/tmp/ioredis-cleanup.log`. The transport probe needs newly generated test
certificates and servers before rerunning; its historical result is above.

### Final independent clearance

Claude Opus 5 cleared `c50f7bc99431d866bd8df9c85c55dc38484055ab` with no blockers
(`C:/tmp/ioredis-diff-opus-r2.json`, same session, requested High, effective effort
unreported). It checked the final diff, provenance, generated metrics/tokens,
private-key absence and socket refusal on both stopped ports. It acknowledged
its F4 probe had mistaken NOAUTH for a stopped server. Its runtime tests remain
at 76d1c7618b; it reviewed the graceful refinement using static analysis and the
executor's exact-SHA Linux/Windows evidence. It did not rerun core coverage,
build, broad suites or the transport probe. Copilot and hosted CI are separate
gates; current PR results belong in the [PR #1295 handoff](https://github.com/KStratMD/Preston-Test/pull/1295).

### Copilot round 1 dispositions

[Review 5189612483](https://github.com/KStratMD/Preston-Test/pull/1295#pullrequestreview-5189612483)
on c50f7bc994 reported three inline and two suppressed findings, 13/14 files at
Lite effort. The stale handoff/ledger clearance clauses were corrected to record
Claude's completed c50f7bc994 pass and link the PR for subsequent gates. The plan
now labels 96475ad493 as historical plan-review evidence, and the DLQ comment no
longer refers to removed casts. No runtime statement changed.

The metrics finding's runtime consequence was reproduced using the actual route
in `C:/tmp/ioredis-metrics-fallback.cjs` / `.log`: with BUILD_SHA absent, the
endpoint reported artifact input 76d1c7618b while HEAD was c50f7bc994. This is the
already retained [build-identity defect](2026-09-12-maintenance-sqlite-precision.md#copilot-metrics-follow-up-and-retained-build-identity-defect),
assigned to maintenance Task 4. Metrics were regenerated at the latest reviewed
input c50f7bc994 in Linux Node v22.22.2, preserving the existing fresh broad
test/coverage reports; strict verification passed. Only generated_at/git_sha
changed (`C:/tmp/ioredis-metrics-refresh.log`). This accepts the requested refresh
but does not claim it fixes runtime identity: the generation input cannot identify
the later containing commit, final CI commit or deployment. That semantic fix and
its no-BUILD_SHA regression remain separate; no self-referential stamp is claimed.

### Copilot round 2 dispositions

[Review 5189631949](https://github.com/KStratMD/Preston-Test/pull/1295#pullrequestreview-5189631949)
on 2277951083 reported zero inline and three suppressed findings, 13/14 files at
Lite effort. The plan now marks completed checklist items at this checkpoint and
keeps the final review/CI and owner-gate items unchecked. Its Node wording now
distinguishes ioredis's >=20 floor from the application's `^22.13.0 || >=24`.

The claim that QueueEvents and Worker share the same blocking client name was
refuted against installed BullMQ 6.0.6 and a fresh bounded runtime probe.
`queue-events.js:58` explicitly calls `clientName(QUEUE_EVENT_SUFFIX)`, and
`utils/index.js:275` defines that suffix as `:qe`. The executor restarted only its
owned plaintext fixture and ran `C:/tmp/ioredis-worker-target.cjs` / `.log`.
Redis reported separate names: the exact base name had ID 7, command `bzpopmin`;
the `:qe` name had ID 6, command `xread`. Killing only ID 7 replaced the worker
socket; ID 6 persisted and the next job completed. Thus the existing test's exact
name match selects the worker; no test change is warranted by this premise.
The probe cleaned its unique queue and exited naturally. The restarted fixture,
PID 38641, was then stopped after executable ownership verification; both task
ports were closed (`C:/tmp/ioredis-worker-target-cleanup.log`). This reproduction
does not change the earlier test provenance or claim a production probe.

### Copilot round 3 status corrections

[Review 5189659755](https://github.com/KStratMD/Preston-Test/pull/1295#pullrequestreview-5189659755)
on e0fdf06ed9 reported zero inline and two suppressed findings, 13/14 files at Lite
effort: the handoff and parent plan still called ioredis the next assigned lane.
Both now identify the implementation as under review in PR #1295, with rate-limit
following its review/CI/owner decision. The surrounding next-session wording was
aligned. The parent plan's original proposal/approval prose is also updated to
link its completed task records and current handoff, distinguish the original
inventory counts, and retain separate merge/promotion/publication approval.
These are status-document corrections only; no code, test or metrics change.

### Copilot round 4: constructor-failure teardown

[Review 5189688705](https://github.com/KStratMD/Preston-Test/pull/1295#pullrequestreview-5189688705)
on c9584910b7 reported zero inline and one suppressed finding, 13/14 files at Lite
effort: BullMQ constructors ran before the test's cleanup scope. The executor
reproduced it before editing with a scratch Jest setup that deliberately throws
from Worker construction after Queue and QueueEvents are created. The old test
reported the injected failure but did not exit within 18 seconds; the parent
terminated it (`C:/tmp/ioredis-constructor-red.log`).

The test now constructs each object inside try/finally, attaches its error
listener immediately, and conditionally closes/disconnects successfully created
objects. The same fault injection now exits naturally with the expected Jest
failure in 879 ms (`C:/tmp/ioredis-constructor-green.log`). This is an expected
negative probe, not a claimed passing Jest case. Scratch reproduction files:
`C:/tmp/ioredis-constructor-fault.cjs` and `C:/tmp/ioredis-constructor-repro.cjs`;
use `--expect-natural` to assert the repaired failure path. No application code
or package changed. Normal real-Redis validation again passes six tests / three
suites with natural exit (`C:/tmp/ioredis-constructor-profile.log`), and lint of
the changed test passes. Exact-SHA Linux and independent review of this test
refinement follow this checkpoint; final fixture cleanup and CI are recorded in
the PR handoff rather than inferred from earlier cleanup records.

Linux Node v22.22.2 then tested exact Git-transferred
`e374af019e51b1909753047ec7be9e2b9d51df86`: real Redis six / three with natural exit.
Metrics were regenerated with cloc at that source and the changed LOC token was
synced; strict verification passed (`C:/tmp/ioredis-constructor-linux.log`).
The existing broad JSON/coverage reports remain from 76d1c7618b: the subsequent
functional edit affects only `tests/redis`, outside the broad profile's roots
(`tests/unit` and `src` in `jest.base.config.cjs`), so its count/coverage blocks
are preserved, not claimed rerun. Final hosted CI will supply fresh head results.

## Copilot round 6: tracing regression and prerequisite (2026-09-13)

Review 5189779117 on f5ca78512f has two actionable suppressed findings despite zero inline comments. The handoff now explicitly states hosted CI is pending. More significantly, installed instrumentation-ioredis 0.69.0 supports `>=2 <6`: both actual application tracing services emit a manual parent but lose Redis spans with ioredis 6. Executor positive controls with 5.11.1 restore the spans (`C:/tmp/ioredis-tracing-red.log`, `ioredis-distributed-red.log`, `ioredis-tracing-v5.log`, `ioredis-distributed-v5.log`). This is a migration regression, not an accepted retained defect.

The [plan amendment](../superpowers/plans/2026-09-12-ioredis-compatibility.md#tracing-compatibility-amendment--2026-09-13) was independently cleared by Claude Opus 5 with three adopted corrections (`C:/tmp/ioredis-tracing-plan-opus.json`): only three direct ranges need changing; the active parent is mandatory because requireParentSpan defaults to true; and the red cell must distinguish missing Redis spans from the still-exported parent. Claude independently verified the underlying 0.69/0.70 client matrix and found a one-package override creates six duplicate OTel versions. Its metadata-only coordinated resolution is not presented as installed-tree evidence.

Permanent tests drive both real application tracing compositions in fresh processes, exporting to an ephemeral loopback collector and exercising successful GET plus handled WRONGTYPE. On the old instrumentation with ioredis 6, both fail specifically after finding the parent, because zero Redis GET spans exist (`C:/tmp/ioredis-tracing-test-red.log`). After the three coordinated direct updates, the complete Redis profile passes **8 tests / 4 suites**, naturally (`C:/tmp/ioredis-otel-redis.log`). The installed graph gate passes **80 OTel packages, each one resolved version** (`C:/tmp/ioredis-otel-graph.log`), and the unchanged manual application OTel smoke passes (`C:/tmp/ioredis-otel-smoke.log`). Windows install reports zero audit vulnerabilities.

The full lock delta against f5ca78512f has 86 changed entries (`C:/tmp/ioredis-otel-actual-lock-diff.json`): coordinated OTel versions plus their transitive import-in-the-middle, es-module-lexer, protobufjs, systeminformation, aws-lambda types and nested configuration yaml updates; four obsolete database/logger type packages disappear. The auto-instrumentation dependency set is unchanged. All prior security overrides remain identical. No custom instrumentation patch, telemetry disabling or graph-gate weakening is included. The reviewer mirror now includes the Redis profile tests and their new smoke driver.

The coordinated update expands this PR beyond the original client bump. The owner can choose this reviewed prerequisite or defer ioredis 6 until OTel advances separately. Earlier broad reports above cover the old OTel graph and are not evidence for the amended graph.

### Amended dependency graph: exact-SHA verification checkpoint

Linux Node v22.22.2, own fresh npm ci, Git-transferred **fabec77a2ff87b8d83d9b030c70dd24d4760cb4d**: zero install audit vulnerabilities; OTel graph gate passes; real Redis **8 / 4**, unchanged manual OTel smoke, OTel graph bash regression, typecheck and build pass. Broad CI profile freshly passes **15,606 tests / 732 suites**, zero failures, **10 tests / 1 suite skipped** (399.852 seconds). Logs: `C:/tmp/ioredis-otel-linux.log` and `ioredis-otel-linux-{install,graph,redis,smoke,harness,typecheck,build,ci}.log`.

Metrics were regenerated with Linux cloc from those fresh JSON/coverage reports, then the stale total-LOC token was synchronized and strict verification passed (`C:/tmp/ioredis-otel-metrics-sync.log`). Coverage is 73% lines, 62.17% branches, 74.77% functions, 72.5% statements. The metrics input SHA identifies fabec77a2f, not a later commit or deployment.

Windows Node v22.23.1: focused tracing/queue/cache units **194 / 8**; core **2,696 / 114**, all **87** floors unchanged; typecheck/build/source lint, changed-test/script lint, type budgets, core type safety, terminology, handoff, agent mirror, reviewer mirror and inbound links pass. Both new tracing smoke modes also pass with standalone typechecked ts-node; the final child runner also typechecks on every run (`C:/tmp/ioredis-otel-smoke-typechecked.log`). Logs use the `C:/tmp/ioredis-otel-` prefix. No new tests are skipped. Final reviewer/CI/fixture-cleanup outcomes are published in the PR handoff rather than claimed by this local verification checkpoint.

The precise 194/8 focused invocation is:

```sh
npx jest --config jest.fast.config.cjs --runInBand --runTestsByPath tests/unit/observability/DistributedTracing.test.ts tests/unit/__tests__/observability/tracing.test.ts tests/unit/config/queueConnectionOptions.test.ts tests/unit/resilience/DeadLetterQueueService.test.ts tests/unit/resilience/__tests__/DeadLetterQueueService.test.ts tests/unit/__tests__/QueueService.test.ts tests/unit/utils/DistributedCache.test.ts tests/unit/performance/CacheService.test.ts
```

Claude Opus 5 cleared the implementation at fabec77a2f (`C:/tmp/ioredis-otel-impl-opus.json`), independently validating the installed graph, complete semantic lock delta, emitted span fields and a clean Redis 8/4 run with natural exit. Its separately selected focused set passes 223/9; that is a different composition, not a contradiction of the explicitly listed executor run. It did not independently run broad/core/build/lint; the executor's exact-SHA logs supply those results. The reviewer saw metrics/docs edits during review and requested a separate final artifact pass.

Two nonblocking review observations are retained explicitly. The compatibility test's 10-second bound timed out during a reviewer run with concurrent probes on the shared Redis fixture; its clean rerun and the executor's rerun (`C:/tmp/ioredis-otel-review-repro.log`) both pass 8/4 naturally. The stalled reviewer Jest process was stopped after over ten minutes, so the first run is a failure, not natural-exit evidence; the reviewer's shell pipeline exit zero did not override the failed Jest summary. Claude cleaned its orphaned unique queue keys. Treat contention and failed-run queue residue as a known flake surface in the retained Redis-fixture follow-up; do not run concurrent probes during the profile. Also, `tests/redis/**` newly includes four synthetic tests in the reviewer mirror: queueOutage and batchProcessingLifecycle existed at the PR base; ioredisCompatibility was added earlier in this PR; ioredisTracing was added by the tracing amendment, consistent with the existing unit/integration/spec test publication scope.

Claude cleared the final artifacts at 75417c86df (`C:/tmp/ioredis-otel-final-opus.json`), resolving the focused-count arithmetic and verifying metrics provenance/tokens. It identified that the new script was outside the standing application typecheck and its child runner used transpile-only. The runner now uses `ts-node/register`, so the Redis job typechecks the smoke on every run, matching the existing OTel smoke convention. Earlier transpile-only references describe the original checkpoint, not the final runner. This one-line test-runner change leaves application code, dependencies, broad-profile inputs and LOC unchanged. Follow-up verification and fixture cleanup are recorded in the PR handoff.

## Copilot round 7: final status wording and bounded provenance refresh

Review 5189927692 on d3826bc875 requested a metrics refresh and two wording fixes. The handoff now explicitly records Claude's completed final-artifact and typecheck-follow-up clearances; the current verification sentence states the child runner is also typechecked. Exact d3826bc875 Linux real Redis passes 8/4 naturally in 16.916 seconds and strict metrics passes; final owned PID 40652 is stopped, ports closed (`C:/tmp/ioredis-otel-typegate-linux.log`, `ioredis-otel-typegate-cleanup.log`). Claude's narrow final clearance is `C:/tmp/ioredis-otel-typegate-opus.json`, including an independent deliberate-type-error probe proving the new runner fails before execution.

Accepted the bounded refresh in inline 3999013820: metrics regenerated on the latest reviewed input **d3826bc875c42f220b53e9300c8169fac869fdf5**, Linux Node v22.22.2 with cloc, using the completed fabec77a2f broad reports whose inputs are unchanged by the final runner edit. Strict verification passes (`C:/tmp/ioredis-copilot-r7-metrics.log`); only generation timestamp and input SHA change. No new broad run is claimed. The generation SHA cannot equal the later commit containing the generated artifact, an empty CI-trigger commit or a deployed build: embedding the containing commit's own hash is self-referential. Therefore the request's implication that regeneration fixes `/api/metrics/review` build identity is rejected. The reproduced fallback defect remains assigned to Task 4 and is not changed in this PR. Subsequent status-only commits do not create stale deterministic metrics inputs merely by having a different Git SHA.

## Copilot round 8: explicit CacheService verification limit

Review 5189969035 on 4db591b231 requested a live CacheService round trip **or an explicit narrower compatibility claim**. The coverage observation is confirmed: `src/performance/CacheService.ts` constructs ioredis with an object at lines 80–88; `src/factories/ServiceFactory.ts` selects the service when Redis is enabled; both `tests/unit/performance/CacheService.test.ts` and `tests/unit/cacheService.unit.test.ts` mock ioredis. The real-Redis profile does not instantiate that service.

Adopt the reviewer's explicit narrowing option. The plan, handoff and PR now limit real-server acceptance to the tested standalone-client replies, BullMQ/QueueService operations and the two tracing compositions. **CacheService object-form connection, L2 round trips and service lifecycle remain unverified against real ioredis 6/RESP3.** Mocked units and generic GET/SET tests do not establish that service contract. Owner KStratMD's existing bounded cache follow-up must supply service-level real-client verification before production cache deployment acceptance. No such deployment or enablement is included here, and this gap is not claimed to be either a newly found regression or proven compatibility. Application code, test inputs, dependencies and deterministic metrics are unchanged by this documentation correction.

## Copilot round 11: close-failure cleanup ordering

Review 5190109965 identified a reproducible test defect: asserting worker/events close results before queue cleanup skips obliteration and queue close when a close rejects. Claude cleared the minimal repair design (`C:/tmp/ioredis-r11-plan-opus.json`). The test now attempts obliteration, attempts queue close in its finally block, and only then asserts the recorded worker/events results. The existing raw-disconnect backstop remains. Cleanup is best-effort if Redis is unavailable, and a cleanup failure can supersede the original error; neither case is silently treated as a pass.

Test-first fault injection awaits the actual worker close, then rejects it. Old ordering: expected Jest failure and **seven** owned queue keys left; repaired ordering: expected Jest failure and **zero** keys left, with the shared client recorded as `ready` at obliteration and natural exit in 1.194 seconds. Both probes remove only their own new compatibility keys. Logs: `C:/tmp/ioredis-close-red.log`, `ioredis-close-green.log`; driver/fault source: `ioredis-close-repro.cjs`, `ioredis-close-fault.cjs`. These are deliberate failing-test probes, not a claim that the injected Jest cases pass. A scratch observation initially used an obsolete BullMQ client property and failed inside the probe; the corrected observation uses the actual options connection and supplies the recorded result. No production source or dependency changes are included. Final normal-profile, exact-SHA Linux, independent review and cleanup evidence belongs in the PR handoff.

The repaired normal profile passes **8/4 naturally** on Windows Node v22.23.1 (18.021 seconds, `C:/tmp/ioredis-r11-windows.log`) and on exact Git-transferred **8617a5c5cfe718c0e5fd958db111fcaba9c118dc**, Linux Node v22.22.2 (17.045 seconds, `C:/tmp/ioredis-r11-linux.log`). Linux cloc regeneration attributes three additional code lines to this test repair; tokens and strict metrics verification pass. Broad-profile roots and dependencies are unchanged, so the completed fabec77a2f broad reports remain the source for count/coverage blocks. Fixture PID 40991 was subsequently stopped after executable ownership verification and both ports are closed (`C:/tmp/ioredis-r11-cleanup.log`). Independent final review and hosted CI outcomes are recorded in the linked PR handoff.

## Merge closeout (2026-09-13 UTC)

Owner-approved [PR #1295](https://github.com/KStratMD/Preston-Test/pull/1295) merged at 2026-09-13T15:49:58Z as `40cf1ea47ff45267d9d5b0f145fe47494dc16b52`. Its parents are prior Working-Branch `4978fdecfbaf496fee291be620ee58595c67a0f6` and final CI head `ad12879ab8d0745cdadda5397d4eb4d62ec81c81`. The merge, CI head and reviewed parent `a369a1beebdd738d9b8aa2560c2a6d0b680454fa` share tree `4070ef302e209db351f495ba43200ae76c71343e`. Original #1144 closed as superseded at 2026-09-13T15:50:27Z. These facts were verified using GitHub PR queries and local Git object comparisons.

The [final verification handoff](https://github.com/KStratMD/Preston-Test/pull/1295#issuecomment-5651797417) preserves executor/reviewer provenance, repros, review dispositions and scope limits. Claude Opus5 independently cleared the scoped implementation and final dispositions (requested High; effective effort unreported). Copilot review5191093231 on a369a1beeb returned zero new inline comments and no suppressed findings, 17/18files at Lite effort. Its general request for human review and caution about pending CI/unverified cache behavior remained disclosed; CI subsequently passed and the owner approved the merge. Round15's alleged cross-file environment leak was refuted by installed Jest isolation and an exact-head forced-outage-first Linux run (8tests/4suites, natural exit16.935seconds). No code change was warranted. Latest owned fixture PID42092 was stopped after executable ownership verification; ports16394/16395 closed.

[Final CI run34764523699](https://github.com/KStratMD/Preston-Test/actions/runs/34764523699) succeeded on ad12879ab8: broad15,606tests/732passing suites, zero failures, existing10test/1suite skips; core2,696/114 with all87floors matched; realRedis8/4; PostgreSQL60/12; full integration932/89 with16test/4suite skips. All15 applicable PR checks passed, including all3required checks; public-mirror publication was conditionally skipped. These are PR-head results, not independent merge-SHA or deployment verification. The final commit was empty and unsuppressed, with no post-review source changes.

The merged scope includes ioredis6.0.0, unchanged BullMQ6.0.6 and the coordinated OTel prerequisite with automatic Redis tracing tests. Real CacheService acceptance, baseline credential/cache behavior, fixture residue, no-BUILD_SHA runtime identity and other documented limits remain separate. Main promotion, deployment and service enablement were not performed. Express-rate-limit #1139 is the next dependency lane; Chalk #1224 remains deliberately deferred. Maintenance Tasks4–7 remain outstanding.
