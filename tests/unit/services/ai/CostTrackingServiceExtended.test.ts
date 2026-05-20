/**
 * Comprehensive unit tests for CostTrackingService
 * Covers: recordCost, checkSessionLimits, getSessionCosts, getAllSessionCosts,
 *         getUsageStatistics, getCostOptimizationRecommendations, resetSession,
 *         getCostLimits, getSessionCost, getProviderBreakdown, getTokenUsage
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { CostTrackingService } from '../../../../src/services/ai/CostTrackingService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetry = {
  recordFeatureUsed: jest.fn().mockResolvedValue(undefined),
  recordErrorOccurred: jest.fn().mockResolvedValue(undefined),
} as any;

const mockInsertInto = jest.fn().mockReturnValue({
  values: jest.fn().mockReturnValue({
    executeTakeFirst: jest.fn().mockResolvedValue(undefined),
  }),
});

const mockDatabase = {
  getDatabase: jest.fn().mockReturnValue({
    insertInto: mockInsertInto,
  }),
} as any;

function makeCostEntry(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'session-1',
    providerId: 'openai',
    requestId: 'req-1',
    tokensUsed: 500,
    cost: 0.015,
    operation: 'mapping' as const,
    ...overrides,
  };
}

describe('CostTrackingService', () => {
  let service: CostTrackingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CostTrackingService(mockLogger, mockTelemetry, mockDatabase);
  });

  describe('getCostLimits', () => {
    it('should return default limits', () => {
      const limits = service.getCostLimits();
      expect(limits.sessionTarget).toBe(0.20);
      expect(limits.sessionAlert).toBe(0.30);
      expect(limits.sessionHardLimit).toBe(0.40);
      expect(limits.dailyLimit).toBe(50.0);
      expect(limits.monthlyLimit).toBe(1000.0);
    });
  });

  describe('recordCost', () => {
    it('should record a cost entry', async () => {
      await service.recordCost(makeCostEntry());
      const session = service.getSessionCosts('session-1');
      expect(session).not.toBeNull();
      expect(session!.totalCost).toBe(0.015);
      expect(session!.totalTokens).toBe(500);
      expect(session!.totalRequests).toBe(1);
    });

    it('should persist to database', async () => {
      await service.recordCost(makeCostEntry());
      expect(mockInsertInto).toHaveBeenCalledWith('ai_usage_logs');
    });

    it('should record telemetry', async () => {
      await service.recordCost(makeCostEntry());
      expect(mockTelemetry.recordFeatureUsed).toHaveBeenCalledWith(
        'ai_cost_tracking_mapping',
        'session-1',
      );
    });

    it('should accumulate multiple entries for same session', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.01 }));
      await service.recordCost(makeCostEntry({ cost: 0.02 }));
      const session = service.getSessionCosts('session-1');
      expect(session!.totalCost).toBeCloseTo(0.03);
      expect(session!.totalRequests).toBe(2);
    });

    it('should track by provider', async () => {
      await service.recordCost(makeCostEntry({ providerId: 'openai', cost: 0.01 }));
      await service.recordCost(makeCostEntry({ providerId: 'claude', cost: 0.005 }));
      const session = service.getSessionCosts('session-1');
      expect(session!.byProvider['openai'].cost).toBe(0.01);
      expect(session!.byProvider['claude'].cost).toBe(0.005);
    });

    it('should mark limitReached when exceeding hard limit', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.45 }));
      const session = service.getSessionCosts('session-1');
      expect(session!.limitReached).toBe(true);
    });

    it('should handle database failure gracefully', async () => {
      mockDatabase.getDatabase.mockReturnValueOnce({
        insertInto: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            executeTakeFirst: jest.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      });
      await expect(service.recordCost(makeCostEntry())).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to persist cost entry to database',
        expect.objectContaining({ error: 'DB error' }),
      );
    });

    it('should handle null database gracefully', async () => {
      mockDatabase.getDatabase.mockReturnValueOnce(null);
      await expect(service.recordCost(makeCostEntry())).resolves.not.toThrow();
    });

    it('should normalize numeric userId', async () => {
      await service.recordCost(makeCostEntry({ userId: '42' }));
      expect(mockInsertInto).toHaveBeenCalled();
    });

    it('should use systemUserId when userId is undefined', async () => {
      await service.recordCost(makeCostEntry({ userId: undefined }));
      expect(mockInsertInto).toHaveBeenCalled();
    });
  });

  describe('checkSessionLimits', () => {
    it('should allow cost within limits', async () => {
      const result = await service.checkSessionLimits('session-1', 0.01);
      expect(result.allowed).toBe(true);
      expect(result.currentCost).toBe(0);
      expect(result.projectedCost).toBe(0.01);
    });

    it('should deny cost exceeding hard limit', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.35 }));
      const result = await service.checkSessionLimits('session-1', 0.10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Session cost limit exceeded');
    });

    it('should recommend fallback when exceeding target', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.18 }));
      const result = await service.checkSessionLimits('session-1', 0.05);
      expect(result.allowed).toBe(true);
      expect(result.recommendFallback).toBe(true);
    });

    it('should not recommend fallback for low cost', async () => {
      const result = await service.checkSessionLimits('session-1', 0.01);
      expect(result.recommendFallback).toBe(false);
    });

    it('should trigger alert when crossing threshold', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.25 }));
      await service.checkSessionLimits('session-1', 0.10);
      expect(mockTelemetry.recordErrorOccurred).toHaveBeenCalledWith(
        'cost-tracking',
        'SESSION_COST_ALERT',
        expect.stringContaining('cost alert'),
      );
    });

    it('should not re-trigger alert once triggered', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.25 }));
      await service.checkSessionLimits('session-1', 0.10);
      mockTelemetry.recordErrorOccurred.mockClear();
      await service.checkSessionLimits('session-1', 0.01);
      // Should not trigger alert again (already triggered)
      const alertCalls = mockTelemetry.recordErrorOccurred.mock.calls.filter(
        (c: any[]) => c[1] === 'SESSION_COST_ALERT',
      );
      expect(alertCalls).toHaveLength(0);
    });
  });

  describe('getSessionCosts', () => {
    it('should return null for unknown session', () => {
      expect(service.getSessionCosts('unknown')).toBeNull();
    });
  });

  describe('getAllSessionCosts', () => {
    it('should return empty array with no sessions', () => {
      expect(service.getAllSessionCosts()).toEqual([]);
    });

    it('should return all sessions', async () => {
      await service.recordCost(makeCostEntry({ sessionId: 's1' }));
      await service.recordCost(makeCostEntry({ sessionId: 's2' }));
      expect(service.getAllSessionCosts()).toHaveLength(2);
    });
  });

  describe('getUsageStatistics', () => {
    it('should return stats for hour timeframe', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.01 }));
      const stats = await service.getUsageStatistics('hour');
      expect(stats.timeframe).toBe('hour');
      expect(stats.totalCost).toBe(0.01);
      expect(stats.totalRequests).toBe(1);
    });

    it('should return stats for day timeframe', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.02 }));
      const stats = await service.getUsageStatistics('day');
      expect(stats.timeframe).toBe('day');
      expect(stats.totalCost).toBe(0.02);
    });

    it('should return stats for month timeframe', async () => {
      await service.recordCost(makeCostEntry());
      const stats = await service.getUsageStatistics('month');
      expect(stats.timeframe).toBe('month');
      expect(stats.totalSessions).toBe(1);
    });

    it('should calculate per-session and per-request averages', async () => {
      await service.recordCost(makeCostEntry({ sessionId: 's1', cost: 0.02 }));
      await service.recordCost(makeCostEntry({ sessionId: 's2', cost: 0.04 }));
      const stats = await service.getUsageStatistics('day');
      expect(stats.avgCostPerSession).toBeCloseTo(0.03);
      expect(stats.avgCostPerRequest).toBeCloseTo(0.03);
    });

    it('should group by provider', async () => {
      await service.recordCost(makeCostEntry({ providerId: 'openai', cost: 0.01 }));
      await service.recordCost(makeCostEntry({ providerId: 'claude', cost: 0.005 }));
      const stats = await service.getUsageStatistics('day');
      expect(stats.byProvider['openai'].cost).toBe(0.01);
      expect(stats.byProvider['claude'].cost).toBe(0.005);
    });

    it('should include cost trend', async () => {
      await service.recordCost(makeCostEntry());
      const stats = await service.getUsageStatistics('day');
      expect(stats.costTrend.length).toBeGreaterThan(0);
    });

    it('should return zero averages with no data', async () => {
      const stats = await service.getUsageStatistics('hour');
      expect(stats.avgCostPerSession).toBe(0);
      expect(stats.avgCostPerRequest).toBe(0);
    });
  });

  describe('getCostOptimizationRecommendations', () => {
    it('should suggest using rule-based for high cost sessions', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.25 }));
      const recs = await service.getCostOptimizationRecommendations('session-1');
      expect(recs.some(r => r.includes('rule-based'))).toBe(true);
    });

    it('should suggest reducing sample size for high cost sessions', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.25 }));
      const recs = await service.getCostOptimizationRecommendations('session-1');
      expect(recs.some(r => r.includes('sample data'))).toBe(true);
    });

    it('should flag dominant provider', async () => {
      await service.recordCost(makeCostEntry({ providerId: 'openai', cost: 0.25 }));
      await service.recordCost(makeCostEntry({ providerId: 'claude', cost: 0.01 }));
      const recs = await service.getCostOptimizationRecommendations('session-1');
      expect(recs.some(r => r.includes('openai'))).toBe(true);
    });

    it('should return optimal message when costs are low', async () => {
      const recs = await service.getCostOptimizationRecommendations('session-1');
      expect(recs).toContain('Cost usage is within optimal ranges');
    });

    it('should provide general recommendations without sessionId', async () => {
      const recs = await service.getCostOptimizationRecommendations();
      expect(recs.length).toBeGreaterThan(0);
    });
  });

  describe('resetSession', () => {
    it('should remove session data', async () => {
      await service.recordCost(makeCostEntry());
      service.resetSession('session-1');
      expect(service.getSessionCosts('session-1')).toBeNull();
    });

    it('should remove cost history for session', async () => {
      await service.recordCost(makeCostEntry());
      service.resetSession('session-1');
      const stats = await service.getUsageStatistics('day');
      expect(stats.totalRequests).toBe(0);
    });
  });

  describe('getSessionCost', () => {
    it('should return 0 for unknown session', async () => {
      const cost = await service.getSessionCost('unknown');
      expect(cost).toBe(0);
    });

    it('should return total cost for session', async () => {
      await service.recordCost(makeCostEntry({ cost: 0.05 }));
      const cost = await service.getSessionCost('session-1');
      expect(cost).toBe(0.05);
    });
  });

  describe('getProviderBreakdown', () => {
    it('should return empty for unknown session', async () => {
      const bd = await service.getProviderBreakdown('unknown');
      expect(bd).toEqual({});
    });

    it('should return breakdown by provider', async () => {
      await service.recordCost(makeCostEntry({ providerId: 'openai', cost: 0.01 }));
      await service.recordCost(makeCostEntry({ providerId: 'claude', cost: 0.02 }));
      const bd = await service.getProviderBreakdown('session-1');
      expect(bd['openai']).toBe(0.01);
      expect(bd['claude']).toBe(0.02);
    });
  });

  describe('getTokenUsage', () => {
    it('should return zero for unknown session', async () => {
      const usage = await service.getTokenUsage('unknown');
      expect(usage.total).toBe(0);
      expect(usage.byProvider).toEqual({});
    });

    it('should return token usage by provider', async () => {
      await service.recordCost(makeCostEntry({ providerId: 'openai', tokensUsed: 300 }));
      await service.recordCost(makeCostEntry({ providerId: 'claude', tokensUsed: 200 }));
      const usage = await service.getTokenUsage('session-1');
      expect(usage.total).toBe(500);
      expect(usage.byProvider['openai']).toBe(300);
      expect(usage.byProvider['claude']).toBe(200);
    });
  });
});
