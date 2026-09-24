/**
 * Task 10 ("Suggestion-time advisory warnings through shared evidence") —
 * route-level tests for `POST /mapping/suggestions` proving the authenticated
 * path resolves advisory cardinality evidence through the SAME coordinator
 * the activation gate uses, that a resolution failure never 500s the
 * suggestion request, and that request-supplied relationship metadata is
 * never forwarded into agent input.
 *
 * System names deliberately avoid 'netsuite'/'salesforce' so
 * `RelationshipEvidenceProvider.getEvidence` resolves deterministically via
 * its zero-I/O `default: unavailable` branch — no network/database calls,
 * no flakiness.
 */
import express from 'express';
import request from 'supertest';

import { aiMappingRouter } from '../../src/routes/aiMapping';
import { MultiAgentOrchestrator } from '../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import { TelemetryService } from '../../src/services/TelemetryService';
import { CardinalityPreflightService } from '../../src/services/cardinality/CardinalityPreflightService';
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

const AGENT_MAPPING = {
  providerId: 'claude',
  sourceField: 'Name',
  targetField: 'name',
  confidence: 0.9,
  transformationType: 'direct',
  reasoning: 'Exact name match',
};

describe('POST /mapping/suggestions — advisory cardinality wiring (Task 10)', () => {
  beforeAll(async () => {
    // DatabaseService and its async-bound dependents (MultiAgentOrchestrator,
    // etc.) are toDynamicValue(async ...) bindings (inversify.config.ts); the
    // route's synchronous container.get(...) calls need them already
    // resolved once, which normal Server boot does — this test mounts the
    // router directly, so it must warm the same singletons first or a sync
    // .get() throws "constructed in a synchronous way".
    await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    await container.getAsync(TYPES.MultiAgentOrchestrator);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves advisory evidence via the shared coordinator and forwards it to the agent, without forwarding request-supplied relationships', async () => {
    const executeAgentSpy = jest
      .spyOn(MultiAgentOrchestrator.prototype, 'executeAgent')
      .mockResolvedValue({ success: true, data: { mappings: [AGENT_MAPPING] }, confidence: 0.9 } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send({
        sourceSystem: 'CustomCRM',
        targetSystem: 'CustomERP',
        sourceSchema: { systemName: 'CustomCRM', fields: [{ name: 'Name', type: 'string' }] },
        targetSchema: {
          systemName: 'CustomERP',
          fields: [{ name: 'name', type: 'string' }],
          // Client-supplied relationship metadata is never trusted evidence
          // and must never reach agent input.
          relationships: [{ field: 'contacts', relatedRecord: 'Contact', type: 'child' }],
        },
      });

    expect(res.status).toBe(200);
    expect(executeAgentSpy).toHaveBeenCalledTimes(1);

    const agentInput = executeAgentSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(agentInput).not.toHaveProperty('relationships');

    const advisory = agentInput.cardinalityAdvisory as Record<string, unknown> | undefined;
    expect(advisory).toBeDefined();
    expect(advisory).toMatchObject({
      sourceSystem: 'CustomCRM',
      targetSystem: 'CustomERP',
      sourceEvidence: expect.objectContaining({ status: 'unavailable' }),
      targetEvidence: expect.objectContaining({ status: 'unavailable' }),
    });
  });

  it('never 500s the suggestion request when advisory evidence resolution fails', async () => {
    jest
      .spyOn(CardinalityPreflightService.prototype, 'getAdvisoryEvidence')
      .mockRejectedValue(new Error('discovery transport failure'));
    const executeAgentSpy = jest
      .spyOn(MultiAgentOrchestrator.prototype, 'executeAgent')
      .mockResolvedValue({ success: true, data: { mappings: [AGENT_MAPPING] }, confidence: 0.9 } as never);
    jest.spyOn(TelemetryService.prototype, 'recordEvent').mockResolvedValue(undefined as never);

    const res = await request(createApp())
      .post('/mapping/suggestions')
      .send({
        sourceSystem: 'CustomCRM',
        targetSystem: 'CustomERP',
        sourceSchema: { systemName: 'CustomCRM', fields: [{ name: 'Name', type: 'string' }] },
        targetSchema: { systemName: 'CustomERP', fields: [{ name: 'name', type: 'string' }] },
      });

    expect(res.status).toBe(200);
    const agentInput = executeAgentSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(agentInput).not.toHaveProperty('cardinalityAdvisory');
  });
});
