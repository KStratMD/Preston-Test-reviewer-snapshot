/**
 * Per-model USD-per-1K-token rates. Pattern mirrors the MODEL_PRICING_USD_PER_1K
 * table in scripts/run-ai-accuracy-benchmark.mjs (PR 837 / M1 Phase A — Codex P1).
 *
 * Current consumers: this table is the canonical source of upstream-published
 * rates. Provider cost tracking (OpenAIProvider/ClaudeProvider
 * `estimateUsageCostUSD()`) now reads it via `tableCostUSD()`, charging input
 * and output tokens at their distinct published rates and falling back to the
 * provider's flat `getCostPerToken()` heuristic only for models with no table
 * entry. The Cost Transparency Dashboard's rollups read the `estimated_cost`
 * values those providers populate, so the table is in that hot path now. It
 * is also the basis for future cost-recomputation features (e.g.,
 * reconciliation against provider invoices).
 *
 * The table is frozen at module load; future consumers that adopt
 * `pricingForModel(model)` get a loud failure (throw) on unknown models
 * rather than a silent zero-rate fallback.
 *
 * Adding a model: insert with the upstream-published rate.
 *
 * Source for rates (verified 2026-06-02):
 *   OpenAI: https://developers.openai.com/api/docs/pricing
 *   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   OpenRouter: https://openrouter.ai/models  (per-model)
 *
 * LMStudio runs locally — no provider-side cost, but pricingForModel still
 * returns a zero entry so cost calculations don't special-case it.
 */
export interface ModelRates {
  readonly input: number;   // USD per 1K input tokens
  readonly output: number;  // USD per 1K output tokens
}

export const MODEL_PRICING_USD_PER_1K = Object.freeze<Record<string, ModelRates>>({
  // OpenAI
  'gpt-5.4':              Object.freeze({ input: 0.0025,  output: 0.015 }),
  'gpt-5.4-mini':         Object.freeze({ input: 0.00075, output: 0.0045 }),
  'gpt-5.4-nano':         Object.freeze({ input: 0.0002,  output: 0.00125 }),
  'gpt-4o':              Object.freeze({ input: 0.0025,  output: 0.01 }),
  'gpt-4o-mini':         Object.freeze({ input: 0.00015, output: 0.0006 }),
  // Anthropic
  'claude-sonnet-4-6':    Object.freeze({ input: 0.003,   output: 0.015 }),
  'claude-haiku-4-5':     Object.freeze({ input: 0.001,   output: 0.005 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 0.001, output: 0.005 }),
  'claude-opus-4-8':      Object.freeze({ input: 0.005,   output: 0.025 }),
  'claude-3-5-sonnet':   Object.freeze({ input: 0.003,   output: 0.015 }),
  'claude-3-5-sonnet-20241022': Object.freeze({ input: 0.003, output: 0.015 }),
  'claude-3-5-haiku':    Object.freeze({ input: 0.0008,  output: 0.004 }),
  'claude-3-5-haiku-20241022':  Object.freeze({ input: 0.0008, output: 0.004 }),
  // OpenRouter (free tier — placeholder; many routes are 0)
  'openrouter/auto':     Object.freeze({ input: 0.001,   output: 0.003 }),
  // LMStudio (local; zero cost by definition)
  'lmstudio/local':      Object.freeze({ input: 0,       output: 0 }),
});

export function knownModels(): readonly string[] {
  return Object.freeze(Object.keys(MODEL_PRICING_USD_PER_1K));
}

export function pricingForModel(model: string): ModelRates {
  const rates = MODEL_PRICING_USD_PER_1K[model];
  if (!rates) {
    const known = knownModels().join(', ');
    throw new Error(
      `Unknown model "${model}" — no pricing rates on file. ` +
      `Add to MODEL_PRICING_USD_PER_1K (with the upstream-published rate) or pick one of: ${known}.`,
    );
  }
  return rates;
}

/**
 * Accurate per-call spend in USD from the canonical input/output rates.
 * Returns null when the model is not in the table, so callers can fall back
 * to their own heuristic rather than throw on an unrecognized model string.
 * This is the correct alternative to a single-rate-x-fixed-multiplier
 * estimate, which cannot match models whose output:input ratio differs from
 * the assumed multiplier (e.g. gpt-5.4-mini is 6x, claude-haiku-4-5 is 5x).
 */
export function tableCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const rates = MODEL_PRICING_USD_PER_1K[model];
  if (!rates) return null;
  return (promptTokens * rates.input + completionTokens * rates.output) / 1000;
}
