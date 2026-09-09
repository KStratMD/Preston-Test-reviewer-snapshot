import { EventEmitter } from "events";
import path from "path";
import { Logger } from "./Logger";
import { FileEventStorage } from "./FileEventStorage";

const logger = new Logger("EventBus");

export interface EventMetadata {
  eventId: string;
  timestamp: Date;
  source: string;
  version: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  sessionId?: string;
  retryCount?: number;
  priority?: "low" | "medium" | "high" | "critical";
}

export interface DomainEvent<T = unknown> {
  type: string;
  data: T;
  metadata: EventMetadata;
}

export interface EventHandler<T = unknown> {
  handle(event: DomainEvent<T>): Promise<void> | void;
  canHandle?(event: DomainEvent): boolean;
  priority?: number; // Lower numbers = higher priority
}

export interface EventSubscription {
  id: string;
  eventType: string;
  handler: EventHandler;
  priority: number;
  retryConfig?: RetryConfig;
  deadLetterConfig?: DeadLetterConfig;
}

export interface RetryConfig {
  maxRetries: number;
  retryDelay: number; // in milliseconds
  retryMultiplier: number;
  maxRetryDelay: number;
  retryableErrors?: (error: Error) => boolean;
}

export interface DeadLetterConfig {
  enabled: boolean;
  maxRetries: number;
  storageLocation?: string;
}

export interface EventBusMetrics {
  totalEventsPublished: number;
  totalEventsProcessed: number;
  totalEventsFailed: number;
  totalEventsRetried: number;
  totalEventsDeadLettered: number;
  averageProcessingTime: number;
  eventsByType: Record<string, number>;
  errorsByType: Record<string, number>;
  activeSubscriptions: number;
  queuedEvents: number;
  maxQueueSize: number;
  queueSaturation: number; // 0-1 representing queue fill percentage
}

export interface EventProcessingResult {
  success: boolean;
  handlerId: string;
  eventId: string;
  processingTime: number;
  error?: Error;
  retryCount: number;
}

export interface EventBusConfig {
  maxQueueSize: number;
  maxDeadLetterQueueSize: number;
  storageDir: string;
  overflowBehavior: "persist" | "reject";
}

const DEFAULT_EVENT_BUS_CONFIG: EventBusConfig = {
  maxQueueSize: 1000,
  maxDeadLetterQueueSize: 1000,
  storageDir: path.join(process.cwd(), "logs", "event-bus"),
  overflowBehavior: "persist",
};

export class EventBus extends EventEmitter {
  private static instance: EventBus;
  private readonly subscriptions = new Map<string, EventSubscription[]>();
  private readonly eventQueue: DomainEvent[] = [];
  private processing = false;
  private readonly metrics: EventBusMetrics;
  private deadLetterQueue: DomainEvent[] = [];
  private readonly retryQueue = new Map<string, { event: DomainEvent; attempts: number; nextRetry: number }>();
  private retryProcessorInterval?: NodeJS.Timeout;
  private readonly config: EventBusConfig;
  private readonly storage: FileEventStorage;
  private readonly saturationWarningThreshold = 0.8;

  private constructor(config: Partial<EventBusConfig> = {}) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(50);
    this.config = { ...DEFAULT_EVENT_BUS_CONFIG, ...config };
    this.storage = new FileEventStorage(this.config.storageDir);
    this.metrics = {
      totalEventsPublished: 0,
      totalEventsProcessed: 0,
      totalEventsFailed: 0,
      totalEventsRetried: 0,
      totalEventsDeadLettered: 0,
      averageProcessingTime: 0,
      eventsByType: {},
      errorsByType: {},
      activeSubscriptions: 0,
      queuedEvents: 0,
      maxQueueSize: this.config.maxQueueSize,
      queueSaturation: 0,
    };

    // Recover persisted events
    const recovered = this.storage.loadOverflowEvents();
    if (recovered.length > 0) {
      this.eventQueue.push(...recovered);
      this.updateQueueMetrics();
      logger.info("Recovered events from storage", { count: recovered.length });
    }

    const deadLetters = this.storage.loadDeadLetterEvents();
    if (deadLetters.length > 0) {
      this.deadLetterQueue.push(...deadLetters);
      while (this.deadLetterQueue.length > this.config.maxDeadLetterQueueSize) {
        this.deadLetterQueue.shift();
      }
      logger.info("Recovered dead-letter events from storage", { count: deadLetters.length });
    }

    this.startRetryProcessor();
  }

  private updateQueueMetrics(): void {
    this.metrics.queuedEvents = this.eventQueue.length;
    this.metrics.maxQueueSize = this.config.maxQueueSize;
    this.metrics.queueSaturation = this.config.maxQueueSize > 0
      ? Math.min(1, this.metrics.queuedEvents / this.config.maxQueueSize)
      : 0;
  }

  public static getInstance(config?: Partial<EventBusConfig>): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus(config);
    }
    return EventBus.instance;
  }

  public updateConfig(config: Partial<EventBusConfig>): void {
    Object.assign(this.config, config);
    this.updateQueueMetrics();
  }

  public async publish<T>(eventType: string, data: T, metadata: Partial<EventMetadata> = {}): Promise<void> {
    const event: DomainEvent<T> = {
      type: eventType,
      data,
      metadata: {
        eventId: this.generateEventId(),
        timestamp: new Date(),
        source: metadata.source || "unknown",
        version: metadata.version || "1.0.0",
        correlationId: metadata.correlationId || this.generateCorrelationId(),
        causationId: metadata.causationId,
        userId: metadata.userId,
        sessionId: metadata.sessionId,
        retryCount: metadata.retryCount || 0,
        priority: metadata.priority || "medium",
      },
    };

    this.metrics.totalEventsPublished++;
    this.metrics.eventsByType[eventType] = (this.metrics.eventsByType[eventType] || 0) + 1;

    if (this.eventQueue.length >= this.config.maxQueueSize) {
      this.updateQueueMetrics();
      this.emit("queue:saturation", {
        queueSize: this.eventQueue.length,
        maxQueueSize: this.config.maxQueueSize,
        saturation: this.metrics.queueSaturation,
      });

      if (this.config.overflowBehavior === "persist") {
        try {
          this.storage.persistOverflowEvent(event);
          logger.warn("Event queue full, persisting event", {
            eventType,
            eventId: event.metadata.eventId,
            queueSize: this.eventQueue.length,
          });
        } catch (err) {
          logger.error("Failed to persist event when queue full", {
            eventType,
            eventId: event.metadata.eventId,
            error: (err as Error).message,
          });
          throw err;
        }
        return;
      }

      logger.error("Event queue full, rejecting event", {
        eventType,
        eventId: event.metadata.eventId,
        queueSize: this.eventQueue.length,
      });
      throw new Error("Event queue is full");
    }

    this.eventQueue.push(event);
    this.updateQueueMetrics();

    if (this.metrics.queueSaturation >= this.saturationWarningThreshold) {
      this.emit("queue:saturation", {
        queueSize: this.eventQueue.length,
        maxQueueSize: this.config.maxQueueSize,
        saturation: this.metrics.queueSaturation,
      });
    }

    logger.info("Event published", {
      eventType,
      eventId: event.metadata.eventId,
      correlationId: event.metadata.correlationId,
      queueSize: this.eventQueue.length,
    });

    this.emit("eventPublished", event);

    // Process immediately if not already processing
    if (!this.processing) {
      setImmediate(async () => this.processQueue());
    }
  }

  public subscribe<T>(
    eventType: string,
    handler: EventHandler<T>,
    options: {
      priority?: number;
      retryConfig?: RetryConfig;
      deadLetterConfig?: DeadLetterConfig;
    } = {},
  ): string {
    const subscription: EventSubscription = {
      id: this.generateSubscriptionId(),
      eventType,
      handler: handler as EventHandler,
      priority: options.priority || 100,
      retryConfig: options.retryConfig || this.getDefaultRetryConfig(),
      deadLetterConfig: options.deadLetterConfig || this.getDefaultDeadLetterConfig(),
    };

    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, []);
    }

    const handlers = this.subscriptions.get(eventType)!;
    handlers.push(subscription);

    // Sort by priority (lower numbers = higher priority)
    handlers.sort((a, b) => a.priority - b.priority);

    this.metrics.activeSubscriptions++;

    logger.info("Event handler subscribed", {
      eventType,
      subscriptionId: subscription.id,
      priority: subscription.priority,
      totalSubscriptions: this.metrics.activeSubscriptions,
    });

    this.emit("handlerSubscribed", eventType, subscription.id);

    return subscription.id;
  }

  public unsubscribe(subscriptionId: string): boolean {
    for (const [eventType, handlers] of this.subscriptions.entries()) {
      const index = handlers.findIndex(h => h.id === subscriptionId);
      if (index !== -1) {
        handlers.splice(index, 1);
        this.metrics.activeSubscriptions--;

        if (handlers.length === 0) {
          this.subscriptions.delete(eventType);
        }

        logger.info("Event handler unsubscribed", {
          eventType,
          subscriptionId,
          remainingHandlers: handlers.length,
        });

        this.emit("handlerUnsubscribed", eventType, subscriptionId);
        return true;
      }
    }

    return false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.eventQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        this.updateQueueMetrics();

        await this.processEvent(event);
      }
    } catch (error) {
      logger.error("Error processing event queue", { error });
    } finally {
      this.processing = false;
    }
  }

  private async processEvent(event: DomainEvent): Promise<void> {
    const handlers = this.subscriptions.get(event.type) || [];

    if (handlers.length === 0) {
      logger.warn("No handlers found for event", {
        eventType: event.type,
        eventId: event.metadata.eventId,
      });
      return;
    }

    const results: EventProcessingResult[] = [];

    for (const subscription of handlers) {
      // Check if handler can handle this specific event
      if (subscription.handler.canHandle && !subscription.handler.canHandle(event)) {
        continue;
      }

      const startTime = Date.now();

      try {
        await subscription.handler.handle(event);

        const processingTime = Date.now() - startTime;

        const result: EventProcessingResult = {
          success: true,
          handlerId: subscription.id,
          eventId: event.metadata.eventId,
          processingTime,
          retryCount: event.metadata.retryCount || 0,
        };

        results.push(result);
        this.updateMetrics(result, event.type);

        logger.debug("Event processed successfully", {
          eventType: event.type,
          eventId: event.metadata.eventId,
          handlerId: subscription.id,
          processingTime,
        });

      } catch (error) {
        const processingTime = Date.now() - startTime;

        const result: EventProcessingResult = {
          success: false,
          handlerId: subscription.id,
          eventId: event.metadata.eventId,
          processingTime,
          error: error as Error,
          retryCount: event.metadata.retryCount || 0,
        };

        results.push(result);
        this.updateMetrics(result, event.type);

        logger.error("Event processing failed", {
          eventType: event.type,
          eventId: event.metadata.eventId,
          handlerId: subscription.id,
          error: (error as Error).message,
          processingTime,
        });

        // Handle retry logic
        await this.handleEventFailure(event, subscription, error as Error);
      }
    }

    this.emit("eventProcessed", event, results);
  }

  private async handleEventFailure(
    event: DomainEvent,
    subscription: EventSubscription,
    error: Error,
  ): Promise<void> {
    const retryConfig = subscription.retryConfig!;
    const retryCount = event.metadata.retryCount || 0;

    // Check if error is retryable
    if (retryConfig.retryableErrors && !retryConfig.retryableErrors(error)) {
      logger.info("Error not retryable, moving to dead letter queue", {
        eventId: event.metadata.eventId,
        error: error.message,
      });
      await this.moveToDeadLetter(event, subscription, error);
      return;
    }

    // Check if we've exceeded max retries
    if (retryCount >= retryConfig.maxRetries) {
      logger.warn("Max retries exceeded, moving to dead letter queue", {
        eventId: event.metadata.eventId,
        retryCount,
        maxRetries: retryConfig.maxRetries,
      });
      await this.moveToDeadLetter(event, subscription, error);
      return;
    }

    // Schedule retry
    const delay = Math.min(
      retryConfig.retryDelay * Math.pow(retryConfig.retryMultiplier, retryCount),
      retryConfig.maxRetryDelay,
    );

    const retryEvent = {
      ...event,
      metadata: {
        ...event.metadata,
        retryCount: retryCount + 1,
      },
    };

    this.scheduleRetry(retryEvent, delay);
    this.metrics.totalEventsRetried++;

    logger.info("Event scheduled for retry", {
      eventId: event.metadata.eventId,
      retryCount: retryCount + 1,
      delay,
      nextRetry: new Date(Date.now() + delay).toISOString(),
    });
  }

  private scheduleRetry(event: DomainEvent, delay: number): void {
    const retryKey = `${event.metadata.eventId}-${event.metadata.retryCount}`;

    this.retryQueue.set(retryKey, {
      event,
      attempts: event.metadata.retryCount || 0,
      nextRetry: Date.now() + delay,
    });
  }

  private async moveToDeadLetter(
    event: DomainEvent,
    subscription: EventSubscription,
    error: Error,
  ): Promise<void> {
    const deadLetterConfig = subscription.deadLetterConfig!;

    if (!deadLetterConfig.enabled) {
      logger.error("Event failed and dead letter queue disabled", {
        eventId: event.metadata.eventId,
        error: error.message,
      });
      return;
    }
    const deadEvent: DomainEvent = {
      ...event,
      metadata: {
        ...event.metadata,
        lastError: error.message,
        failedAt: new Date(),
        subscriptionId: subscription.id,
      } as any,
    };

    try {
      this.storage.persistDeadLetterEvent(deadEvent);
    } catch (err) {
      logger.error("Failed to persist dead-letter event", {
        eventId: event.metadata.eventId,
        error: (err as Error).message,
      });
    }

    this.deadLetterQueue.push(deadEvent);
    if (this.deadLetterQueue.length > this.config.maxDeadLetterQueueSize) {
      this.deadLetterQueue.shift();
    }

    this.metrics.totalEventsDeadLettered++;

    logger.error("Event moved to dead letter queue", {
      eventId: event.metadata.eventId,
      eventType: event.type,
      error: error.message,
      deadLetterQueueSize: this.deadLetterQueue.length,
    });

    this.emit("eventDeadLettered", event, error);
  }

  private startRetryProcessor(): void {
    if (process.env.DASHBOARD_DISABLE_INTERVALS === "1") return;
    this.retryProcessorInterval = setInterval(() => {
      this.processRetries();
    }, 1000); // Check every second
  }

  private async processRetries(): Promise<void> {
    const now = Date.now();
    const readyRetries: string[] = [];

    for (const [key, retry] of this.retryQueue.entries()) {
      if (retry.nextRetry <= now) {
        readyRetries.push(key);
      }
    }

    for (const key of readyRetries) {
      const retry = this.retryQueue.get(key);
      if (retry) {
        this.retryQueue.delete(key);
        this.eventQueue.push(retry.event);
        this.updateQueueMetrics();

        logger.debug("Event moved from retry queue to processing queue", {
          eventId: retry.event.metadata.eventId,
          retryCount: retry.attempts,
        });
      }
    }

    if (readyRetries.length > 0 && !this.processing) {
      setImmediate(async () => this.processQueue());
    }
  }

  private updateMetrics(result: EventProcessingResult, _eventType: string): void {
    if (result.success) {
      this.metrics.totalEventsProcessed++;
    } else {
      this.metrics.totalEventsFailed++;
      const errorType = result.error?.constructor.name || "UnknownError";
      this.metrics.errorsByType[errorType] = (this.metrics.errorsByType[errorType] || 0) + 1;
    }

    // Update average processing time
    const totalProcessed = this.metrics.totalEventsProcessed + this.metrics.totalEventsFailed;
    this.metrics.averageProcessingTime =
      (this.metrics.averageProcessingTime * (totalProcessed - 1) + result.processingTime) / totalProcessed;
  }

  private getDefaultRetryConfig(): RetryConfig {
    return {
      maxRetries: 3,
      retryDelay: 1000,
      retryMultiplier: 2,
      maxRetryDelay: 30000,
    };
  }

  private getDefaultDeadLetterConfig(): DeadLetterConfig {
    return {
      enabled: true,
      maxRetries: 3,
    };
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private generateSubscriptionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  private generateCorrelationId(): string {
    return `cor_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  // Public API methods
  public getMetrics(): EventBusMetrics {
    return { ...this.metrics };
  }

  public getQueueStatus(): {
    processing: number;
    waiting: number;
    retrying: number;
    deadLetter: number;
    } {
    return {
      processing: this.processing ? 1 : 0,
      waiting: this.eventQueue.length,
      retrying: this.retryQueue.size,
      deadLetter: this.deadLetterQueue.length,
    };
  }

  public getSubscriptions(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [eventType, handlers] of this.subscriptions.entries()) {
      result[eventType] = handlers.length;
    }
    return result;
  }

  public getDeadLetterQueue(): DomainEvent[] {
    return [...this.deadLetterQueue];
  }

  public async processRecoveredEvents(): Promise<void> {
    if (!this.processing && this.eventQueue.length > 0) {
      await this.processQueue();
    }
  }

  public reprocessDeadLetterEvent(eventId: string): boolean {
    const index = this.deadLetterQueue.findIndex(e => e.metadata.eventId === eventId);
    if (index !== -1) {
      const event = this.deadLetterQueue.splice(index, 1)[0];
      if (event) {
        // Reset retry count
        event.metadata.retryCount = 0;
        this.eventQueue.push(event);
        this.updateQueueMetrics();

        logger.info("Dead letter event reprocessed", { eventId });

        if (!this.processing) {
          setImmediate(async () => this.processQueue());
        }

        return true;
      }
    }
    return false;
  }

  public clearDeadLetterQueue(): number {
    const count = this.deadLetterQueue.length;
    this.deadLetterQueue = [];
    logger.info("Dead letter queue cleared", { eventsCleared: count });
    return count;
  }

  public async shutdown(): Promise<void> {
    logger.info("Event bus shutdown initiated");

    // Clear retry processor interval to prevent memory leaks
    if (this.retryProcessorInterval) {
      clearInterval(this.retryProcessorInterval);
      this.retryProcessorInterval = undefined;
    }

    // Clear all event listeners to prevent memory leaks
    this.removeAllListeners();

    // Process remaining events (with timeout for tests)
    const maxProcessingTime = process.env.NODE_ENV === "test" ? 1000 : 10000;
    const startTime = Date.now();

    while (this.eventQueue.length > 0 && !this.processing && (Date.now() - startTime < maxProcessingTime)) {
      await this.processQueue();
    }

    // Wait for current processing to complete (with timeout)
    while (this.processing && (Date.now() - startTime < maxProcessingTime)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Force clear queues in test environment
    if (process.env.NODE_ENV === "test") {
      this.eventQueue.length = 0;
      this.deadLetterQueue.length = 0;
      this.retryQueue.clear();
    }

    logger.info("Event bus shutdown completed", {
      finalMetrics: this.getMetrics(),
      queueStatus: this.getQueueStatus(),
    });
  }
}

// Convenience functions
export function getEventBus(): EventBus {
  return EventBus.getInstance();
}

export async function publishEvent<T>(
  eventType: string,
  data: T,
  metadata?: Partial<EventMetadata>,
): Promise<void> {
  return getEventBus().publish(eventType, data, metadata);
}

export function subscribeToEvent<T>(
  eventType: string,
  handler: EventHandler<T>,
  options?: {
    priority?: number;
    retryConfig?: RetryConfig;
    deadLetterConfig?: DeadLetterConfig;
  },
): string {
  return getEventBus().subscribe(eventType, handler, options);
}

// Event handler decorator
export function eventHandler(eventType: string, options?: { priority?: number }) {
  return function (target: unknown, _propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    // Auto-subscribe when class is instantiated
    const originalConstructor = (target as any).constructor;
    if (!originalConstructor._eventHandlersRegistered) {
      const originalInit = originalConstructor.prototype.init || (() => {});

      originalConstructor.prototype.init = function() {
        const handler: EventHandler = {
          handle: (event: DomainEvent) => method.call(this, event),
          priority: options?.priority || 100,
        };

        subscribeToEvent(eventType, handler, { priority: options?.priority });

        return originalInit.call(this);
      };

      originalConstructor._eventHandlersRegistered = true;
    }

    return descriptor;
  };
}
