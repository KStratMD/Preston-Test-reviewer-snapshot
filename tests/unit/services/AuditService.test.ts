/**
 * AuditService Unit Tests
 * Tests for audit logging and compliance reporting
 */

import 'reflect-metadata';
import {
  AuditService,
  AuditLogEntry,
  AuditLogFilter,
} from '../../../src/services/AuditService';

describe('AuditService', () => {
  let service: AuditService;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service = new AuditService(mockLogger as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('log()', () => {
    it('should create audit log entry with generated id and timestamp', async () => {
      await service.log({
        action: 'CREATE',
        resource: 'user',
        result: 'success',
      });

      const logs = await service.query({});
      expect(logs.length).toBe(1);
      expect(logs[0].id).toBeDefined();
      expect(logs[0].timestamp).toBeInstanceOf(Date);
    });

    it('should log to standard logger', async () => {
      await service.log({
        action: 'UPDATE',
        resource: 'integration',
        userId: 'user-123',
        result: 'success',
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Audit log entry',
        expect.objectContaining({
          action: 'UPDATE',
          resource: 'integration',
          userId: 'user-123',
          result: 'success',
        })
      );
    });

    it('should store all provided details', async () => {
      await service.log({
        action: 'DELETE',
        resource: 'config',
        resourceId: 'config-456',
        userId: 'admin',
        details: { reason: 'cleanup' },
        result: 'success',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        duration: 150,
      });

      const logs = await service.query({});
      expect(logs[0].resourceId).toBe('config-456');
      expect(logs[0].details).toEqual({ reason: 'cleanup' });
      expect(logs[0].ipAddress).toBe('192.168.1.1');
      expect(logs[0].userAgent).toBe('Mozilla/5.0');
      expect(logs[0].duration).toBe(150);
    });
  });

  describe('logSuccess()', () => {
    it('should log success action', async () => {
      await service.logSuccess('CREATE', 'user', { email: 'test@example.com' });

      const logs = await service.query({});
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('CREATE');
      expect(logs[0].resource).toBe('user');
      expect(logs[0].result).toBe('success');
      expect(logs[0].details).toEqual({ email: 'test@example.com' });
    });

    it('should work without details', async () => {
      await service.logSuccess('READ', 'config');

      const logs = await service.query({});
      expect(logs[0].result).toBe('success');
      expect(logs[0].details).toBeUndefined();
    });
  });

  describe('logFailure()', () => {
    it('should log failure with Error object', async () => {
      const error = new Error('Connection timeout');
      await service.logFailure('SYNC', 'integration', error);

      const logs = await service.query({});
      expect(logs[0].result).toBe('failure');
      expect(logs[0].errorMessage).toBe('Connection timeout');
    });

    it('should log failure with string error', async () => {
      await service.logFailure('UPDATE', 'user', 'Invalid data format');

      const logs = await service.query({});
      expect(logs[0].result).toBe('failure');
      expect(logs[0].errorMessage).toBe('Invalid data format');
    });

    it('should include details with failure', async () => {
      await service.logFailure('DELETE', 'resource', 'Not found', { id: '123' });

      const logs = await service.query({});
      expect(logs[0].details).toEqual({ id: '123' });
    });
  });

  describe('query()', () => {
    beforeEach(async () => {
      // Set up test data
      await service.log({ userId: 'user1', action: 'CREATE', resource: 'user', result: 'success' });
      await service.log({ userId: 'user1', action: 'UPDATE', resource: 'user', result: 'success' });
      await service.log({ userId: 'user2', action: 'CREATE', resource: 'config', result: 'failure' });
      await service.log({ userId: 'user2', action: 'DELETE', resource: 'user', result: 'success' });
    });

    it('should return all logs when no filter', async () => {
      const logs = await service.query({});
      expect(logs.length).toBe(4);
    });

    it('should filter by userId', async () => {
      const logs = await service.query({ userId: 'user1' });
      expect(logs.length).toBe(2);
      expect(logs.every(l => l.userId === 'user1')).toBe(true);
    });

    it('should filter by action', async () => {
      const logs = await service.query({ action: 'CREATE' });
      expect(logs.length).toBe(2);
      expect(logs.every(l => l.action === 'CREATE')).toBe(true);
    });

    it('should filter by resource', async () => {
      const logs = await service.query({ resource: 'user' });
      expect(logs.length).toBe(3);
      expect(logs.every(l => l.resource === 'user')).toBe(true);
    });

    it('should filter by result', async () => {
      const logs = await service.query({ result: 'failure' });
      expect(logs.length).toBe(1);
      expect(logs[0].result).toBe('failure');
    });

    it('should filter by date range', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const oneHourLater = new Date(now.getTime() + 3600000);

      const logs = await service.query({ startDate: oneHourAgo, endDate: oneHourLater });
      expect(logs.length).toBe(4);
    });

    it('should sort by timestamp descending', async () => {
      const logs = await service.query({});
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(logs[i].timestamp.getTime());
      }
    });

    it('should apply limit', async () => {
      const logs = await service.query({ limit: 2 });
      expect(logs.length).toBe(2);
    });

    it('should apply offset', async () => {
      const allLogs = await service.query({});
      const offsetLogs = await service.query({ offset: 2 });

      expect(offsetLogs.length).toBe(2);
      expect(offsetLogs[0].id).toBe(allLogs[2].id);
    });

    it('should apply limit and offset together', async () => {
      const logs = await service.query({ limit: 1, offset: 1 });
      expect(logs.length).toBe(1);
    });

    it('should combine multiple filters', async () => {
      const logs = await service.query({ userId: 'user1', action: 'CREATE' });
      expect(logs.length).toBe(1);
      expect(logs[0].userId).toBe('user1');
      expect(logs[0].action).toBe('CREATE');
    });
  });

  describe('getComplianceReport()', () => {
    beforeEach(async () => {
      // Set up test data for compliance report
      await service.log({ userId: 'admin', action: 'CREATE', resource: 'user', result: 'success' });
      await service.log({ userId: 'admin', action: 'UPDATE', resource: 'user', result: 'success' });
      await service.log({ userId: 'admin', action: 'DELETE', resource: 'config', result: 'failure' });
      await service.log({ userId: 'user1', action: 'CREATE', resource: 'config', result: 'success' });
      await service.log({ userId: 'user1', action: 'READ', resource: 'report', result: 'failure' });
      await service.log({ userId: 'user2', action: 'CREATE', resource: 'user', result: 'success' });
    });

    it('should calculate total actions', async () => {
      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.totalActions).toBe(6);
    });

    it('should calculate success rate', async () => {
      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      // 4 successes out of 6 = 66.67%
      expect(report.successRate).toBeCloseTo(66.67, 0);
    });

    it('should return top users', async () => {
      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.topUsers.length).toBeGreaterThan(0);
      expect(report.topUsers[0].userId).toBe('admin');
      expect(report.topUsers[0].actionCount).toBe(3);
    });

    it('should return top actions', async () => {
      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.topActions.length).toBeGreaterThan(0);
      expect(report.topActions[0].action).toBe('CREATE');
      expect(report.topActions[0].count).toBe(3);
    });

    it('should track failures by resource', async () => {
      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.failuresByResource).toEqual({
        config: 1,
        report: 1,
      });
    });

    it('should return 0 success rate for empty logs', async () => {
      const emptyService = new AuditService(mockLogger as any);
      const report = await emptyService.getComplianceReport(
        new Date(),
        new Date()
      );

      expect(report.totalActions).toBe(0);
      expect(report.successRate).toBe(0);
    });

    it('should limit top users to 10', async () => {
      // Create logs for many users
      for (let i = 0; i < 15; i++) {
        await service.log({
          userId: `user-${i}`,
          action: 'READ',
          resource: 'test',
          result: 'success',
        });
      }

      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.topUsers.length).toBeLessThanOrEqual(10);
    });

    it('should limit top actions to 10', async () => {
      // Create logs for many different actions
      for (let i = 0; i < 15; i++) {
        await service.log({
          action: `ACTION_${i}`,
          resource: 'test',
          result: 'success',
        });
      }

      const now = new Date();
      const report = await service.getComplianceReport(
        new Date(now.getTime() - 3600000),
        new Date(now.getTime() + 3600000)
      );

      expect(report.topActions.length).toBeLessThanOrEqual(10);
    });
  });
});

describe('legacy service boundary', () => {
  it('documents that this generic AuditService is not the production-bound audit service', () => {
    const source = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/services/AuditService.ts'),
      'utf8',
    );

    expect(source).toContain('@deprecated Internal legacy helper');
    expect(source).toContain('src/services/ai/orchestrator/AuditService.ts');
  });
});
