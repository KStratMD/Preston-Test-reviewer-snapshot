# Proof Card: <Component Name>

**Status:** production | beta | demo_only | stub
**Last verified:** YYYY-MM-DD · git sha `<short>`

## Claim

One paragraph, plain language, no marketing. State precisely what this component does and where it sits in the system. A skeptical reader should be able to tell from this paragraph whether the claim is interesting and what counter-evidence would falsify it.

## Source

- Implementation: `<path:line-range>`
- Entry point: `<path:line>` (e.g. authenticate, the public method, the registered route)
- Dependencies: `<paths>` (only the load-bearing ones — the modules whose absence would break the claim)

## Tests

- Unit: `<test path>` (N tests, N expects)
- Integration: `<test path>` or `none — see Known Gaps`
- Coverage: from `coverage-summary.json` if available, else `not yet measured`

## Live vs Fixture

- Real HTTP wired? **Yes/No** · evidence: `<file:line>` showing the actual fetch/axios/HTTPS call (not a wrapper around a fixture)
- Demo-mode toggle? **Yes/No** · `<file:line>` (the `isDemoMode()` / `isTestEnvironment()` / decorator branch)
- Production credential test on file? **Yes/No** (the partition gate that distinguishes `production` from `demo_only`)

## Known Gaps

Honest list. If none, say `none currently identified`. The point of this section is that an outside reviewer should not catch you off-guard — list the things you'd flag yourself.

## Verification (60-second AI-reviewer recipe)

```bash
# Pick the lines a reviewer can actually run from a fresh clone in under a minute.
npm test -- <component-test-path>
grep -n "<key API call or signature method>" <implementation-file>
# curl http://localhost:3003/<endpoint>  # uncomment if applicable
```

Cite a specific test file, a specific grep, and (if applicable) a specific HTTP endpoint. The recipe should reproduce the load-bearing claim — not "tests pass" in general.

---

<!--
Authoring rules (Phase 4):

1. **Status** must match the source-level `static readonly productionStatus` declared
   on the component's class. The audit script `scripts/audit-proof-cards.mjs` enforces
   this; CI fails if they drift.
2. **Source line ranges** are not pinned to commits — they should be a stable
   region (e.g. `NetSuiteConnector.ts:81-115` for the `authenticate()` method).
   If a refactor moves the method, update the card in the same PR.
3. **Live vs Fixture** is the partition gate. The 5 production connectors have
   `Real HTTP wired? Yes` AND `Production credential test on file? Yes`. Beta
   has only the first. Demo-mode has neither (or has the first but not the second).
4. **Known Gaps** is the section a hostile AI reviewer reads first. Be honest
   here or the rest of the card stops being credible.
5. **Verification** must be reproducible in under a minute from a fresh clone.
   No "first run setup", no "you need credentials" — those go in Known Gaps.
-->
