/**
 * Task 10 ("advisory AI profile recommendations", 2026-07-27 NetSuite
 * serialized-asset sync plan) — route-level tests for `POST
 * /mapping/suggestions` proving the `netsuite_serialized_asset` ADVISORY
 * recommendation:
 *   - is returned ONLY for the exact NetSuite `inventorynumber` -> Salesforce
 *     `Asset` pair (system/entity casing normalized),
 *   - never carries or is influenced by AI/model-supplied content,
 *   - never carries a custom-field selection (those come only from live
 *     readiness discovery + explicit operator choice, Task 11), and
 *   - is discarded by the route (rather than relayed) if `agentResult.data`
 *     ever returns something that isn't EXACTLY the closed advisory shape —
 *     the "hostile AI output" boundary this task must make impossible to
 *     bypass.
 *
 * Mirrors `aiMappingCardinalityAdvisory.routes.test.ts`'s setup: mounts
 * `aiMappingRouter` directly (bypassing `MappingRouter.ts`'s interception of
 * the composed `/api/ai/proxy` chain) and spies on
 * `MultiAgentOrchestrator.prototype.executeAgent` to control the agent
 * result and inspect the agent input the route builds.
 */
import express from 'express';
import request from 'supertest';

import { aiMappingRouter } from '../../src/routes/aiMapping';
import { MultiAgentOrchestrator } from '../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import { TelemetryService } from '../../src/services/TelemetryService';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { DatabaseService } from '../../src/database/DatabaseService';

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  // Simulates an authenticated request (isAnonymousRequest checks req.user).
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: 1 };
    next();
  });
  app.use('/mapping', aiMappingRouter);
  return app;
}

const BENIGN_MAPPING = {
  providerId: 'claude',
  sourceField: 'inventorynumber',
  targetField: 'SerialNumber',
  confidence: 0.9,
  transformationType: 'direct',
  reasoning: 'Exact field match',
};

const EXPECTED_RECOMMENDATION = {
  profile: 'netsuite_serialized_asset',
  advisoryOnly: true,
  sourceEntity: 'inventorynumber',
  targetEntity: 'Asset',
  requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id'],
  optionalMappingRoles: ['status', 'location'],
};

const NETSUITE_ASSET_REQUEST_BODY = {
  sourceSystem: 'netsuite',
  targetSystem: 'salesforce',
  sourceSchema: {
    systemName: 'netsuite',
    recordType: 'inventorynumber',
    fields: [{ name: 'inventorynumber', type: 'string' }],
  },
  targetSchema: {
    systemName: 'salesforce',
    recordType: 'Asset',
    fields: [{ name: 'SerialNumber', type: 'string' }],
  },
};

describe('POST /mapping/suggestions — advisory execution-profile recommendation (Task 10)', () => {
  beforeAll(async () => {
    // Same async-singleton warmup aiMappingCardinalityAdvisory.routes.test.ts
    // performs: the route's synchronous container.get(...) calls need these
    // already resolved once.
    await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    await container.getAsync(TYPES.MultiAgentOrchestrator);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the advisory recommendation for the exact supported pair and forwards a deterministic hint to the agent', async () => {
    const executeAgentSpy = jest
      .spyOn(MultiAgentOrchestrator.prototype, 'executeAgent')
      .mockResolvedValue({ success: true, data: { mappings: [BENIGN_MAPPING] }, confidence: 0.9 } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send(NETSUITE_ASSET_REQUEST_BODY);

    expect(res.status).toBe(200);

    const agentInput = executeAgentSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(agentInput.executionProfileHint).toEqual({
      sourceSystem: 'netsuite',
      targetSystem: 'salesforce',
      sourceEntity: 'inventorynumber',
      targetEntity: 'Asset',
    });
  });

  it('normalizes casing on both systems and both entities', async () => {
    jest
      .spyOn(MultiAgentOrchestrator.prototype, 'executeAgent')
      .mockResolvedValue({
        success: true,
        data: { mappings: [BENIGN_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
        confidence: 0.9,
      } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send({
        ...NETSUITE_ASSET_REQUEST_BODY,
        sourceSchema: {
          ...NETSUITE_ASSET_REQUEST_BODY.sourceSchema,
          systemName: 'NetSuite',
          recordType: 'InventoryNumber',
        },
        targetSchema: {
          ...NETSUITE_ASSET_REQUEST_BODY.targetSchema,
          systemName: 'Salesforce',
          recordType: 'ASSET',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.executionProfileRecommendation).toEqual(EXPECTED_RECOMMENDATION);
  });

  it('omits executionProfileRecommendation for an unsupported pair', async () => {
    // The agent RETURNS a well-formed recommendation even though the
    // request's own pair (CustomCRM/CustomERP) is unsupported — this is
    // what makes the assertion below a genuine test of the ROUTE'S OWN
    // pair-check (`sanitizeExecutionProfileRecommendation` re-validating
    // `executionProfileHint` against `matchesSerializedAssetAdvisoryPair`),
    // not a tautology: if that check were ever removed, this test would
    // fail because the recommendation would be relayed as-is.
    jest.spyOn(MultiAgentOrchestrator.prototype, 'executeAgent').mockResolvedValue({
      success: true,
      data: { mappings: [BENIGN_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
      confidence: 0.9,
    } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send({
        sourceSystem: 'CustomCRM',
        targetSystem: 'CustomERP',
        sourceSchema: { systemName: 'CustomCRM', recordType: 'inventorynumber', fields: [{ name: 'Name', type: 'string' }] },
        targetSchema: { systemName: 'CustomERP', recordType: 'Asset', fields: [{ name: 'name', type: 'string' }] },
      });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
  });

  it('omits executionProfileRecommendation when trusted entity metadata is missing (recordType defaults to generic), even if the agent returns one', async () => {
    // Same non-tautology rationale as above: the mocked agent asserts a
    // recommendation despite the request never declaring recordType (which
    // defaults to 'generic') — proving the route strips it rather than
    // merely never having produced it.
    jest.spyOn(MultiAgentOrchestrator.prototype, 'executeAgent').mockResolvedValue({
      success: true,
      data: { mappings: [BENIGN_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
      confidence: 0.9,
    } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send({
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        // No sourceSchema/targetSchema.recordType supplied — buildSystemSchema
        // defaults recordType to 'generic', which must not accidentally match.
        sourceFields: [{ name: 'inventorynumber', type: 'string' }],
        targetFields: [{ name: 'SerialNumber', type: 'string' }],
      });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
  });

  it('marks the recommendation advisory-only and never includes a custom-field selection', async () => {
    jest
      .spyOn(MultiAgentOrchestrator.prototype, 'executeAgent')
      .mockResolvedValue({
        success: true,
        data: { mappings: [BENIGN_MAPPING], executionProfileRecommendation: EXPECTED_RECOMMENDATION },
        confidence: 0.9,
      } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send(NETSUITE_ASSET_REQUEST_BODY);

    expect(res.status).toBe(200);
    expect(res.body.executionProfileRecommendation.advisoryOnly).toBe(true);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/productExternalIdField/);
    expect(raw).not.toMatch(/assetExternalIdField/);
  });

  it('strips smuggled properties from a malformed executionProfileRecommendation instead of relaying them verbatim (hostile AI output)', async () => {
    jest.spyOn(MultiAgentOrchestrator.prototype, 'executeAgent').mockResolvedValue({
      success: true,
      data: {
        mappings: [BENIGN_MAPPING],
        // Simulates a compromised/malformed agent result: extra properties
        // an attacker would want to smuggle through as if they were part of
        // the advisory contract (an activation instruction and a
        // custom-field selection). The route rebuilds the object field-by-
        // field from a fixed whitelist, so these never survive — the
        // otherwise-valid core of the recommendation is still returned, but
        // with nothing beyond its five known properties.
        executionProfileRecommendation: {
          ...EXPECTED_RECOMMENDATION,
          activate: true,
          assetExternalIdField: 'My_Custom_Field__c',
        },
      },
      confidence: 0.9,
    } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send(NETSUITE_ASSET_REQUEST_BODY);

    expect(res.status).toBe(200);
    expect(res.body.executionProfileRecommendation).toEqual(EXPECTED_RECOMMENDATION);
    expect(res.body.executionProfileRecommendation).not.toHaveProperty('activate');
    expect(res.body.executionProfileRecommendation).not.toHaveProperty('assetExternalIdField');
    expect(JSON.stringify(res.body)).not.toMatch(/My_Custom_Field__c/);
  });

  it('discards a recommendation whose role arrays contain a value outside the closed vocabulary', async () => {
    jest.spyOn(MultiAgentOrchestrator.prototype, 'executeAgent').mockResolvedValue({
      success: true,
      data: {
        mappings: [BENIGN_MAPPING],
        executionProfileRecommendation: {
          ...EXPECTED_RECOMMENDATION,
          requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id', 'custom_field__c'],
        },
      },
      confidence: 0.9,
    } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send(NETSUITE_ASSET_REQUEST_BODY);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('executionProfileRecommendation');
  });
});
