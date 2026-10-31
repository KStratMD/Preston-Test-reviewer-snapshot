/**
 * Port Resolver Unit Tests
 * Tests for port resolution utilities
 */

// Mock is-port-free
jest.mock('is-port-free');

import isPortFree from 'is-port-free';
import { resolveAvailablePort, PortResolutionOptions } from '../../../src/utils/portResolver';

const mockIsPortFree = isPortFree as jest.MockedFunction<typeof isPortFree>;

describe('portResolver', () => {
  let mockLogger: {
    info: jest.Mock;
    warn: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
  });

  describe('resolveAvailablePort', () => {
    it('should return base port when available', async () => {
      mockIsPortFree.mockResolvedValue(true);

      const port = await resolveAvailablePort(3000);

      expect(port).toBe(3000);
    });

    it('should return base port when disableAutoPort is true', async () => {
      mockIsPortFree.mockResolvedValue(false);

      const port = await resolveAvailablePort(3000, { disableAutoPort: true });

      expect(port).toBe(3000);
      expect(mockIsPortFree).not.toHaveBeenCalled();
    });

    it('should return base port when userSpecifiedPort is true and not forcing', async () => {
      mockIsPortFree.mockResolvedValue(false);

      const port = await resolveAvailablePort(3000, { userSpecifiedPort: true });

      expect(port).toBe(3000);
      expect(mockIsPortFree).not.toHaveBeenCalled();
    });

    it('should find available port when userSpecifiedPort is true but forceAutoPort is true', async () => {
      mockIsPortFree
        .mockResolvedValueOnce(false) // 3000 busy
        .mockResolvedValueOnce(true);  // 3001 free

      const port = await resolveAvailablePort(3000, { 
        userSpecifiedPort: true, 
        forceAutoPort: true,
        logger: mockLogger,
      });

      expect(port).toBe(3001);
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should try next port when base is busy', async () => {
      mockIsPortFree
        .mockResolvedValueOnce(false) // 3000 busy
        .mockResolvedValueOnce(true);  // 3001 free

      const port = await resolveAvailablePort(3000, { logger: mockLogger });

      expect(port).toBe(3001);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('3001'));
    });

    it('should try multiple ports if needed', async () => {
      mockIsPortFree
        .mockResolvedValueOnce(false) // 3000 busy
        .mockResolvedValueOnce(false) // 3001 busy
        .mockResolvedValueOnce(false) // 3002 busy
        .mockResolvedValueOnce(true);  // 3003 free

      const port = await resolveAvailablePort(3000, { logger: mockLogger });

      expect(port).toBe(3003);
    });

    it('should throw error after maxAttempts', async () => {
      mockIsPortFree.mockResolvedValue(false);

      await expect(resolveAvailablePort(3000, { maxAttempts: 5 }))
        .rejects.toThrow('Unable to find available port after 5 attempts');
    });

    it('should handle isPortFree error for base port', async () => {
      mockIsPortFree
        .mockRejectedValueOnce(new Error('Network error')) // 3000 error
        .mockResolvedValueOnce(true); // 3001 free

      const port = await resolveAvailablePort(3000, { logger: mockLogger });

      expect(port).toBe(3001);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('3000'));
    });

    it('should handle isPortFree error for subsequent ports', async () => {
      mockIsPortFree
        .mockResolvedValueOnce(false) // 3000 busy
        .mockRejectedValueOnce(new Error('Network error')) // 3001 error
        .mockResolvedValueOnce(true); // 3002 free

      const port = await resolveAvailablePort(3000, { logger: mockLogger });

      expect(port).toBe(3002);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should use default maxAttempts of 10', async () => {
      mockIsPortFree.mockResolvedValue(false);

      await expect(resolveAvailablePort(3000))
        .rejects.toThrow('Unable to find available port after 10 attempts');

      // Base port + 10 attempts
      expect(mockIsPortFree).toHaveBeenCalledTimes(11);
    });

    it('should use console as default logger', async () => {
      mockIsPortFree
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      // Should not throw
      const port = await resolveAvailablePort(3000);

      expect(port).toBe(3001);
    });

    it('should handle non-Error thrown values', async () => {
      mockIsPortFree
        .mockRejectedValueOnce('string error')
        .mockResolvedValueOnce(true);

      const port = await resolveAvailablePort(3000, { logger: mockLogger });

      expect(port).toBe(3001);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('string error'));
    });
  });
});
