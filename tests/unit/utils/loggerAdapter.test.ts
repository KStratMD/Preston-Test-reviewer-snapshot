/**
 * Logger Adapter Unit Tests
 * Tests for scope logger adapter utilities
 */

import { adaptScopeLogger, safeCloseLogger, ScopeLoggerLike } from '../../../src/utils/loggerAdapter';

describe('loggerAdapter', () => {
  describe('adaptScopeLogger', () => {
    it('should adapt object with all methods', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);

      expect(typeof adapted.info).toBe('function');
      expect(typeof adapted.warn).toBe('function');
      expect(typeof adapted.error).toBe('function');
      expect(typeof adapted.debug).toBe('function');
    });

    it('should call underlying info method', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);
      adapted.info('test message', { key: 'value' });

      expect(mockLogger.info).toHaveBeenCalledWith('test message', { key: 'value' });
    });

    it('should call underlying warn method', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);
      adapted.warn('warning message');

      expect(mockLogger.warn).toHaveBeenCalledWith('warning message');
    });

    it('should call underlying error method', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);
      adapted.error('error message');

      expect(mockLogger.error).toHaveBeenCalledWith('error message');
    });

    it('should call underlying debug method', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);
      adapted.debug!('debug message');

      expect(mockLogger.debug).toHaveBeenCalledWith('debug message');
    });

    it('should handle null logger gracefully', () => {
      const adapted = adaptScopeLogger(null);

      expect(() => adapted.info('test')).not.toThrow();
      expect(() => adapted.warn('test')).not.toThrow();
      expect(() => adapted.error('test')).not.toThrow();
    });

    it('should handle undefined logger gracefully', () => {
      const adapted = adaptScopeLogger(undefined);

      expect(() => adapted.info('test')).not.toThrow();
      expect(() => adapted.warn('test')).not.toThrow();
      expect(() => adapted.error('test')).not.toThrow();
    });

    it('should handle non-object logger gracefully', () => {
      const adapted = adaptScopeLogger('not an object');

      expect(() => adapted.info('test')).not.toThrow();
      expect(() => adapted.warn('test')).not.toThrow();
      expect(() => adapted.error('test')).not.toThrow();
    });

    it('should fall back to log method if specific method missing', () => {
      const mockLogger = {
        log: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);
      adapted.info('test message');

      expect(mockLogger.log).toHaveBeenCalledWith('test message');
    });

    it('should handle child logger factory', () => {
      const childLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnValue(childLogger),
      };

      const adapted = adaptScopeLogger(mockLogger);
      const child = adapted.child!({ context: 'test' });

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'test' });
      expect(child).toBeDefined();
      child.info('child message');
      expect(childLogger.info).toHaveBeenCalledWith('child message');
    });

    it('should return self if child factory throws', () => {
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockImplementation(() => {
          throw new Error('Child error');
        }),
      };

      const adapted = adaptScopeLogger(mockLogger);
      const child = adapted.child!({ context: 'test' });

      expect(child).toBe(adapted);
    });

    it('should handle logger methods that throw', () => {
      const mockLogger = {
        info: jest.fn().mockImplementation(() => {
          throw new Error('Info error');
        }),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const adapted = adaptScopeLogger(mockLogger);

      expect(() => adapted.info('test')).not.toThrow();
    });
  });

  describe('safeCloseLogger', () => {
    it('should call close method on logger', async () => {
      const mockLogger = {
        close: jest.fn(),
      };

      await safeCloseLogger(mockLogger);

      expect(mockLogger.close).toHaveBeenCalled();
    });

    it('should handle async close method', async () => {
      const mockLogger = {
        close: jest.fn().mockResolvedValue(undefined),
      };

      await expect(safeCloseLogger(mockLogger)).resolves.not.toThrow();
      expect(mockLogger.close).toHaveBeenCalled();
    });

    it('should handle null logger', async () => {
      await expect(safeCloseLogger(null)).resolves.not.toThrow();
    });

    it('should handle undefined logger', async () => {
      await expect(safeCloseLogger(undefined)).resolves.not.toThrow();
    });

    it('should handle logger without close method', async () => {
      const mockLogger = {
        info: jest.fn(),
      };

      await expect(safeCloseLogger(mockLogger)).resolves.not.toThrow();
    });

    it('should handle close method that throws', async () => {
      const mockLogger = {
        close: jest.fn().mockImplementation(() => {
          throw new Error('Close error');
        }),
      };

      await expect(safeCloseLogger(mockLogger)).resolves.not.toThrow();
    });

    it('should handle close method that returns rejected promise', async () => {
      const mockLogger = {
        close: jest.fn().mockRejectedValue(new Error('Async close error')),
      };

      await expect(safeCloseLogger(mockLogger)).resolves.not.toThrow();
    });
  });
});
