/**
 * Task 9 — bounded preflight API and the active-save `_cardinality` envelope.
 *
 * Two surfaces are pinned here:
 *
 *   1. `POST /api/configurations/cardinality-preflight` — a tenant-narrowed,
 *      bounded advisory endpoint. It returns `200` for a COMPLETED report even
 *      when that report blocks (the `422` contract belongs to activation, not
 *      preflight); request/auth failures keep their normal `400`/`401`/`413`
 *      contracts; and a coordinator that cannot decide maps to `503`.
 *
 *   2. The `_cardinality` save envelope on create/update/import — stripped
 *      before the configuration ever reaches canonical validation/persistence
 *      and forwarded as the server-side `CardinalityAuthorizationInput`.
 *
 * Privacy bar (design "Preflight API"): sample values never appear in a
 * response body. Violations carry a code and a row/field PATH only.
 */

import request from 'supertest';
import express from 'express';

import { createConfigurationRouter } from '../../../src/routes/configuration';
import type { ConfigurationService } from '../../../src/services/ConfigurationService';
import type { CardinalityPreflight, CardinalityPlanInput } from '../../../src/types/cardinality';
import { CardinalityPreflightUnavailableError } from '../../../src/services/cardinality/CardinalityPreflightService';
import {
  makeFinding,
  makePreflightRunResult,
  makeReport,
  makeStubPreflight,
} from '../../helpers/cardinalityTestDoubles';
import { fakeAuthMiddleware, type FakeUserOverrides } from './_helpers/routerTestAuth';

function createMockConfigService(): jest.Mocked<ConfigurationService> {
  return {
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    getAllConfigurationsForTenant: jest.fn().mockReturnValue([]),
    saveConfiguration: jest.fn().mockResolvedValue(undefined),
    deleteConfiguration: jest.fn(),
    deleteConfigurationForTenant: jest.fn(),
    validateConfiguration: jest.fn(),
    exportConfigurationForTenant: jest.fn(),
    importConfiguration: jest.fn().mockResolvedValue({ id: 'imported' }),
    getConfigurationHistory: jest.fn(),
    restoreConfiguration: jest.fn(),
    duplicateConfiguration: jest.fn(),
  } as unknown as jest.Mocked<ConfigurationService>;
}

function makeApp(
  configurationService: ConfigurationService,
  cardinalityPreflight?: CardinalityPreflight,
  authOverrides: FakeUserOverrides = {},
) {
  const app = express();
  // Larger than the 512 KiB sample cap so the ROUTE's 413 is what the
  // oversize test exercises, not body-parser's own limit.
  app.use(express.json({ limit: '5mb' }));
  app.use(
    '/api/configurations',
    fakeAuthMiddleware(authOverrides),
    createConfigurationRouter({ configurationService, cardinalityPreflight }),
  );
  return app;
}

/** A minimal request body that satisfies `CardinalityPreflightRequestSchema`. */
function makePreflightBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    fieldMappings: [
      { sourceField: 'Name', targetField: 'companyName', transformationType: 'direct', isRequired: false },
    ],
    strategies: [],
    keyDeclarations: { sourceRecordKeys: ['id'], parentKeys: ['accountId'], targetKeys: ['externalId'] },
    ...overrides,
  };
}

const PREFLIGHT_PATH = '/api/configurations/cardinality-preflight';

describe('POST /api/configurations/cardinality-preflight', () => {
  let configService: jest.Mocked<ConfigurationService>;

  beforeEach(() => {
    configService = createMockConfigService();
    jest.clearAllMocks();
  });

  it('returns 200 with the completed report and binds the verified tenant', async () => {
    const result = makePreflightRunResult();
    const preflight = makeStubPreflight(result);
    const body = makePreflightBody();

    const res = await request(makeApp(configService, preflight)).post(PREFLIGHT_PATH).send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      blocking: false,
      combinedFingerprint: result.combinedFingerprint,
      reports: result.reports,
    });

    const [plan, tenantId, samples] = (preflight.runForPlan as jest.Mock).mock.calls[0];
    expect(tenantId).toBe('test-tenant');
    expect(samples).toBeUndefined();
    // The plan is a SAFE PROJECTION, never the request body cast to a config:
    // it carries exactly the pinned CardinalityPlanInput keys.
    expect(Object.keys(plan as CardinalityPlanInput).sort()).toEqual([
      'fieldMappings',
      'keyDeclarations',
      'sourceEntity',
      'sourceSystem',
      'strategies',
      'syncDirection',
      'targetEntity',
      'targetSystem',
    ]);
  });

  it('returns 200 (not 422) for a completed report that contains blocking findings', async () => {
    const blockingResult = makePreflightRunResult({
      reports: [makeReport({ findings: [makeFinding()] })],
      blocking: true,
    });

    const res = await request(makeApp(configService, makeStubPreflight(blockingResult)))
      .post(PREFLIGHT_PATH)
      .send(makePreflightBody());

    expect(res.status).toBe(200);
    expect(res.body.blocking).toBe(true);
    expect(res.body.reports[0].findings).toHaveLength(1);
  });

  it('sanitizes unexpected finding properties from the advisory response', async () => {
    const finding = Object.assign(makeFinding(), {
      rawSampleValue: 'secret-sample-value',
      credential: 'secret-credential',
    });
    const result = makePreflightRunResult({
      reports: [makeReport({ findings: [finding] })],
      blocking: true,
    });

    const res = await request(makeApp(configService, makeStubPreflight(result)))
      .post(PREFLIGHT_PATH)
      .send(makePreflightBody());

    expect(res.status).toBe(200);
    expect(res.body.reports[0].findings[0]).not.toHaveProperty('rawSampleValue');
    expect(res.body.reports[0].findings[0]).not.toHaveProperty('credential');
    expect(JSON.stringify(res.body)).not.toContain('secret-sample-value');
    expect(JSON.stringify(res.body)).not.toContain('secret-credential');
  });

  it('returns 401 tenant_required when the token carries no tenant claim', async () => {
    const preflight = makeStubPreflight();

    const res = await request(makeApp(configService, preflight, { tenantId: undefined }))
      .post(PREFLIGHT_PATH)
      .send(makePreflightBody());

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
    expect(preflight.runForPlan).not.toHaveBeenCalled();
  });

  it('returns 503 when the coordinator is not wired (fail closed, never skip)', async () => {
    const res = await request(makeApp(configService)).post(PREFLIGHT_PATH).send(makePreflightBody());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('cardinality_preflight_unavailable');
  });

  it('returns 503 when the coordinator cannot determine evidence availability', async () => {
    const preflight: CardinalityPreflight = {
      runForConfig: jest.fn(),
      runForPlan: jest.fn(async () => {
        throw new CardinalityPreflightUnavailableError('discovery transport failure');
      }),
    };

    const res = await request(makeApp(configService, preflight))
      .post(PREFLIGHT_PATH)
      .send(makePreflightBody());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('cardinality_preflight_unavailable');
  });

  describe('bounded sample payloads', () => {
    it('returns 413 when the serialized samples exceed the UTF-8 byte cap', async () => {
      const preflight = makeStubPreflight();
      const wide = 'x'.repeat(2000);
      const samples = Array.from({ length: 400 }, (_, i) => ({ accountId: `a-${i}`, externalId: `e-${i}`, notes: wide }));

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples }));

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('payload_too_large');
      expect(preflight.runForPlan).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain(wide);
    });

    it('returns 413 when there are more sample rows than the cap allows', async () => {
      const preflight = makeStubPreflight();
      const samples = Array.from({ length: 1001 }, (_, i) => ({ accountId: `a-${i}`, externalId: `e-${i}` }));

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples }));

      expect(res.status).toBe(413);
      expect(preflight.runForPlan).not.toHaveBeenCalled();
    });

    it('returns 400 for samples nested deeper than the depth cap', async () => {
      const preflight = makeStubPreflight();
      const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples: [deep] }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_samples');
      expect(res.body.violations.some((v: { code: string }) => v.code === 'too_deep')).toBe(true);
      expect(preflight.runForPlan).not.toHaveBeenCalled();
    });

    it('returns 400 for a credential-like sample field and never echoes its value', async () => {
      const preflight = makeStubPreflight();
      const secret = 'super-secret-token-value';

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples: [{ accountId: 'a-1', apiKey: secret }] }));

      expect(res.status).toBe(400);
      expect(res.body.violations.some((v: { code: string }) => v.code === 'credential_like_key')).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect(preflight.runForPlan).not.toHaveBeenCalled();
    });

    it('returns 400 for prototype-pollution sample keys', async () => {
      const preflight = makeStubPreflight();

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples: [JSON.parse('{"__proto__": {"polluted": true}}')] }));

      expect(res.status).toBe(400);
      expect(res.body.violations.some((v: { code: string }) => v.code === 'forbidden_key')).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(preflight.runForPlan).not.toHaveBeenCalled();
    });

    it('forwards safe samples verbatim to the coordinator', async () => {
      const preflight = makeStubPreflight();
      const samples = [{ accountId: 'a-1', externalId: 'e-1' }];

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(makePreflightBody({ samples }));

      expect(res.status).toBe(200);
      expect((preflight.runForPlan as jest.Mock).mock.calls[0][2]).toEqual(samples);
    });

    it('returns 400 when samples arrive without the parent/target key declarations they need', async () => {
      const preflight = makeStubPreflight();

      const res = await request(makeApp(configService, preflight))
        .post(PREFLIGHT_PATH)
        .send(
          makePreflightBody({
            samples: [{ accountId: 'a-1' }],
            keyDeclarations: { sourceRecordKeys: ['id'], parentKeys: [], targetKeys: [] },
          }),
        );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(preflight.runForPlan).not.toHaveBeenCalled();
    });
  });

  it('returns 400 for unsafe plan fields the strict envelope does not accept', async () => {
    const preflight = makeStubPreflight();

    const res = await request(makeApp(configService, preflight))
      .post(PREFLIGHT_PATH)
      .send(
        makePreflightBody({
          tenantId: 'other-tenant',
          relationships: [{ fromEntity: 'Account', toEntity: 'Contact' }],
          sourceAuthentication: { type: 'oauth2', credentials: { clientSecret: 's3cret' } },
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
    expect(preflight.runForPlan).not.toHaveBeenCalled();
  });
});

describe('active-save `_cardinality` envelope', () => {
  let configService: jest.Mocked<ConfigurationService>;

  const override = {
    reason: 'Evidence is unavailable for this connector; accepted by the data owner.',
    findingKeys: ['relationship_evidence_unavailable|source_to_target|account'],
    reportFingerprint: 'fingerprint-a',
  };
  const samples = [{ accountId: 'a-1', externalId: 'e-1' }];

  beforeEach(() => {
    configService = createMockConfigService();
    jest.clearAllMocks();
  });

  it('strips the envelope on create and forwards it as authorization input', async () => {
    const res = await request(makeApp(configService, makeStubPreflight()))
      .post('/api/configurations')
      .send({
        id: 'cfg-1',
        name: 'SFDC → NetSuite',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        isActive: true,
        _cardinality: { override, samples },
      });

    expect(res.status).toBe(201);
    const [saved, context, authorization] = configService.saveConfiguration.mock.calls[0];
    expect(saved).not.toHaveProperty('_cardinality');
    expect(context?.operation).toBe('create');
    expect(authorization).toEqual({ override, samples });
  });

  it('strips the envelope on update and forwards it as authorization input', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1' });

    const res = await request(makeApp(configService, makeStubPreflight()))
      .put('/api/configurations/cfg-1')
      .send({ name: 'SFDC → NetSuite', isActive: true, _cardinality: { override, samples } });

    expect(res.status).toBe(200);
    const [saved, context, authorization] = configService.saveConfiguration.mock.calls[0];
    expect(saved).not.toHaveProperty('_cardinality');
    expect(context?.operation).toBe('update');
    expect(authorization).toEqual({ override, samples });
  });

  it('rejects an override request that fails the strict envelope', async () => {
    const res = await request(makeApp(configService, makeStubPreflight()))
      .post('/api/configurations')
      .send({
        id: 'cfg-1',
        name: 'SFDC → NetSuite',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        isActive: true,
        _cardinality: { override: { ...override, reason: 'too short' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(configService.saveConfiguration).not.toHaveBeenCalled();
  });

  it('applies the same bounded sample limits to the save envelope', async () => {
    const secret = 'super-secret-token-value';

    const res = await request(makeApp(configService, makeStubPreflight()))
      .post('/api/configurations')
      .send({
        id: 'cfg-1',
        name: 'SFDC → NetSuite',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        isActive: true,
        _cardinality: { samples: [{ accountId: 'a-1', apiKey: secret }] },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_samples');
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(configService.saveConfiguration).not.toHaveBeenCalled();
  });

  it('strips the envelope out of an imported configuration and forwards authorization', async () => {
    const res = await request(makeApp(configService, makeStubPreflight()))
      .post('/api/configurations/import')
      .send({
        configuration: {
          id: 'cfg-import',
          name: 'Imported',
          sourceSystem: 'salesforce',
          targetSystem: 'netsuite',
          isActive: true,
          _cardinality: { override, samples },
        },
      });

    expect(res.status).toBe(200);
    const [payload, context, authorization] = (configService.importConfiguration as jest.Mock).mock.calls[0];
    expect(JSON.parse(payload as string)).not.toHaveProperty('_cardinality');
    expect((context as { operation: string }).operation).toBe('import');
    expect(authorization).toEqual({ override, samples });
  });
});
