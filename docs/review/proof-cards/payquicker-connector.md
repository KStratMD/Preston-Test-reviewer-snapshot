# Proof Card: PayQuicker Connector

**Status:** stub
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`PayQuickerConnector` is an **explicit, honest stub**. The class declares `productionStatus = 'stub'` and `authenticate()` throws `'PayQuicker authentication not yet implemented - use demo mode'` when not in demo or test mode. CRUD-shaped methods (`createRecipient`, `createPayout`, etc.) exist as scaffolding so upstream interfaces compile, but they call back into `authenticate()` which short-circuits to a demo token in non-production runtimes. **There is no production code path.** This card exists to prove the stub is honest — i.e., that an outside reviewer running the verification recipe will see the throw and not be misled by the file's existence.

## Source

- Implementation: `src/connectors/PayQuickerConnector.ts:1-311`
- Entry point: `src/connectors/PayQuickerConnector.ts:124-137` (`authenticate()` — the stub path)
- Throw site: `src/connectors/PayQuickerConnector.ts:136` (`throw new Error('PayQuicker authentication not yet implemented - use demo mode')`)
- Demo-mode toggle: `src/connectors/PayQuickerConnector.ts:128-132` (`isDemoMode() || isTestEnvironment()` returns a static `'demo-token-payquicker'`)

## Tests

- Unit: `none currently — stub status by design`
- Integration: `none — see Known Gaps`

## Live vs Fixture

- Real HTTP wired? **No** — `authenticate()` throws before any HTTP call when not in demo/test mode.
- Demo-mode toggle? **Yes** · `PayQuickerConnector.ts:128` returns a hardcoded `'demo-token-payquicker'` string, which the CRUD-shaped methods then "use" to make stub responses.
- Production credential test on file? **No** — and intentionally so. PayQuicker has not been onboarded as a production payment provider.

## Known Gaps

- The class has CRUD-shaped methods that don't reflect production flows; if PayQuicker is ever genuinely onboarded, these scaffolds need to be replaced (not edited) with a real OAuth2 client-credentials flow against `https://api.payquicker.com`.
- No unit tests exist — partly because there's nothing real to test, and partly because the audit script + this card are the regression-prevention surface today. If the throw at line 136 is ever removed without replacing it with a working flow, the stub status would silently become a lie.
- This is the only connector in the `stub` partition. The `audit-status-claims.mjs` cross-check ensures `metrics.json:connectors.stub === 1`; flipping the status field on this class without removing/adding a card will fail CI.

## Verification (60-second AI-reviewer recipe)

```bash
grep -n "not yet implemented" src/connectors/PayQuickerConnector.ts
grep -n "productionStatus = 'stub'" src/connectors/PayQuickerConnector.ts
node scripts/audit-status-claims.mjs
```

The first grep should match exactly one line (the throw at line 136). The second should match exactly one line (the source-level partition tag). The audit script reports `stub=1` in its summary line.
