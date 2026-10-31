import { MODEL_PRICING_USD_PER_1K, pricingForModel, knownModels, tableCostUSD } from '../../../../src/services/cost/modelPricing';

describe('modelPricing', () => {
  it('exposes a frozen pricing table', () => {
    expect(Object.isFrozen(MODEL_PRICING_USD_PER_1K)).toBe(true);
    for (const rates of Object.values(MODEL_PRICING_USD_PER_1K)) {
      expect(Object.isFrozen(rates)).toBe(true);
    }
  });

  it('returns rates for known models', () => {
    const rates = pricingForModel('gpt-5.4-mini');
    expect(rates.input).toBeGreaterThan(0);
    expect(rates.output).toBeGreaterThan(rates.input);
  });

  it('includes current token-efficient OpenAI and Claude defaults', () => {
    expect(pricingForModel('gpt-5.4-mini')).toEqual({ input: 0.00075, output: 0.0045 });
    expect(pricingForModel('claude-haiku-4-5-20251001')).toEqual({ input: 0.001, output: 0.005 });
  });

  it('includes current higher-quality upgrade tiers', () => {
    expect(pricingForModel('gpt-5.4')).toEqual({ input: 0.0025, output: 0.015 });
    expect(pricingForModel('claude-sonnet-4-6')).toEqual({ input: 0.003, output: 0.015 });
  });

  it('returns zero rates for lmstudio/local without throwing', () => {
    const rates = pricingForModel('lmstudio/local');
    expect(rates.input).toBe(0);
    expect(rates.output).toBe(0);
  });

  it('throws on unknown models with an actionable message', () => {
    expect(() => pricingForModel('nonexistent-model')).toThrow(/Unknown model "nonexistent-model"/);
    expect(() => pricingForModel('nonexistent-model')).toThrow(/Add to MODEL_PRICING_USD_PER_1K/);
  });

  it('throws on empty string', () => {
    expect(() => pricingForModel('')).toThrow();
  });

  it('lists all known models in the error message', () => {
    try {
      pricingForModel('nonexistent-model');
      fail('expected throw');
    } catch (e) {
      for (const name of knownModels()) {
        expect((e as Error).message).toContain(name);
      }
    }
  });

  describe('tableCostUSD', () => {
    it('charges input and output at their distinct published rates (not a fixed multiplier)', () => {
      // gpt-5.4-mini: input 0.00075/1K, output 0.0045/1K.
      // 1000 in + 1000 out => 0.00075 + 0.0045 = 0.00525.
      expect(tableCostUSD('gpt-5.4-mini', 1000, 1000)).toBeCloseTo(0.00525, 10);
      const inputOnly = tableCostUSD('gpt-5.4-mini', 1000, 0)!;
      const outputOnly = tableCostUSD('gpt-5.4-mini', 0, 1000)!;
      // Real output:input ratio is 6x — far above the legacy x2 heuristic the
      // provider applied, which is exactly what this helper corrects.
      expect(outputOnly / inputOnly).toBeCloseTo(6, 5);
    });

    it('charges Claude output at the real 5x ratio (not the legacy 3x)', () => {
      // claude-haiku-4-5: input 0.001/1K, output 0.005/1K.
      expect(tableCostUSD('claude-haiku-4-5-20251001', 1000, 1000)).toBeCloseTo(0.006, 10);
    });

    it('prices the dated legacy Claude IDs that remain selectable/overridable', () => {
      // claude-3-5-sonnet-20241022 stays selectable in the model catalog and is
      // used by provider tests; claude-3-5-haiku-20241022 remains a valid
      // NL_ACTION_GATE_INTENT_MODEL override. Both must resolve so their cost
      // estimates use the table, not the flat heuristic fallback.
      expect(tableCostUSD('claude-3-5-haiku-20241022', 1000, 1000)).not.toBeNull();
      expect(tableCostUSD('claude-3-5-sonnet-20241022', 1000, 1000)).not.toBeNull();
    });

    it('returns null for unpriced models so callers can fall back', () => {
      expect(tableCostUSD('some-unlisted-model', 1000, 1000)).toBeNull();
    });

    it('returns 0 for local/zero-rate models', () => {
      expect(tableCostUSD('lmstudio/local', 1000, 1000)).toBe(0);
    });
  });
});
