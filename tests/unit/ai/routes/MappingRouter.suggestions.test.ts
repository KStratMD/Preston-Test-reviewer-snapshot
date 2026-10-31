/**
 * MappingRouter suggestion-projection unit tests (PR2/Task 3).
 *
 * Covers `projectAgentMappingSuggestion`, the pure function extracted from
 * the inline `/mapping/suggestions` projection (~old lines 264-300). Verifies
 * the additive structured `reasoning` field's contract AND that every
 * pre-existing field (`reason`'s fallback chain in particular) stays
 * byte-compatible with the prior inline behavior.
 *
 * PR6/Task 10 adds endpoint-contract coverage for
 * `POST /suggestions/:suggestionId/accept` — the acceptance-telemetry
 * contract the restyled UI (Task 12) relies on before mutating local state:
 * success is only reported after `recordAISuggestionAccepted` resolves, and
 * a telemetry failure surfaces as a non-success response.
 */

import request from 'supertest';
import express, { Application, Request, Response, NextFunction } from 'express';
import {
  projectAgentMappingSuggestion,
  AgentMapping,
  createMappingRouter,
  MappingRouterDependencies,
} from '../../../../src/routes/ai-proxy/MappingRouter';

describe('projectAgentMappingSuggestion', () => {
  it('joins array reasoning into `reason` while `reasoning` remains the array (stringified)', () => {
    const mapping: AgentMapping = {
      sourceField: 'first_name',
      targetField: 'FirstName',
      confidence: 0.9,
      reasoning: ['Exact name match', 'Same data type'],
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 0);

    expect(result.reason).toBe('Exact name match. Same data type');
    expect(result.reasoning).toEqual(['Exact name match', 'Same data type']);
  });

  it('wraps string reasoning into a one-element `reasoning` array while `reason` stays the raw string', () => {
    const mapping: AgentMapping = {
      sourceField: 'email',
      targetField: 'Email',
      confidence: 0.8,
      reasoning: 'Matched by field name similarity',
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 1);

    expect(result.reason).toBe('Matched by field name similarity');
    expect(result.reasoning).toEqual(['Matched by field name similarity']);
  });

  it('leaves `reasoning` undefined and falls back to `businessRule` for `reason` when reasoning is absent', () => {
    const mapping: AgentMapping = {
      sourceField: 'acct_no',
      targetField: 'AccountNumber',
      confidence: 0.7,
      businessRule: 'Account numbers map 1:1 across systems',
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 2);

    expect(result.reason).toBe('Account numbers map 1:1 across systems');
    expect(result.reasoning).toBeUndefined();
  });

  it('leaves `reasoning` undefined and falls back to the transformation-type sentence for `reason` when reasoning and businessRule are both absent', () => {
    const mapping: AgentMapping = {
      sourceField: 'amount',
      targetField: 'Amount',
      confidence: 0.5,
      transformationType: 'currency-convert',
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 3);

    expect(result.reason).toBe('Mapped via currency-convert transformation');
    expect(result.reasoning).toBeUndefined();
  });

  it('keeps existing fields byte-compatible (id, transformationType default, transformationLogic passthrough)', () => {
    const mapping: AgentMapping = {
      sourceField: 'qty',
      targetField: 'Quantity',
      confidence: 0.6,
      transformation: { type: 'numeric-cast', logic: 'parseInt(value, 10)' },
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_abc', 4);

    expect(result.id).toBe('suggestion_abc_4');
    expect(result.sourceField).toBe('qty');
    expect(result.targetField).toBe('Quantity');
    expect(result.confidence).toBe(0.6);
    expect(result.transformationType).toBe('numeric-cast');
    expect(result.transformationLogic).toBe('parseInt(value, 10)');
    expect(result.reason).toBe('Mapped via numeric-cast transformation');
    expect(result.reasoning).toBeUndefined();
  });

  it('normalizes an empty reasoning array to `reasoning: undefined` while pinning the `reason` byte-compat quirk (`[].join === \'\'`)', () => {
    const mapping: AgentMapping = {
      sourceField: 'phone',
      targetField: 'Phone',
      confidence: 0.4,
      reasoning: [],
      businessRule: 'Phone numbers map 1:1 across systems',
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 5);

    expect(result.reasoning).toBeUndefined();
    expect(result.reason).toBe('');
  });

  it('normalizes an empty reasoning string to `reasoning: undefined` and falls back to `businessRule` for `reason`', () => {
    const mapping: AgentMapping = {
      sourceField: 'zip',
      targetField: 'PostalCode',
      confidence: 0.4,
      reasoning: '',
      businessRule: 'Postal codes map 1:1 across systems',
    };

    const result = projectAgentMappingSuggestion(mapping, 'suggestion_123', 6);

    expect(result.reasoning).toBeUndefined();
    expect(result.reason).toBe('Postal codes map 1:1 across systems');
  });
});

describe('POST /suggestions/:suggestionId/accept (acceptance-telemetry contract)', () => {
  const AUTH_USER = { id: 'user-42', tenantId: 'tenant-alpha' };

  // Simulates authMiddleware having verified a JWT: extractIdentityContext
  // reads the whole-source `req.user` (tenantId + id) and derives userId.
  const injectAuthenticatedUser = (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: typeof AUTH_USER }).user = AUTH_USER;
    next();
  };

  let app: Application;
  let recordAISuggestionAccepted: jest.Mock;
  let recordErrorOccurred: jest.Mock;

  beforeEach(async () => {
    recordAISuggestionAccepted = jest.fn().mockResolvedValue(undefined);
    recordErrorOccurred = jest.fn().mockResolvedValue(undefined);

    // Only the members the accept endpoint touches are mocked; the other
    // dependencies are inert placeholders (never invoked by this route).
    const deps = {
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      telemetry: { recordAISuggestionAccepted, recordErrorOccurred },
      costTracking: {},
      governanceService: {},
      orchestrator: {},
    } as unknown as MappingRouterDependencies;

    app = express();
    app.use(express.json());
    app.use(injectAuthenticatedUser);
    app.use('/', await createMappingRouter(deps));
  });

  it('records acceptance exactly once with the authenticated user context and returns success', async () => {
    const res = await request(app).post('/suggestions/suggestion_abc_1/accept').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestionId).toBe('suggestion_abc_1');
    expect(recordAISuggestionAccepted).toHaveBeenCalledTimes(1);
    expect(recordAISuggestionAccepted).toHaveBeenCalledWith('suggestion_abc_1', AUTH_USER.id);
    // The clean path never touches the error-telemetry channel.
    expect(recordErrorOccurred).not.toHaveBeenCalled();
  });

  it('returns a non-success response when acceptance telemetry fails (suggestion NOT reported as accepted)', async () => {
    recordAISuggestionAccepted.mockRejectedValueOnce(new Error('telemetry sink unavailable'));

    const res = await request(app).post('/suggestions/suggestion_abc_1/accept').send({});

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Failed to accept suggestion');
    expect(res.body.suggestionId).toBe('suggestion_abc_1');
    // The failure itself is recorded through the error-telemetry channel.
    expect(recordErrorOccurred).toHaveBeenCalledWith(
      'ai-proxy',
      'SUGGESTION_ACCEPT_FAILED',
      expect.stringContaining('telemetry sink unavailable')
    );
    // No swallow-and-retry: the accept signal is attempted exactly once.
    expect(recordAISuggestionAccepted).toHaveBeenCalledTimes(1);
  });
});

/**
 * Deferred item from the Task 11 review, now closed.
 *
 * `SuggestionsBodySchema`'s `sourceEntity`/`targetEntity` were introduced
 * unbounded by Task 10 while the canonical configuration schema caps entity
 * names at 100 characters. That was harmless only while nothing could set them:
 * Task 11 added the editor's Record Type inputs AND a URL deep-link, so an
 * operator-supplied string of any length now reaches the mapping context and,
 * through `executionProfileHint`, the agent prompt.
 *
 * These run against `MappingRouter` itself — the AUTHENTICATED entry point that
 * owns `POST /mapping/suggestions`. The sibling advisory suite mounts
 * `aiMapping.ts` directly and never exercises this schema.
 */
describe('POST /mapping/suggestions — entity-name bounds', () => {
  const AUTH_USER = { id: 'user-42', tenantId: 'tenant-alpha' };

  const validBody = {
    sourceSystem: 'netsuite',
    targetSystem: 'salesforce',
    sourceFields: [{ name: 'inventorynumber', type: 'string' }],
    targetFields: [{ name: 'SerialNumber', type: 'string' }],
  };

  let app: Application;
  let executeAgent: jest.Mock;

  beforeEach(async () => {
    executeAgent = jest.fn().mockResolvedValue({ success: true, data: { mappings: [] }, confidence: 0.9 });

    const deps = {
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      telemetry: {
        recordErrorOccurred: jest.fn().mockResolvedValue(undefined),
        recordEvent: jest.fn().mockResolvedValue(undefined),
        recordAISuggestionRequested: jest.fn().mockResolvedValue(undefined),
        recordAIMappingGenerated: jest.fn().mockResolvedValue(undefined),
      },
      costTracking: { recordUsage: jest.fn().mockResolvedValue(undefined) },
      // The route governance-pre-checks before it reaches the orchestrator;
      // approving keeps these tests about the SCHEMA bound and nothing else.
      governanceService: {
        validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [] }),
        validateOutput: jest.fn().mockResolvedValue({ approved: true, flags: [] }),
      },
      orchestrator: { executeAgent },
    } as unknown as MappingRouterDependencies;

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: typeof AUTH_USER }).user = AUTH_USER;
      next();
    });
    app.use('/', await createMappingRouter(deps));
  });

  it('rejects a sourceEntity longer than the canonical 100-character cap', async () => {
    const res = await request(app)
      .post('/mapping/suggestions')
      .send({ ...validBody, sourceEntity: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    // The cap must bite BEFORE the agent runs — otherwise the unbounded string
    // has already reached the prompt regardless of the response status.
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('rejects an over-long targetEntity as well', async () => {
    const res = await request(app)
      .post('/mapping/suggestions')
      .send({ ...validBody, targetEntity: 'y'.repeat(101) });

    expect(res.status).toBe(400);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('rejects an empty-string entity (min 1, matching the canonical schema)', async () => {
    const res = await request(app)
      .post('/mapping/suggestions')
      .send({ ...validBody, sourceEntity: '' });

    expect(res.status).toBe(400);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  // These two assert that VALIDATION passed, not that the whole suggestion
  // pipeline succeeded — reaching the orchestrator is the exact boundary this
  // schema change moves, and the rest of the pipeline needs a dependency graph
  // that has nothing to do with entity-name bounds.
  it('accepts a name exactly at the 100-character boundary, so the cap is not off by one', async () => {
    const res = await request(app)
      .post('/mapping/suggestions')
      .send({ ...validBody, sourceEntity: 'x'.repeat(100) });

    expect(res.status).not.toBe(400);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('still accepts the entities being omitted entirely (they remain optional)', async () => {
    const res = await request(app).post('/mapping/suggestions').send(validBody);

    expect(res.status).not.toBe(400);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });
});
