import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { App } from '../../../src/app';

/**
 * Validates that /openapi.json returns a parseable spec and basic structural expectations.
 * We do not embed a full OpenAPI meta-schema (heavy) but assert key fields and path schemas exist.
 */

describe('OpenAPI spec exposure & validation', () => {
  let app: App;
  beforeAll(async () => {
    app = new App({ lightweight: true });
    await app.waitForInitialization();
  });

  test('GET /openapi.json returns valid spec with required top-level fields', async () => {
    const server = app.getExpressApp();
    const res = await request(server).get('/openapi.json').expect(200);
    const spec = res.body;
    expect(spec.openapi || spec.openapiVersion).toBeDefined();
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
    // minimal structural assertions
    expect(spec.paths['/api/ai/proxy/models']).toBeDefined();
    expect(spec.paths['/api/ai/proxy/orchestrate']).toBeDefined();
  });

  test('OpenAPI spec passes AJV validation against simplified schema', async () => {
    const server = app.getExpressApp();
    const res = await request(server).get('/openapi.json').expect(200);
    const spec = res.body;

    // Simplified schema: only check presence & types of core fields to keep test lightweight
    const simpleSchema = {
      type: 'object',
      required: ['openapi', 'info', 'paths'],
      properties: {
        openapi: { type: 'string' },
        info: {
          type: 'object',
          required: ['title', 'version'],
          properties: {
            title: { type: 'string' },
            version: { type: 'string' },
            description: { type: 'string' }
          }
        },
        paths: {
          type: 'object',
          minProperties: 1
        }
      }
    } as const;

  const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(simpleSchema);
    const valid = validate(spec);
    if (!valid) {
      console.error(validate.errors);
    }
    expect(valid).toBe(true);
  });
});
