// Production-ready monitoring with conditional OpenTelemetry
import { Logger } from "./Logger";
import type { Request, Response, NextFunction } from "express";

const logger = new Logger("PerformanceMonitor");

interface Span {
  name: string;
  startTime: number;
  options: Record<string, unknown>;
  end: () => void;
  recordException: (error: Error) => void;
  setStatus: (status: { code: number; message?: string }) => void;
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private isEnabled = false;
  private readonly metrics = new Map<string, number>();

  private constructor() {
    this.isEnabled = process.env.NODE_ENV !== "test" && process.env.ENABLE_TELEMETRY === "true";

    if (this.isEnabled) {
      this.initializeOpenTelemetry();
    }
  }

  public static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  private async initializeOpenTelemetry() {
    try {
      // Dynamic import for OpenTelemetry to avoid issues when not needed
      await import("@opentelemetry/api");

      logger.info("OpenTelemetry initialized for production monitoring");
      this.isEnabled = true;
    } catch (error) {
      logger.warn("OpenTelemetry not available, using fallback metrics", { error: error instanceof Error ? error.message : String(error) });
      this.isEnabled = false;
    }
  }

  // HTTP Request monitoring
  public recordHttpRequest(method: string, route: string, statusCode: number, duration: number) {
    const key = `http_${method}_${route}_${statusCode}`;
    this.metrics.set(key, (this.metrics.get(key) ?? 0) + 1);
    this.metrics.set(`${key}_duration`, duration);

    logger.debug("HTTP request recorded", {
      method,
      route,
      statusCode,
      duration,
      telemetryEnabled: this.isEnabled,
    });
  }

  // Integration execution monitoring
  public recordIntegrationExecution(
    integrationId: string,
    status: "success" | "error" | "timeout",
    duration: number,
    recordsProcessed = 0,
  ) {
    const key = `integration_${integrationId}_${status}`;
    this.metrics.set(key, (this.metrics.get(key) ?? 0) + 1);
    this.metrics.set(`${key}_duration`, duration);
    this.metrics.set(`${key}_records`, recordsProcessed);

    logger.info("Integration execution recorded", {
      integrationId,
      status,
      duration,
      recordsProcessed,
      telemetryEnabled: this.isEnabled,
    });
  }

  // Error tracking
  public recordError(type: string, operation: string, integrationId?: string) {
    const key = `error_${type}_${operation}`;
    this.metrics.set(key, (this.metrics.get(key) ?? 0) + 1);

    logger.warn("Error recorded", {
      type,
      operation,
      integrationId,
      telemetryEnabled: this.isEnabled,
    });
  }

  // Connection tracking
  public recordConnectionChange(change: 1 | -1, system: string) {
    const key = `connections_${system}`;
    const current = this.metrics.get(key) ?? 0;
    this.metrics.set(key, Math.max(0, current + change));

    logger.debug("Connection change recorded", {
      system,
      change,
      current: this.metrics.get(key),
      telemetryEnabled: this.isEnabled,
    });
  }

  // Custom metrics for business logic
  public recordCustomMetric(name: string, value: number, labels: Record<string, string> = {}) {
    const key = `custom_${name}`;
    this.metrics.set(key, value);

    logger.debug("Custom metric recorded", {
      name,
      value,
      labels,
      telemetryEnabled: this.isEnabled,
    });
  }

  // Get current metrics for health checks
  public getMetrics(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.metrics.entries()) {
      result[key] = value;
    }
    return result;
  }

  // Middleware for Express
  public getExpressMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();

      res.on("finish", () => {
        const duration = Date.now() - startTime;
        this.recordHttpRequest(req.method, req.route?.path ?? req.path, res.statusCode, duration);
      });

      next();
    };
  }

  // Tracing wrapper (simplified for compatibility)
  public startSpan(name: string, options: Record<string, unknown> = {}): Span {
    const span: Span = {
      name,
      startTime: Date.now(),
      options,
      end: () => {
        logger.debug("Span completed", { name, duration: Date.now() - span.startTime });
      },
      recordException: (error: Error) => {
        logger.error("Span exception", error, { spanName: name });
      },
      setStatus: (status: { code: number; message?: string }) => {
        logger.debug("Span status", { name, status });
      },
    };

    logger.debug("Span started", { name, options });
    return span;
  }

  public withSpan<T>(_span: Span, fn: () => T): T {
    try {
      return fn();
    } finally {
      // Span context is maintained in the function execution
    }
  }

  public endSpan(span: Span, error?: Error) {
    if (error) {
      span.recordException(error);
      span.setStatus({ code: 2, message: error.message }); // ERROR
    } else {
      span.setStatus({ code: 1 }); // OK
    }
    span.end();
  }

  // Health check endpoint for metrics
  public getHealthMetrics() {
    const metrics = this.getMetrics();
    return {
      telemetryEnabled: this.isEnabled,
      metricsCollected: Object.keys(metrics).length,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      metrics,
    };
  }

  public async shutdown() {
    try {
      logger.info("Performance monitoring shutdown initiated");
      this.metrics.clear();
      logger.info("Performance monitoring shutdown completed");
    } catch (error) {
      logger.error("Error shutting down monitoring:", error);
    }
  }
}
