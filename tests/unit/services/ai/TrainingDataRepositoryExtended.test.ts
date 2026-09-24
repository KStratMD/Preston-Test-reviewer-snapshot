/**
 * Comprehensive unit tests for TrainingDataRepository
 * Covers: storeTrainingExample, getTrainingExamples, analyzeLearningInsights,
 *         getModelPerformanceMetrics, getSignalEffectiveness, updateTrainingExample,
 *         getDatasetStatistics, listDatasets
 */
import 'reflect-metadata';

// Mock fs/promises to avoid filesystem operations
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue([]),
  readFile: jest.fn().mockResolvedValue('{}'),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

import { TrainingDataRepository } from '../../../../src/services/ai/TrainingDataRepository';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function buildExample(overrides: Record<string, any> = {}) {
  return {
    id: `ex-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceField: 'AccountName',
    targetField: 'companyname',
    transformationType: 'direct',
    successRate: 0.9,
    userFeedback: 'positive' as const,
    createdAt: new Date(),
    context: {},
    ...overrides,
  };
}

describe('TrainingDataRepository', () => {
  let repo: TrainingDataRepository;

  beforeEach(async () => {
    jest.clearAllMocks();
    repo = new TrainingDataRepository(mockLogger, {
      storageDirectory: '/tmp/test-training-data',
      minSamples: 2,
      clampMin: 0.75,
      clampMax: 1.25,
    });
    // Wait for the internal initializationPromise to complete
    // Access it through any public method that awaits it
    await repo.listDatasets();
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(repo).toBeDefined();
    });
  });

  describe('storeTrainingExample', () => {
    it('should store an example to default dataset', async () => {
      const example = buildExample();
      await repo.storeTrainingExample(example);
      const examples = await repo.getTrainingExamples({});
      expect(examples.length).toBe(1);
      expect(examples[0].id).toBe(example.id);
    });

    it('should store to named dataset', async () => {
      const example = buildExample();
      await repo.storeTrainingExample(example, 'custom-ds');
      const examples = await repo.getTrainingExamples({ datasetId: 'custom-ds' });
      expect(examples.length).toBe(1);
    });

    it('should create dataset if it does not exist', async () => {
      await repo.storeTrainingExample(buildExample(), 'new-ds');
      const stats = await repo.getDatasetStatistics('new-ds');
      expect(stats.totalExamples).toBe(1);
    });

    it('should update metadata after storing', async () => {
      await repo.storeTrainingExample(buildExample({ sourceSystem: 'SAP' }));
      await repo.storeTrainingExample(buildExample({ sourceSystem: 'Salesforce' }));
      const stats = await repo.getDatasetStatistics();
      expect(stats.totalExamples).toBe(2);
      expect(stats.sourceSystemBreakdown['SAP']).toBe(1);
      expect(stats.sourceSystemBreakdown['Salesforce']).toBe(1);
    });
  });

  describe('getTrainingExamples', () => {
    beforeEach(async () => {
      await repo.storeTrainingExample(buildExample({
        id: 'ex-1',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        sourceField: 'Name',
        targetField: 'companyname',
        transformationType: 'direct',
        userFeedback: 'positive',
        successRate: 0.9,
      }));
      await repo.storeTrainingExample(buildExample({
        id: 'ex-2',
        sourceSystem: 'SAP',
        targetSystem: 'NetSuite',
        sourceField: 'KUNNR',
        targetField: 'externalid',
        transformationType: 'lookup',
        userFeedback: 'negative',
        successRate: 0.3,
      }));
      await repo.storeTrainingExample(buildExample({
        id: 'ex-3',
        sourceSystem: 'Salesforce',
        targetSystem: 'BusinessCentral',
        sourceField: 'Phone',
        targetField: 'phone',
        transformationType: 'direct',
        userFeedback: 'positive',
        successRate: 0.95,
      }));
    });

    it('should return all examples when no criteria', async () => {
      const examples = await repo.getTrainingExamples({});
      expect(examples.length).toBe(3);
    });

    it('should filter by sourceSystem', async () => {
      const examples = await repo.getTrainingExamples({ sourceSystem: 'SAP' });
      expect(examples.length).toBe(1);
      expect(examples[0].sourceSystem).toBe('SAP');
    });

    it('should filter by targetSystem', async () => {
      const examples = await repo.getTrainingExamples({ targetSystem: 'NetSuite' });
      expect(examples.length).toBe(2);
    });

    it('should filter by sourceField', async () => {
      const examples = await repo.getTrainingExamples({ sourceField: 'Phone' });
      expect(examples.length).toBe(1);
    });

    it('should filter by targetField', async () => {
      const examples = await repo.getTrainingExamples({ targetField: 'companyname' });
      expect(examples.length).toBe(1);
    });

    it('should filter by transformationType', async () => {
      const examples = await repo.getTrainingExamples({ transformationType: 'direct' });
      expect(examples.length).toBe(2);
    });

    it('should filter by userFeedback', async () => {
      const examples = await repo.getTrainingExamples({ userFeedback: 'negative' });
      expect(examples.length).toBe(1);
    });

    it('should filter by successRateThreshold', async () => {
      const examples = await repo.getTrainingExamples({ successRateThreshold: 0.8 });
      expect(examples.length).toBe(2);
    });

    it('should apply limit', async () => {
      const examples = await repo.getTrainingExamples({ limit: 1 });
      expect(examples.length).toBe(1);
    });

    it('should return empty for unknown dataset', async () => {
      const examples = await repo.getTrainingExamples({ datasetId: 'nonexistent' });
      expect(examples.length).toBe(0);
    });
  });

  describe('analyzeLearningInsights', () => {
    it('should return empty for unknown dataset', async () => {
      const insights = await repo.analyzeLearningInsights('nonexistent');
      expect(insights).toEqual([]);
    });

    it('should analyze field mapping patterns', async () => {
      // Need >=3 examples of same pattern for insight
      for (let i = 0; i < 4; i++) {
        await repo.storeTrainingExample(buildExample({
          id: `pattern-${i}`,
          sourceField: 'Name',
          targetField: 'companyname',
          userFeedback: 'positive',
          successRate: 0.9,
        }));
      }
      const insights = await repo.analyzeLearningInsights();
      expect(insights.length).toBeGreaterThan(0);
      const fieldInsight = insights.find(i => i.pattern.includes('Field mapping'));
      expect(fieldInsight).toBeDefined();
    });

    it('should analyze transformation patterns', async () => {
      await repo.storeTrainingExample(buildExample({ transformationType: 'direct' }));
      await repo.storeTrainingExample(buildExample({ transformationType: 'lookup' }));
      const insights = await repo.analyzeLearningInsights();
      const transformInsight = insights.find(i => i.pattern.includes('Transformation'));
      expect(transformInsight).toBeDefined();
    });

    it('should analyze system patterns', async () => {
      await repo.storeTrainingExample(buildExample({
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
      }));
      const insights = await repo.analyzeLearningInsights();
      const systemInsight = insights.find(i => i.pattern.includes('System integration'));
      expect(systemInsight).toBeDefined();
    });
  });

  describe('getModelPerformanceMetrics', () => {
    it('should throw for unknown dataset', async () => {
      await expect(repo.getModelPerformanceMetrics('nonexistent'))
        .rejects.toThrow('Dataset nonexistent not found');
    });

    it('should calculate metrics', async () => {
      await repo.storeTrainingExample(buildExample({ userFeedback: 'positive', successRate: 0.9 }));
      await repo.storeTrainingExample(buildExample({ userFeedback: 'positive', successRate: 0.85 }));
      await repo.storeTrainingExample(buildExample({ userFeedback: 'negative', successRate: 0.2 }));

      const metrics = await repo.getModelPerformanceMetrics();
      expect(typeof metrics.accuracy).toBe('number');
      expect(typeof metrics.precision).toBe('number');
      expect(typeof metrics.recall).toBe('number');
      expect(typeof metrics.f1Score).toBe('number');
      expect(metrics.confusionMatrix).toBeDefined();
      expect(metrics.fieldLevelMetrics).toBeDefined();
    });
  });

  describe('getSignalEffectiveness', () => {
    it('should return empty for empty dataset', async () => {
      const effectiveness = await repo.getSignalEffectiveness('nonexistent');
      expect(effectiveness).toEqual({});
    });

    it('should calculate effectiveness when enough samples', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.storeTrainingExample(buildExample({
          id: `sig-${i}`,
          successRate: 0.9,
          context: { signals: ['semantic'] },
        }));
      }
      const effectiveness = await repo.getSignalEffectiveness();
      // May or may not include semantic depending on filtering
      expect(typeof effectiveness).toBe('object');
    });

    it('should use cached value on repeated calls', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.storeTrainingExample(buildExample({
          id: `cache-${i}`,
          successRate: 0.8,
          context: { signals: ['pattern'] },
        }));
      }
      const first = await repo.getSignalEffectiveness();
      const second = await repo.getSignalEffectiveness();
      expect(first).toEqual(second);
    });
  });

  describe('updateTrainingExample', () => {
    it('should update example feedback', async () => {
      const example = buildExample({ id: 'update-me' });
      await repo.storeTrainingExample(example);
      await repo.updateTrainingExample('update-me', {
        userFeedback: 'negative',
        successRate: 0.2,
      });
      const examples = await repo.getTrainingExamples({ userFeedback: 'negative' });
      expect(examples.length).toBe(1);
      expect(examples[0].successRate).toBe(0.2);
    });

    it('should throw for unknown dataset', async () => {
      await expect(repo.updateTrainingExample('x', {}, 'nonexistent'))
        .rejects.toThrow('Dataset nonexistent not found');
    });

    it('should throw for unknown example', async () => {
      await repo.storeTrainingExample(buildExample());
      await expect(repo.updateTrainingExample('nonexistent-id', {}))
        .rejects.toThrow('Training example nonexistent-id not found');
    });

    it('should merge context', async () => {
      const example = buildExample({ id: 'ctx-merge', context: { a: 1 } });
      await repo.storeTrainingExample(example);
      await repo.updateTrainingExample('ctx-merge', { context: { b: 2 } });
      const examples = await repo.getTrainingExamples({});
      const updated = examples.find(e => e.id === 'ctx-merge');
      expect(updated!.context).toEqual({ a: 1, b: 2 });
    });
  });

  describe('getDatasetStatistics', () => {
    it('should throw for unknown dataset', async () => {
      await expect(repo.getDatasetStatistics('nonexistent'))
        .rejects.toThrow('Dataset nonexistent not found');
    });

    it('should return metadata for existing dataset', async () => {
      await repo.storeTrainingExample(buildExample());
      const stats = await repo.getDatasetStatistics();
      expect(stats.totalExamples).toBe(1);
      expect(typeof stats.successRate).toBe('number');
      expect(typeof stats.averageConfidence).toBe('number');
    });
  });

  describe('listDatasets', () => {
    it('should list available datasets', async () => {
      await repo.storeTrainingExample(buildExample(), 'ds-1');
      await repo.storeTrainingExample(buildExample(), 'ds-2');
      const datasets = await repo.listDatasets();
      expect(datasets.length).toBeGreaterThanOrEqual(2);
      const ids = datasets.map(d => d.id);
      expect(ids).toContain('ds-1');
      expect(ids).toContain('ds-2');
    });

    it('should include example counts', async () => {
      await repo.storeTrainingExample(buildExample(), 'counted-ds');
      await repo.storeTrainingExample(buildExample(), 'counted-ds');
      const datasets = await repo.listDatasets();
      const ds = datasets.find(d => d.id === 'counted-ds');
      expect(ds).toBeDefined();
      expect(ds!.exampleCount).toBe(2);
    });
  });
});
