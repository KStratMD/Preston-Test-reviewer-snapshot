/**
 * Task 6 (2026-07-27 NetSuite serialized-asset sync plan) —
 * `POST /api/configurations/:id/serialized-asset-readiness`.
 *
 * The endpoint takes a saved configuration ID and an EMPTY body. It resolves
 * the draft through `getConfigurationForTenant(req.user.tenantId, req.params.id)`
 * and hands THAT stored object to the readiness evaluator. Credentials,
 * systems, mappings, and hosts are never read from the request: initializing a
 * Salesforce connector from request-supplied data would assign an
 * attacker-chosen `instanceUrl` to the outbound HTTP client and post the
 * client secret / username / password to the attacker's token endpoint. That
 * is credential exfiltration, not merely SSRF — hence the credential-injection
 * canary at the bottom of this file.
 *
 * Production wiring is part of the contract: a readiness route reachable only
 * through a hand-constructed router is DEAD IN PRODUCTION. The final block
 * drives the SAME composition-root factory `RouteSetup` uses.
 */

import request from 'supertest';
import express from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

import { createConfigurationRouter } from '../../../src/routes/configuration';
import { createProductionConfigurationRouter } from '../../../src/middleware/setup/RouteSetup';
import { TYPES } from '../../../src/inversify/types';
import { SERIALIZED_ASSET_READINESS_MAX_REQUESTS } from '../../../src/middleware/rateLimit';
import { ServiceUnavailableAppError } from '../../../src/errors/AppError';
import type { ConfigurationService } from '../../../src/services/ConfigurationService';
import type {
  SerializedAssetReadinessEvaluator,
  SerializedAssetReadinessResult,
} from '../../../src/services/serializedAsset/SerializedAssetReadinessService';
import type { IntegrationConfig } from '../../../src/types';
import { fakeAuthMiddleware, type FakeUserOverrides } from './_helpers/routerTestAuth';

const ASSET_EXTERNAL_ID = 'Serial_External_Id__c';
const PRODUCT_EXTERNAL_ID = 'SKU__c';
const STORED_INSTANCE_URL = 'https://stored-tenant.my.salesforce.com';

function makeStoredConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-1',
    tenantId: 'test-tenant',
    name: 'NetSuite serialized assets',
    sourceSystem: { type: 'netsuite', systemId: 'ns-prod', credentialSource: 'secret_manager' },
    targetSystem: { type: 'salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    targetAuthentication: { instanceUrl: STORED_INSTANCE_URL },
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig: {
      executionProfile: 'netsuite_serialized_asset',
      productExternalIdField: PRODUCT_EXTERNAL_ID,
      assetExternalIdField: ASSET_EXTERNAL_ID,
      serialNumberTargetField: 'SerialNumber',
      productReferenceTargetField: 'Product2Id',
    },
    ...overrides,
  } as IntegrationConfig;
}

function makeResult(overrides: Partial<SerializedAssetReadinessResult> = {}): SerializedAssetReadinessResult {
  return {
    ready: true,
    checkedAt: '2026-07-27T00:00:00.000Z',
    blockers: [],
    productExternalIdFields: [PRODUCT_EXTERNAL_ID],
    assetExternalIdFields: [ASSET_EXTERNAL_ID],
    ...overrides,
  };
}

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
    importConfiguration: jest.fn(),
    activateConfigurationForTenant: jest.fn().mockResolvedValue(undefined),
    getConfigurationHistory: jest.fn(),
    restoreConfiguration: jest.fn(),
    duplicateConfiguration: jest.fn(),
  } as unknown as jest.Mocked<ConfigurationService>;
}

function makeApp(
  configurationService: ConfigurationService,
  serializedAssetReadiness?: SerializedAssetReadinessEvaluator,
  authOverrides: FakeUserOverrides = {},
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/configurations',
    fakeAuthMiddleware(authOverrides),
    createConfigurationRouter({ configurationService, serializedAssetReadiness }),
  );
  return app;
}

const readinessPath = (id: string) => `/api/configurations/${id}/serialized-asset-readiness`;

describe('POST /api/configurations/:id/serialized-asset-readiness', () => {
  let configService: jest.Mocked<ConfigurationService>;
  let readiness: { evaluate: jest.Mock };

  beforeEach(() => {
    configService = createMockConfigService();
    readiness = { evaluate: jest.fn(async () => makeResult()) };
    jest.clearAllMocks();
  });

  it('resolves the stored draft through the VERIFIED tenant claim and returns the readiness result', async () => {
    const stored = makeStoredConfig();
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(stored);

    const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(makeResult());
    expect(configService.getConfigurationForTenant).toHaveBeenCalledWith('test-tenant', 'cfg-1');
    expect(readiness.evaluate).toHaveBeenCalledWith(stored);
  });

  it('returns 401 tenant_required when the token carries no tenant claim', async () => {
    const res = await request(makeApp(configService, readiness, { tenantId: undefined }))
      .post(readinessPath('cfg-1'))
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
    expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
    expect(readiness.evaluate).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown id and the IDENTICAL 404 for a cross-tenant id', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

    const unknown = await request(makeApp(configService, readiness)).post(readinessPath('missing')).send({});
    const crossTenant = await request(makeApp(configService, readiness, { tenantId: 'other-tenant' }))
      .post(readinessPath('cfg-owned-by-someone-else'))
      .send({});

    expect(unknown.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body).toEqual(unknown.body);
    expect(readiness.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a configuration that does not use the specialized profile', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(
      makeStoredConfig({ executionProfile: undefined, executionProfileConfig: undefined }),
    );

    const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(readiness.evaluate).not.toHaveBeenCalled();
  });

  it('rejects ANY body content — the route accepts an empty body only', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());

    const res = await request(makeApp(configService, readiness))
      .post(readinessPath('cfg-1'))
      .send({ productExternalIdField: 'Injected__c' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: 'productExternalIdField' }),
    ]);
    expect(readiness.evaluate).not.toHaveBeenCalled();
  });

  it('returns sanitized blockers and field-name choices — never a raw describe payload', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());
    readiness.evaluate.mockResolvedValue(
      makeResult({
        ready: false,
        blockers: [
          { code: 'field_not_external_id', message: `${PRODUCT_EXTERNAL_ID} is not marked External ID` },
        ],
      }),
    );

    const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.blockers).toEqual([
      { code: 'field_not_external_id', message: `${PRODUCT_EXTERNAL_ID} is not marked External ID` },
    ]);
    expect(Object.keys(res.body).sort()).toEqual(
      ['assetExternalIdFields', 'blockers', 'checkedAt', 'productExternalIdFields', 'ready'].sort(),
    );
  });

  it('fails CLOSED with 503 when the readiness dependency is not wired', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());

    const res = await request(makeApp(configService, undefined)).post(readinessPath('cfg-1')).send({});

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'serialized_asset_readiness_unavailable',
      reason: 'service_not_configured',
    });
  });

  it('maps an undeterminable readiness evaluation to 503, never to a clean result', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());
    readiness.evaluate.mockRejectedValue(new ServiceUnavailableAppError('storage failure'));

    const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'serialized_asset_readiness_unavailable',
      reason: 'readiness_undetermined',
    });
  });

  it('never saves or activates as a side effect of a readiness check', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());

    await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

    expect(configService.saveConfiguration).not.toHaveBeenCalled();
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  describe('credential-injection canary', () => {
    const attacker = {
      targetSystem: { type: 'salesforce', systemId: 'evil', credentialSource: 'inline' },
      targetAuthentication: {
        instanceUrl: 'https://attacker.example.com',
        loginUrl: 'https://attacker.example.com',
        clientId: 'stolen-client',
        clientSecret: 'stolen-secret',
        username: 'victim@example.com',
        password: 'victim-password',
      },
      fieldMappings: [{ sourceField: 'serial', targetField: 'Name' }],
      executionProfileConfig: { executionProfile: 'netsuite_serialized_asset', assetExternalIdField: 'Evil__c' },
    };

    it('readiness refuses an attacker-supplied host/credential body and never evaluates it', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());

      const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send(attacker);

      expect(res.status).toBe(400);
      expect(readiness.evaluate).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain('attacker.example.com');
      expect(JSON.stringify(res.body)).not.toContain('stolen-secret');
    });

    it('readiness evaluates the STORED system reference even when the caller sends a rogue one alongside nothing else', async () => {
      const stored = makeStoredConfig();
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(stored);

      await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

      const evaluated = readiness.evaluate.mock.calls[0][0] as IntegrationConfig;
      expect(evaluated).toBe(stored);
      expect(evaluated.targetAuthentication?.instanceUrl).toBe(STORED_INSTANCE_URL);
    });

    it('activation refuses the same attacker body before touching the service', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());

      const res = await request(makeApp(configService, readiness))
        .post('/api/configurations/cfg-1/activate')
        .send(attacker);

      expect(res.status).toBe(400);
      expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
    });
  });

  describe('undeterminable-readiness contract at activation', () => {
    it('lets a ServiceUnavailableAppError out of the activate route unchanged (503, not the 409 refusal body)', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());
      (configService.activateConfigurationForTenant as jest.Mock).mockRejectedValue(
        new ServiceUnavailableAppError('readiness could not be determined'),
      );

      const app = express();
      app.use(express.json());
      app.use('/api/configurations', fakeAuthMiddleware(), createConfigurationRouter({
        configurationService: configService,
        serializedAssetReadiness: readiness,
      }));
      // Minimal boundary stand-in: assert the route neither swallowed the error
      // nor rewrote it into the serialized-asset 409 refusal contract.
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = err instanceof ServiceUnavailableAppError ? err.statusCode : 500;
        res.status(status).json({ propagated: err instanceof ServiceUnavailableAppError });
      });

      const res = await request(app).post('/api/configurations/cfg-1/activate').send({});

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ propagated: true });
    });
  });

  describe('production wiring (composition root)', () => {
    it('createProductionConfigurationRouter resolves the readiness service from the container and serves the route', async () => {
      const stored = makeStoredConfig();
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(stored);
      const containerGet = jest.fn((symbol: symbol) => {
        if (symbol === TYPES.SerializedAssetReadinessService) return readiness;
        if (symbol === TYPES.CardinalityPreflightService) return { runForPlan: jest.fn(), runForConfig: jest.fn() };
        throw new Error(`unexpected container resolution: ${String(symbol)}`);
      });

      const router = await createProductionConfigurationRouter(
        { get: containerGet } as never,
        configService,
      );

      const app = express();
      app.use(express.json());
      app.use('/api/configurations', fakeAuthMiddleware(), router);

      const res = await request(app).post(readinessPath('cfg-1')).send({});

      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(containerGet).toHaveBeenCalledWith(TYPES.SerializedAssetReadinessService);
      expect(containerGet).toHaveBeenCalledWith(TYPES.CardinalityPreflightService);
    });

    it('is the ONLY way RouteSetup builds the configuration router (no second, dependency-less call site)', () => {
      // `createProductionConfigurationRouter` requires the readiness dependency
      // at the type level, so routing the composition root through it is what
      // makes "compiles but dead in production" impossible. Pin that the mount
      // block still uses it and never re-derives the router inline.
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'src', 'middleware', 'setup', 'RouteSetup.ts'),
        'utf-8',
      );
      const mountBlock = source.slice(source.indexOf('// Configuration routes'));
      expect(mountBlock).toContain('createProductionConfigurationRouter(');
      // The raw factory appears exactly once in the file: inside the helper.
      expect(source.match(/createConfigurationRouter\(/g)).toHaveLength(1);
    });
  });

  /**
   * "Empty body ONLY" must mean what the comment claims. `Object.keys([])` is
   * empty, so an ARRAY body sailed through the allowlist and reached the
   * evaluator; the same holds for any non-plain-object JSON value.
   */
  describe('body shape', () => {
    beforeEach(() => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());
    });

    // Arrays reach the handler (body-parser's strict mode accepts them), so
    // the route itself must reject them: this is the case `Object.keys([])`
    // silently admitted.
    it.each([
      ['an empty array', []],
      ['a populated array', [{ productExternalIdField: 'Injected__c' }]],
    ])('rejects %s body with the route contract', async (_label, body) => {
      const res = await request(makeApp(configService, readiness))
        .post(readinessPath('cfg-1'))
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    // Top-level scalars are refused upstream by express.json's strict mode.
    // Pinned here so the guarantee that matters — they never reach the
    // evaluator — is covered wherever it is enforced.
    it.each([
      ['a string', 'nope'],
      ['a number', 7],
      ['a boolean', true],
    ])('rejects %s body before the evaluator', async (_label, body) => {
      const res = await request(makeApp(configService, readiness))
        .post(readinessPath('cfg-1'))
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body));

      expect(res.status).toBe(400);
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    // Same class of bug, one route away: the activate handler used the same
    // keys-only allowlist, so `[]` counted as an empty body there too.
    it.each([
      ['an empty array', []],
      ['a populated array', [{ targetSystem: 'evil' }]],
    ])('rejects %s body on the ACTIVATE route as well', async (_label, body) => {
      const res = await request(makeApp(configService, readiness))
        .post('/api/configurations/cfg-1/activate')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
    });

    it('accepts a genuinely empty object body', async () => {
      const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1')).send({});

      expect(res.status).toBe(200);
      expect(readiness.evaluate).toHaveBeenCalledTimes(1);
    });

    it('accepts a request with no body at all', async () => {
      const res = await request(makeApp(configService, readiness)).post(readinessPath('cfg-1'));

      expect(res.status).toBe(200);
    });
  });

  /**
   * Every readiness POST costs a secret-manager read, a connector
   * initialization, and two live Salesforce describe round-trips. Without a
   * limiter, any authenticated caller with a tenant claim can loop it:
   * Salesforce API-limit exhaustion, credential-store amplification, and a
   * fast oracle for probing systemIds. The limiter is scoped to the two
   * expensive routes (readiness + activation, which triggers readiness through
   * the guard) rather than the whole configuration router, and runs AFTER
   * auth/authz so refused traffic never consumes budget.
   */
  describe('rate limiting', () => {
    beforeEach(() => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(makeStoredConfig());
    });

    it('throttles a readiness loop from one (IP, user) with 429 and stops calling the evaluator', async () => {
      const app = makeApp(configService, readiness);
      const statuses: number[] = [];

      for (let i = 0; i < SERIALIZED_ASSET_READINESS_MAX_REQUESTS + 3; i++) {
        const res = await request(app).post(readinessPath('cfg-1')).send({});
        statuses.push(res.status);
      }

      expect(statuses.filter((status) => status === 200)).toHaveLength(
        SERIALIZED_ASSET_READINESS_MAX_REQUESTS,
      );
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
      expect(readiness.evaluate).toHaveBeenCalledTimes(SERIALIZED_ASSET_READINESS_MAX_REQUESTS);
    });

    it('shares ONE budget between readiness and activation (activation also triggers live readiness)', async () => {
      const app = makeApp(configService, readiness);

      for (let i = 0; i < SERIALIZED_ASSET_READINESS_MAX_REQUESTS; i++) {
        await request(app).post(readinessPath('cfg-1')).send({});
      }
      const activate = await request(app).post('/api/configurations/cfg-1/activate').send({});

      expect(activate.status).toBe(429);
      expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
    });

    it('does not throttle the rest of the configuration router', async () => {
      const app = makeApp(configService, readiness);
      for (let i = 0; i < SERIALIZED_ASSET_READINESS_MAX_REQUESTS + 2; i++) {
        await request(app).post(readinessPath('cfg-1')).send({});
      }

      const list = await request(app).get('/api/configurations');

      expect(list.status).toBe(200);
    });

    it('does not consume budget for a caller refused at the auth gate', async () => {
      const app = makeApp(configService, readiness, { tenantId: undefined });
      for (let i = 0; i < SERIALIZED_ASSET_READINESS_MAX_REQUESTS + 2; i++) {
        const res = await request(app).post(readinessPath('cfg-1')).send({});
        // Never a 429: the limiter sits behind the tenant check, so an
        // unauthorized flood cannot exhaust a legitimate caller's budget.
        expect(res.status).toBe(401);
      }
    });
  });
});
