import { CostTrackingService } from '../../../../src/services/ai/CostTrackingService';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const telemetry = {
  recordFeatureUsed: jest.fn(),
  recordErrorOccurred: jest.fn()
};

const executeMock = jest.fn().mockResolvedValue(undefined);
const valuesMock = jest.fn().mockReturnValue({ executeTakeFirst: executeMock });
const insertMock = jest.fn().mockReturnValue({ values: valuesMock });

const database = {
  getDatabase: jest.fn().mockReturnValue({
    insertInto: insertMock
  })
};

describe('CostTrackingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    executeMock.mockResolvedValue(undefined);
  });

  it('normalizes audit context when persisting cost entries', async () => {
    const service = new CostTrackingService(
      logger as any,
      telemetry as any,
      database as any
    );

    await service.recordCost({
      sessionId: 'session-1',
      providerId: 'openai',
      requestId: 'req-1',
      tokensUsed: 150,
      cost: 0.012,
      operation: 'mapping',
      sourceSystem: 'CRM',
      targetSystem: 'ERP',
      userId: '42',          // should be coerced to number
      organizationId: '7',   // should be coerced to number
      responseTime: 123,
      tenantId: 'tenant-abc',
      costSource: 'measured',
    });

    expect(insertMock).toHaveBeenCalledWith('ai_usage_logs');
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 42,
      organization_id: 7,
      execution_time_ms: 123
    }));

    // Session totals should be tracked
    await expect(service.getSessionCost('session-1')).resolves.toBeCloseTo(0.012);
    await expect(service.getTokenUsage('session-1')).resolves.toEqual({
      total: 150,
      byProvider: { openai: 150 }
    });

    expect(telemetry.recordFeatureUsed).toHaveBeenCalledWith(
      'ai_cost_tracking_mapping',
      'session-1'
    );
  });

  it('persists tenant_id and cost_source on recordCost', async () => {
    const service = new CostTrackingService(
      logger as any,
      telemetry as any,
      database as any
    );

    await service.recordCost({
      sessionId: 'session-t1',
      providerId: 'openai',
      requestId: 'req-t1',
      tokensUsed: 100,
      cost: 0.50,
      operation: 'mapping',
      tenantId: 'tenant-xyz',
      costSource: 'measured',
    });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant-xyz',
      cost_source: 'measured',
    }));
  });

  it('persists estimated costSource when passed', async () => {
    const service = new CostTrackingService(
      logger as any,
      telemetry as any,
      database as any
    );

    await service.recordCost({
      sessionId: 'session-t2',
      providerId: 'rule-based',
      requestId: 'req-t2',
      tokensUsed: 0,
      cost: 0,
      operation: 'other',
      tenantId: '__system__',
      costSource: 'estimated',
    });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: '__system__',
      cost_source: 'estimated',
    }));
  });

  it('throws on empty or whitespace tenantId', async () => {
    const service = new CostTrackingService(
      logger as any,
      telemetry as any,
      database as any
    );

    await expect(service.recordCost({
      sessionId: 's1',
      providerId: 'openai',
      requestId: 'r1',
      tokensUsed: 100,
      cost: 0.50,
      operation: 'mapping',
      tenantId: '',
      costSource: 'measured',
    })).rejects.toThrow(/tenantId must be non-empty/);

    await expect(service.recordCost({
      sessionId: 's1',
      providerId: 'openai',
      requestId: 'r1',
      tokensUsed: 100,
      cost: 0.50,
      operation: 'mapping',
      tenantId: '   ',
      costSource: 'measured',
    })).rejects.toThrow(/tenantId must be non-empty/);
  });
});
