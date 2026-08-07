/**
 * Regression test for the AI-accuracy-benchmark data-leakage guard (M1 Phase A).
 *
 * The benchmark fixture (`scripts/golden/fixtures/sfdc-to-ns-customers.yaml`)
 * must NOT contain any (sourceField, targetField) pair that appears in
 * `COMMON_MAPPING_EXAMPLES` in `src/services/ai/prompts/FieldMappingPrompts.ts`.
 * Those examples ship in production prompts, so allowing them in the
 * benchmark would let the model "cheat" on patterns it was just taught.
 *
 * Two complementary checks here:
 *
 *   1. PARITY — the hardcoded `COMMON_EXAMPLE_PAIRS` array in the .mjs
 *      runner must enumerate every pair in the .ts source.  If the .ts
 *      source grows a new example, this test fails and the runner must
 *      be updated in lockstep.
 *
 *   2. FIXTURE EXCLUSION — no labeled mapping in the fixture overlaps
 *      with any pair in COMMON_EXAMPLE_PAIRS.
 *
 * The combined effect: extending COMMON_MAPPING_EXAMPLES is safe; the
 * test forces the runner + fixture to stay aligned.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');

interface CasePair {
  source: string;
  target: string;
}

/** Parse COMMON_MAPPING_EXAMPLES from the TypeScript source via AST. */
function readSourcePairsFromTs(): CasePair[] {
  const filePath = path.join(REPO_ROOT, 'src/services/ai/prompts/FieldMappingPrompts.ts');
  const text = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);

  let arrayLiteral: ts.ArrayLiteralExpression | null = null;

  function walk(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'COMMON_MAPPING_EXAMPLES' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      arrayLiteral = node.initializer;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  if (!arrayLiteral) {
    throw new Error('Could not find COMMON_MAPPING_EXAMPLES array literal in FieldMappingPrompts.ts');
  }

  const pairs: CasePair[] = [];
  for (const el of (arrayLiteral as ts.ArrayLiteralExpression).elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    let source: string | null = null;
    let target: string | null = null;
    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !prop.name || !ts.isIdentifier(prop.name)) continue;
      if (!ts.isStringLiteral(prop.initializer)) continue;
      if (prop.name.text === 'sourceField') source = prop.initializer.text;
      else if (prop.name.text === 'targetField') target = prop.initializer.text;
    }
    if (source && target) {
      pairs.push({ source, target });
    }
  }
  return pairs;
}

/** Parse COMMON_EXAMPLE_PAIRS from the .mjs runner via text regex. */
function readRunnerPairsFromMjs(): CasePair[] {
  const filePath = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');
  const text = fs.readFileSync(filePath, 'utf8');
  const blockRe = /const COMMON_EXAMPLE_PAIRS\s*=\s*\[([\s\S]*?)\];/;
  const block = text.match(blockRe);
  if (!block) {
    throw new Error('Could not find COMMON_EXAMPLE_PAIRS in run-ai-accuracy-benchmark.mjs');
  }
  const inner = block[1];
  // Match each `['source', 'target']` tuple. Single or double quotes both OK.
  const pairRe = /\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g;
  const pairs: CasePair[] = [];
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(inner)) !== null) {
    pairs.push({ source: m[1], target: m[2] });
  }
  return pairs;
}

const NS_FIXTURE_PATH = 'scripts/golden/fixtures/sfdc-to-ns-customers.yaml';
const BC_FIXTURE_PATH = 'scripts/golden/fixtures/sfdc-to-bc-customers.yaml';

interface Fixture {
  testSuite: { targetSystem?: string };
  testCases: {
    name: string;
    expectedMappings: { source: string; target: string }[];
  }[];
}

function readFixture(fixtureRelPath: string): Fixture {
  const filePath = path.join(REPO_ROOT, fixtureRelPath);
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw) as Fixture;
}

function readFixturePairs(fixtureRelPath: string = NS_FIXTURE_PATH): (CasePair & { case: string })[] {
  const parsed = readFixture(fixtureRelPath);
  const out: (CasePair & { case: string })[] = [];
  for (const tc of parsed.testCases) {
    for (const m of tc.expectedMappings) {
      out.push({ case: tc.name, source: m.source, target: m.target });
    }
  }
  return out;
}

function readRunnerSchemaFields(constantName: string): string[] {
  const filePath = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');
  const text = fs.readFileSync(filePath, 'utf8');
  const blockRe = new RegExp(`const ${constantName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`);
  const block = text.match(blockRe);
  if (!block) {
    throw new Error(`Could not find ${constantName} in run-ai-accuracy-benchmark.mjs`);
  }

  return [...block[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function readRunnerCustomerSchemaFields(): string[] {
  return readRunnerSchemaFields('NETSUITE_CUSTOMER_SCHEMA_FIELDS');
}

/**
 * Parse the scalar Property names of the customers EntityType from the real
 * BC OData v4 metadata fixture. `<Property ...>` only — NavigationProperty
 * elements are relationship links, not mappable scalar fields (the leading
 * `<` anchors the match so "NavigationProperty" cannot match "Property").
 */
function readBcXmlPropertyNames(): string[] {
  const filePath = path.join(REPO_ROOT, 'src/connectors/fixtures/bc/metadata/customers.xml');
  const text = fs.readFileSync(filePath, 'utf8');
  return [...text.matchAll(/<Property\s+Name="([^"]+)"/g)].map((match) => match[1]);
}

function pairKey(p: CasePair): string {
  return `${p.source}::${p.target}`;
}

describe('AI accuracy benchmark data-leakage guard (M1 Phase A)', () => {
  describe('COMMON_EXAMPLE_PAIRS parity', () => {
    it('the .mjs runner enumerates every (source, target) pair from FieldMappingPrompts.ts', () => {
      const sourcePairs = readSourcePairsFromTs();
      const runnerPairs = readRunnerPairsFromMjs();

      // Order doesn't matter — what matters is set equality.
      const sourceSet = new Set(sourcePairs.map(pairKey));
      const runnerSet = new Set(runnerPairs.map(pairKey));

      const missingInRunner = [...sourceSet].filter((k) => !runnerSet.has(k));
      const extraInRunner = [...runnerSet].filter((k) => !sourceSet.has(k));

      expect({ missingInRunner, extraInRunner }).toEqual({ missingInRunner: [], extraInRunner: [] });
    });

    it('parses at least one pair from each source (regression net against the parser silently returning empty)', () => {
      expect(readSourcePairsFromTs().length).toBeGreaterThan(0);
      expect(readRunnerPairsFromMjs().length).toBeGreaterThan(0);
    });
  });

  describe('fixture exclusion', () => {
    it('no fixture (source, target) pair appears in COMMON_EXAMPLE_PAIRS', () => {
      const sourcePairs = readSourcePairsFromTs();
      const sourceSet = new Set(sourcePairs.map(pairKey));
      const fixture = readFixturePairs();

      const conflicts = fixture.filter((p) => sourceSet.has(pairKey(p)));

      expect(conflicts).toEqual([]);
    });

    it('the fixture has at least 55 labeled mappings (Phase B coverage floor)', () => {
      const fixture = readFixturePairs();
      // Phase B widened the fixture from ~37 to 61 labeled (source, target)
      // mappings (contact person, marketing attribution, lifecycle,
      // pricing/ops families). 55 is the documented floor; any shrinkage
      // below this should be deliberate (update the plan + this assertion
      // together).
      expect(fixture.length).toBeGreaterThanOrEqual(55);
    });

    it('the runner target schema is broad enough to avoid fixture answer-set leakage', () => {
      const runnerPath = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');
      const runnerText = fs.readFileSync(runnerPath, 'utf8');
      const fixtureTargets = new Set(readFixturePairs().map((p) => p.target));
      const schemaFields = readRunnerCustomerSchemaFields();
      const schemaFieldSet = new Set(schemaFields);

      const missingTargets = [...fixtureTargets].filter((target) => !schemaFieldSet.has(target));
      // Count distractors by unique id, not raw array length — duplicate ids
      // must not be able to inflate the breadth checks below.
      const distractors = [...schemaFieldSet].filter((field) => !fixtureTargets.has(field));

      // Duplicate schema ids would silently weaken the guard, so pin uniqueness.
      expect(schemaFieldSet.size).toBe(schemaFields.length);
      expect(missingTargets).toEqual([]);
      expect(distractors.length).toBeGreaterThanOrEqual(75);
      expect(schemaFieldSet.size).toBeGreaterThan(fixtureTargets.size * 3);
      expect(runnerText).not.toContain('Allowed NetSuite Customer targetField values');
    });
  });

  /**
   * Business Central pair (Phase B). Leakage posture differs from NS:
   * the candidate set is the COMPLETE real production schema (every scalar
   * Property of the OData v4 customers EntityType fixture), uncurated
   * relative to the answer set. Because that schema is only ~19 fields, the
   * NS >=75 absolute distractor floor is replaced by a proportional rule —
   * the fixture may label at most floor(schema/2) distinct targets,
   * guaranteeing >=50% distractors — plus a parity pin against the XML so
   * the candidate set can never be quietly curated back down to the
   * answer-set (the PR #880 leak class).
   */
  describe('Business Central pair (Phase B)', () => {
    it('BC_CUSTOMER_SCHEMA_FIELDS is parity-pinned to the real BC metadata fixture (scalar Properties only)', () => {
      const xmlNames = readBcXmlPropertyNames();
      const runnerIds = readRunnerSchemaFields('BC_CUSTOMER_SCHEMA_FIELDS');

      // Regression net against either parser silently returning empty.
      expect(xmlNames.length).toBeGreaterThan(0);
      expect(runnerIds.length).toBeGreaterThan(0);

      const xmlSet = new Set(xmlNames);
      const runnerSet = new Set(runnerIds);
      const missingInRunner = [...xmlSet].filter((n) => !runnerSet.has(n));
      const extraInRunner = [...runnerSet].filter((n) => !xmlSet.has(n));

      expect({ missingInRunner, extraInRunner }).toEqual({ missingInRunner: [], extraInRunner: [] });
    });

    it('the BC fixture declares targetSystem businesscentral (prompt selection keys off it)', () => {
      const fixture = readFixture(BC_FIXTURE_PATH);
      expect(fixture.testSuite.targetSystem).toBe('businesscentral');
    });

    it('no BC fixture (source, target) pair appears in COMMON_MAPPING_EXAMPLES', () => {
      const sourceSet = new Set(readSourcePairsFromTs().map(pairKey));
      const conflicts = readFixturePairs(BC_FIXTURE_PATH).filter((p) => sourceSet.has(pairKey(p)));

      expect(conflicts).toEqual([]);
    });

    it('BC schema is the full uncurated candidate set: targets subset, <=floor(schema/2) distinct targets, >=10 distractors, unique ids', () => {
      const schemaFields = readRunnerSchemaFields('BC_CUSTOMER_SCHEMA_FIELDS');
      const schemaFieldSet = new Set(schemaFields);
      const fixtureTargets = new Set(readFixturePairs(BC_FIXTURE_PATH).map((p) => p.target));

      // Duplicate schema ids would silently weaken the breadth checks.
      expect(schemaFieldSet.size).toBe(schemaFields.length);

      // Every labeled target must be a real schema field.
      const missingTargets = [...fixtureTargets].filter((target) => !schemaFieldSet.has(target));
      expect(missingTargets).toEqual([]);

      // Proportional floor: at most floor(schema/2) distinct labeled targets
      // (= 9 for the current 19-field schema), so distractors are >=50%.
      expect(fixtureTargets.size).toBeLessThanOrEqual(Math.floor(schemaFieldSet.size / 2));

      const distractors = [...schemaFieldSet].filter((field) => !fixtureTargets.has(field));
      expect(distractors.length).toBeGreaterThanOrEqual(10);
    });
  });
});
