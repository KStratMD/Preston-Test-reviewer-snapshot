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
