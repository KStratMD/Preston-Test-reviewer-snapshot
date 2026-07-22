/**
 * SecurityMonitor Tests
 * Tests for security event tracking, alerting, and IP quarantine
 */

import 'reflect-metadata';
import { SecurityMonitor, SecurityEvent, SecurityEventType } from '../../../src/services/SecurityMonitor';

describe('SecurityMonitor', () => {
  let service: SecurityMonitor;
  let mockLogger: any;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    service = new SecurityMonitor(mockLogger);
  });

  afterEach(() => {
    service.removeAllListeners();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize alert rules', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Security alert rules initialized', expect.any(Object));
    });
  });

  describe('recordEvent', () => {
    it('should record security event with generated ID and timestamp', () => {
      const event = service.recordEvent({
        type: 'authentication_failure',
        severity: 'medium',
        source: 'auth-service',
        userId: 'user-1',
        ip: '192.168.1.1',
        details: { reason: 'Invalid password' },
      });

      expect(event.id).toBeDefined();
      expect(event.id).toContain('evt_');
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('should log event based on severity', () => {
      service.recordEvent({
        type: 'authentication_failure',
        severity: 'low',
        source: 'test',
        details: {},
      });
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Security event'), expect.any(Object));

      service.recordEvent({
        type: 'suspicious_activity',
        severity: 'medium',
        source: 'test',
        details: {},
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Security event'), expect.any(Object));

      service.recordEvent({
        type: 'data_breach_attempt',
        severity: 'critical',
        source: 'test',
        details: {},
      });
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Security event'), expect.any(Object));
    });

    it('should emit securityEvent', () => {
      const listener = jest.fn();
      service.on('securityEvent', listener);

      const event = service.recordEvent({
        type: 'authentication_failure',
        severity: 'medium',
        source: 'test',
        details: {},
      });

      expect(listener).toHaveBeenCalledWith(event);
    });

    it('should auto-quarantine IP for critical events', () => {
      service.recordEvent({
        type: 'data_breach_attempt',
        severity: 'critical',
        source: 'test',
        ip: '10.0.0.1',
        details: {},
      });

      expect(service.isIPQuarantined('10.0.0.1')).toBe(true);
    });

    it('should not quarantine IP for non-critical events', () => {
      service.recordEvent({
        type: 'authentication_failure',
        severity: 'medium',
        source: 'test',
        ip: '10.0.0.2',
        details: {},
      });

      expect(service.isIPQuarantined('10.0.0.2')).toBe(false);
    });
  });

  describe('IP quarantine', () => {
    it('should check if IP is quarantined', () => {
      expect(service.isIPQuarantined('192.168.1.1')).toBe(false);

      service.recordEvent({
        type: 'malicious_payload',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.1',
        details: {},
      });

      expect(service.isIPQuarantined('192.168.1.1')).toBe(true);
    });

    it('should release IP from quarantine', () => {
      service.recordEvent({
        type: 'malicious_payload',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.1',
        details: {},
      });

      expect(service.isIPQuarantined('192.168.1.1')).toBe(true);

      service.releaseIP('192.168.1.1', 'admin');

      expect(service.isIPQuarantined('192.168.1.1')).toBe(false);
    });

    it('should emit ipReleased event', () => {
      const listener = jest.fn();
      service.on('ipReleased', listener);

      service.recordEvent({
        type: 'malicious_payload',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.1',
        details: {},
      });

      service.releaseIP('192.168.1.1', 'admin');

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        ip: '192.168.1.1',
        releasedBy: 'admin',
      }));
    });

    it('should log IP release', () => {
      service.recordEvent({
        type: 'malicious_payload',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.1',
        details: {},
      });

      service.releaseIP('192.168.1.1', 'admin');

      expect(mockLogger.info).toHaveBeenCalledWith('IP released from quarantine', expect.objectContaining({
        ip: '192.168.1.1',
        releasedBy: 'admin',
      }));
    });

    it('should get list of quarantined IPs', () => {
      service.recordEvent({
        type: 'malicious_payload',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.1',
        details: {},
      });
      service.recordEvent({
        type: 'injection_attempt',
        severity: 'critical',
        source: 'test',
        ip: '192.168.1.2',
        details: {},
      });

      const quarantined = service.getQuarantinedIPs();

      expect(quarantined).toContain('192.168.1.1');
      expect(quarantined).toContain('192.168.1.2');
    });
  });

  describe('alert thresholds', () => {
    it('should create alert when threshold exceeded', () => {
      const listener = jest.fn();
      service.on('securityAlert', listener);

      // Authentication failure threshold is 5 in 15 minutes
      for (let i = 0; i < 5; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: { attempt: i },
        });
      }

      expect(listener).toHaveBeenCalled();
    });

    it('should create alert with correct details', () => {
      const listener = jest.fn();
      service.on('securityAlert', listener);

      for (let i = 0; i < 5; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: {},
        });
      }

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringContaining('AUTHENTICATION'),
        severity: 'medium',
        count: expect.any(Number),
      }));
    });

    it('should track events within time window', () => {
      const listener = jest.fn();
      service.on('securityAlert', listener);

      // Record 3 events
      for (let i = 0; i < 3; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: {},
        });
      }

      expect(listener).not.toHaveBeenCalled();

      // Record 2 more events - should trigger alert
      for (let i = 0; i < 2; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: {},
        });
      }

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('acknowledgeAlert', () => {
    it('should acknowledge existing alert', () => {
      // Create alert by exceeding threshold
      for (let i = 0; i < 5; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: {},
        });
      }

      const alerts = service.getActiveAlerts();
      expect(alerts.length).toBeGreaterThan(0);

      const result = service.acknowledgeAlert(alerts[0].id, 'admin');

      expect(result).toBe(true);
    });

    it('should return false for non-existent alert', () => {
      const result = service.acknowledgeAlert('non-existent', 'admin');
      expect(result).toBe(false);
    });

    it('should emit alertAcknowledged event', () => {
      const listener = jest.fn();
      service.on('alertAcknowledged', listener);

      for (let i = 0; i < 5; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          details: {},
        });
      }

      const alerts = service.getActiveAlerts();
      service.acknowledgeAlert(alerts[0].id, 'admin');

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('resolveEvent', () => {
    it('should resolve existing event', () => {
      const event = service.recordEvent({
        type: 'authentication_failure',
        severity: 'medium',
        source: 'test',
        details: {},
      });

      const result = service.resolveEvent(event.id, 'admin');

      expect(result).toBe(true);
    });

    it('should return false for non-existent event', () => {
      const result = service.resolveEvent('non-existent', 'admin');
      expect(result).toBe(false);
    });

    it('should emit eventResolved', () => {
      const listener = jest.fn();
      service.on('eventResolved', listener);

      const event = service.recordEvent({
        type: 'authentication_failure',
        severity: 'medium',
        source: 'test',
        details: {},
      });

      service.resolveEvent(event.id, 'admin');

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        id: event.id,
        resolved: true,
        resolvedBy: 'admin',
      }));
    });
  });

  describe('getSecurityMetrics', () => {
    it('should return security metrics', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', ip: '10.0.0.1', resource: '/api/login', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'high', source: 'test', ip: '10.0.0.1', resource: '/api/login', details: {} });
      service.recordEvent({ type: 'rate_limit_exceeded', severity: 'low', source: 'test', ip: '10.0.0.2', resource: '/api/data', details: {} });

      const metrics = service.getSecurityMetrics();

      expect(metrics.totalEvents).toBe(3);
      expect(metrics.eventsBySeverity).toBeDefined();
      expect(metrics.eventsByType).toBeDefined();
    });

    it('should calculate events by severity', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'high', source: 'test', details: {} });

      const metrics = service.getSecurityMetrics();

      expect(metrics.eventsBySeverity.medium).toBe(2);
      expect(metrics.eventsBySeverity.high).toBe(1);
    });

    it('should calculate events by type', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      service.recordEvent({ type: 'rate_limit_exceeded', severity: 'low', source: 'test', details: {} });

      const metrics = service.getSecurityMetrics();

      expect(metrics.eventsByType.authentication_failure).toBe(2);
      expect(metrics.eventsByType.rate_limit_exceeded).toBe(1);
    });

    it('should identify top attackers by IP', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', ip: '10.0.0.1', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', ip: '10.0.0.1', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', ip: '10.0.0.2', details: {} });

      const metrics = service.getSecurityMetrics();

      expect(metrics.topAttackers[0].ip).toBe('10.0.0.1');
      expect(metrics.topAttackers[0].count).toBe(2);
    });

    it('should identify top targets by resource', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', resource: '/api/login', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', resource: '/api/login', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', resource: '/api/data', details: {} });

      const metrics = service.getSecurityMetrics();

      expect(metrics.topTargets[0].resource).toBe('/api/login');
      expect(metrics.topTargets[0].count).toBe(2);
    });

    it('should filter by time range', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });

      const metrics = service.getSecurityMetrics({
        start: yesterday,
        end: now,
      });

      expect(metrics.totalEvents).toBeGreaterThan(0);
    });
  });

  describe('getRecentEvents', () => {
    it('should return recent events', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      service.recordEvent({ type: 'rate_limit_exceeded', severity: 'low', source: 'test', details: {} });

      const events = service.getRecentEvents();

      expect(events.length).toBe(2);
    });

    it('should limit results', () => {
      for (let i = 0; i < 10; i++) {
        service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      }

      const events = service.getRecentEvents(5);

      expect(events.length).toBe(5);
    });

    it('should filter by severity', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'low', source: 'test', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'high', source: 'test', details: {} });
      service.recordEvent({ type: 'authentication_failure', severity: 'high', source: 'test', details: {} });

      const events = service.getRecentEvents(100, 'high');

      expect(events.length).toBe(2);
      events.forEach(e => expect(e.severity).toBe('high'));
    });

    it('should sort by timestamp descending', () => {
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: { order: 1 } });
      service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: { order: 2 } });

      const events = service.getRecentEvents();

      expect(events[0].timestamp.getTime()).toBeGreaterThanOrEqual(events[1].timestamp.getTime());
    });
  });

  describe('getActiveAlerts', () => {
    it('should return unacknowledged alerts', () => {
      // Create alerts
      for (let i = 0; i < 5; i++) {
        service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      }

      const alerts = service.getActiveAlerts();

      expect(alerts.length).toBeGreaterThan(0);
      alerts.forEach(alert => expect(alert.acknowledged).toBeFalsy());
    });

    it('should sort by severity then timestamp', () => {
      // Create critical alert
      for (let i = 0; i < 1; i++) {
        service.recordEvent({ type: 'data_breach_attempt', severity: 'critical', source: 'test', details: {} });
      }

      // Create medium alert
      for (let i = 0; i < 5; i++) {
        service.recordEvent({ type: 'authentication_failure', severity: 'medium', source: 'test', details: {} });
      }

      const alerts = service.getActiveAlerts();

      if (alerts.length >= 2) {
        const severityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
        expect(severityOrder[alerts[0].severity]).toBeGreaterThanOrEqual(severityOrder[alerts[1].severity]);
      }
    });
  });

  describe('failed login tracking', () => {
    it('should quarantine IP after excessive failed logins', () => {
      const ip = '10.0.0.5';

      // Record 10+ failed logins from same IP
      for (let i = 0; i < 10; i++) {
        service.recordEvent({
          type: 'authentication_failure',
          severity: 'medium',
          source: 'test',
          ip,
          details: { attempt: i },
        });
      }

      expect(service.isIPQuarantined(ip)).toBe(true);
    });
  });

  describe('privilege escalation detection', () => {
    it('should detect privilege escalation attempts', () => {
      const listener = jest.fn();
      service.on('securityEvent', listener);

      service.recordEvent({
        type: 'authorization_failure',
        severity: 'medium',
        source: 'test',
        userId: 'user-1',
        action: 'admin_access',
        details: {},
      });

      // Should have recorded both the original event and the escalation event
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });
});
