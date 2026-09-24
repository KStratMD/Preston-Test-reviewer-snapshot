/**
 * EventBus Unit Tests
 * Tests for event-driven architecture with pub/sub, retry logic, and dead-letter queue
 */

import {
  EventBus,
  EventHandler,
  DomainEvent,
  EventMetadata,
  RetryConfig,
  DeadLetterConfig,
  getEventBus,
  publishEvent,
  subscribeToEvent,
} from '../../../src/utils/EventBus';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Mock FileEventStorage
jest.mock('../../../src/utils/FileEventStorage', () => ({
  FileEventStorage: jest.fn().mockImplementation(() => ({
    loadOverflowEvents: jest.fn().mockReturnValue([]),
    loadDeadLetterEvents: jest.fn().mockReturnValue([]),
    persistOverflowEvent: jest.fn(),
    persistDeadLetterEvent: jest.fn(),
  })),
}));

// Use real timers
beforeAll(() => {
  jest.useRealTimers();
  process.env.DASHBOARD_DISABLE_INTERVALS = '1';
  process.env.NODE_ENV = 'test';
});

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    // Reset the singleton for each test by accessing private instance
    (EventBus as any).instance = undefined;
    eventBus = EventBus.getInstance({
      maxQueueSize: 100,
      maxDeadLetterQueueSize: 50,
      overflowBehavior: 'reject',
    });
  });

  afterEach(async () => {
    await eventBus.shutdown();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = EventBus.getInstance();
      const instance2 = EventBus.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create instance with custom config', () => {
      (EventBus as any).instance = undefined;
      const customBus = EventBus.getInstance({
        maxQueueSize: 500,
        maxDeadLetterQueueSize: 200,
      });

      const metrics = customBus.getMetrics();
      expect(metrics.maxQueueSize).toBe(500);
    });
  });

  describe('publish', () => {
    it('should publish an event with auto-generated metadata', async () => {
      const eventPublished = jest.fn();
      eventBus.on('eventPublished', eventPublished);

      await eventBus.publish('test.event', { message: 'hello' });

      expect(eventPublished).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'test.event',
          data: { message: 'hello' },
          metadata: expect.objectContaining({
            eventId: expect.stringMatching(/^evt_/),
            timestamp: expect.any(Date),
            source: 'unknown',
            version: '1.0.0',
            correlationId: expect.stringMatching(/^cor_/),
            retryCount: 0,
            priority: 'medium',
          }),
        }),
      );
    });

    it('should publish with custom metadata', async () => {
      const eventPublished = jest.fn();
      eventBus.on('eventPublished', eventPublished);

      await eventBus.publish('test.event', { data: 1 }, {
        source: 'test-source',
        version: '2.0.0',
        priority: 'high',
        userId: 'user-123',
        sessionId: 'session-456',
      });

      expect(eventPublished).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source: 'test-source',
            version: '2.0.0',
            priority: 'high',
            userId: 'user-123',
            sessionId: 'session-456',
          }),
        }),
      );
    });

    it('should increment metrics on publish', async () => {
      const initialMetrics = eventBus.getMetrics();
      const initialPublished = initialMetrics.totalEventsPublished;

      await eventBus.publish('metrics.test', { count: 1 });

      const newMetrics = eventBus.getMetrics();
      expect(newMetrics.totalEventsPublished).toBe(initialPublished + 1);
      expect(newMetrics.eventsByType['metrics.test']).toBe(1);
    });

    it('should reject event when queue is full with reject behavior', async () => {
      (EventBus as any).instance = undefined;
      const smallQueueBus = EventBus.getInstance({
        maxQueueSize: 2,
        overflowBehavior: 'reject',
      });

      // Subscribe a slow handler to prevent immediate processing
      smallQueueBus.subscribe('queue.test', {
        handle: async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
        },
      });

      // Fill the queue
      await smallQueueBus.publish('queue.test', { i: 0 });
      await smallQueueBus.publish('queue.test', { i: 1 });

      // Third should fail
      await expect(
        smallQueueBus.publish('queue.test', { i: 2 }),
      ).rejects.toThrow('Event queue is full');

      await smallQueueBus.shutdown();
    });

    it('should emit queue:saturation event when near capacity', async () => {
      (EventBus as any).instance = undefined;
      const smallQueueBus = EventBus.getInstance({
        maxQueueSize: 5,
        overflowBehavior: 'reject',
      });

      const saturationHandler = jest.fn();
      smallQueueBus.on('queue:saturation', saturationHandler);

      // Subscribe a slow handler
      smallQueueBus.subscribe('saturation.test', {
        handle: async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
        },
      });

      // Fill to 80% (4 of 5)
      for (let i = 0; i < 4; i++) {
        await smallQueueBus.publish('saturation.test', { i });
      }

      // Should have emitted saturation warning
      expect(saturationHandler).toHaveBeenCalled();

      await smallQueueBus.shutdown();
    });
  });

  describe('subscribe', () => {
    it('should subscribe a handler and return subscription id', () => {
      const handler: EventHandler = {
        handle: jest.fn(),
      };

      const subscriptionId = eventBus.subscribe('test.subscribe', handler);

      expect(subscriptionId).toMatch(/^sub_/);
      expect(eventBus.getMetrics().activeSubscriptions).toBeGreaterThan(0);
    });

    it('should emit handlerSubscribed event', () => {
      const subscribedHandler = jest.fn();
      eventBus.on('handlerSubscribed', subscribedHandler);

      const handler: EventHandler = {
        handle: jest.fn(),
      };

      eventBus.subscribe('test.subscribe.event', handler);

      expect(subscribedHandler).toHaveBeenCalledWith(
        'test.subscribe.event',
        expect.stringMatching(/^sub_/),
      );
    });

    it('should support custom priority', () => {
      const handler1: EventHandler = { handle: jest.fn() };
      const handler2: EventHandler = { handle: jest.fn() };

      eventBus.subscribe('priority.test', handler1, { priority: 50 });
      eventBus.subscribe('priority.test', handler2, { priority: 10 });

      const subscriptions = eventBus.getSubscriptions();
      expect(subscriptions['priority.test']).toBe(2);
    });

    it('should support custom retry config', () => {
      const handler: EventHandler = { handle: jest.fn() };
      const retryConfig: RetryConfig = {
        maxRetries: 5,
        retryDelay: 500,
        retryMultiplier: 1.5,
        maxRetryDelay: 10000,
      };

      const subscriptionId = eventBus.subscribe('retry.test', handler, { retryConfig });

      expect(subscriptionId).toBeDefined();
    });

    it('should support custom dead letter config', () => {
      const handler: EventHandler = { handle: jest.fn() };
      const deadLetterConfig: DeadLetterConfig = {
        enabled: true,
        maxRetries: 10,
        storageLocation: '/custom/path',
      };

      const subscriptionId = eventBus.subscribe('deadletter.test', handler, { deadLetterConfig });

      expect(subscriptionId).toBeDefined();
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe a handler', () => {
      const handler: EventHandler = { handle: jest.fn() };
      const subscriptionId = eventBus.subscribe('unsub.test', handler);

      const result = eventBus.unsubscribe(subscriptionId);

      expect(result).toBe(true);
    });

    it('should return false for non-existent subscription', () => {
      const result = eventBus.unsubscribe('non-existent-id');

      expect(result).toBe(false);
    });

    it('should emit handlerUnsubscribed event', () => {
      const unsubscribedHandler = jest.fn();
      eventBus.on('handlerUnsubscribed', unsubscribedHandler);

      const handler: EventHandler = { handle: jest.fn() };
      const subscriptionId = eventBus.subscribe('unsub.event.test', handler);

      eventBus.unsubscribe(subscriptionId);

      expect(unsubscribedHandler).toHaveBeenCalledWith('unsub.event.test', subscriptionId);
    });

    it('should decrement activeSubscriptions', () => {
      const handler: EventHandler = { handle: jest.fn() };
      const subscriptionId = eventBus.subscribe('metrics.unsub', handler);

      const beforeUnsub = eventBus.getMetrics().activeSubscriptions;
      eventBus.unsubscribe(subscriptionId);
      const afterUnsub = eventBus.getMetrics().activeSubscriptions;

      expect(afterUnsub).toBe(beforeUnsub - 1);
    });
  });

  describe('event processing', () => {
    it('should process events through subscribed handlers', async () => {
      const handleFn = jest.fn();
      const handler: EventHandler = { handle: handleFn };

      eventBus.subscribe('process.test', handler);
      await eventBus.publish('process.test', { value: 42 });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handleFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'process.test',
          data: { value: 42 },
        }),
      );
    });

    it('should process handlers in priority order', async () => {
      const order: number[] = [];

      const handler1: EventHandler = {
        handle: () => { order.push(1); },
        priority: 100,
      };
      const handler2: EventHandler = {
        handle: () => { order.push(2); },
        priority: 10,
      };
      const handler3: EventHandler = {
        handle: () => { order.push(3); },
        priority: 50,
      };

      eventBus.subscribe('priority.order', handler1, { priority: 100 });
      eventBus.subscribe('priority.order', handler2, { priority: 10 });
      eventBus.subscribe('priority.order', handler3, { priority: 50 });

      await eventBus.publish('priority.order', {});
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(order).toEqual([2, 3, 1]); // Lower priority number = higher priority
    });

    it('should skip handlers that cannot handle the event', async () => {
      const handleFn = jest.fn();
      const handler: EventHandler = {
        handle: handleFn,
        canHandle: (event: DomainEvent) => (event.data as any).shouldProcess === true,
      };

      eventBus.subscribe('canHandle.test', handler);

      await eventBus.publish('canHandle.test', { shouldProcess: false });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handleFn).not.toHaveBeenCalled();

      await eventBus.publish('canHandle.test', { shouldProcess: true });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handleFn).toHaveBeenCalledTimes(1);
    });

    it('should emit eventProcessed after processing', async () => {
      const processedHandler = jest.fn();
      eventBus.on('eventProcessed', processedHandler);

      const handler: EventHandler = { handle: jest.fn() };
      eventBus.subscribe('processed.event', handler);

      await eventBus.publish('processed.event', {});
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(processedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'processed.event' }),
        expect.arrayContaining([
          expect.objectContaining({ success: true }),
        ]),
      );
    });

    it('should update metrics on successful processing', async () => {
      const handler: EventHandler = { handle: jest.fn() };
      eventBus.subscribe('metrics.success', handler);

      const before = eventBus.getMetrics().totalEventsProcessed;

      await eventBus.publish('metrics.success', {});
      await new Promise(resolve => setTimeout(resolve, 100));

      const after = eventBus.getMetrics().totalEventsProcessed;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('error handling and retries', () => {
    it('should track failed events in metrics', async () => {
      const handler: EventHandler = {
        handle: () => { throw new Error('Test error'); },
      };

      eventBus.subscribe('error.test', handler, {
        retryConfig: { maxRetries: 0, retryDelay: 100, retryMultiplier: 1, maxRetryDelay: 100 },
        deadLetterConfig: { enabled: true, maxRetries: 0 },
      });

      await eventBus.publish('error.test', {});
      await new Promise(resolve => setTimeout(resolve, 200));

      const metrics = eventBus.getMetrics();
      expect(metrics.totalEventsFailed).toBeGreaterThan(0);
    });

    it('should move event to dead letter after max retries', async () => {
      const handler: EventHandler = {
        handle: () => { throw new Error('Persistent error'); },
      };

      const deadLetterHandler = jest.fn();
      eventBus.on('eventDeadLettered', deadLetterHandler);

      eventBus.subscribe('deadletter.maxretry', handler, {
        retryConfig: { maxRetries: 0, retryDelay: 10, retryMultiplier: 1, maxRetryDelay: 10 },
        deadLetterConfig: { enabled: true, maxRetries: 0 },
      });

      await eventBus.publish('deadletter.maxretry', { test: 'data' });
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(deadLetterHandler).toHaveBeenCalled();
      expect(eventBus.getDeadLetterQueue().length).toBeGreaterThan(0);
    });

    it('should not retry non-retryable errors', async () => {
      const handler: EventHandler = {
        handle: () => { throw new Error('Non-retryable'); },
      };

      const deadLetterHandler = jest.fn();
      eventBus.on('eventDeadLettered', deadLetterHandler);

      eventBus.subscribe('nonretryable.test', handler, {
        retryConfig: {
          maxRetries: 5,
          retryDelay: 10,
          retryMultiplier: 1,
          maxRetryDelay: 100,
          retryableErrors: () => false, // Never retry
        },
        deadLetterConfig: { enabled: true, maxRetries: 5 },
      });

      await eventBus.publish('nonretryable.test', {});
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should go straight to dead letter, not retry
      expect(deadLetterHandler).toHaveBeenCalled();
    });
  });

  describe('dead letter queue', () => {
    it('should return dead letter queue contents', () => {
      const deadLetterQueue = eventBus.getDeadLetterQueue();
      expect(Array.isArray(deadLetterQueue)).toBe(true);
    });

    it('should reprocess dead letter event', async () => {
      // First, add an event to dead letter queue
      const failingHandler: EventHandler = {
        handle: () => { throw new Error('Fail'); },
      };

      eventBus.subscribe('reprocess.test', failingHandler, {
        retryConfig: { maxRetries: 0, retryDelay: 10, retryMultiplier: 1, maxRetryDelay: 10 },
        deadLetterConfig: { enabled: true, maxRetries: 0 },
      });

      await eventBus.publish('reprocess.test', { reprocess: true });
      await new Promise(resolve => setTimeout(resolve, 200));

      const deadLetterQueue = eventBus.getDeadLetterQueue();
      expect(deadLetterQueue.length).toBeGreaterThan(0);

      const eventId = deadLetterQueue[0].metadata.eventId;

      // Unsubscribe failing handler and add passing one
      eventBus.unsubscribe(
        Array.from((eventBus as any).subscriptions.get('reprocess.test'))[0].id,
      );
      const successHandler: EventHandler = { handle: jest.fn() };
      eventBus.subscribe('reprocess.test', successHandler);

      // Reprocess
      const result = eventBus.reprocessDeadLetterEvent(eventId);
      expect(result).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Event should have been removed from dead letter queue
      const newDeadLetterQueue = eventBus.getDeadLetterQueue();
      const stillInQueue = newDeadLetterQueue.find(e => e.metadata.eventId === eventId);
      expect(stillInQueue).toBeUndefined();
    });

    it('should return false when reprocessing non-existent event', () => {
      const result = eventBus.reprocessDeadLetterEvent('non-existent-id');
      expect(result).toBe(false);
    });

    it('should clear dead letter queue', async () => {
      // Add event to dead letter
      const handler: EventHandler = {
        handle: () => { throw new Error('Fail'); },
      };

      eventBus.subscribe('clear.deadletter', handler, {
        retryConfig: { maxRetries: 0, retryDelay: 10, retryMultiplier: 1, maxRetryDelay: 10 },
        deadLetterConfig: { enabled: true, maxRetries: 0 },
      });

      await eventBus.publish('clear.deadletter', {});
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(eventBus.getDeadLetterQueue().length).toBeGreaterThan(0);

      const cleared = eventBus.clearDeadLetterQueue();
      expect(cleared).toBeGreaterThan(0);
      expect(eventBus.getDeadLetterQueue().length).toBe(0);
    });
  });

  describe('metrics', () => {
    it('should return complete metrics object', () => {
      const metrics = eventBus.getMetrics();

      expect(metrics).toHaveProperty('totalEventsPublished');
      expect(metrics).toHaveProperty('totalEventsProcessed');
      expect(metrics).toHaveProperty('totalEventsFailed');
      expect(metrics).toHaveProperty('totalEventsRetried');
      expect(metrics).toHaveProperty('totalEventsDeadLettered');
      expect(metrics).toHaveProperty('averageProcessingTime');
      expect(metrics).toHaveProperty('eventsByType');
      expect(metrics).toHaveProperty('errorsByType');
      expect(metrics).toHaveProperty('activeSubscriptions');
      expect(metrics).toHaveProperty('queuedEvents');
      expect(metrics).toHaveProperty('maxQueueSize');
      expect(metrics).toHaveProperty('queueSaturation');
    });

    it('should track events by type', async () => {
      await eventBus.publish('type.a', {});
      await eventBus.publish('type.a', {});
      await eventBus.publish('type.b', {});

      const metrics = eventBus.getMetrics();
      expect(metrics.eventsByType['type.a']).toBe(2);
      expect(metrics.eventsByType['type.b']).toBe(1);
    });

    it('should calculate queue saturation', async () => {
      (EventBus as any).instance = undefined;
      const smallBus = EventBus.getInstance({
        maxQueueSize: 10,
        overflowBehavior: 'reject',
      });

      // Subscribe slow handler
      smallBus.subscribe('saturation.calc', {
        handle: async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
        },
      });

      await smallBus.publish('saturation.calc', {});

      const metrics = smallBus.getMetrics();
      expect(metrics.queueSaturation).toBeGreaterThanOrEqual(0);
      expect(metrics.queueSaturation).toBeLessThanOrEqual(1);

      await smallBus.shutdown();
    });
  });

  describe('queue status', () => {
    it('should return queue status', () => {
      const status = eventBus.getQueueStatus();

      expect(status).toHaveProperty('processing');
      expect(status).toHaveProperty('waiting');
      expect(status).toHaveProperty('retrying');
      expect(status).toHaveProperty('deadLetter');
    });
  });

  describe('subscriptions', () => {
    it('should return subscriptions by event type', () => {
      eventBus.subscribe('sub.a', { handle: jest.fn() });
      eventBus.subscribe('sub.a', { handle: jest.fn() });
      eventBus.subscribe('sub.b', { handle: jest.fn() });

      const subscriptions = eventBus.getSubscriptions();

      expect(subscriptions['sub.a']).toBe(2);
      expect(subscriptions['sub.b']).toBe(1);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      eventBus.updateConfig({ maxQueueSize: 200 });

      const metrics = eventBus.getMetrics();
      expect(metrics.maxQueueSize).toBe(200);
    });
  });

  describe('processRecoveredEvents', () => {
    it('should process events in queue', async () => {
      const handler: EventHandler = { handle: jest.fn() };
      eventBus.subscribe('recovered.test', handler);

      await eventBus.publish('recovered.test', {});
      await eventBus.processRecoveredEvents();

      await new Promise(resolve => setTimeout(resolve, 100));
      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await eventBus.shutdown();

      // Listeners should be removed
      expect(eventBus.listenerCount('eventPublished')).toBe(0);
    });

    it('should clear queues in test environment', async () => {
      // Add some events
      eventBus.subscribe('shutdown.test', {
        handle: async () => {
          await new Promise(resolve => setTimeout(resolve, 1000));
        },
      });

      await eventBus.publish('shutdown.test', {});

      await eventBus.shutdown();

      const status = eventBus.getQueueStatus();
      expect(status.waiting).toBe(0);
    });
  });
});

describe('Convenience Functions', () => {
  beforeEach(() => {
    (EventBus as any).instance = undefined;
  });

  afterEach(async () => {
    const bus = getEventBus();
    await bus.shutdown();
  });

  describe('getEventBus', () => {
    it('should return EventBus instance', () => {
      const bus = getEventBus();
      expect(bus).toBeInstanceOf(EventBus);
    });

    it('should return same instance on multiple calls', () => {
      const bus1 = getEventBus();
      const bus2 = getEventBus();
      expect(bus1).toBe(bus2);
    });
  });

  describe('publishEvent', () => {
    it('should publish event using singleton', async () => {
      const bus = getEventBus();
      const eventPublished = jest.fn();
      bus.on('eventPublished', eventPublished);

      await publishEvent('convenience.publish', { data: 'test' });

      expect(eventPublished).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'convenience.publish',
          data: { data: 'test' },
        }),
      );
    });

    it('should support metadata', async () => {
      const bus = getEventBus();
      const eventPublished = jest.fn();
      bus.on('eventPublished', eventPublished);

      await publishEvent('convenience.metadata', { value: 1 }, {
        source: 'convenience-test',
        priority: 'critical',
      });

      expect(eventPublished).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source: 'convenience-test',
            priority: 'critical',
          }),
        }),
      );
    });
  });

  describe('subscribeToEvent', () => {
    it('should subscribe handler using singleton', async () => {
      const handleFn = jest.fn();
      const handler: EventHandler = { handle: handleFn };

      const subscriptionId = subscribeToEvent('convenience.subscribe', handler);

      expect(subscriptionId).toMatch(/^sub_/);

      await publishEvent('convenience.subscribe', { test: true });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handleFn).toHaveBeenCalled();
    });

    it('should support options', () => {
      const handler: EventHandler = { handle: jest.fn() };

      const subscriptionId = subscribeToEvent('convenience.options', handler, {
        priority: 5,
        retryConfig: {
          maxRetries: 10,
          retryDelay: 100,
          retryMultiplier: 2,
          maxRetryDelay: 5000,
        },
      });

      expect(subscriptionId).toBeDefined();
    });
  });
});

describe('EventMetadata', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    (EventBus as any).instance = undefined;
    eventBus = EventBus.getInstance();
  });

  afterEach(async () => {
    await eventBus.shutdown();
  });

  it('should generate unique event IDs', async () => {
    const eventIds: string[] = [];
    const handler = jest.fn();

    eventBus.on('eventPublished', (event: DomainEvent) => {
      eventIds.push(event.metadata.eventId);
    });

    await eventBus.publish('unique.id.test', {});
    await eventBus.publish('unique.id.test', {});
    await eventBus.publish('unique.id.test', {});

    expect(eventIds.length).toBe(3);
    expect(new Set(eventIds).size).toBe(3); // All unique
  });

  it('should generate unique correlation IDs', async () => {
    const correlationIds: string[] = [];

    eventBus.on('eventPublished', (event: DomainEvent) => {
      correlationIds.push(event.metadata.correlationId!);
    });

    await eventBus.publish('unique.cor.test', {});
    await eventBus.publish('unique.cor.test', {});

    expect(new Set(correlationIds).size).toBe(2);
  });

  it('should preserve causation ID chain', async () => {
    const events: DomainEvent[] = [];

    eventBus.on('eventPublished', (event: DomainEvent) => {
      events.push(event);
    });

    // First event
    await eventBus.publish('causation.test', {}, {
      correlationId: 'cor-123',
    });

    const firstEventId = events[0].metadata.eventId;

    // Second event caused by first
    await eventBus.publish('causation.test.2', {}, {
      correlationId: 'cor-123',
      causationId: firstEventId,
    });

    expect(events[1].metadata.causationId).toBe(firstEventId);
    expect(events[1].metadata.correlationId).toBe('cor-123');
  });
});

describe('Handler Priority Execution', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    (EventBus as any).instance = undefined;
    eventBus = EventBus.getInstance();
  });

  afterEach(async () => {
    await eventBus.shutdown();
  });

  it('should execute handlers in ascending priority order', async () => {
    const executionOrder: string[] = [];

    eventBus.subscribe('priority.exec', {
      handle: () => { executionOrder.push('low'); },
    }, { priority: 1000 });

    eventBus.subscribe('priority.exec', {
      handle: () => { executionOrder.push('high'); },
    }, { priority: 1 });

    eventBus.subscribe('priority.exec', {
      handle: () => { executionOrder.push('medium'); },
    }, { priority: 100 });

    await eventBus.publish('priority.exec', {});
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executionOrder).toEqual(['high', 'medium', 'low']);
  });

  it('should handle handlers with same priority', async () => {
    const executed = new Set<string>();

    eventBus.subscribe('same.priority', {
      handle: () => { executed.add('a'); },
    }, { priority: 50 });

    eventBus.subscribe('same.priority', {
      handle: () => { executed.add('b'); },
    }, { priority: 50 });

    await eventBus.publish('same.priority', {});
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(executed.size).toBe(2);
    expect(executed.has('a')).toBe(true);
    expect(executed.has('b')).toBe(true);
  });
});
