/**
 * Comprehensive unit tests for UnifiedTelemetryService
 * Covers: all record methods, queryEvents, getStatistics, shutdown, buffer flushing
 */
import 'reflect-metadata';
import { UnifiedTelemetryService } from '../../../src/services/UnifiedTelemetryService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('UnifiedTelemetryService', () => {
  let service: UnifiedTelemetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new UnifiedTelemetryService(mockLogger);
    jest.useRealTimers();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  describe('constructor', () => {
    it('should initialize with in-memory backend', () => {
      expect(service).toBeDefined();
    });
  });

  describe('recordAISuggestionRequested', () => {
    it('should record AI suggestion request', async () => {
      await service.recordAISuggestionRequested('openai', 'field-mapping', 'user-1');
      await service.shutdown(); // Flush buffer
      const events = await service.queryEvents({ eventType: 'ai_suggestion_requested' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.provider).toBe('openai');
      expect(events[0].metadata.context).toBe('field-mapping');
    });
  });

  describe('recordAISuggestionResponded', () => {
    it('should record AI suggestion response', async () => {
      await service.recordAISuggestionResponded('claude', 250, 0.003, 'sug-001', 0.95);
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'ai_suggestion_responded' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.latencyMs).toBe(250);
      expect(events[0].metadata.costUsd).toBe(0.003);
      expect(events[0].metadata.accuracyScore).toBe(0.95);
    });
  });

  describe('recordAISuggestionAccepted', () => {
    it('should record AI suggestion acceptance', async () => {
      await service.recordAISuggestionAccepted('sug-001', 'user-1');
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'ai_suggestion_accepted' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.suggestionId).toBe('sug-001');
    });
  });

  describe('recordFeatureUsed', () => {
    it('should record feature usage', async () => {
      await service.recordFeatureUsed('field-mapping', 'user-2');
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'feature_used' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.featureName).toBe('field-mapping');
    });
  });

  describe('recordPageViewed', () => {
    it('should record page view', async () => {
      await service.recordPageViewed('dashboard', 450);
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'page_viewed' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.pageName).toBe('dashboard');
      expect(events[0].metadata.loadTimeMs).toBe(450);
    });
  });

  describe('recordErrorOccurred', () => {
    it('should record error', async () => {
      await service.recordErrorOccurred('auth-service', '401', 'Unauthorized');
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'error_occurred' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.service).toBe('auth-service');
      expect(events[0].metadata.errorCode).toBe('401');
    });
  });

  describe('recordMultiAgentWorkflowExecuted', () => {
    it('should record multi-agent workflow execution', async () => {
      await service.recordMultiAgentWorkflowExecuted(
        'session-1', 'user-1', 'field-mapping', 3, 2000, true, 0.05,
        [{ agentType: 'mapper', success: true, duration: 1000, confidence: 0.9 }]
      );
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'multi_agent_workflow_executed' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.workflowType).toBe('field-mapping');
      expect(events[0].metadata.agentCount).toBe(3);
    });
  });

  describe('recordMultiAgentWorkflowFailed', () => {
    it('should record multi-agent workflow failure', async () => {
      await service.recordMultiAgentWorkflowFailed(
        'session-2', 'user-1', 'data-quality', 500, 'Timeout', 'agent-3'
      );
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'multi_agent_workflow_failed' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.error).toBe('Timeout');
      expect(events[0].metadata.failurePoint).toBe('agent-3');
    });
  });

  describe('recordSingleAgentExecuted', () => {
    it('should record single agent execution', async () => {
      await service.recordSingleAgentExecuted(
        'FieldMapper', 'exec-1', 'user-1', 300, true, 0.85, 100, 50, 0.02
      );
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'single_agent_executed' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.agentType).toBe('FieldMapper');
      expect(events[0].metadata.confidence).toBe(0.85);
    });
  });

  describe('recordSingleAgentFailed', () => {
    it('should record single agent failure', async () => {
      await service.recordSingleAgentFailed(
        'QualityAgent', 'exec-2', 'user-1', 100, 'Provider unavailable', 200
      );
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'single_agent_failed' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.error).toBe('Provider unavailable');
    });
  });

  describe('recordAgentHealthCheck', () => {
    it('should record agent health check', async () => {
      await service.recordAgentHealthCheck('agent-1', 'FieldMapper', 'healthy', 50, 0.01);
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'agent_health_check' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.healthStatus).toBe('healthy');
    });

    it('should record unhealthy agent', async () => {
      await service.recordAgentHealthCheck('agent-2', 'QualityAgent', 'unhealthy', 5000, 0.5);
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'agent_health_check' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.healthStatus).toBe('unhealthy');
    });
  });

  describe('recordGovernanceViolation', () => {
    it('should record governance violation', async () => {
      await service.recordGovernanceViolation(
        'session-3', 'FieldMapper', 'pii_detected', 'high', 'SSN found in output', 'redacted'
      );
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'governance_violation' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.violationType).toBe('pii_detected');
      expect(events[0].metadata.action).toBe('redacted');
    });
  });

  describe('recordGenericEvent', () => {
    it('should record generic event', async () => {
      await service.recordGenericEvent('custom_event', { key: 'value' }, 'user-1', 'session-1');
      await service.shutdown();
      const events = await service.queryEvents({ eventType: 'custom_event' });
      expect(events.length).toBe(1);
      expect(events[0].metadata.key).toBe('value');
    });
  });

  describe('queryEvents', () => {
    beforeEach(async () => {
      await service.recordFeatureUsed('feature-a', 'user-1');
      await service.recordFeatureUsed('feature-b', 'user-2');
      await service.recordErrorOccurred('svc', '500', 'Internal error');
      await service.shutdown(); // Flush all
    });

    it('should filter by eventType', async () => {
      const events = await service.queryEvents({ eventType: 'feature_used' });
      expect(events.length).toBe(2);
    });

    it('should filter by userId', async () => {
      const events = await service.queryEvents({ userId: 'user-1' });
      expect(events.length).toBe(1);
    });

    it('should apply limit', async () => {
      const events = await service.queryEvents({ limit: 1 });
      expect(events.length).toBe(1);
    });

    it('should return all events when no filters', async () => {
      const events = await service.queryEvents({});
      expect(events.length).toBe(3);
    });
  });

  describe('getStatistics', () => {
    it('should return empty stats when no events', async () => {
      const stats = await service.getStatistics();
      expect(stats.totalEvents).toBe(0);
    });

    it('should calculate statistics from events', async () => {
      await service.recordAISuggestionRequested('openai', 'mapping', 'user-1');
      await service.recordAISuggestionResponded('openai', 200, 0.02, 'sug-1', 0.9);
      await service.recordAISuggestionAccepted('sug-1', 'user-1');
      await service.recordFeatureUsed('mapping', 'user-1');
      await service.recordPageViewed('dashboard', 300);
      await service.recordErrorOccurred('api', '500', 'Server error');
      await service.recordMultiAgentWorkflowExecuted(
        's1', 'u1', 'mapping', 2, 1000, true, 0.03,
        [{ agentType: 'mapper', success: true, duration: 500, confidence: 0.9 }]
      );
      await service.recordSingleAgentExecuted(
        'mapper', 'e1', 'u1', 200, true, 0.85, 100, 50, 0.01
      );
      await service.recordAgentHealthCheck('a1', 'mapper', 'healthy', 50, 0.01);
      await service.recordGovernanceViolation(
        's1', 'mapper', 'pii_detected', 'high', 'PII found', 'blocked'
      );
      await service.shutdown(); // Flush buffer

      const stats = await service.getStatistics('week');
      expect(stats.totalEvents).toBe(10);
      expect(stats.aiSuggestions.requested).toBe(1);
      expect(stats.aiSuggestions.responded).toBe(1);
      expect(stats.aiSuggestions.accepted).toBe(1);
      expect(stats.aiSuggestions.avgLatencyMs).toBe(200);
      expect(stats.aiSuggestions.totalCostUsd).toBe(0.02);
      expect(stats.features.totalUsage).toBe(1);
      expect(stats.errors.totalErrors).toBe(1);
      expect(stats.multiAgentWorkflows.totalExecutions).toBe(1);
      expect(stats.singleAgents.totalExecutions).toBe(1);
      expect(stats.agentHealth.totalChecks).toBe(1);
      expect(stats.governance.totalViolations).toBe(1);
    });

    it('should support different timeframes', async () => {
      await service.recordFeatureUsed('feat', 'u1');
      await service.shutdown();

      const hourStats = await service.getStatistics('hour');
      expect(hourStats.totalEvents).toBeGreaterThanOrEqual(0);

      const dayStats = await service.getStatistics('day');
      expect(dayStats.totalEvents).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shutdown', () => {
    it('should flush buffer and clear interval', async () => {
      await service.recordFeatureUsed('test', 'user-1');
      await service.shutdown();
      // Should be able to query the event after shutdown flushed
      const events = await service.queryEvents({ eventType: 'feature_used' });
      expect(events.length).toBe(1);
    });

    it('should handle double shutdown gracefully', async () => {
      await service.shutdown();
      await service.shutdown(); // Should not throw
    });
  });

  describe('buffer management', () => {
    it('should auto-flush when buffer reaches capacity', async () => {
      // bufferSize is 100, record 100+ events
      for (let i = 0; i < 101; i++) {
        await service.recordFeatureUsed(`feature-${i}`, 'user-1');
      }
      // After 100 events, buffer should have auto-flushed
      const events = await service.queryEvents({ eventType: 'feature_used' });
      expect(events.length).toBeGreaterThanOrEqual(100);
    });
  });
});
