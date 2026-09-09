/**
 * Error Monitor Unit Tests
 * Tests for error monitoring and alerting
 */

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { ErrorMonitor, startErrorMonitoring, stopErrorMonitoring } from '../../../src/utils/ErrorMonitor';
import { logger } from '../../../src/utils/Logger';

describe('ErrorMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ErrorMonitor.resetCounts();
  });

  afterEach(() => {
    stopErrorMonitoring();
  });

  describe('trackError', () => {
    it('should track low severity errors', () => {
      ErrorMonitor.trackError('ERR001', 'low');
      
      // Should not trigger alert for low severity
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should track medium severity errors', () => {
      ErrorMonitor.trackError('ERR002', 'medium');
      
      // Should not trigger alert for medium severity
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should track high severity errors', () => {
      ErrorMonitor.trackError('ERR003', 'high');
      
      // Should not trigger alert for high severity (only critical)
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should trigger alert for critical errors above threshold', () => {
      // Track 3 critical errors (threshold is 3)
      ErrorMonitor.trackError('ERR004', 'critical');
      ErrorMonitor.trackError('ERR004', 'critical');
      ErrorMonitor.trackError('ERR004', 'critical');
      
      expect(logger.error).toHaveBeenCalledWith(
        'Critical error threshold exceeded',
        expect.objectContaining({
          errorCode: 'ERR004',
          severity: 'critical',
          type: 'alert',
        })
      );
    });

    it('should not trigger alert for critical errors below threshold', () => {
      // Track 2 critical errors (threshold is 3)
      ErrorMonitor.trackError('ERR005', 'critical');
      ErrorMonitor.trackError('ERR005', 'critical');
      
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should track different error codes separately', () => {
      ErrorMonitor.trackError('ERR006', 'critical');
      ErrorMonitor.trackError('ERR006', 'critical');
      ErrorMonitor.trackError('ERR007', 'critical');
      ErrorMonitor.trackError('ERR007', 'critical');
      
      // Neither should trigger alert as each has only 2
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should track different severities separately', () => {
      ErrorMonitor.trackError('ERR008', 'low');
      ErrorMonitor.trackError('ERR008', 'medium');
      ErrorMonitor.trackError('ERR008', 'high');
      
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('resetCounts', () => {
    it('should reset all error counts', () => {
      // Track some errors
      ErrorMonitor.trackError('ERR009', 'critical');
      ErrorMonitor.trackError('ERR009', 'critical');
      
      // Reset counts
      ErrorMonitor.resetCounts();
      
      // Track again - should start from 0
      ErrorMonitor.trackError('ERR009', 'critical');
      ErrorMonitor.trackError('ERR009', 'critical');
      
      // Should still not trigger alert (only 2 after reset)
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('startErrorMonitoring', () => {
    it('should start monitoring without error', () => {
      expect(() => startErrorMonitoring()).not.toThrow();
    });

    it('should be idempotent', () => {
      startErrorMonitoring();
      startErrorMonitoring();
      
      // Should not throw or create multiple intervals
      expect(() => stopErrorMonitoring()).not.toThrow();
    });
  });

  describe('stopErrorMonitoring', () => {
    it('should stop monitoring without error', () => {
      startErrorMonitoring();
      
      expect(() => stopErrorMonitoring()).not.toThrow();
    });

    it('should handle stopping when not started', () => {
      expect(() => stopErrorMonitoring()).not.toThrow();
    });

    it('should be idempotent', () => {
      startErrorMonitoring();
      stopErrorMonitoring();
      stopErrorMonitoring();
      
      // Should not throw
    });
  });
});
