/**
 * F2 zero-spend ruling, end-to-end through the REAL aiMapping router: an
 * anonymous suggestion request is served by the deterministic pure mapper
 * (providerId 'rule-based') — real-router evidence that the
 * anonymous demo flow spends nothing (Codex F5/F6 on the v2 plan review).
 */
import express from 'express';
import request from 'supertest';
import { aiMappingRouter } from '../../src/routes/aiMapping';
import { AIFieldMappingService } from '../../src/services/ai/AIFieldMappingService';
import { MultiAgentOrchestrator } from '../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import { TelemetryService } from '../../src/services/TelemetryService';

describe('aiMapping anonymous rule-based flow (F2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('anonymous POST /mapping/suggestions returns rule-based suggestions', async () => {
    const learnedServiceSpy = jest.spyOn(AIFieldMappingService.prototype, 'suggestFieldMappings');
    const orchestratorSpy = jest.spyOn(MultiAgentOrchestrator.prototype, 'executeAgent');
    const telemetrySpy = jest.spyOn(TelemetryService.prototype, 'recordEvent');
    const app = express();
    app.use(express.json());
    app.use('/mapping', aiMappingRouter);

    const res = await request(app)
      .post('/mapping/suggestions')
      .send({
        sourceSchema: { systemType: 'salesforce', fields: [{ name: 'company_name', type: 'string' }, { name: 'phone', type: 'string' }] },
        targetSchema: { systemType: 'netsuite', fields: [{ name: 'companyname', type: 'string' }, { name: 'phone', type: 'string' }] },
      });

    expect(res.status).toBe(200);
    // Provider attribution lives under metadata (aiMapping.ts:639 response shape).
    expect(res.body.metadata?.providerId).toBe('rule-based');
    expect(res.body.metadata?.strategy).toBe('demo-fixture');
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(learnedServiceSpy).not.toHaveBeenCalled();
    expect(orchestratorSpy).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it('anonymous POST /mapping/feedback is acknowledged but never recorded (no training write)', async () => {
    const feedbackSpy = jest.spyOn(AIFieldMappingService.prototype, 'recordUserFeedback');
    const telemetrySpy = jest.spyOn(TelemetryService.prototype, 'recordEvent');
    const app = express();
    app.use(express.json());
    app.use('/mapping', aiMappingRouter);

    const res = await request(app)
      .post('/mapping/feedback')
      .send({ suggestion: { sourceField: 'a', targetField: 'b', confidence: 0.5 }, accepted: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, demoFixture: true, recorded: false });
    expect(feedbackSpy).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });
});
