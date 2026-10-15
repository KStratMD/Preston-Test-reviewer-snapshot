/**
 * Golden-Set AI Evaluator
 * Runs predefined test cases through AI and computes an accuracy scorecard.
 *
 * Phase A (M1) update: the previous in-process mock `callAI()` was a heuristic
 * stub. It now delegates to a real OpenAI provider call when OPENAI_API_KEY is
 * present, so this scaffold and `scripts/run-ai-accuracy-benchmark.mjs` agree
 * on the top-1 accuracy number for the same fixture. The CLI runner is the
 * canonical entry point (`npm run benchmark:ai`); this file remains as the
 * detailed scorecard variant (top-1 + top-3 + manual-edit-rate + per-case
 * breakdown) and as a regression-net example of how to drive a real provider
 * from a labeled fixture.
 *
 * To run live: `OPENAI_API_KEY=... ts-node scripts/golden/run-eval.ts`
 * Without OPENAI_API_KEY this script aborts — there is no mock fallback by
 * design, so a stale "looks like everything passed" result can't ship.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from '../../src/utils/Logger';

interface AIFieldMappingSuggestion {
  sourceField: string;
  targetField: string;
  confidence: number;
  transformationType: string;
}

interface TestCase {
  name: string;
  sourceFields: Array<{ name: string; type: string; sample: string }>;
  expectedMappings: Array<{
    source: string;
    target: string;
    confidence: number;
  }>;
}

interface TestSuite {
  testSuite: {
    name: string;
    sourceSystem: string;
    targetSystem: string;
    entityType: string;
  };
  testCases: TestCase[];
}

interface EvaluationResult {
  testCase: string;
  top1Accuracy: number;
  top3Accuracy: number;
  avgConfidence: number;
  manualEditRate: number;
  hallucinations: number;
  timeMs: number;
  details: Array<{
    field: string;
    expected: string;
    actual: string;
    match: boolean;
  }>;
}

interface Scorecard {
  timestamp: number;
  totalCases: number;
  overallAccuracy: number;
  top1Accuracy: number;
  top3Accuracy: number;
  avgConfidence: number;
  manualEditRate: number;
  hallucinationCount: number;
  avgTimeMs: number;
  breakdown: EvaluationResult[];
}

/**
 * Load test suites from fixtures
 */
function loadTestSuites(pattern: string): TestSuite[] {
  const fixturesDir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.yaml'));

  return files.map(file => {
    const content = fs.readFileSync(path.join(fixturesDir, file), 'utf-8');
    return yaml.load(content) as TestSuite;
  });
}

/**
 * Drive a real OpenAI call for one test case. Follows the same base prompt
 * shape as `scripts/run-ai-accuracy-benchmark.mjs`, but does NOT inject the
 * broad NetSuite Customer target-schema block the benchmark runner now uses,
 * so scores from this helper are NOT directly comparable to the committed
 * benchmark artifact (`docs/review/ai-accuracy-benchmark.md`) — treat this
 * as a lightweight smoke harness, not a reproduction of that number.
 * The few-shot examples shipped in production prompts are intentionally NOT
 * included here either — the data-leakage guard in the .mjs runner enforces
 * that fixture pairs don't overlap with `COMMON_MAPPING_EXAMPLES`, and adding
 * the examples back would defeat the guard.
 */
async function callAI(testCase: TestCase, suite: TestSuite): Promise<AIFieldMappingSuggestion[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY required. Run `OPENAI_API_KEY=... ts-node scripts/golden/run-eval.ts`, ' +
      'or use `npm run benchmark:ai -- --dry-run` for the deterministic oracle path.'
    );
  }
  const model = process.env.OPENAI_BENCHMARK_MODEL || 'gpt-5.4-mini';

  const fieldsBlock = testCase.sourceFields
    .map(f => `  - "${f.name}" (${f.type}): sample = ${JSON.stringify(f.sample)}`)
    .join('\n');

  const system =
    'You are an expert data integration engineer with deep expertise in Salesforce and NetSuite field mapping. ' +
    'Return ONLY a JSON object — no commentary, no markdown fences.';

  const user = `Map each source field below to the most appropriate ${suite.testSuite.targetSystem} field.

Source System: ${suite.testSuite.sourceSystem}
Target System: ${suite.testSuite.targetSystem}
Entity Type: ${suite.testSuite.entityType}

Source Fields:
${fieldsBlock}

Response format (JSON, no markdown):
{
  "suggestions": [
    { "sourceField": "<exact source field name>", "targetField": "<target field>", "confidence": <0-100>, "transformationType": "direct|lookup|calculation|concatenation" }
  ]
}

Output every source field exactly once. Use the EXACT sourceField names from the input.`;

  // Per-request timeout — mirrors `scripts/run-ai-accuracy-benchmark.mjs`
  // and `scripts/ai-config-smoke.js`. A stalled OpenAI response would
  // otherwise wedge this worked example indefinitely.
  const REQUEST_TIMEOUT_MS = 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  let payload: { choices?: Array<{ message?: { content?: string } }> };
  try {
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          temperature: 0,
          ...openAICompletionTokenLimitParam(model, 800)
        }),
        signal: controller.signal
      });
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === 'AbortError') {
        throw new Error(
          `OpenAI request timed out after ${REQUEST_TIMEOUT_MS} ms (case: "${testCase.name}")`
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '<no body>');
      throw new Error(`OpenAI API ${response.status}: ${text}`);
    }

    payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
  } finally {
    clearTimeout(timeout);
  }
  const raw = payload?.choices?.[0]?.message?.content;
  if (!raw || typeof raw !== 'string') {
    throw new Error('OpenAI returned no content');
  }
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  let parsed: { suggestions?: AIFieldMappingSuggestion[] };
  try {
    parsed = JSON.parse(cleaned) as { suggestions?: AIFieldMappingSuggestion[] };
  } catch (err) {
    const msg = (err as { message?: string } | undefined)?.message ?? String(err);
    throw new Error(`OpenAI response not valid JSON: ${msg} / raw: ${cleaned.slice(0, 200)}`);
  }
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  return suggestions.map(s => ({
    sourceField: String(s.sourceField || ''),
    targetField: String(s.targetField || ''),
    confidence: typeof s.confidence === 'number' ? s.confidence / 100 : 0.8,
    transformationType: String(s.transformationType || 'direct')
  }));
}

function openAICompletionTokenLimitParam(model: string, maxTokens: number): { max_completion_tokens: number } | { max_tokens: number } {
  return model.toLowerCase().startsWith('gpt-5')
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/**
 * Evaluate accuracy of AI suggestions against expected mappings
 */
function evaluateAccuracy(
  suggestions: AIFieldMappingSuggestion[],
  expected: TestCase['expectedMappings']
): { correct: number; total: number; details: any[] } {
  let correct = 0;
  const details: any[] = [];

  expected.forEach(exp => {
    const suggestion = suggestions.find(s => s.sourceField === exp.source);
    const match = suggestion?.targetField === exp.target;

    if (match) correct++;

    details.push({
      field: exp.source,
      expected: exp.target,
      actual: suggestion?.targetField || 'N/A',
      match
    });
  });

  return {
    correct,
    total: expected.length,
    details
  };
}

/**
 * Run evaluation on all test suites
 */
async function runEvaluation(): Promise<Scorecard> {
  logger.info('Starting Golden-Set AI Evaluation...');

  const suites = loadTestSuites('*.yaml');
  const results: EvaluationResult[] = [];

  for (const suite of suites) {
    logger.info(`Evaluating suite: ${suite.testSuite.name}`);

    for (const testCase of suite.testCases) {
      const startTime = Date.now();

      // Call AI
      const suggestions = await callAI(testCase, suite);

      // Evaluate accuracy
      const { correct, total, details } = evaluateAccuracy(suggestions, testCase.expectedMappings);

      const timeMs = Date.now() - startTime;
      const top1Accuracy = correct / total;

      // Calculate metrics. Guard against empty suggestions (zero-divide → NaN)
      // when the model returns no candidates — Copilot R2 caught this.
      const avgConfidence = suggestions.length > 0
        ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length
        : 0;
      const manualEditRate = (total - correct) / total;
      const hallucinations = suggestions.filter(s =>
        !testCase.sourceFields.some(f => f.name === s.sourceField)
      ).length;

      results.push({
        testCase: testCase.name,
        top1Accuracy,
        top3Accuracy: top1Accuracy, // Simplified for MVP
        avgConfidence,
        manualEditRate,
        hallucinations,
        timeMs,
        details
      });

      logger.info(`  ${testCase.name}: ${(top1Accuracy * 100).toFixed(1)}% accuracy`);
    }
  }

  // Generate scorecard
  const scorecard: Scorecard = {
    timestamp: Date.now(),
    totalCases: results.length,
    overallAccuracy: results.reduce((sum, r) => sum + r.top1Accuracy, 0) / results.length,
    top1Accuracy: results.reduce((sum, r) => sum + r.top1Accuracy, 0) / results.length,
    top3Accuracy: results.reduce((sum, r) => sum + r.top3Accuracy, 0) / results.length,
    avgConfidence: results.reduce((sum, r) => sum + r.avgConfidence, 0) / results.length,
    manualEditRate: results.reduce((sum, r) => sum + r.manualEditRate, 0) / results.length,
    hallucinationCount: results.reduce((sum, r) => sum + r.hallucinations, 0),
    avgTimeMs: results.reduce((sum, r) => sum + r.timeMs, 0) / results.length,
    breakdown: results
  };

  // Save scorecard
  const outputPath = path.join(__dirname, '..', '..', 'out', 'scorecard.json');
  fs.writeFileSync(outputPath, JSON.stringify(scorecard, null, 2));

  logger.info(`Scorecard saved to: ${outputPath}`);

  // Print summary table
  console.log('\n=== Golden-Set AI Evaluation Results ===\n');
  console.log(`Total Test Cases: ${scorecard.totalCases}`);
  console.log(`Overall Accuracy: ${(scorecard.overallAccuracy * 100).toFixed(1)}%`);
  console.log(`Top-1 Accuracy: ${(scorecard.top1Accuracy * 100).toFixed(1)}%`);
  console.log(`Top-3 Accuracy: ${(scorecard.top3Accuracy * 100).toFixed(1)}%`);
  console.log(`Avg Confidence: ${(scorecard.avgConfidence * 100).toFixed(1)}%`);
  console.log(`Manual Edit Rate: ${(scorecard.manualEditRate * 100).toFixed(1)}%`);
  console.log(`Hallucinations: ${scorecard.hallucinationCount}`);
  console.log(`Avg Time: ${scorecard.avgTimeMs.toFixed(0)}ms`);
  console.log('\n========================================\n');

  return scorecard;
}

// Run if executed directly
if (require.main === module) {
  runEvaluation()
    .then(() => {
      logger.info('Evaluation complete');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Evaluation failed', { error });
      process.exit(1);
    });
}

export { runEvaluation };
