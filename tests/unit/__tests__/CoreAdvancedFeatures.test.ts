import { EventBus } from '../../src/utils/EventBus';
import { DynamicConfiguration } from '../../src/utils/DynamicConfiguration';
import { AdvancedRetryManager, withRetry } from '../../src/utils/AdvancedRetryStrategies';

describe('Core Advanced Features Tests', () => {
  let eventBus: EventBus;
  let dynamicConfig: DynamicConfiguration;
  let retryManager: AdvancedRetryManager;

  beforeEach(() => {
    jest.useRealTimers();
    eventBus = EventBus.getInstance();
    dynamicConfig = DynamicConfiguration.getInstance();
    retryManager = AdvancedRetryManager.getInstance();
  });

  afterEach(async () => {
    await eventBus.shutdown();
    await dynamicConfig.shutdown();
    retryManager.reset();
  });

  describe('Event-Driven Architecture', () => {
    it('should publish and handle events successfully', async () => {
      let eventReceived = false;
      let eventData: unknown = null;

      eventBus.subscribe('test.event', {
        handle: async (event) => {
          eventReceived = true;
          eventData = event.data;
        },
      });

      await eventBus.publish('test.event', { message: 'Hello World' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(eventReceived).toBe(true);
      expect(eventData).toEqual({ message: 'Hello World' });
    });

    it('should collect event metrics', async () => {
      await eventBus.publish('test.metrics', { data: 'test' });

      const metrics = eventBus.getMetrics();
      expect(metrics.totalEventsPublished).toBeGreaterThan(0);
    });
  });

  describe('Dynamic Configuration Management', () => {
    it('should set and retrieve configuration values', () => {
      dynamicConfig.set('test.value', 'hello');
      const value = dynamicConfig.get('test.value');

      expect(value).toBe('hello');
    });

    it('should emit configuration change events', () => {
      // Test the event emission synchronously
      let changeEventEmitted = false;
      let changeData: any = null;

      dynamicConfig.on('configurationChanged', (changes) => {
        changeEventEmitted = true;
        changeData = changes;
      });

      dynamicConfig.set('test.sync.change', 'new-value');

      // Check if event was emitted
      expect(changeEventEmitted).toBe(true);
      expect(changeData).toBeTruthy();
      expect(changeData['test.sync.change']).toBe('new-value');
    });

    it('should handle hot-reloadable configuration', () => {
      // Set up schema with hot-reloadable property
      dynamicConfig.setSchema({
        'test.hotreload.sync': {
          type: 'string',
          hotReloadable: true,
          default: 'initial',
        },
      });

      let hotReloadEmitted = false;
      let hotReloadData: any = null;

      dynamicConfig.on('hotReload', (changes) => {
        hotReloadEmitted = true;
        hotReloadData = changes;
      });

      dynamicConfig.set('test.hotreload.sync', 'updated');

      // Check if hot reload event was emitted
      expect(hotReloadEmitted).toBe(true);
      expect(hotReloadData).toBeTruthy();
      expect(hotReloadData['test.hotreload.sync']).toBe('updated');
    });
  });

  describe('Advanced Retry Strategies (Basic)', () => {
    it('should retry failed operations with exponential backoff', async () => {
      let attempts = 0;

      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      }, {
        maxAttempts: 5,
        baseDelay: 10,
        maxDelay: 1000,
        backoffFactor: 2,
        jitter: false,
        strategy: 'exponential',
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should collect retry metrics', async () => {
      await withRetry(async () => {
        return 'immediate success';
      }, {
        maxAttempts: 3,
        baseDelay: 10,
        maxDelay: 100,
        backoffFactor: 2,
        jitter: false,
        strategy: 'exponential',
        name: 'test-operation',
      });

      const metrics = retryManager.getMetrics('test-operation');
      expect(metrics).toBeDefined();
      if (typeof metrics === 'object' && 'successfulOperations' in metrics) {
        expect(metrics.successfulOperations).toBe(1);
      }
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle high-frequency events', async () => {
      const eventCount = 50; // Reduced for faster test
      let processedCount = 0;

      eventBus.subscribe('performance.test', {
        handle: async () => {
          processedCount++;
        },
      });

      // Publish events rapidly
      const promises = Array(eventCount).fill(0).map(async (_, index) =>
        eventBus.publish('performance.test', { index }),
      );

      await Promise.all(promises);

      // Wait for all events to process
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processedCount).toBe(eventCount);
    });

    it('should handle configuration updates under load', async () => {
      // Update configuration rapidly
      for (let i = 0; i < 20; i++) {
        dynamicConfig.set(`load.test.${i}`, `value-${i}`);
      }

      // Verify all values are set correctly
      for (let i = 0; i < 20; i++) {
        const value = dynamicConfig.get(`load.test.${i}`);
        expect(value).toBe(`value-${i}`);
      }
    });

    it('should handle concurrent retry operations', async () => {
      const operations = Array(10).fill(0).map(async (_, index) => {
        return withRetry(async () => {
          // Simulate some work
          await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
          return `result-${index}`;
        }, {
          maxAttempts: 3,
          baseDelay: 5,
          maxDelay: 50,
          backoffFactor: 2,
          jitter: true,
          strategy: 'exponential',
          name: `concurrent-op-${index}`,
        });
      });

      const results = await Promise.all(operations);

      expect(results).toHaveLength(10);
      results.forEach((result, index) => {
        expect(result).toBe(`result-${index}`);
      });
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle system failures gracefully', async () => {
      // Simulate a system failure by forcing an error in event processing
      eventBus.subscribe('error.test', {
        handle: async () => {
          throw new Error('System failure simulation');
        },
      });

      await eventBus.publish('error.test', { test: true });

      // System should continue functioning despite the error
      await new Promise(resolve => setTimeout(resolve, 100));

      const metrics = eventBus.getMetrics();
      expect(metrics.totalEventsFailed).toBeGreaterThan(0);
    });

    it('should recover from configuration errors', () => {
      dynamicConfig.setSchema({
        'recovery.test': {
          type: 'number',
          required: true,
          validation: (value) => value > 0 || 'Value must be positive',
        },
      });

      // This should fail validation
      expect(() => {
        dynamicConfig.set('recovery.test', -1);
      }).toThrow();

      // This should succeed
      expect(() => {
        dynamicConfig.set('recovery.test', 5);
      }).not.toThrow();

      expect(dynamicConfig.get('recovery.test')).toBe(5);
    });
  });
});
