/**
 * Comprehensive tests for QualityScoringService
 * Covers: calculateQualityScores, assessDataCompleteness, assessDataUniqueness,
 *         assessDataValidity, assessDataConsistency, assessDataAccuracy, assessDataTimeliness
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/utils/Logger', () => ({
  logger: mockLogger,
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { QualityScoringService } from '../../../../src/services/ai/orchestrator/agents/quality/QualityScoringService';

describe('QualityScoringService', () => {
  let service: QualityScoringService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (QualityScoringService as any)(mockLogger);
  });

  /* ────────────── calculateQualityScores ────────────── */

  describe('calculateQualityScores', () => {
    it('should return 0 overall score for empty profiling results', async () => {
      const result = await service.calculateQualityScores([]);
      expect(result.overallScore).toBe(0);
      expect(result.issues).toEqual([]);
      expect(result.fieldScores).toEqual({});
    });

    it('should calculate overall score as average of field scores', async () => {
      const profiling = [
        { field: 'email', quality: { overallScore: 0.9, completeness: 1.0, validity: 1.0, consistency: 1.0 } },
        { field: 'name', quality: { overallScore: 0.7, completeness: 1.0, validity: 1.0, consistency: 1.0 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      expect(result.overallScore).toBeCloseTo(0.8, 2);
      expect(result.fieldScores['email']).toBe(0.9);
      expect(result.fieldScores['name']).toBe(0.7);
    });

    it('should identify completeness issues when below 0.9', async () => {
      const profiling = [
        { field: 'phone', quality: { overallScore: 0.6, completeness: 0.85, validity: 1.0, consistency: 1.0 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const completenessIssues = result.issues.filter(i => i.type === 'completeness');
      expect(completenessIssues.length).toBe(1);
      expect(completenessIssues[0].severity).toBe('medium');
      expect(completenessIssues[0].message).toContain('15.0%');
    });

    it('should flag high severity completeness when below 0.8', async () => {
      const profiling = [
        { field: 'addr', quality: { overallScore: 0.5, completeness: 0.6, validity: 1.0, consistency: 1.0 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const completenessIssues = result.issues.filter(i => i.type === 'completeness');
      expect(completenessIssues[0].severity).toBe('high');
    });

    it('should identify validity issues when below 0.9', async () => {
      const profiling = [
        { field: 'email', quality: { overallScore: 0.7, completeness: 1.0, validity: 0.85, consistency: 1.0 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const validityIssues = result.issues.filter(i => i.type === 'validity');
      expect(validityIssues.length).toBe(1);
      expect(validityIssues[0].severity).toBe('medium');
    });

    it('should flag high severity validity when below 0.8', async () => {
      const profiling = [
        { field: 'date', quality: { overallScore: 0.5, completeness: 1.0, validity: 0.5, consistency: 1.0 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const validityIssues = result.issues.filter(i => i.type === 'validity');
      expect(validityIssues[0].severity).toBe('high');
    });

    it('should identify consistency issues when below 0.8', async () => {
      const profiling = [
        { field: 'status', quality: { overallScore: 0.6, completeness: 1.0, validity: 1.0, consistency: 0.5 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const consistencyIssues = result.issues.filter(i => i.type === 'consistency');
      expect(consistencyIssues.length).toBe(1);
      expect(consistencyIssues[0].severity).toBe('medium');
    });

    it('should not flag consistency when at 0.8 or above', async () => {
      const profiling = [
        { field: 'status', quality: { overallScore: 0.9, completeness: 1.0, validity: 1.0, consistency: 0.8 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      const consistencyIssues = result.issues.filter(i => i.type === 'consistency');
      expect(consistencyIssues).toEqual([]);
    });

    it('should combine multiple issues from multiple fields', async () => {
      const profiling = [
        { field: 'a', quality: { overallScore: 0.5, completeness: 0.7, validity: 0.7, consistency: 0.5 } },
        { field: 'b', quality: { overallScore: 0.8, completeness: 0.85, validity: 0.95, consistency: 0.9 } },
      ] as any[];
      const result = await service.calculateQualityScores(profiling);
      expect(result.issues.length).toBeGreaterThanOrEqual(3); // field a: completeness + validity + consistency
    });

    it('should apply quality standards if provided', async () => {
      const profiling = [
        { field: 'x', quality: { overallScore: 1.0, completeness: 1.0, validity: 1.0, consistency: 1.0 } },
      ] as any[];
      const standards = [{ name: 'standard1' }] as any[];
      const result = await service.calculateQualityScores(profiling, standards);
      expect(result.overallScore).toBe(1.0);
      expect(result.issues).toEqual([]);
      expect(mockLogger.info).toHaveBeenCalledWith('Calculating quality scores', expect.objectContaining({ standardsCount: 1 }));
    });

    it('should log start and completion', async () => {
      await service.calculateQualityScores([
        { field: 'x', quality: { overallScore: 0.9, completeness: 1.0, validity: 1.0, consistency: 1.0 } },
      ] as any[]);
      expect(mockLogger.info).toHaveBeenCalledWith('Calculating quality scores', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Quality scoring completed', expect.any(Object));
    });
  });

  /* ────────────── assessDataCompleteness ────────────── */

  describe('assessDataCompleteness', () => {
    it('should return 0 for empty schema', () => {
      expect(service.assessDataCompleteness([{ name: 'Alice' }], [])).toBe(0);
    });

    it('should return 0 for empty data', () => {
      expect(service.assessDataCompleteness([], [{ name: 'name', type: 'string' } as any])).toBe(0);
    });

    it('should return 1.0 for complete data', () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      expect(service.assessDataCompleteness(data, schema)).toBe(1.0);
    });

    it('should calculate partial completeness', () => {
      const data = [{ name: 'Alice' }, { name: null }, { name: 'Charlie' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      const result = service.assessDataCompleteness(data, schema);
      expect(result).toBeCloseTo(2 / 3, 2);
    });

    it('should average completeness across multiple fields', () => {
      const data = [
        { name: 'Alice', email: 'a@b.com' },
        { name: 'Bob', email: '' },
      ];
      const schema = [
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' },
      ] as any[];
      const result = service.assessDataCompleteness(data, schema);
      // name: 2/2 = 1.0, email: 1/2 = 0.5 (empty string counts as incomplete)
      expect(result).toBeCloseTo(0.75, 2);
    });

    it('should treat undefined as incomplete', () => {
      const data = [{ name: undefined }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      expect(service.assessDataCompleteness(data, schema)).toBe(0);
    });
  });

  /* ────────────── assessDataUniqueness ────────────── */

  describe('assessDataUniqueness', () => {
    it('should return 1.0 when no ID fields in schema', () => {
      const data = [{ name: 'Alice' }, { name: 'Alice' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      expect(service.assessDataUniqueness(data, schema)).toBe(1.0);
    });

    it('should return 1.0 when all IDs are unique', () => {
      const data = [{ recordId: '1' }, { recordId: '2' }, { recordId: '3' }];
      const schema = [{ name: 'recordId', type: 'string' }] as any[];
      expect(service.assessDataUniqueness(data, schema)).toBe(1.0);
    });

    it('should detect duplicate IDs', () => {
      const data = [{ customerId: 'A' }, { customerId: 'A' }, { customerId: 'B' }];
      const schema = [{ name: 'customerId', type: 'string' }] as any[];
      const result = service.assessDataUniqueness(data, schema);
      expect(result).toBeCloseTo(2 / 3, 2);
    });

    it('should average uniqueness across multiple ID fields', () => {
      const data = [
        { recordId: '1', parentId: 'A' },
        { recordId: '2', parentId: 'A' },
      ];
      const schema = [
        { name: 'recordId', type: 'string' },
        { name: 'parentId', type: 'string' },
      ] as any[];
      const result = service.assessDataUniqueness(data, schema);
      // recordId: 2/2=1.0, parentId: 1/2=0.5 => avg=0.75
      expect(result).toBeCloseTo(0.75, 2);
    });

    it('should exclude null/empty values from uniqueness check', () => {
      const data = [{ recordId: '1' }, { recordId: null }, { recordId: '2' }];
      const schema = [{ name: 'recordId', type: 'string' }] as any[];
      const result = service.assessDataUniqueness(data, schema);
      expect(result).toBe(1.0); // 2 unique out of 2 non-null
    });
  });

  /* ────────────── assessDataValidity ────────────── */

  describe('assessDataValidity', () => {
    it('should return 1.0 for empty validation results', () => {
      expect(service.assessDataValidity([])).toBe(1.0);
    });

    it('should return average of validation scores', () => {
      const validations = [
        { overallScore: 0.9 },
        { overallScore: 0.7 },
      ] as any[];
      expect(service.assessDataValidity(validations)).toBeCloseTo(0.8, 2);
    });

    it('should return exact score for single validation', () => {
      expect(service.assessDataValidity([{ overallScore: 0.95 }] as any[])).toBe(0.95);
    });
  });

  /* ────────────── assessDataConsistency ────────────── */

  describe('assessDataConsistency', () => {
    it('should return 1.0 for empty profiling results', () => {
      expect(service.assessDataConsistency([])).toBe(1.0);
    });

    it('should return average consistency', () => {
      const profiling = [
        { quality: { consistency: 0.9 } },
        { quality: { consistency: 0.7 } },
      ] as any[];
      expect(service.assessDataConsistency(profiling)).toBeCloseTo(0.8, 2);
    });
  });

  /* ────────────── assessDataAccuracy ────────────── */

  describe('assessDataAccuracy', () => {
    it('should return 0.95 placeholder value', () => {
      expect(service.assessDataAccuracy([])).toBe(0.95);
    });

    it('should return 0.95 regardless of standards', () => {
      expect(service.assessDataAccuracy([{ x: 1 }], [{ name: 's1' }] as any[])).toBe(0.95);
    });
  });

  /* ────────────── assessDataTimeliness ────────────── */

  describe('assessDataTimeliness', () => {
    it('should return 1.0 when no date fields in schema', () => {
      const data = [{ name: 'Alice' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      expect(service.assessDataTimeliness(data, schema)).toBe(1.0);
    });

    it('should detect date fields by type', () => {
      const now = new Date();
      const data = [{ createdDate: now.toISOString() }];
      const schema = [{ name: 'createdDate', type: 'date' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBe(1.0); // Recent date
    });

    it('should detect date fields by name containing "date"', () => {
      const now = new Date();
      const data = [{ lastModifiedDate: now.toISOString() }];
      const schema = [{ name: 'lastModifiedDate', type: 'string' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBe(1.0);
    });

    it('should detect datetime type fields', () => {
      const now = new Date();
      const data = [{ timestamp: now.toISOString() }];
      const schema = [{ name: 'timestamp', type: 'datetime' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBe(1.0);
    });

    it('should return lower score for old dates', () => {
      const oldDate = new Date(2020, 0, 1).toISOString();
      const data = [{ createdDate: oldDate }, { createdDate: oldDate }];
      const schema = [{ name: 'createdDate', type: 'date' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBe(0);
    });

    it('should handle mix of recent and old dates', () => {
      const now = new Date();
      const oldDate = new Date(2020, 0, 1).toISOString();
      const data = [{ updateDate: now.toISOString() }, { updateDate: oldDate }];
      const schema = [{ name: 'updateDate', type: 'date' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBeCloseTo(0.5, 2);
    });

    it('should return 1.0 when date fields exist but no data', () => {
      const data: any[] = [];
      const schema = [{ name: 'createdDate', type: 'date' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      expect(result).toBe(1.0); // No assessed fields → 1.0
    });

    it('should handle invalid date strings gracefully', () => {
      const data = [{ createdDate: 'not-a-date' }];
      const schema = [{ name: 'createdDate', type: 'date' }] as any[];
      const result = service.assessDataTimeliness(data, schema);
      // 'not-a-date' becomes invalid Date; new Date('not-a-date') >= oneYearAgo returns false
      expect(result).toBe(0);
    });
  });
});
