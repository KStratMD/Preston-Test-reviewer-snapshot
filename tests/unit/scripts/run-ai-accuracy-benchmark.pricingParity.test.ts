/**
 * Pricing-parity guard for the AI-accuracy-benchmark runner (M1 Phase B).
 *
 * The benchmark runner (`scripts/run-ai-accuracy-benchmark.mjs`) keeps its own
 * `MODEL_PRICING_USD_PER_1K` table because it is plain ESM and cannot import
 * the TypeScript canonical table in `src/services/cost/modelPricing.ts`.
 * Diverging rates would make the benchmark's cost cap / estimated-cost output
 * disagree with the Cost Transparency Dashboard, so this test pins parity:
 *
 *   1. Every `claude-*` model priced in the benchmark table must have rates
 *      byte-equal to the canonical modelPricing.ts entry.
 *   2. The two Anthropic benchmark defaults (`claude-haiku-4-5` and its dated
 *      snapshot) must be present in the benchmark table.
 *   3. `gpt-5.4-mini` (the OpenAI benchmark default) exists in modelPricing.ts,
 *      so its rates are also asserted equal. (If modelPricing.ts ever drops
 *      OpenAI models, scope this back to claude-* only.)
 *
 * Parsing follows the established style of
 * `run-ai-accuracy-benchmark.dataLeakage.test.ts`: TypeScript AST for the .ts
 * source, text regex for the .mjs runner (which jest does not transpile).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');

interface Rates {
  input: number;
  output: number;
}

/** Parse MODEL_PRICING_USD_PER_1K from the .mjs runner via text regex. */
function readBenchmarkPricing(): Record<string, Rates> {
  const filePath = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');
  const text = fs.readFileSync(filePath, 'utf8');
  const blockRe = /const MODEL_PRICING_USD_PER_1K\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/;
  const block = text.match(blockRe);
  if (!block) {
    throw new Error('Could not find MODEL_PRICING_USD_PER_1K in run-ai-accuracy-benchmark.mjs');
  }
  const entryRe =
    /['"]([^'"]+)['"]:\s*Object\.freeze\(\{\s*input:\s*([0-9.eE+-]+)\s*,\s*output:\s*([0-9.eE+-]+)\s*\}\)/g;
  const out: Record<string, Rates> = {};
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block[1])) !== null) {
    out[m[1]] = { input: Number(m[2]), output: Number(m[3]) };
  }
  return out;
}

/** Parse MODEL_PRICING_USD_PER_1K from modelPricing.ts via AST. */
function readCanonicalPricing(): Record<string, Rates> {
  const filePath = path.join(REPO_ROOT, 'src/services/cost/modelPricing.ts');
  const text = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);

  let tableLiteral: ts.ObjectLiteralExpression | null = null;

  function walk(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MODEL_PRICING_USD_PER_1K' &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const arg = node.initializer.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        tableLiteral = arg;
        return;
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  if (!tableLiteral) {
    throw new Error('Could not find MODEL_PRICING_USD_PER_1K object literal in modelPricing.ts');
  }

  const out: Record<string, Rates> = {};
  for (const prop of (tableLiteral as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isStringLiteral(prop.name)
      ? prop.name.text
      : ts.isIdentifier(prop.name)
        ? prop.name.text
        : null;
    if (!name) continue;
    if (!ts.isCallExpression(prop.initializer)) continue;
    const arg = prop.initializer.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;

    let input: number | null = null;
    let output: number | null = null;
    for (const rateProp of arg.properties) {
      if (!ts.isPropertyAssignment(rateProp) || !ts.isIdentifier(rateProp.name)) continue;
      if (!ts.isNumericLiteral(rateProp.initializer)) continue;
      if (rateProp.name.text === 'input') input = Number(rateProp.initializer.text);
      else if (rateProp.name.text === 'output') output = Number(rateProp.initializer.text);
    }
    if (input !== null && output !== null) {
      out[name] = { input, output };
    }
  }
  return out;
}

describe('AI accuracy benchmark pricing parity (M1 Phase B)', () => {
  it('parses at least one entry from each source (regression net against silent-empty parsers)', () => {
    expect(Object.keys(readBenchmarkPricing()).length).toBeGreaterThan(0);
    expect(Object.keys(readCanonicalPricing()).length).toBeGreaterThan(0);
  });

  it('the benchmark table prices the Anthropic default model (alias and dated snapshot)', () => {
    const benchmark = readBenchmarkPricing();
    expect(benchmark['claude-haiku-4-5']).toBeDefined();
    expect(benchmark['claude-haiku-4-5-20251001']).toBeDefined();
  });

  it('every claude-* model in the benchmark table matches the canonical modelPricing.ts rates', () => {
    const benchmark = readBenchmarkPricing();
    const canonical = readCanonicalPricing();

    const claudeModels = Object.keys(benchmark).filter((model) => model.startsWith('claude-'));
    expect(claudeModels.length).toBeGreaterThan(0);

    const mismatches: { model: string; benchmark: Rates | null; canonical: Rates | null }[] = [];
    for (const model of claudeModels) {
      const canonicalRates = canonical[model] ?? null;
      if (
        !canonicalRates ||
        canonicalRates.input !== benchmark[model].input ||
        canonicalRates.output !== benchmark[model].output
      ) {
        mismatches.push({ model, benchmark: benchmark[model], canonical: canonicalRates });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('gpt-5.4-mini (OpenAI benchmark default) matches the canonical modelPricing.ts rates', () => {
    const benchmark = readBenchmarkPricing();
    const canonical = readCanonicalPricing();

    // modelPricing.ts currently prices OpenAI models too. If it ever drops
    // them, scope this test back to claude-* only (see header comment).
    expect(canonical['gpt-5.4-mini']).toBeDefined();
    expect(benchmark['gpt-5.4-mini']).toEqual(canonical['gpt-5.4-mini']);
  });
});
