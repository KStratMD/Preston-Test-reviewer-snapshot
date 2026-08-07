# Proof Card: MCP Aggregator Service

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`MCPAggregatorService` proxies MCP tool calls (Model Context Protocol) from registered clients (e.g. Business Central, NetSuite-Official) and **auto-redacts PII before returning the result to the caller**. The auto-redact path is the security-critical claim: every MCP tool result passes through `dlpService.scanForPII({ autoRedact: true })` on its way back to the caller, so a tool that returns `{ customerEmail: 'x@y.com' }` produces a redacted version regardless of what the upstream MCP server emits.

## Source

- Implementation: `src/services/mcp/MCPAggregatorService.ts:1-322`
- Auto-redact entry point: `src/services/mcp/MCPAggregatorService.ts:215-224`:
  ```ts
  const toolResult = await adapter.callTool(parsed.toolName, args);
  const piiScan = await this.dlpService.scanForPII(toolResult, {
    allowPII: false,
    piiTypes: [],
    autoRedact: true,
    blockOnDetection: false,
  });
  ```
- Adapter clients (real MCP wire integrations):
  - `src/services/bc/mcp/BusinessCentralMcpClient.ts`
  - `src/services/netsuite/mcp/NetSuiteOfficialMcpClient.ts`
- Dependencies: `DLPService` (next card), `IMCPAdapter` interface

## Tests

- Unit: `tests/unit/__tests__/services/mcp/MCPAggregatorService.test.ts` (10 tests, 18 expects)
- Integration (regression net): `tests/integration/MCPAutoRedact.fixture.test.ts` (12 tests, 33 expects) — pins per-PII-type positive/negative pairs plus a multi-field object-integrity guard. Per CLAUDE.md, this fixture test is "the regression-prevention net" for the auto-redact contract.

## Live vs Fixture

- Real HTTP wired? **Yes** at the adapter layer — `BusinessCentralMcpClient.ts` and `NetSuiteOfficialMcpClient.ts` issue real MCP tool calls (referenced in CLAUDE.md as `BusinessCentralMcpClient.ts:298` and `NetSuiteOfficialMcpClient.ts:318` for the `content[0].text` payload shape).
- Auto-redact wired into the response path? **Yes** at `MCPAggregatorService.ts:215`. There is no branch that skips DLP scanning.
- Demo-mode toggle? **No** — the redaction path is unconditional. If DLP scanning fails (throws), the caller sees the failure rather than the unredacted result.

## Known Gaps

- **Free-text intl phone detection is intentionally not flagged.** Per CLAUDE.md "Phone detection scope limitation": phones embedded in `content[0].text` of a tool result without a stable surrounding field name are NOT redacted, because the same Codex false-positive risk applies even more strongly to free text. The integration test "should NOT flag intl phone in a free-text MCP content[].text payload" pins this gap.
- Field-name-aware validation is the contract for new patterns. Adding a new aggressive regex without a field-context gate would silently mutate MCP tool output.
- DLP failures are surfaced as call failures rather than partial results — by design, but worth knowing when triaging tool-call errors.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/integration/MCPAutoRedact.fixture.test.ts
npm test -- tests/unit/__tests__/services/mcp/MCPAggregatorService.test.ts
grep -n "scanForPII\|autoRedact: true" src/services/mcp/MCPAggregatorService.ts
```

The grep should match exactly one auto-redact site at line 215. The fixture test enumerates the per-PII-type positive/negative pairs the auto-redact path must handle.
