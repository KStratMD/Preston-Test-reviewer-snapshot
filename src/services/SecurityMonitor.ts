import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { EventEmitter } from 'events';

export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  resource?: string;
  action?: string;
  details: Record<string, unknown>;
  timestamp: Date;
  resolved?: boolean;
  resolvedAt?: Date;
  resolvedBy?: string;
}

export type SecurityEventType =
  | 'authentication_failure'
  | 'authorization_failure'
  | 'rate_limit_exceeded'
  | 'suspicious_activity'
  | 'data_breach_attempt'
  | 'malicious_payload'
  | 'unusual_access_pattern'
  | 'privilege_escalation'
  | 'account_lockout'
  | 'password_attack'
  | 'api_abuse'
  | 'configuration_change'
  | 'security_bypass_attempt'
  | 'injection_attempt'
  | 'xss_attempt';

export interface SecurityAlert {
  id: string;
  eventIds: string[];
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  threshold: number;
  count: number;
  timeWindow: number; // minutes
  firstOccurrence: Date;
  lastOccurrence: Date;
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

export interface SecurityMetrics {
  totalEvents: number;
  eventsBySeverity: Record<string, number>;
  eventsByType: Record<SecurityEventType, number>;
  topAttackers: { ip: string; count: number }[];
  topTargets: { resource: string; count: number }[];
  alertsActive: number;
  alertsResolved: number;
  averageResponseTime: number;
}

/**
 * Security monitoring and alerting service
 */
@injectable()
export class SecurityMonitor extends EventEmitter {
  private readonly logger: Logger;
  private readonly events = new Map<string, SecurityEvent>();
  private readonly alerts = new Map<string, SecurityAlert>();
  private readonly alertRules = new Map<SecurityEventType, { threshold: number; timeWindow: number; severity: SecurityAlert['severity'] }>();
  private readonly suspiciousIPs = new Set<string>();
  private readonly rateLimitCounters = new Map<string, { count: number; resetTime: number }>();

  constructor(@inject(TYPES.Logger) logger: Logger) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(20);
    this.logger = logger;
    this.initializeAlertRules();
    this.startPeriodicCleanup();
  }

  /**
   * Initialize default alert rules
   */
  private initializeAlertRules(): void {
    const rules = [
      { type: 'authentication_failure' as SecurityEventType, threshold: 5, timeWindow: 15, severity: 'medium' as const },
      { type: 'authorization_failure' as SecurityEventType, threshold: 10, timeWindow: 10, severity: 'medium' as const },
      { type: 'rate_limit_exceeded' as SecurityEventType, threshold: 3, timeWindow: 5, severity: 'high' as const },
      { type: 'suspicious_activity' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'high' as const },
      { type: 'data_breach_attempt' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'critical' as const },
      { type: 'malicious_payload' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'critical' as const },
      { type: 'privilege_escalation' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'critical' as const },
      { type: 'password_attack' as SecurityEventType, threshold: 3, timeWindow: 10, severity: 'high' as const },
      { type: 'api_abuse' as SecurityEventType, threshold: 100, timeWindow: 5, severity: 'medium' as const },
      { type: 'injection_attempt' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'critical' as const },
      { type: 'xss_attempt' as SecurityEventType, threshold: 1, timeWindow: 60, severity: 'high' as const },
    ];

    rules.forEach(rule => {
      this.alertRules.set(rule.type, {
        threshold: rule.threshold,
        timeWindow: rule.timeWindow,
        severity: rule.severity,
      });
    });

    this.logger.info('Security alert rules initialized', {
      ruleCount: rules.length,
    });
  }

  /**
   * Record a security event
   */
  recordEvent(eventData: Omit<SecurityEvent, 'id' | 'timestamp'>): SecurityEvent {
    const event: SecurityEvent = {
      ...eventData,
      id: this.generateEventId(),
      timestamp: new Date(),
    };

    this.events.set(event.id, event);

    // Log the event
    const logMethod = this.getLogMethod(event.severity);
    logMethod.call(this.logger, `Security event: ${event.type}`, {
      eventId: event.id,
      type: event.type,
      severity: event.severity,
      source: event.source,
      userId: event.userId,
      ip: event.ip,
      resource: event.resource,
      action: event.action,
      details: event.details,
    });

    // Check for suspicious patterns
    this.analyzeEvent(event);

    // Check alert thresholds
    this.checkAlertThresholds(event);

    // Emit event for real-time processing
    this.emit('securityEvent', event);

    // Auto-quarantine suspicious IPs
    if (event.severity === 'critical' && event.ip) {
      this.quarantineIP(event.ip, `Critical security event: ${event.type}`);
    }

    return event;
  }

  /**
   * Analyze event for suspicious patterns
   */
  private analyzeEvent(event: SecurityEvent): void {
    // Detect unusual access patterns
    if (event.ip && event.type === 'authentication_failure') {
      this.trackFailedLogin(event.ip);
    }

    // Detect rapid successive requests (potential bot)
    if (event.ip) {
      this.trackRequestRate(event.ip);
    }

    // Detect privilege escalation attempts
    if (event.type === 'authorization_failure' && event.action?.includes('admin')) {
      this.recordEvent({
        type: 'privilege_escalation',
        severity: 'critical',
        source: 'SecurityMonitor',
        userId: event.userId,
        ip: event.ip,
        userAgent: event.userAgent,
        resource: event.resource,
        action: event.action,
        details: {
          originalEvent: event.id,
          reason: 'Attempted admin action with insufficient privileges',
        },
      });
    }
  }

  /**
   * Track failed login attempts from IP
   */
  private trackFailedLogin(ip: string): void {
    const key = `failed_login:${ip}`;
    const now = Date.now();
    const window = 15 * 60 * 1000; // 15 minutes

    let counter = this.rateLimitCounters.get(key);
    if (!counter || now > counter.resetTime) {
      counter = { count: 0, resetTime: now + window };
    }

    counter.count++;
    this.rateLimitCounters.set(key, counter);

    // If too many failures, mark IP as suspicious
    if (counter.count >= 10) {
      this.quarantineIP(ip, `Excessive failed login attempts: ${counter.count}`);
    }
  }

  /**
   * Track request rate from IP
   */
  private trackRequestRate(ip: string): void {
    const key = `request_rate:${ip}`;
    const now = Date.now();
    const window = 60 * 1000; // 1 minute

    let counter = this.rateLimitCounters.get(key);
    if (!counter || now > counter.resetTime) {
      counter = { count: 0, resetTime: now + window };
    }

    counter.count++;
    this.rateLimitCounters.set(key, counter);

    // If too many requests, record suspicious activity
    if (counter.count >= 500) {
      this.recordEvent({
        type: 'suspicious_activity',
        severity: 'high',
        source: 'SecurityMonitor',
        ip,
        details: {
          reason: `Excessive request rate: ${counter.count} requests/minute`,
          threshold: 500,
        },
      });
    }
  }

  /**
   * Quarantine suspicious IP
   */
  private quarantineIP(ip: string, reason: string): void {
    this.suspiciousIPs.add(ip);

    this.logger.error('IP quarantined', {
      ip,
      reason,
      timestamp: new Date().toISOString(),
    });

    this.emit('ipQuarantined', { ip, reason, timestamp: new Date() });
  }

  /**
   * Check if IP is quarantined
   */
  isIPQuarantined(ip: string): boolean {
    return this.suspiciousIPs.has(ip);
  }

  /**
   * Remove IP from quarantine
   */
  releaseIP(ip: string, releasedBy: string): void {
    if (this.suspiciousIPs.delete(ip)) {
      this.logger.info('IP released from quarantine', {
        ip,
        releasedBy,
        timestamp: new Date().toISOString(),
      });

      this.emit('ipReleased', { ip, releasedBy, timestamp: new Date() });
    }
  }

  /**
   * Check alert thresholds and create alerts
   */
  private checkAlertThresholds(event: SecurityEvent): void {
    const rule = this.alertRules.get(event.type);
    if (!rule) return;

    const timeWindowMs = rule.timeWindow * 60 * 1000;
    const cutoffTime = new Date(Date.now() - timeWindowMs);

    // Count recent events of the same type
    const recentEvents = Array.from(this.events.values()).filter(e =>
      e.type === event.type &&
      e.timestamp >= cutoffTime,
    );

    if (recentEvents.length >= rule.threshold) {
      this.createAlert(event.type, recentEvents, rule);
    }
  }

  /**
   * Create a security alert
   */
  private createAlert(
    eventType: SecurityEventType,
    events: SecurityEvent[],
    rule: { threshold: number; timeWindow: number; severity: SecurityAlert['severity'] },
  ): void {
    const alertId = `${eventType}_${Date.now()}`;
    const eventIds = events.map(e => e.id);

    const alert: SecurityAlert = {
      id: alertId,
      eventIds,
      title: `${eventType.replace(/_/g, ' ').toUpperCase()} Alert`,
      description: `${events.length} occurrences of ${eventType} detected in ${rule.timeWindow} minutes`,
      severity: rule.severity,
      threshold: rule.threshold,
      count: events.length,
      timeWindow: rule.timeWindow,
      firstOccurrence: new Date(events[0]?.timestamp || Date.now()),
      lastOccurrence: new Date(events[events.length - 1]?.timestamp || Date.now()),
    };

    this.alerts.set(alertId, alert);

    this.logger.error('Security alert created', {
      alertId,
      eventType,
      severity: alert.severity,
      count: events.length,
      threshold: rule.threshold,
      timeWindow: rule.timeWindow,
    });

    this.emit('securityAlert', alert);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, acknowledgedBy: string): boolean {
    const alert = this.alerts.get(alertId);
    if (!alert) return false;

    alert.acknowledged = true;
    alert.acknowledgedBy = acknowledgedBy;
    alert.acknowledgedAt = new Date();

    this.logger.info('Security alert acknowledged', {
      alertId,
      acknowledgedBy,
      acknowledgedAt: alert.acknowledgedAt,
    });

    this.emit('alertAcknowledged', alert);
    return true;
  }

  /**
   * Resolve a security event
   */
  resolveEvent(eventId: string, resolvedBy: string): boolean {
    const event = this.events.get(eventId);
    if (!event) return false;

    event.resolved = true;
    event.resolvedBy = resolvedBy;
    event.resolvedAt = new Date();

    this.logger.info('Security event resolved', {
      eventId,
      eventType: event.type,
      resolvedBy,
      resolvedAt: event.resolvedAt,
    });

    this.emit('eventResolved', event);
    return true;
  }

  /**
   * Get security metrics
   */
  getSecurityMetrics(timeRange?: { start: Date; end: Date }): SecurityMetrics {
    let events = Array.from(this.events.values());

    if (timeRange) {
      events = events.filter(e =>
        e.timestamp >= timeRange.start && e.timestamp <= timeRange.end,
      );
    }

    const eventsBySeverity = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.severity] = (acc[event.severity] || 0) + 1;
      return acc;
    }, {});

    const eventsByType = events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<SecurityEventType, number>);

    // Top attackers by IP
    const ipCounts = events
      .filter(e => e.ip)
      .reduce<Record<string, number>>((acc, event) => {
        acc[event.ip!] = (acc[event.ip!] || 0) + 1;
        return acc;
      }, {});

    const topAttackers = Object.entries(ipCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, count }));

    // Top targets by resource
    const resourceCounts = events
      .filter(e => e.resource)
      .reduce<Record<string, number>>((acc, event) => {
        acc[event.resource!] = (acc[event.resource!] || 0) + 1;
        return acc;
      }, {});

    const topTargets = Object.entries(resourceCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([resource, count]) => ({ resource, count }));

    const alerts = Array.from(this.alerts.values());
    const alertsActive = alerts.filter(a => !a.acknowledged).length;
    const alertsResolved = alerts.filter(a => a.acknowledged).length;

    // Calculate average response time for resolved events
    const resolvedEvents = events.filter(e => e.resolved && e.resolvedAt);
    const averageResponseTime = resolvedEvents.length > 0
      ? resolvedEvents.reduce((sum, event) => {
        const responseTime = event.resolvedAt!.getTime() - event.timestamp.getTime();
        return sum + responseTime;
      }, 0) / resolvedEvents.length / 1000 / 60 // Convert to minutes
      : 0;

    return {
      totalEvents: events.length,
      eventsBySeverity,
      eventsByType,
      topAttackers,
      topTargets,
      alertsActive,
      alertsResolved,
      averageResponseTime: Math.round(averageResponseTime),
    };
  }

  /**
   * Get recent security events
   */
  getRecentEvents(limit = 100, severity?: SecurityEvent['severity']): SecurityEvent[] {
    let events = Array.from(this.events.values());

    if (severity) {
      events = events.filter(e => e.severity === severity);
    }

    return events
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): SecurityAlert[] {
    return Array.from(this.alerts.values())
      .filter(alert => !alert.acknowledged)
      .sort((a, b) => {
        // Sort by severity, then by last occurrence
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
        if (severityDiff !== 0) return severityDiff;
        return b.lastOccurrence.getTime() - a.lastOccurrence.getTime();
      });
  }

  /**
   * Get quarantined IPs
   */
  getQuarantinedIPs(): string[] {
    return Array.from(this.suspiciousIPs);
  }

  /**
   * Periodic cleanup of old events and counters
   */
  private startPeriodicCleanup(): void {
    setInterval(() => {
      this.cleanupOldData();
    }, 60 * 60 * 1000); // Run every hour
  }

  /**
   * Clean up old events and rate limit counters
   */
  private cleanupOldData(): void {
    const now = Date.now();
    const eventRetentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const cutoffTime = now - eventRetentionMs;

    // Clean up old events
    let cleanedEvents = 0;
    for (const [id, event] of this.events.entries()) {
      if (event.timestamp.getTime() < cutoffTime) {
        this.events.delete(id);
        cleanedEvents++;
      }
    }

    // Clean up expired rate limit counters
    let cleanedCounters = 0;
    for (const [key, counter] of this.rateLimitCounters.entries()) {
      if (now > counter.resetTime) {
        this.rateLimitCounters.delete(key);
        cleanedCounters++;
      }
    }

    if (cleanedEvents > 0 || cleanedCounters > 0) {
      this.logger.info('Security data cleanup completed', {
        cleanedEvents,
        cleanedCounters,
        remainingEvents: this.events.size,
        remainingCounters: this.rateLimitCounters.size,
      });
    }
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `evt_${timestamp}_${random}`;
  }

  /**
   * Get appropriate log method for severity
   */
  private getLogMethod(severity: SecurityEvent['severity']) {
    switch (severity) {
    case 'critical':
    case 'high':
      return this.logger.error;
    case 'medium':
      return this.logger.warn;
    case 'low':
    default:
      return this.logger.info;
    }
  }
}
