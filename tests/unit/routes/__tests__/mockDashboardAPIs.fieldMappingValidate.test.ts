/**
 * Codex round 4 on PR #1253 (finding 5): the demo fallback's field-mapping
 * validator (`POST /api/ai/field-mapping/validate`) called 'format' valid and
 * let 'split' pass on score, so `passedMappings` counted mappings the engine
 * cannot execute. It now uses the canonical contract's vocabulary and zeroes
 * the score of anything outside it.
 */
import express from 'express';
import request from 'supertest';
import { createMockDashboardAPIs } from '../../../../src/routes/mockDashboardAPIs';
import { EXECUTABLE_TRANSFORMATIONS } from '../../../../src/domain/mapping/MappingContract';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/', createMockDashboardAPIs(app));
  return app;
}

describe('mock field-mapping validator vocabulary', () => {
  it('refuses an EMPTY mapping set instead of answering success:true for validating nothing (Codex round 13)', async () => {
    const res = await request(createApp())
      .post('/api/ai/field-mapping/validate')
      .send({ mappings: [] })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it.each(['format', 'split', 'uppercase', 'conditional'])('does not pass a %s mapping', async (transformationType) => {
    const res = await request(createApp())
      .post('/api/ai/field-mapping/validate')
      .send({ mappings: [{ sourceField: 'name', targetField: 'name', transformationType, isRequired: false }] })
      .expect(200);
    expect(res.body.validationResults[0].score).toBe(0);
    // A word outside the union is a zod 'Invalid option'; a declared-only word is 'not executable'.
    expect(res.body.validationResults[0].issues.join(' ')).toMatch(/not executable|Invalid option/);
    expect(res.body.metadata.passedMappings).toBe(0);
  });

  it.each([
    ['no transformationType', { sourceField: 'name', targetField: 'name', isRequired: false }],
    ['lookup without config', { sourceField: 'name', targetField: 'name', transformationType: 'lookup', isRequired: false }],
    ['calculation with a malformed expression', { sourceField: 'name', targetField: 'name', transformationType: 'calculation', isRequired: false, transformationConfig: { type: 'calculation', expression: '1+' } }],
    ['concatenation with no fields', { sourceField: 'name', targetField: 'name', transformationType: 'concatenation', isRequired: false, transformationConfig: { type: 'concatenation' } }],
  ])('does not pass a structurally invalid mapping: %s (Codex round 5)', async (_label, mapping) => {
    const res = await request(createApp())
      .post('/api/ai/field-mapping/validate')
      .send({ mappings: [mapping] })
      .expect(200);
    expect(res.body.validationResults[0].score).toBe(0);
    expect(res.body.validationResults[0].issues.length).toBeGreaterThan(0);
    expect(res.body.metadata.passedMappings).toBe(0);
  });
  it.each([...EXECUTABLE_TRANSFORMATIONS])('still passes an executable %s mapping with matching names', async (transformationType) => {
    const res = await request(createApp())
      .post('/api/ai/field-mapping/validate')
      .send({ mappings: [{ sourceField: 'name', targetField: 'name', transformationType, isRequired: false, transformationConfig: { direct: undefined, lookup: { type: 'lookup', lookupTable: 't', mappings: { name: 'Name' } }, calculation: { type: 'calculation', expression: 'parseInt(name)' }, concatenation: { type: 'concatenation', fields: ['name'] } }[transformationType] }] })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.validationResults[0].score).toBeGreaterThan(0.7);
    expect(res.body.metadata.passedMappings).toBe(1);
  });

  it.each([
    ['a wrong-typed isRequired', { sourceField: 'name', targetField: 'name', transformationType: 'direct', isRequired: 'not-a-boolean' }],
    ['an unknown key', { sourceField: 'name', targetField: 'name', transformationType: 'direct', isRequired: false, rogue: 1 }],
    ['no isRequired at all', { sourceField: 'name', targetField: 'name', transformationType: 'direct' }],
  ])('judges the RAW mapping — %s scores 0 (Codex round 6)', async (_label, mapping) => {
    const res = await request(createApp()).post('/api/ai/field-mapping/validate').send({ mappings: [mapping] }).expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.validationResults[0].score).toBe(0);
    expect(res.body.metadata.passedMappings).toBe(0);
  });

  it.each([[null], [42], ['direct'], [[1]]])('answers 200 with success:false for a non-object entry (%p), never 500 (Codex round 8)', async (entry) => {
    const res = await request(createApp()).post('/api/ai/field-mapping/validate').send({ mappings: [entry] }).expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.metadata.passedMappings).toBe(0);
  });

  it('validates the SET: two lodash spellings of one target fail every member (Codex round 6)', async () => {
    const res = await request(createApp())
      .post('/api/ai/field-mapping/validate')
      .send({ mappings: [
        { sourceField: 'name', targetField: 'a.b', transformationType: 'direct', isRequired: false },
        { sourceField: 'name', targetField: 'a[b]', transformationType: 'direct', isRequired: false },
      ] })
      .expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.metadata.passedMappings).toBe(0);
    expect(res.body.potentialIssues.join(' ')).toMatch(/same slot/);
  });
});
