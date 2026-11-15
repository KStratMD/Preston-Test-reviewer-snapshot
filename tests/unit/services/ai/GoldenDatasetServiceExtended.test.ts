/**
 * Comprehensive unit tests for GoldenDatasetService
 * Covers: addExample, getExamplesBySystemPair, getTopExamples,
 *         getSimilarExamples, updateProductionMetrics, getStats,
 *         exportDataset, importDataset, seed initialization
 */
import 'reflect-metadata';
import { GoldenDatasetService, type GoldenExample } from '../../../../src/services/ai/learning/GoldenDatasetService';

function makeExample(overrides: Record<string, any> = {}): Omit<GoldenExample, 'id'> {
  return {
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceField: { name: 'Email', type: 'email', sampleValues: ['test@example.com'] },
    targetField: 'email',
    transformationType: 'direct',
    confidence: 99,
    reasoning: 'Direct email mapping',
    verifiedBy: 'tester',
    verifiedAt: new Date(),
    verificationSource: 'human_review' as const,
    tags: ['test'],
    ...overrides,
  };
}

describe('GoldenDatasetService', () => {
  let service: GoldenDatasetService;

  beforeEach(() => {
    service = new GoldenDatasetService();
  });

  describe('constructor and seed data', () => {
    it('should initialize with seed examples', () => {
      const stats = service.getStats();
      expect(stats.totalExamples).toBe(5); // 3 Salesforce + 2 BusinessCentral seeds
    });

    it('should have Salesforce-NetSuite examples in seed', () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      expect(examples.length).toBe(3);
    });

    it('should have BusinessCentral-NetSuite examples in seed', () => {
      const examples = service.getExamplesBySystemPair('BusinessCentral', 'NetSuite');
      expect(examples.length).toBe(2);
    });

    it('should accept custom config', () => {
      const custom = new GoldenDatasetService({
        minConfidence: 90,
        maxExamplesPerSystem: 50,
        storageBackend: 'memory',
      });
      expect(custom.getStats().totalExamples).toBe(5); // Seeds still load
    });
  });

  describe('addExample', () => {
    it('should add a valid example', async () => {
      const id = await service.addExample(makeExample({
        sourceField: { name: 'CustomField', type: 'string' },
        targetField: 'custom_field',
      }));
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should reject example below confidence threshold', async () => {
      await expect(service.addExample(makeExample({ confidence: 80 })))
        .rejects.toThrow('below minimum');
    });

    it('should generate deterministic IDs', async () => {
      const id1 = await service.addExample(makeExample({
        sourceSystem: 'A',
        targetSystem: 'B',
        sourceField: { name: 'field1', type: 'string' },
        targetField: 'field2',
      }));
      // Same fields should produce same ID
      expect(id1).toBe('a-b-field1-field2');
    });

    it('should enforce max examples per system pair', async () => {
      const limitedService = new GoldenDatasetService({ maxExamplesPerSystem: 5 });
      // Seeds already add 3 Salesforce-NetSuite examples
      // Add 2 more to reach the limit
      await limitedService.addExample(makeExample({
        sourceField: { name: 'Field4', type: 'string' },
        targetField: 'target4',
      }));
      await limitedService.addExample(makeExample({
        sourceField: { name: 'Field5', type: 'string' },
        targetField: 'target5',
      }));
      // This should remove lowest confidence and add new one
      await limitedService.addExample(makeExample({
        sourceField: { name: 'Field6', type: 'string' },
        targetField: 'target6',
        confidence: 100,
      }));
      const examples = limitedService.getExamplesBySystemPair('Salesforce', 'NetSuite');
      expect(examples.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getExamplesBySystemPair', () => {
    it('should return empty for unknown system pair', () => {
      const examples = service.getExamplesBySystemPair('Unknown', 'Unknown');
      expect(examples).toEqual([]);
    });

    it('should sort by confidence descending', () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      for (let i = 1; i < examples.length; i++) {
        expect(examples[i - 1].confidence).toBeGreaterThanOrEqual(examples[i].confidence);
      }
    });
  });

  describe('getTopExamples', () => {
    it('should return top N examples', () => {
      const top = service.getTopExamples('Salesforce', 'NetSuite', 2);
      expect(top.length).toBe(2);
      expect(top[0].confidence).toBeGreaterThanOrEqual(top[1].confidence);
    });

    it('should return all if fewer than limit', () => {
      const top = service.getTopExamples('Salesforce', 'NetSuite', 100);
      expect(top.length).toBe(3);
    });

    it('should use default limit of 5', () => {
      const top = service.getTopExamples('Salesforce', 'NetSuite');
      expect(top.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getSimilarExamples', () => {
    it('should find exact field name match', () => {
      const similar = service.getSimilarExamples(
        'Salesforce', 'NetSuite',
        { name: 'Email', type: 'email' },
        3
      );
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].sourceField.name).toBe('Email');
    });

    it('should find partial field name match', () => {
      const similar = service.getSimilarExamples(
        'Salesforce', 'NetSuite',
        { name: 'AccountIdentifier', type: 'string' },
        3
      );
      // Should find AccountId due to partial name match
      expect(similar.length).toBeGreaterThan(0);
    });

    it('should boost type matches', () => {
      const similar = service.getSimilarExamples(
        'Salesforce', 'NetSuite',
        { name: 'ContactEmail', type: 'email' },
        3
      );
      // Email type match should score higher
      expect(similar.length).toBeGreaterThan(0);
    });

    it('should return empty for unknown system pair', () => {
      const similar = service.getSimilarExamples(
        'Unknown', 'Unknown',
        { name: 'field', type: 'string' },
        3
      );
      expect(similar).toEqual([]);
    });
  });

  describe('updateProductionMetrics', () => {
    it('should update usage count', async () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      const id = examples[0].id;
      await service.updateProductionMetrics(id, { usageCount: 10 });
      const updated = service.exportDataset().find(e => e.id === id);
      expect(updated!.productionUsageCount).toBe(10);
    });

    it('should accumulate usage count', async () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      const id = examples[0].id;
      await service.updateProductionMetrics(id, { usageCount: 5 });
      await service.updateProductionMetrics(id, { usageCount: 3 });
      const updated = service.exportDataset().find(e => e.id === id);
      expect(updated!.productionUsageCount).toBe(8);
    });

    it('should set approval rate', async () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      const id = examples[0].id;
      await service.updateProductionMetrics(id, { approvalRate: 85 });
      const updated = service.exportDataset().find(e => e.id === id);
      expect(updated!.userApprovalRate).toBe(85);
    });

    it('should average approval rate on update', async () => {
      const examples = service.getExamplesBySystemPair('Salesforce', 'NetSuite');
      const id = examples[0].id;
      await service.updateProductionMetrics(id, { approvalRate: 80 });
      await service.updateProductionMetrics(id, { approvalRate: 90 });
      const updated = service.exportDataset().find(e => e.id === id);
      expect(updated!.userApprovalRate).toBe(85);
    });

    it('should throw for nonexistent example', async () => {
      await expect(service.updateProductionMetrics('nonexistent', { usageCount: 1 }))
        .rejects.toThrow('not found');
    });
  });

  describe('getStats', () => {
    it('should return comprehensive stats', () => {
      const stats = service.getStats();
      expect(stats.totalExamples).toBe(5);
      expect(stats.bySourceSystem['Salesforce']).toBe(3);
      expect(stats.bySourceSystem['BusinessCentral']).toBe(2);
      expect(stats.byTargetSystem['NetSuite']).toBe(5);
      expect(stats.averageConfidence).toBeGreaterThan(95);
      expect(stats.verificationSources['expert_annotation']).toBe(5);
    });

    it('should count transformation types', () => {
      const stats = service.getStats();
      expect(stats.byTransformationType['direct']).toBeGreaterThanOrEqual(2);
      expect(stats.byTransformationType['lookup']).toBeGreaterThanOrEqual(2);
    });
  });

  describe('exportDataset', () => {
    it('should export all examples', () => {
      const exported = service.exportDataset();
      expect(exported.length).toBe(5);
      for (const ex of exported) {
        expect(ex.id).toBeDefined();
        expect(ex.sourceSystem).toBeDefined();
        expect(ex.targetSystem).toBeDefined();
      }
    });
  });

  describe('importDataset', () => {
    it('should import examples', async () => {
      const newService = new GoldenDatasetService();
      const examples = service.exportDataset();
      // Add a custom example
      examples.push({
        id: 'custom-import-1',
        sourceSystem: 'HubSpot',
        targetSystem: 'NetSuite',
        sourceField: { name: 'email', type: 'string' },
        targetField: 'email',
        transformationType: 'direct',
        confidence: 99,
        reasoning: 'Direct',
        verifiedBy: 'test',
        verifiedAt: new Date(),
        verificationSource: 'human_review',
      });

      const imported = await newService.importDataset(examples);
      expect(imported).toBe(examples.length);
      const stats = newService.getStats();
      expect(stats.bySourceSystem['HubSpot']).toBe(1);
    });
  });
});
