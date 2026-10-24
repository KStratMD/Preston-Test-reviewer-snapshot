import fs from 'node:fs';
import { BlueprintSpecSchema } from '../../../../src/blueprint/schema/blueprintSpec';
import { QUESTIONNAIRE } from '../../../../src/blueprint/schema/questionnaire';
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/blueprints/shopify-netsuite-order-to-cash.v1.json', 'utf8'));
it('parses the reference blueprint', () => {
  const spec = BlueprintSpecSchema.parse(fixture);
  expect(spec.schemaVersion).toBe(1);
  expect(spec.mappings[0].fieldMappings[0].transformationType).toBe('direct');
  expect(spec.mappings[0].goldenCases.length).toBeGreaterThan(0);
});
it('rejects a non-canonical mapping, recorded approvals inside the document, and unknown keys', () => {
  const a = structuredClone(fixture); a.mappings[0].fieldMappings[0] = { source: 'a', target: 'b', transformation: 'direct' };
  expect(() => BlueprintSpecSchema.parse(a)).toThrow(/sourceField/);
  const b = structuredClone(fixture); b.approvals.recorded = [];
  expect(() => BlueprintSpecSchema.parse(b)).toThrow(/recorded|unrecognized/i);
});
it('questionnaire covers every top-level section with at least 20 questions', () => {
  const sections = Object.keys(BlueprintSpecSchema.shape).filter(k => k !== 'schemaVersion');
  for (const s of sections) expect(QUESTIONNAIRE.some(q => q.path === s || q.path.startsWith(`${s}.`))).toBe(true);
  expect(QUESTIONNAIRE.length).toBeGreaterThanOrEqual(20);
});

it('requires each section and rejects unknown keys at every structured object', () => {
  for (const key of Object.keys(fixture)) {
    const missing = structuredClone(fixture);
    delete missing[key];
    expect(BlueprintSpecSchema.safeParse(missing).success).toBe(false);
  }
  const paths = [[], ['metadata'], ['goals', 0], ['systems', 0], ['integrationPaths', 0],
    ['objects', 0], ['ownership', 0], ['mappings', 0], ['mappings', 0, 'goldenCases', 0],
    ['mappings', 0, 'goldenCases', 0, 'input'], ['mappings', 0, 'goldenCases', 0, 'expected'],
    ['exceptions', 0], ['approvals'], ['dlp'], ['testPlan'], ['testPlan', 'tolerances'],
    ['adapterRequirements', 0], ['architecture'], ['backlog', 0], ['risks', 0],
    ['proposalInputs'], ['outcomes', 0]];
  for (const path of paths) {
    const bad = structuredClone(fixture);
    let target = bad;
    for (const part of path) target = target[part];
    target.unexpectedProperty = true;
    expect(BlueprintSpecSchema.safeParse(bad).success).toBe(false);
  }
});

it('requires nonempty golden cases and bounded literal expected errors', () => {
  const bad = structuredClone(fixture);
  bad.mappings[0].goldenCases = [];
  expect(BlueprintSpecSchema.safeParse(bad).success).toBe(false);
  for (const error of ['', 'x'.repeat(201)]) {
    const b = structuredClone(fixture);
    b.mappings[0].goldenCases[1].expected.error = error;
    expect(BlueprintSpecSchema.safeParse(b).success).toBe(false);
  }
});
