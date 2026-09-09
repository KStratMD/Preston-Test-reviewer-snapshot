import { logger } from "./Logger";

/**
 * Error monitoring and alerting
 */
export class ErrorMonitor {
  private static readonly errorCounts = new Map<string, number>();
  private static readonly alertThresholds = {
    errorRate: 10, // errors per minute
    criticalErrors: 3, // critical errors per hour
  };

  /**
   * Track error occurrence for monitoring
   */
  static trackError(errorCode: string, severity: "low" | "medium" | "high" | "critical") {
    const key = `${errorCode}_${severity}`;
    const current = ErrorMonitor.errorCounts.get(key) || 0;
    ErrorMonitor.errorCounts.set(key, current + 1);

    // Check if we need to send alerts
    ErrorMonitor.checkAlertThresholds(errorCode, severity, current + 1);
  }

  /**
   * Check if error rates exceed thresholds
   */
  private static checkAlertThresholds(errorCode: string, severity: string, count: number) {
    if (severity === "critical" && count >= ErrorMonitor.alertThresholds.criticalErrors) {
      logger.error("Critical error threshold exceeded", {
        errorCode,
        severity,
        count,
        threshold: ErrorMonitor.alertThresholds.criticalErrors,
        type: "alert",
      });
      // Here you would integrate with alerting system (PagerDuty, Slack, etc.)
    }
  }

  /**
   * Reset error counts (call this periodically)
   */
  static resetCounts() {
    ErrorMonitor.errorCounts.clear();
  }
}

// Set up periodic reset of error counts
let errorResetInterval: NodeJS.Timeout | undefined;

export function startErrorMonitoring() {
  if (!errorResetInterval) {
    errorResetInterval = setInterval(() => {
      ErrorMonitor.resetCounts();
    }, 60 * 60 * 1000); // Reset every hour
  }
}

export function stopErrorMonitoring() {
  if (errorResetInterval) {
    clearInterval(errorResetInterval);
    errorResetInterval = undefined;
  }
}

// Only start in real production runtime, not during tests or when intervals are disabled
if (process.env.NODE_ENV === "production" && process.env.DASHBOARD_DISABLE_INTERVALS !== "1") {
  startErrorMonitoring();
}
