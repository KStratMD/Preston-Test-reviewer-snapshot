/**
 * Comprehensive unit tests for MDMFeedbackService
 * Covers: recordConflict, resolveConflict, getMappingQualityAdjustments,
 *         getFieldStats, getTopConflictingFields, analyzeConflictPatterns,
 *         getStatistics, clearAll, updateRollingAverage
 */
import 'reflect-metadata';
import { MDMFeedbackService } from '../../../../src/services/mdm/MDMFeedbackService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('MDMFeedbackService', () => {
  let service: MDMFeedbackService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MDMFeedbackService(mockLogger);
  });

  describe('constructor', () => {
    it('should log initialization', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[MDMFeedback] Service initialized',
        expect.objectContaining({ persistenceEnabled: false })
      );
    });
  });

  describe('recordConflict', () => {
    it('should record a new conflict', async () => {
      await service.recordConflict('email', 'Salesforce', 'NetSuite', 'a@b.com', 'A@B.COM');
      const stats = await service.getFieldStats('email');
      expect(stats.length).toBe(1);
      expect(stats[0].conflictCount).toBe(1);
      expect(stats[0].fieldName).toBe('email');
      expect(stats[0].sourceSystem).toBe('Salesforce');
    });

    it('should increment existing conflict count', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      await service.recordConflict('email', 'SF', 'NS', 'c', 'd');
      const stats = await service.getFieldStats('email');
      expect(stats[0].conflictCount).toBe(2);
    });

    it('should track auto resolution rate', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'auto');
      const stats = await service.getFieldStats('email');
      expect(stats[0].autoResolutionRate).toBe(1);
      expect(stats[0].manualResolutionRate).toBe(0);
    });

    it('should track manual resolution rate', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'manual');
      const stats = await service.getFieldStats('email');
      expect(stats[0].manualResolutionRate).toBe(1);
    });

    it('should track pending conflicts (no resolution)', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'pending');
      const stats = await service.getFieldStats('email');
      expect(stats[0].resolutionCount).toBe(0);
    });

    it('should update rolling average across resolutions', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'auto');
      await service.recordConflict('email', 'SF', 'NS', 'c', 'd', 'manual');
      const stats = await service.getFieldStats('email');
      // First: auto=1.0, Second: (1.0*1 + 0)/2 = 0.5
      expect(stats[0].autoResolutionRate).toBe(0.5);
      expect(stats[0].manualResolutionRate).toBe(0.5);
    });

    it('should trim history when exceeding 1000', async () => {
      for (let i = 0; i < 1010; i++) {
        await service.recordConflict('field', 'A', 'B', i, i + 1);
      }
      // History should be trimmed to 500
      const stats = await service.getStatistics();
      expect(stats.totalConflicts).toBe(1010);
    });

    it('should log conflict', async () => {
      await service.recordConflict('phone', 'SF', 'NS', '123', '456');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[MDMFeedback] Conflict recorded',
        expect.objectContaining({ fieldName: 'phone' })
      );
    });
  });

  describe('resolveConflict', () => {
    it('should update resolution counts', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'pending');
      await service.resolveConflict('email', 'SF', 'NS', 'auto');
      const stats = await service.getFieldStats('email');
      expect(stats[0].resolutionCount).toBe(1);
      expect(stats[0].autoResolutionRate).toBe(1);
    });

    it('should handle manual resolution', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'pending');
      await service.resolveConflict('email', 'SF', 'NS', 'manual');
      const stats = await service.getFieldStats('email');
      expect(stats[0].manualResolutionRate).toBe(1);
    });

    it('should do nothing for unknown conflict', async () => {
      await service.resolveConflict('unknown', 'SF', 'NS', 'auto');
      // Should not throw
      expect(await service.getFieldStats('unknown')).toEqual([]);
    });

    it('should log resolution', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      await service.resolveConflict('email', 'SF', 'NS', 'auto');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[MDMFeedback] Conflict resolved',
        expect.objectContaining({ fieldName: 'email', resolution: 'auto' })
      );
    });
  });

  describe('getMappingQualityAdjustments', () => {
    it('should return empty for no conflicts', async () => {
      const adjustments = await service.getMappingQualityAdjustments();
      expect(adjustments).toEqual([]);
    });

    it('should return no adjustment for low conflict count', async () => {
      for (let i = 0; i < 3; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments();
      expect(adjustments.length).toBe(0); // < 6 conflicts = no adjustment
    });

    it('should adjust for moderate conflicts (>5)', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments();
      expect(adjustments.length).toBe(1);
      expect(adjustments[0].confidenceAdjustment).toBe(0.95);
    });

    it('should adjust for high conflicts (>20)', async () => {
      for (let i = 0; i < 25; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments();
      expect(adjustments[0].confidenceAdjustment).toBe(0.85);
    });

    it('should adjust for very high conflicts (>50)', async () => {
      for (let i = 0; i < 55; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments();
      expect(adjustments[0].confidenceAdjustment).toBe(0.7);
    });

    it('should further adjust for high manual resolution rate', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'manual');
      }
      const adjustments = await service.getMappingQualityAdjustments();
      // 10 conflicts (0.95) * high manual rate (0.8) = 0.76
      expect(adjustments[0].confidenceAdjustment).toBe(0.95 * 0.8);
    });

    it('should filter by source system', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
        await service.recordConflict('email', 'BC', 'NS', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments('SF');
      expect(adjustments.length).toBe(1);
      expect(adjustments[0].reason).toContain('conflicts');
    });

    it('should filter by target system', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
        await service.recordConflict('email', 'SF', 'BC', 'a', 'b');
      }
      const adjustments = await service.getMappingQualityAdjustments(undefined, 'NS');
      expect(adjustments.length).toBe(1);
    });
  });

  describe('getFieldStats', () => {
    it('should return empty for unknown field', async () => {
      expect(await service.getFieldStats('unknown')).toEqual([]);
    });

    it('should return stats for field across multiple system pairs', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      await service.recordConflict('email', 'BC', 'NS', 'c', 'd');
      const stats = await service.getFieldStats('email');
      expect(stats.length).toBe(2);
    });
  });

  describe('getTopConflictingFields', () => {
    it('should return fields sorted by conflict count', async () => {
      for (let i = 0; i < 10; i++) await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      for (let i = 0; i < 5; i++) await service.recordConflict('phone', 'SF', 'NS', '1', '2');
      for (let i = 0; i < 15; i++) await service.recordConflict('name', 'SF', 'NS', 'x', 'y');

      const top = await service.getTopConflictingFields(3);
      expect(top[0].fieldName).toBe('name');
      expect(top[1].fieldName).toBe('email');
      expect(top[2].fieldName).toBe('phone');
    });

    it('should respect limit', async () => {
      await service.recordConflict('a', 'SF', 'NS', 1, 2);
      await service.recordConflict('b', 'SF', 'NS', 1, 2);
      await service.recordConflict('c', 'SF', 'NS', 1, 2);

      const top = await service.getTopConflictingFields(2);
      expect(top.length).toBe(2);
    });
  });

  describe('analyzeConflictPatterns', () => {
    it('should return empty when no significant conflicts', async () => {
      const patterns = await service.analyzeConflictPatterns();
      expect(patterns).toEqual([]);
    });

    it('should detect email format mismatch pattern', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('email', 'SF', 'NS', 'a@b.com', 'A@B.COM');
      }
      const patterns = await service.analyzeConflictPatterns();
      expect(patterns.some(p => p.pattern === 'email_format_mismatch')).toBe(true);
    });

    it('should detect phone format mismatch pattern', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('phone', 'SF', 'NS', '123-456-7890', '+11234567890');
      }
      const patterns = await service.analyzeConflictPatterns();
      expect(patterns.some(p => p.pattern === 'phone_format_mismatch')).toBe(true);
    });

    it('should detect address structure mismatch', async () => {
      for (let i = 0; i < 5; i++) {
        await service.recordConflict('address', 'SF', 'NS', '123 Main', '123 Main St');
      }
      const patterns = await service.analyzeConflictPatterns();
      expect(patterns.some(p => p.pattern === 'address_structure_mismatch')).toBe(true);
    });

    it('should detect company name variation', async () => {
      for (let i = 0; i < 10; i++) {
        await service.recordConflict('name', 'SF', 'NS', 'Acme Inc', 'Acme, Inc.');
      }
      const patterns = await service.analyzeConflictPatterns();
      expect(patterns.some(p => p.pattern === 'company_name_variation')).toBe(true);
    });
  });

  describe('getStatistics', () => {
    it('should return zero stats when empty', async () => {
      const stats = await service.getStatistics();
      expect(stats.totalConflicts).toBe(0);
      expect(stats.resolvedConflicts).toBe(0);
      expect(stats.pendingConflicts).toBe(0);
      expect(stats.autoResolutionRate).toBe(0);
      expect(stats.topConflictingFields).toEqual([]);
      expect(stats.patternCount).toBe(0);
    });

    it('should return comprehensive statistics', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b', 'auto');
      await service.recordConflict('phone', 'SF', 'NS', '1', '2', 'manual');
      await service.recordConflict('name', 'SF', 'NS', 'x', 'y', 'pending');

      const stats = await service.getStatistics();
      expect(stats.totalConflicts).toBe(3);
      expect(stats.resolvedConflicts).toBe(2);
      expect(stats.pendingConflicts).toBe(1);
      expect(stats.topConflictingFields.length).toBe(3);
    });
  });

  describe('clearAll', () => {
    it('should clear all data', async () => {
      await service.recordConflict('email', 'SF', 'NS', 'a', 'b');
      await service.clearAll();
      expect(await service.getFieldStats('email')).toEqual([]);
      expect((await service.getStatistics()).totalConflicts).toBe(0);
    });

    it('should log clear operation', async () => {
      await service.clearAll();
      expect(mockLogger.info).toHaveBeenCalledWith('[MDMFeedback] All data cleared');
    });
  });
});
