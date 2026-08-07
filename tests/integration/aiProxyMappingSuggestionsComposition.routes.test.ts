/**
 * Task 10 hardening (post-review, 2026-07-27 NetSuite serialized-asset sync
 * plan). Reviewer-proven CRITICAL: the previous route-level tests for the
 * `netsuite_serialized_asset` ADVISORY recommendation mounted `aiMappingRouter`
 * in isolation — a configuration that cannot occur in production. In the
 * REAL composed router (`src/routes/aiProxy.ts:158-165` mounts
 * `createMappingRouter`'s router at `/`, THEN `:232` mounts `aiMappingRouter`
 * at `/mapping`), `MappingRouter.ts:189`'s `POST /mapping/suggestions`
 * handler owns every authenticated request and never calls `next()` — so
 * `aiMapping.ts`'s handler is reachable ONLY via MappingRouter's anonymous
 * delegation, and only ever serves the anonymous demo-fixture path from
 * there.
 *
 * This suite composes the two routers in that EXACT order and proves:
 *   - the advisory recommendation for an authenticated request is produced
 *     by MappingRouter itself (the only handler authenticated traffic can
 *     reach),
 *   - MappingRouter's own pair-check strips a recommendation the (mocked)
 *     agent asserts for an unsupported pair — not just shape validity,
 *   - anonymous traffic still falls through to aiMapping.ts's zero-spend
 *     demo fixture, with the orchestrator never invoked and no
 *     recommendation ever attempted.
 */
import express from 'express';
import request from 'supertest';

import { createMappingRouter } from '../../src/routes/ai-proxy/MappingRouter';
import { aiMappingRouter } from '../../src/routes/aiMapping';

const EXPECTED_RECOMMENDATION = {
  profile: 'netsuite_serialized_asset',
  advisoryOnly: true,
  sourceEntity: 'inventorynumber',
  targetEntity: 'Asset',
  requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id'],
  optionalMappingRoles: ['status', 'location'],
};

const BENIGN_AGENT_MAPPING = {
  sourceField: 'inventorynumber',
  targetField: 'SerialNumber',
  confidence: 0.9,
  transformationType: 'direct',
  reasoning: 'exact field match',
};

function buildDeps(executeAgent: jest.Mock) {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    telemetry: {
      recordAISuggestionRequested: jest.fn().mockResolvedValue(undefined),
      recordAISuggestionGenerated: jest.fn().mockResolvedValue(undefined),
      recordAISuggestionAccepted: jest.fn().mockResolvedValue(undefined),
      recordEvent: jest.fn().mockResolvedValue(undefined),
      recordErrorOccurred: jest.fn().mockResolvedValue(undefined),
      recordAISuggestionResponded: jest.fn().mockResolvedValue(undefined),
    } as any,
    costTracking: {
      getSessionCost: jest.fn().mockResolvedValue(0),
      getTokenUsage: jest.fn().mockResolvedValue({ byProvider: {} }),
      recordCost: jest.fn().mockResolvedValue(undefined),
    } as any,
    governanceService: {
      validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }),
      validateOutput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }),
    } as any,
    orchestrator: { executeAgent } as any,
  };
}

/** Composes the two routers in the EXACT order `aiProxy.ts` uses: `createMappingRouter`'s router at `/`, then `aiMappingRouter` at `/mapping`. */
async function buildComposedApp(deps: ReturnType<typeof buildDeps>, identity?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  if (identity) {
    app.use((req, _res, next) => {
      (req as express.Request & { user?: Record<string, unknown> }).user = identity;
      next();
    });
  }
  app.use('/', await createMappingRouter(deps));
  app.use('/mapping', aiMappingRouter);
  return app;
}

const AUTH_IDENTITY = { id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] };

const NETSUITE_ASSET_BODY = {
  sourceSystem: 'netsuite',
  targetSystem: 'salesforce',
  sourceFields: [{ name: 'inventorynumber', type: 'string' }],
  targetFields: [{ name: 'SerialNumber', type: 'string' }],
  sourceEntity: 'inventorynumber',
  targetEntity: 'Asset',
};

describe('POST /mapping/suggestions — real composed router (Task 10 reachability, CRITICAL fix)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('authenticated: MappingRouter itself produces executionProfileRecommendation for the exact supported pair', async () => {
    const executeAgent = jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.9,
      reasoning: [],
      data: { mappings: [BENIGN_AGENT_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
    });
    const deps = buildDeps(executeAgent);
    const app = await buildComposedApp(deps, AUTH_IDENTITY);

    const res = await request(app).post('/mapping/suggestions').send(NETSUITE_ASSET_BODY);

    expect(res.status).toBe(200);
    expect(executeAgent).toHaveBeenCalledTimes(1);
    // Proves the hint reached the agent through the REAL production entry
    // point, not just through aiMapping.ts's isolated-mount tests.
    const agentInput = executeAgent.mock.calls[0][2] as Record<string, unknown>;
    expect(agentInput.executionProfileHint).toEqual({
      sourceSystem: 'netsuite',
      targetSystem: 'salesforce',
      sourceEntity: 'inventorynumber',
      targetEntity: 'Asset',
    });
    expect(res.body.executionProfileRecommendation).toEqual(EXPECTED_RECOMMENDATION);
  });

  it('authenticated: MappingRouter strips a recommendation the agent asserts for an UNSUPPORTED pair (IMPORTANT 1 regression, proven on the real entry point)', async () => {
    const executeAgent = jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.9,
      reasoning: [],
      // The mocked agent asserts a well-formed recommendation even though
      // the request pair (hubspot/businesscentral) is unsupported — this is
      // what makes the assertion below fail if MappingRouter's own pair
      // re-check were ever removed.
      data: { mappings: [BENIGN_AGENT_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
    });
    const deps = buildDeps(executeAgent);
    const app = await buildComposedApp(deps, AUTH_IDENTITY);

    const res = await request(app)
      .post('/mapping/suggestions')
      .send({
        ...NETSUITE_ASSET_BODY,
        sourceSystem: 'hubspot',
        targetSystem: 'businesscentral',
      });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
  });

  it('authenticated: a backward-compatible caller that never sends sourceEntity/targetEntity gets no recommendation, but suggestions still work', async () => {
    const executeAgent = jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.9,
      reasoning: [],
      data: { mappings: [BENIGN_AGENT_MAPPING] },
    });
    const deps = buildDeps(executeAgent);
    const app = await buildComposedApp(deps, AUTH_IDENTITY);

    const res = await request(app)
      .post('/mapping/suggestions')
      .send({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceFields: [{ name: 'inventorynumber', type: 'string' }],
        targetFields: [{ name: 'SerialNumber', type: 'string' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toBeDefined();
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
    const agentInput = executeAgent.mock.calls[0][2] as Record<string, unknown>;
    expect(agentInput).not.toHaveProperty('executionProfileHint');
  });

  it('anonymous: falls through to the zero-spend demo fixture — orchestrator never invoked, no recommendation attempted', async () => {
    const executeAgent = jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.9,
      reasoning: [],
      data: { mappings: [BENIGN_AGENT_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
    });
    const deps = buildDeps(executeAgent);
    const app = await buildComposedApp(deps); // no identity middleware => isAnonymousRequest === true

    const res = await request(app).post('/mapping/suggestions').send(NETSUITE_ASSET_BODY);

    expect(res.status).toBe(200);
    expect(executeAgent).not.toHaveBeenCalled();
    expect(res.body.metadata?.strategy).toBe('demo-fixture');
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
  });
});
