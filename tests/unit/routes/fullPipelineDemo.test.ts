/**
 * Router-behavior suite for the full-pipeline demo family.
 *
 * The mount chain (authMiddleware + requirePlatformAdmin + erp-write limiter)
 * is proved separately in
 * tests/integration/erpWriteFamiliesTenantStatusGate.routes.test.ts. This
 * suite mounts the BARE router and injects `req.user` directly, so it tests
 * only what the handler itself decides.
 *
 * The identity and validation refusals both fire before connector
 * initialization, so those cases never touch the mocks below — the mocks
 * exist to keep module import cheap and to let the default-run case assert
 * that no write happened.
 */
import request from 'supertest';
import express from 'express';

const mockGuardedWrite = jest.fn();
jest.mock('../../../src/governance/sourceOfTruth/guardedWrite', () => ({
  guardedWrite: (...args: unknown[]) => mockGuardedWrite(...args),
}));

jest.mock('../../../src/utils/Logger', () => {
  const inst = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { Logger: jest.fn(() => inst), logger: inst, createLogger: jest.fn(() => inst) };
});

jest.mock('../../../src/services/AuthService', () => ({
  AuthService: jest.fn(() => ({ authenticate: jest.fn() })),
}));

const mockSquireInitialize = jest.fn().mockResolvedValue(undefined);
const mockSquireList = jest.fn();
jest.mock('../../../src/connectors/SquireConnector', () => ({
  SquireConnector: jest.fn(() => ({
    initialize: (...args: unknown[]) => mockSquireInitialize(...args),
    list: (...args: unknown[]) => mockSquireList(...args),
  })),
}));

const mockSuiteCentralInitialize = jest.fn().mockResolvedValue(undefined);
const mockSuiteCentralCreate = jest.fn();
jest.mock('../../../src/connectors/SuiteCentralProductionConnector', () => ({
  SuiteCentralProductionConnector: jest.fn(() => ({
    initialize: (...args: unknown[]) => mockSuiteCentralInitialize(...args),
    create: (...args: unknown[]) => mockSuiteCentralCreate(...args),
  })),
}));

const mockNetSuiteInitialize = jest.fn().mockResolvedValue(undefined);
const mockNetSuiteCreate = jest.fn();
jest.mock('../../../src/connectors/connectorRegistry', () => ({
  getConnectorRegistration: jest.fn(() => ({
    factory: jest.fn(() => ({
      initialize: (...args: unknown[]) => mockNetSuiteInitialize(...args),
      create: (...args: unknown[]) => mockNetSuiteCreate(...args),
    })),
  })),
}));

// Prevents full DI initialization (EncryptionService et al.) on import.
jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn(() => ({})),
    getAsync: jest.fn(async () => ({})),
  },
}));

import { createFullPipelineDemoRouter } from '../../../src/routes/fullPipelineDemo';
import { squireVendors } from '../../../src/data/squireMockData';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

/** Mount the bare router with an injected verified identity (or none). */
function makeApp(user?: { id?: string; tenantId?: string }): express.Application {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = user;
      next();
    });
  }
  app.use('/api/full-pipeline-demo', createFullPipelineDemoRouter());
  return app;
}

/**
 * Mount WITHOUT express.json(), so `req.body` is genuinely `undefined` rather
 * than `{}`. Express only populates it when a body parser matched, so a caller
 * sending no body (or a non-JSON content type) reaches the handler this way.
 */
function makeAppWithoutBodyParser(user: { id: string; tenantId: string }): express.Application {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = user;
    next();
  });
  app.use('/api/full-pipeline-demo', createFullPipelineDemoRouter());
  return app;
}

const ADMIN = { id: 'admin-1', tenantId: 'tenant-admin' };

function expectNoPipelineWork(): void {
  expect(mockSquireInitialize).not.toHaveBeenCalled();
  expect(mockSuiteCentralInitialize).not.toHaveBeenCalled();
  expect(mockNetSuiteInitialize).not.toHaveBeenCalled();
  expect(mockSquireList).not.toHaveBeenCalled();
  expect(mockGuardedWrite).not.toHaveBeenCalled();
}

describe('POST /api/full-pipeline-demo/execute — operator identity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no verified user → 401 identity_required, no connector work', async () => {
    const res = await request(makeApp()).post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expectNoPipelineWork();
  });

  it('missing tenantId claim → 401 identity_required', async () => {
    const res = await request(makeApp({ id: 'admin-1' }))
      .post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockSquireList).not.toHaveBeenCalled();
  });

  it('missing user.id claim → 401 identity_required', async () => {
    const res = await request(makeApp({ tenantId: 'tenant-admin' }))
      .post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockSquireList).not.toHaveBeenCalled();
  });

  it('blank claims are refused, not treated as an identity', async () => {
    const res = await request(makeApp({ id: '', tenantId: 'tenant-admin' }))
      .post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
  });

  it('both claims present → proceeds past the identity gate', async () => {
    mockSquireList.mockResolvedValue([]);
    const res = await request(makeApp(ADMIN)).post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).not.toBe(401);
    expect(mockSquireList).toHaveBeenCalled();
  });

  it('refuses a sentinel-claiming JWT instead of writing __system__ to audit_logs', async () => {
    const app = makeApp({ id: SYSTEM_IDENTITY.userId, tenantId: SYSTEM_IDENTITY.tenantId });
    const res = await request(app).post('/api/full-pipeline-demo/execute').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('identity_required');
  });
});

describe('safe defaults', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /configurations advertises the safe defaults', async () => {
    const res = await request(makeApp(ADMIN)).get('/api/full-pipeline-demo/configurations');
    expect(res.status).toBe(200);
    expect(res.body.defaultSettings).toEqual({
      batchSize: 10,
      includeNetSuiteSync: false,
      dryRun: true,
    });
  });

  // The load-bearing assertion. Advertised-equals-applied cannot fail once
  // both sides read FULL_PIPELINE_DEFAULTS (design section 3), so the proof
  // that the defaults are SAFE has to come from observed behavior: an empty
  // body must reach neither connector write nor guardedWrite.
  it('an empty body simulates — no connector write, no governance row', async () => {
    // Use the production fixture shape: FieldMapperUtility requires the
    // SupplierCentral source fields (vendorName, contactPerson, payment terms,
    // etc.). A generic DataRecord with only `fields.name` transforms to zero
    // records and would return before exercising the dry-run branch.
    mockSquireList.mockResolvedValue(squireVendors.slice(0, 2));

    const res = await request(makeApp(ADMIN)).post('/api/full-pipeline-demo/execute').send({});

    expect(res.status).toBe(200);
    expect(mockSuiteCentralCreate).not.toHaveBeenCalled();
    expect(mockNetSuiteCreate).not.toHaveBeenCalled();
    expect(mockGuardedWrite).not.toHaveBeenCalled();

    const stepNames = (res.body.steps as Array<{ step: string }>).map((s) => s.step);
    expect(stepNames).toContain('load_to_suitecentral');
    expect(stepNames).not.toContain('sync_to_netsuite');

    const loadStep = (res.body.steps as Array<{ step: string; metadata?: { dryRun?: boolean } }>)
      .find((s) => s.step === 'load_to_suitecentral');
    expect(loadStep?.metadata?.dryRun).toBe(true);
  }, 15000);

  // Cheap tripwire only: this equality is structurally guaranteed while both
  // sides read the same frozen object. It exists to catch a future
  // re-literalisation of either side, NOT as drift protection.
  it('advertised defaults are the applied defaults', async () => {
    mockSquireList.mockResolvedValue([]);
    const configured = await request(makeApp(ADMIN)).get('/api/full-pipeline-demo/configurations');
    expect(configured.body.defaultSettings.dryRun).toBe(true);
    expect(configured.body.defaultSettings.includeNetSuiteSync).toBe(false);
    expect(configured.body.defaultSettings.batchSize).toBe(10);
  });

  it('GET /configurations cannot be mutated by a caller', async () => {
    const first = await request(makeApp(ADMIN)).get('/api/full-pipeline-demo/configurations');
    first.body.defaultSettings.dryRun = false;
    const second = await request(makeApp(ADMIN)).get('/api/full-pipeline-demo/configurations');
    expect(second.body.defaultSettings.dryRun).toBe(true);
  });
});

describe('request-body validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSquireList.mockResolvedValue([]);
  });

  const INVALID_BATCH: Array<[string, unknown]> = [
    ['zero (would never terminate the batch loop)', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the cap', 101],
    ['numeric string', '10'],
    ['boolean', true],
    ['null', null],
  ];

  for (const [label, value] of INVALID_BATCH) {
    it(`rejects batchSize ${label}`, async () => {
      // The zero case deliberately carries a real-run request and non-empty,
      // transformable fixture. If the lower-bound validator is removed, this
      // reaches `for (...; i += batchSize)` and reproduces the original hang
      // instead of returning early on an empty extraction or dry-run branch.
      if (value === 0) {
        mockSquireList.mockResolvedValue([squireVendors[0]]);
      }
      const body = value === 0
        ? { batchSize: value, dryRun: false }
        : { batchSize: value };
      const res = await request(makeApp(ADMIN))
        .post('/api/full-pipeline-demo/execute').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'invalid_request',
        message: 'batchSize must be an integer between 1 and 100.',
      });
      expectNoPipelineWork();
    });
  }

  it.each([[1], [100], [10]])('accepts batchSize %i', async (value) => {
    const res = await request(makeApp(ADMIN))
      .post('/api/full-pipeline-demo/execute').send({ batchSize: value });
    expect(res.status).toBe(200);
  }, 15000);

  const INVALID_BOOL: Array<[string, unknown]> = [
    ['string "false"', 'false'],
    ['string "true"', 'true'],
    ['zero', 0],
    ['null', null],
  ];

  for (const [label, value] of INVALID_BOOL) {
    it(`rejects dryRun ${label} rather than coercing it`, async () => {
      const res = await request(makeApp(ADMIN))
        .post('/api/full-pipeline-demo/execute').send({ dryRun: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'invalid_request',
        message: 'dryRun must be a boolean.',
      });
      expectNoPipelineWork();
    });

    it(`rejects includeNetSuiteSync ${label} rather than coercing it`, async () => {
      const res = await request(makeApp(ADMIN))
        .post('/api/full-pipeline-demo/execute').send({ includeNetSuiteSync: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'invalid_request',
        message: 'includeNetSuiteSync must be a boolean.',
      });
      expectNoPipelineWork();
    });
  }

  it('checks fields in a fixed order so a multi-error body is deterministic', async () => {
    const res = await request(makeApp(ADMIN))
      .post('/api/full-pipeline-demo/execute')
      .send({ batchSize: 0, includeNetSuiteSync: 'no', dryRun: 'no' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('batchSize must be an integer between 1 and 100.');
    expectNoPipelineWork();
  });

  it('rejects an array body with the shape error', async () => {
    const res = await request(makeApp(ADMIN))
      .post('/api/full-pipeline-demo/execute')
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_request',
      message: 'body must be a JSON object.',
    });
    expectNoPipelineWork();
  });

  // express.json({strict: true}) rejects null and primitive bodies upstream,
  // so these never reach our shape check. Assert only the status — the
  // message belongs to body-parser, and pinning it here would couple this
  // suite to an Express internal.
  it.each([['null', 'null'], ['primitive', '42']])(
    'rejects a %s body with 400 (upstream body-parser)',
    async (_label, raw) => {
      const res = await request(makeApp(ADMIN))
        .post('/api/full-pipeline-demo/execute')
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(400);
      expectNoPipelineWork();
    },
  );

  it('an omitted body selects defaults rather than erroring', async () => {
    const res = await request(makeApp(ADMIN)).post('/api/full-pipeline-demo/execute');
    expect(res.status).toBe(200);
  }, 15000);

  // Copilot #1083: the handler normalizes an absent `req.body` to `{}` for the
  // shape check, so every later read must go through that normalized value.
  // Reading the passthrough fields off the raw `req.body` re-introduced the
  // throw the normalization exists to prevent — a TypeError surfacing as 500.
  it('an undefined req.body takes the defaults path rather than throwing', async () => {
    const res = await request(makeAppWithoutBodyParser(ADMIN))
      .post('/api/full-pipeline-demo/execute');
    expect(res.status).toBe(200);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  }, 15000);

  it('identity is checked before validation', async () => {
    const res = await request(makeApp())
      .post('/api/full-pipeline-demo/execute').send({ batchSize: 0 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expectNoPipelineWork();
  });
});
