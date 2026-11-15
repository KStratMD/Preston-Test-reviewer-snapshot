# Authentication characterization and design evidence

Verified 2026-09-10 UTC. Codex | OpenAI | MSI | `C:\tmp\gacp-wsb2` | `codex/authentication-characterization-design` | source/tested SHA `9a36a6c4e8ea13c4e59a1a547112fcd27a69477c` | Windows Node v22.23.1 | Linux gate locator: not assigned, no Linux execution claimed | foreground investigation | reviewer Claude Fable requested at High effort. Codex effective effort is unknown. Source and dependencies are unchanged. The [Task 2 design amendment](../superpowers/specs/2026-09-10-connector-authentication-ownership-design.md) is proposed, not implementation clearance.

The shared-handoff resolver returned verified against origin/Working-Branch before branch creation. The owner authorized authentication characterization/design after approving the security-batch closeout. This record does not reuse that approval for source changes, a new PR merge, main promotion or the other maintenance lanes.

## Reproduced entry-point defect

The self-contained temporary reproduction in the [earlier maintenance review](2026-09-10-maintenance-review.md#authentication-findings) was extracted unchanged and executed from this Windows worktree. It replaces the HTTP request function and uses only fixture credentials.

| Connector | Entry | Probe calls | Business calls | Authenticated at completion |
| --- | --- | --- | --- | --- |
| HubSpot | direct | 2 | 0 | true |
| HubSpot | ensure | 2 | 0 | true |
| HubSpot | request | 1 | 1 | true |
| ShipStation | direct | 1 | 0 | true |
| ShipStation | ensure | 1 | 0 | true |
| ShipStation | request | 0 | 1 | false |

Source evidence: [BaseConnector](../../src/core/BaseConnector.ts) lines 155–195; [HubSpot](../../src/connectors/HubSpotConnector.ts) lines 149–183; [ShipStation](../../src/connectors/ShipStationConnector.ts) lines 198–228. The base guard returns early for any caller while isAuthenticating is true. HubSpot reenters without taking the flag itself; ShipStation returns true early when the base wrapper has taken it. These are local state/dispatch failures, not evidence that a vendor accepts invalid credentials.

## Concurrent-request failure through actual Axios adapters

Eight cases cover HubSpot and ShipStation, ordinary and sensitive request entry, and a pending credential probe that subsequently succeeds or rejects. In every case, one business fixture request reaches the Axios adapter while the first credential probe remains blocked and isAuthenticated is false. In all four refusal cases, authentication rejects but the unrelated business request fulfills. Interceptors and the real base request wrappers execute; only the Axios adapter is replaced, so no socket is opened.

The diagnostic deliberately waits for the known-bad dispatch, with a five-second failure deadline. It is a baseline characterization, not the future positive regression: a repaired implementation would no longer satisfy that wait. The future typed regression must instead assert zero business calls at a deterministic scheduling checkpoint, release the probe, then assert the success/failure outcome. It must not wait for a forbidden event as its positive success condition.

Save the following as a temporary `.cjs` file outside the repository and run `node <file>` from a Windows worktree checked out at baseline `9a36a6c4e8ea13c4e59a1a547112fcd27a69477c`. This baseline-only diagnostic deliberately waits for the old forbidden dispatch and is not a passing test of the repaired current tree. No dependency install or live credentials are needed beyond the worktree's existing Node 22 dependencies. Protected-member access is deliberate in this diagnostic; the implementation suite must use typed test subclasses.

```javascript
process.env.NODE_ENV = 'test';
require(process.cwd() + '/node_modules/ts-node').register({
  transpileOnly: true, project: process.cwd() + '/tsconfig.json',
});
require(process.cwd() + '/node_modules/reflect-metadata');
const { HubSpotConnector } = require(process.cwd() + '/src/connectors/HubSpotConnector');
const { ShipStationConnector } = require(process.cwd() + '/src/connectors/ShipStationConnector');
const assert = require('node:assert/strict');
const logger = new Proxy({}, { get: (_, key) => key === 'child' ? () => logger : () => {} });
const deadline = setTimeout(() => { console.error('fixture deadline exceeded'); process.exit(2); }, 5000);
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
(async () => {
  for (const [name, Connector, credentials, probe] of [
    ['HubSpot', HubSpotConnector, { accessToken: 'fixture-token' }, '/objects/contacts'],
    ['ShipStation', ShipStationConnector, { apiKey: 'fixture-key', apiSecret: 'fixture-secret' }, '/carriers'],
  ]) {
    for (const sensitive of [false, true]) for (const refused of [false, true]) {
      const connector = new Connector(logger, {});
      await connector.initialize({ type: 'api_key', credentials });
      const entered = deferred(), release = deferred(), businessEntered = deferred(), calls = [];
      connector.httpClient.defaults.adapter = async config => {
        calls.push(config.url);
        if (config.url === probe) { entered.resolve(); await release.promise; }
        else if (config.url === '/business-fixture') businessEntered.resolve();
        else throw new Error('unexpected fixture path');
        return { status: 200, statusText: 'OK', data: [], headers: {}, config };
      };
      const auth = connector.authenticate().then(() => 'fulfilled', () => 'rejected');
      await entered.promise;
      const request = (sensitive
        ? connector.makeSensitiveRequest({ method: 'GET', url: '/business-fixture' }, '/redacted-fixture')
        : connector.makeRequest({ method: 'GET', url: '/business-fixture' }))
        .then(() => 'fulfilled', () => 'rejected');
      await businessEntered.promise;
      const before = { probeCalls: calls.filter(x => x === probe).length,
        businessCalls: calls.filter(x => x === '/business-fixture').length,
        authenticated: connector.isAuthenticated };
      assert.equal(before.businessCalls, 1);
      assert.equal(before.authenticated, false);
      if (refused) release.reject(new Error('fixture-auth-refused')); else release.resolve();
      const [authResult, requestResult] = await Promise.all([auth, request]);
      assert.equal(authResult, refused ? 'rejected' : 'fulfilled');
      assert.equal(requestResult, 'fulfilled');
      console.log(JSON.stringify({ name, transport: sensitive ? 'sensitive' : 'ordinary',
        refused, before, authResult, requestResult }));
    }
  }
})().then(() => { clearTimeout(deadline); process.exit(0); }, error => {
  console.error(error); process.exit(1);
});
```

An independent desired-contract comparison of the resulting logs exits 1: three of six entry-point cases fail `probeCount === 1 && authenticated`, and all eight concurrency cases fail `before.businessCalls === 0` (the four refusal cases also violate rejection propagation). **Eleven failing cases**, not eleven passing tests. This is a diagnostic assertion over recorded fixture outputs; no Jest regression or production fix has been added. Machine-local evidence: `C:\tmp\auth-task2-{baseline,concurrency,expect-fixed}.cjs` and corresponding `.log` files.

## Adyen and Shopify preservation checks

A separate adapter-only probe initializes Adyen and Shopify with fixture credentials; NODE_ENV is temporarily production and DEMO_MODE=0 to exercise the non-demo branch, with the adapter attached before initialization. After recording initialization calls, it clears the call list and resets protected isAuthenticated to false, then exercises each entry. This is deliberately a forced unauthenticated post-initialize instance, because Adyen authenticates inside initialize.

| Connector | Initialization probe | Direct / ensure afterward | Request afterward |
| --- | --- | --- | --- |
| Adyen | one `/v1/me` | one `/v1/me`, authenticated true | zero credential probes, one business call, authenticated false |
| Shopify | none | one `/shop.json`, authenticated true | one `/shop.json` then business call, authenticated true |

Machine-local script/output: `C:\tmp\auth-task2-preservation.cjs` and `.log`. These checks establish call order and local state only. They do not validate Adyen header/baseURL configuration, vendor API correctness, credential acceptance or demo promotion. Existing Adyen tests mock makeRequest/getSystemInfo in key cases, so they cannot substitute for adapter-level lifecycle regressions. The source inventory identifies the three shared-boolean writers and all fifteen direct BaseConnector subclasses; the complete bounded list and transport-specific preservation requirements are in the linked design.

## Existing suite baseline and remaining work

The following command passed **189 tests in seven suites**, zero snapshots, against the recorded source SHA:

```text
npm run test:fast -- --runInBand --runTestsByPath tests/unit/core/BaseConnector.test.ts tests/unit/core/BaseConnectorEdgeCases.test.ts tests/unit/__tests__/BaseConnector.test.ts tests/unit/core/http/RetryPolicy.test.ts tests/unit/connectors/__tests__/AdyenConnector.test.ts tests/unit/contract/HubSpotConnector.contract.test.ts tests/unit/contract/ShipStationConnector.contract.test.ts
```

Log: `C:\tmp\auth-task2-existing-tests.log`. Passing existing suites does not close the demonstrated gaps. False-result waiter behavior, promise coalescing, late-401 generations, reinitialization, probe-capability expiry, full fifteen-class transport preservation and post-fix sensitive redaction remain acceptance requirements rather than completed tests. No full coverage run, Linux harness, live vendor request, deployment, or authentication implementation is claimed for this phase.

## Independent design review and clarification evidence

Claude Fable (`claude-fable-5`, High requested, effective effort not exposed) returned **DESIGN CLEARED** after independently reproducing the six-case matrix, all eight concurrent cases, the eleven failed desired-contract comparisons and the existing 189-test baseline. Its open-scope pass verified the fifteen subclasses, three guard writers/ensure overrides/test doubles, connector-specific flows and status boundaries. It found no smaller single-contract migration that fixes both public direct entry and nested probes. Machine-local verdict: `C:\tmp\auth-task2-design-review.json`; detailed review: `%USERPROFILE%\.claude\plans\you-are-claude-fable-effervescent-comet.md`. This initial verdict precedes the clarifications below; final follow-up clearance is recorded separately when available.

The executor verified and incorporated four non-blocking observations: base ensure currently ignores false and freshness (the correction is now explicitly labeled a behavior change); the direct boolean consumers are SuiteCentralMonitoringRuntime and SuiteCentralControlPlaneService; nested breaker accounting needs explicit parity; and the handoff now says baseline suite run rather than implying new regression tests exist.

Additional no-network checks ground those clarifications. A synthetic BaseConnector fixture with authenticate returning false and getSystemInfo returning a fixture object reports `isConnected: true` and calls system-info once; the design's false-result correction is therefore required (`C:\tmp\auth-task2-false-connection.cjs/.log`). A HubSpot adapter fixture with maxRetries=1 and one HTTP 500 probe failure records one adapter call and two breaker failures; the same fixture using HTTP 503 records zero breaker failures because of the existing expected-error predicate (`C:\tmp\auth-task2-breaker.cjs/.log` contains the final 500 variant; substitute status 503 to reproduce the other). The design preserves these counts and does not claim a global breaker fix.

The executor's follow-up state-write scan also found assignments in Adyen/Dynamics/PayPal/SAP/Stripe error handlers and SuiteCentralConnectorProd's pinned response handler. The amendment now explicitly requires a read-only subclass view of authenticated state and generation-aware invalidation of both base state and connector-local credentials. Its reset policy preserves the pinned connector's already-initialized rejection and clears cached credentials only for permitted initialization. These are design constraints, not completed source changes.

Review limitations: no live vendor calls or Linux tests; no full-suite/coverage claim; the historical #1263 disposition was taken from the committed review rather than re-fetched. The reviewer inspected the saved verified resolver result and matching source SHA, not a second origin fetch. Owner authorization comes from the supplied user context rather than GitHub account identity.

Final follow-up: Claude Fable independently reviewed candidate `a69838aa59d9d35523c772f3af60f8642abdb97b` against the recorded source base and returned **FINAL DESIGN CLEARED**, with no actionable findings. It verified the four clarifications, the complete subclass state-write inventory, the pinned one-shot initialization rule, both direct boolean consumers, the false-connection fixture and the 500 breaker fixture; it checked the 503 variant against source rather than claiming a second recorded run. Its open-scope pass confirmed the migration remains proposed and no new test or implementation exists. Machine-local response: `C:\tmp\auth-task2-final-design-review.json`; full review: `%USERPROFILE%\.claude\plans\claude-fable-independent-follow-up-glittery-puzzle.md`. Model `claude-fable-5`, High requested, effective effort unreported. [Draft PR #1287](https://github.com/KStratMD/Preston-Test/pull/1287) holds the design for owner approval; it is not an implementation or merge-ready PR. The later documentation commit records this verdict and pending owner decision only.
