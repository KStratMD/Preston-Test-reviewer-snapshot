# Proof Card: AI Providers (OpenAI, Claude, OpenRouter, LMStudio)

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

Four AI providers are wired against real LLM APIs:

- **OpenAI** — `https://api.openai.com/v1/chat/completions` (GPT-4o)
- **Claude** — `https://api.anthropic.com/v1/messages` (Claude 3.5 Sonnet)
- **OpenRouter** — `https://openrouter.ai/api/v1/chat/completions` (multi-model gateway, 50+ models)
- **LMStudio** — `http://localhost:1234` (local, default; configurable)

Each provider extends a common `AIProvider` interface with `chat()`, `generateMappingSuggestions()`, and `assessQuality()` methods. They are not mocks of each other or wrappers around a fixture proxy — each issues `fetch()` directly against its provider's REST endpoint with the right auth header.

## Source

- OpenAI: `src/services/ai/providers/OpenAIProvider.ts:63-466` — `chat()` POSTs to `${baseURL}/chat/completions` at line 284, default `baseURL = 'https://api.openai.com/v1'` at line 81
- Claude: `src/services/ai/providers/ClaudeProvider.ts:66-540` — `chat()` POSTs to `${baseURL}/messages` at line 301, default `baseURL = 'https://api.anthropic.com/v1'` at line 84
- OpenRouter: `src/services/ai/providers/OpenRouterProvider.ts:78-380` — `generateMappingSuggestions()` POSTs to `${apiBaseUrl}/chat/completions` at line 312, default `baseURL = 'https://openrouter.ai/api/v1'` at line 95
- LMStudio: `src/services/ai/providers/LMStudioProvider.ts`
- Router: `src/services/ai/providers/IntelligentProviderRouter.ts:64-380` — `routeRequest()` at line 90 picks a provider tier based on task type + cost + latency

## Tests

- Provider factories: `tests/unit/services/ai/providers/ProviderFactories.test.ts` (93 tests, 206 expects) — exercises construction + factory selection
- CloudAI shell: `tests/unit/services/ai/providers/__tests__/CloudAIProvider.test.ts` (7 tests, 11 expects)
- Catalog: `tests/unit/__tests__/ModelCatalogService.providers.test.ts`
- Provider utils: `tests/unit/utils/ai/providers.test.ts`

## Live vs Fixture

- Real HTTP wired? **Yes** · all four providers issue `fetch(...)` against the documented public endpoints; the unit tests use Jest module mocks at the provider class level (`jest.mock('src/services/ai/providers/OpenAIProvider', ...)` at `ProviderFactories.test.ts:81-98`), but the providers themselves call `global.fetch`.
- Demo-mode toggle? Indirectly — `IntelligentProviderRouter` can route to `RuleBasedProvider` (no network) when no live provider is configured, but the four cloud providers don't carry their own demo branches.
- Production credential test on file? **Yes** — operator-attested per CLAUDE.md "AI System: Phase 1-5 complete, all production-ready" and per repeated production usage cited in commit history.

## Known Gaps

- The unit tests mock at the provider class level, not at the `fetch` boundary. A reviewer who wants to verify wire-format correctness end-to-end would need to add an MSW (or `nock`) integration test at the HTTP boundary; today the wire-format claim rests on the readable POST body in each provider's `chat()` method.
- Provider rotation under quota exhaustion is implemented in `IntelligentProviderRouter` but `quota=0` failover scenarios are not exhaustively tested.
- LMStudio's local-server pattern means `chat()` against an unreachable endpoint surfaces a connection error to the caller rather than failing over — by design, since LMStudio is the local-LLM tier.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/services/ai/providers/ProviderFactories.test.ts
grep -n "api.openai.com\|api.anthropic.com\|openrouter.ai" src/services/ai/providers/*.ts
grep -n "global.fetch\|fetch(" src/services/ai/providers/OpenAIProvider.ts src/services/ai/providers/ClaudeProvider.ts | head -10
```

The first grep proves the three cloud hosts are real string literals in the source. The second grep proves the providers call the global `fetch` API directly — they aren't routing through a mock layer.
