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
      responseTime: 123
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
});

