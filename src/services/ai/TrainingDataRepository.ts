import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { TrainingExample, ConfidenceSignal } from './AIFieldMappingService';
import fs from 'fs/promises';
import path from 'path';

export interface TrainingDataset {
  id: string;
  name: string;
  description: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  examples: TrainingExample[];
  metadata: TrainingMetadata;
}

export interface TrainingMetadata {
  totalExamples: number;
  sourceSystemBreakdown: Record<string, number>;
  targetSystemBreakdown: Record<string, number>;
  transformationTypeBreakdown: Record<string, number>;
  feedbackBreakdown: Record<string, number>;
  successRate: number;
  averageConfidence: number;
}

export interface LearningInsight {
  pattern: string;
  confidence: number;
  frequency: number;
  successRate: number;
  recommendation: string;
  examples: TrainingExample[];
}

export interface ModelPerformanceMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  confusionMatrix: Record<string, Record<string, number>>;
  fieldLevelMetrics: Record<string, {
    accuracy: number;
    totalPredictions: number;
    correctPredictions: number;
  }>;
}

export interface TrainingRepoOptions {
  clampMin?: number;
  clampMax?: number;
  minSamples?: number;
  storageDirectory?: string;
}

/**
 * Training Data Repository manages learning data for the AI field mapping system.
 * It stores, retrieves, and analyzes training examples to improve mapping accuracy.
 */
@injectable()
export class TrainingDataRepository {
  private logger: Logger;
  private trainingData = new Map<string, TrainingDataset>();
  private readonly storageDirectory: string;
  private readonly options: Required<Omit<TrainingRepoOptions, 'storageDirectory'>>;
  private readonly signalEffectivenessCache = new Map<string, {
    adjustments: Partial<Record<ConfidenceSignal, number>>;
    exampleCount: number;
    updatedAtMs: number;
    optionsKey: string;
  }>();
  private readonly initializationPromise: Promise<void>;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    options?: TrainingRepoOptions,
  ) {
    this.logger = logger;
    this.options = {
      clampMin: options?.clampMin ?? 0.75,
      clampMax: options?.clampMax ?? 1.25,
      minSamples: options?.minSamples ?? 3,
    };
    this.storageDirectory = options?.storageDirectory
      ? options.storageDirectory
      : path.join(process.cwd(), 'data', 'ai-training');
    this.initializationPromise = this.initializeStorage();
  }

  /**
   * Store a training example
   */
  async storeTrainingExample(example: TrainingExample, datasetId = 'default'): Promise<void> {
    await this.initializationPromise;

    this.logger.debug('Storing training example', {
      exampleId: example.id,
      datasetId,
      sourceSystem: example.sourceSystem,
      targetSystem: example.targetSystem,
    });

    let dataset = this.trainingData.get(datasetId);

    if (!dataset) {
      dataset = await this.createDataset(datasetId, `Training Dataset ${datasetId}`);
    }

    // Add example to dataset
    dataset.examples.push(example);
    dataset.updatedAt = new Date();
    dataset.metadata = this.calculateMetadata(dataset.examples);

    // Persist to disk
    await this.persistDataset(dataset);

    this.logger.info('Training example stored successfully', {
      exampleId: example.id,
      datasetId,
      totalExamples: dataset.examples.length,
    });
    // Invalidate effectiveness cache for this dataset
    this.signalEffectivenessCache.delete(datasetId);
  }

  /**
   * Retrieve training examples by criteria
   */
  async getTrainingExamples(criteria: {
    sourceSystem?: string;
    targetSystem?: string;
    sourceField?: string;
    targetField?: string;
    transformationType?: string;
    userFeedback?: 'positive' | 'negative' | 'neutral';
    successRateThreshold?: number;
    limit?: number;
    datasetId?: string;
  }): Promise<TrainingExample[]> {
    await this.initializationPromise;

    this.logger.debug('Retrieving training examples', criteria);

    const datasetId = criteria.datasetId || 'default';
    const dataset = this.trainingData.get(datasetId);

    if (!dataset) {
      this.logger.warn('Dataset not found', { datasetId });
      return [];
    }

    let examples = dataset.examples;

    // Apply filters
    if (criteria.sourceSystem) {
      examples = examples.filter(e => e.sourceSystem === criteria.sourceSystem);
    }

    if (criteria.targetSystem) {
      examples = examples.filter(e => e.targetSystem === criteria.targetSystem);
    }

    if (criteria.sourceField) {
      examples = examples.filter(e => e.sourceField === criteria.sourceField);
    }

    if (criteria.targetField) {
      examples = examples.filter(e => e.targetField === criteria.targetField);
    }

    if (criteria.transformationType) {
      examples = examples.filter(e => e.transformationType === criteria.transformationType);
    }

    if (criteria.userFeedback) {
      examples = examples.filter(e => e.userFeedback === criteria.userFeedback);
    }

    if (criteria.successRateThreshold !== undefined) {
      examples = examples.filter(e => e.successRate >= (criteria.successRateThreshold ?? 0));
    }

    // Apply limit
    if (criteria.limit) {
      examples = examples.slice(0, criteria.limit);
    }

    this.logger.debug('Retrieved training examples', {
      totalFound: examples.length,
      criteria,
    });

    return examples;
  }

  /**
   * Analyze training data to extract learning insights
   */
  async analyzeLearningInsights(datasetId = 'default'): Promise<LearningInsight[]> {
    await this.initializationPromise;

    this.logger.debug('Analyzing learning insights', { datasetId });

    const dataset = this.trainingData.get(datasetId);
    if (!dataset) {
      return [];
    }

    const insights: LearningInsight[] = [];

    // Analyze field mapping patterns
    const fieldMappingPatterns = this.analyzeFieldMappingPatterns(dataset.examples);
    insights.push(...fieldMappingPatterns);

    // Analyze transformation patterns
    const transformationPatterns = this.analyzeTransformationPatterns(dataset.examples);
    insights.push(...transformationPatterns);

    // Analyze system-specific patterns
    const systemPatterns = this.analyzeSystemPatterns(dataset.examples);
    insights.push(...systemPatterns);

    // Sort by confidence and frequency
    insights.sort((a, b) => (b.confidence * b.frequency) - (a.confidence * a.frequency));

    this.logger.info('Learning insights analyzed', {
      datasetId,
      insightCount: insights.length,
      topInsight: insights[0]?.pattern,
    });

    return insights;
  }

  /**
   * Get model performance metrics
   */
  async getModelPerformanceMetrics(datasetId = 'default'): Promise<ModelPerformanceMetrics> {
    await this.initializationPromise;

    const dataset = this.trainingData.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    const examples = dataset.examples;
    const totalExamples = examples.length;
    const positiveExamples = examples.filter(e => e.userFeedback === 'positive').length;
    const negativeExamples = examples.filter(e => e.userFeedback === 'negative').length;

    // Calculate basic metrics
    const accuracy = positiveExamples / totalExamples;
    const precision = positiveExamples / (positiveExamples + negativeExamples) || 0;
    const recall = positiveExamples / totalExamples;
    const f1Score = 2 * (precision * recall) / (precision + recall) || 0;

    // Build confusion matrix (simplified)
    const confusionMatrix = {
      'positive': { 'positive': positiveExamples, 'negative': 0 },
      'negative': { 'positive': 0, 'negative': negativeExamples },
    };

    // Calculate field-level metrics
    const fieldMetrics: Record<string, { accuracy: number; totalPredictions: number; correctPredictions: number }> = {};

    const fieldGroups = new Map<string, TrainingExample[]>();
    examples.forEach(example => {
      const key = `${example.sourceField}->${example.targetField}`;
      if (!fieldGroups.has(key)) {
        fieldGroups.set(key, []);
      }
      fieldGroups.get(key)!.push(example);
    });

    for (const [fieldMapping, fieldExamples] of fieldGroups.entries()) {
      const correctPredictions = fieldExamples.filter(e => e.userFeedback === 'positive').length;
      const totalPredictions = fieldExamples.length;

      fieldMetrics[fieldMapping] = {
        accuracy: correctPredictions / totalPredictions,
        totalPredictions,
        correctPredictions,
      };
    }

    return {
      accuracy,
      precision,
      recall,
      f1Score,
      confusionMatrix,
      fieldLevelMetrics: fieldMetrics,
    };
  }

  /**
   * Compute effectiveness multipliers for each confidence signal based on
   * stored training feedback. Returns per-signal adjustments centered at 1.0.
   * Values > 1 increase weight; < 1 decrease it. Lightly clamped for stability.
   */
  async getSignalEffectiveness(
    datasetId = 'default',
  ): Promise<Partial<Record<ConfidenceSignal, number>>> {
    await this.initializationPromise;

    const dataset = this.trainingData.get(datasetId);
    if (!dataset || dataset.examples.length === 0) {
      return {};
    }
    // Return memoized value if dataset unchanged and options match
    const optionsKey = `min:${this.options.minSamples}|lo:${this.options.clampMin}|hi:${this.options.clampMax}`;
    const cached = this.signalEffectivenessCache.get(datasetId);
    const dsUpdatedMs = new Date((dataset as any).updatedAt).getTime();
    if (cached &&
        cached.exampleCount === dataset.examples.length &&
        cached.updatedAtMs === dsUpdatedMs &&
        cached.optionsKey === optionsKey) {
      return cached.adjustments;
    }

    const examples = dataset.examples;

    // Overall baseline success with Laplace smoothing for stability
    const totalCount = examples.length;
    const totalSuccess = examples.reduce((sum, e) => sum + (typeof e.successRate === 'number' ? e.successRate : (e.userFeedback === 'positive' ? 1 : 0)), 0);
    const overall = (totalSuccess + 1) / (totalCount + 2);

    const adjustments: Partial<Record<ConfidenceSignal, number>> = {};
    const allSignals: ConfidenceSignal[] = ['semantic', 'pattern', 'netsuite'];

    for (const signal of allSignals) {
      const relevant = examples.filter(e => Array.isArray((e as any).context?.signals) && (e as any).context.signals.includes(signal));
      if (relevant.length < this.options.minSamples) {
        continue;
      }

      const success = relevant.reduce((sum, e) => sum + (typeof e.successRate === 'number' ? e.successRate : (e.userFeedback === 'positive' ? 1 : 0)), 0);
      const pHat = (success + 1) / (relevant.length + 2);
      let multiplier = overall > 0 ? (pHat / overall) : 1.0;

      // Clamp to reduce volatility from small samples
      const MIN = this.options.clampMin;
      const MAX = this.options.clampMax;
      if (multiplier < MIN) multiplier = MIN;
      if (multiplier > MAX) multiplier = MAX;
      adjustments[signal] = multiplier;
    }

    this.logger.debug('Calculated signal effectiveness', {
      datasetId,
      overall,
      adjustments,
    });

    // Cache and return
    this.signalEffectivenessCache.set(datasetId, {
      adjustments,
      exampleCount: examples.length,
      updatedAtMs: dsUpdatedMs,
      optionsKey,
    });
    return adjustments;
  }

  /**
   * Update training example with user feedback
   */
  async updateTrainingExample(
    exampleId: string,
    feedback: {
      userFeedback?: 'positive' | 'negative' | 'neutral';
      successRate?: number;
      context?: Record<string, unknown>;
    },
    datasetId = 'default',
  ): Promise<void> {
    await this.initializationPromise;

    const dataset = this.trainingData.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    const example = dataset.examples.find(e => e.id === exampleId);
    if (!example) {
      throw new Error(`Training example ${exampleId} not found`);
    }

    // Update example
    if (feedback.userFeedback) {
      example.userFeedback = feedback.userFeedback;
    }
    if (feedback.successRate !== undefined) {
      example.successRate = feedback.successRate;
    }
    if (feedback.context) {
      example.context = { ...example.context, ...feedback.context };
    }

    // Update dataset metadata
    dataset.updatedAt = new Date();
    dataset.metadata = this.calculateMetadata(dataset.examples);

    // Persist changes
    await this.persistDataset(dataset);

    this.logger.info('Training example updated', {
      exampleId,
      feedback,
      datasetId,
    });
    // Invalidate effectiveness cache for this dataset
    this.signalEffectivenessCache.delete(datasetId);
  }

  /**
   * Export training dataset
   */
  async exportDataset(datasetId = 'default', format: 'json' | 'csv' = 'json'): Promise<string> {
    const dataset = this.trainingData.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    const exportPath = path.join(this.storageDirectory, 'exports', `${datasetId}_${Date.now()}.${format}`);

    if (format === 'json') {
      await fs.writeFile(exportPath, JSON.stringify(dataset, null, 2));
    } else {
      const csvContent = this.convertToCSV(dataset.examples);
      await fs.writeFile(exportPath, csvContent);
    }

    this.logger.info('Dataset exported', {
      datasetId,
      format,
      exportPath,
      exampleCount: dataset.examples.length,
    });

    return exportPath;
  }

  /**
   * Import training dataset
   */
  async importDataset(filePath: string, datasetId?: string): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const dataset: TrainingDataset = JSON.parse(content);

    const targetDatasetId = datasetId || dataset.id;

    // Validate and store dataset
    this.trainingData.set(targetDatasetId, {
      ...dataset,
      id: targetDatasetId,
      updatedAt: new Date(),
    });

    await this.persistDataset(this.trainingData.get(targetDatasetId)!);

    this.logger.info('Dataset imported', {
      datasetId: targetDatasetId,
      exampleCount: dataset.examples.length,
      sourceFile: filePath,
    });

    // Invalidate cache for imported dataset
    this.signalEffectivenessCache.delete(targetDatasetId);
    return targetDatasetId;
  }

  /**
   * Get dataset statistics
   */
  async getDatasetStatistics(datasetId = 'default'): Promise<TrainingMetadata> {
    await this.initializationPromise;

    const dataset = this.trainingData.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    return dataset.metadata;
  }

  /**
   * Initialize storage directory
   */
  private async initializeStorage(): Promise<void> {
    try {
      await fs.mkdir(this.storageDirectory, { recursive: true });
      await fs.mkdir(path.join(this.storageDirectory, 'exports'), { recursive: true });

      // Load existing datasets
      await this.loadExistingDatasets();

      this.logger.info('Training data repository initialized', {
        storageDirectory: this.storageDirectory,
      });
    } catch (error) {
      this.logger.error('Failed to initialize training data repository', error);
      throw error;
    }
  }

  /**
   * Load existing datasets from disk
   */
  private async loadExistingDatasets(): Promise<void> {
    try {
      const files = await fs.readdir(this.storageDirectory);
      const datasetFiles = files.filter(file => file.endsWith('.json'));

      for (const file of datasetFiles) {
        const filePath = path.join(this.storageDirectory, file);
        const content = await fs.readFile(filePath, 'utf-8');
        type RawExample = Record<string, unknown> & { createdAt?: string | number | Date };
        type RawDataset = Partial<{
          id: string;
          name: string;
          description: string;
          version: string;
          createdAt: string | number | Date;
          updatedAt: string | number | Date;
          examples: RawExample[];
          metadata: Record<string, unknown>;
        }>;
        const parsed = JSON.parse(content) as RawDataset;
        if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
          this.logger.warn('Skipping dataset file with missing or invalid id', { file });
          continue;
        }
        const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : new Date();
        const updatedAt = parsed.updatedAt ? new Date(parsed.updatedAt) : createdAt;
        const normalizedExamples = Array.isArray(parsed.examples)
          ? parsed.examples.map(ex => ({ ...ex, createdAt: ex?.createdAt ? new Date(ex.createdAt) : new Date(createdAt) }))
          : [];
        // Treat imported on-disk JSON as a trust boundary: files may contain
        // arbitrary content (importDataset persists user-supplied JSON without
        // schema validation, and files can also be hand-edited). This path
        // performs only minimal checks and normalization — id presence above,
        // dates here, examples preserved as Record<string, unknown>, and a
        // computed metadata fallback for files written before that field was
        // tracked. Going through `unknown` keeps that boundary explicit in
        // one place because the parsed examples retain a Record<string,
        // unknown> shape rather than the stricter `TrainingExample` type.
        const dataset = {
          id: parsed.id,
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          createdAt,
          updatedAt,
          examples: normalizedExamples,
          metadata: parsed.metadata ?? this.calculateMetadata(normalizedExamples as TrainingExample[]),
        } as unknown as TrainingDataset;
        this.trainingData.set(dataset.id, dataset);
      }

      this.logger.info('Existing datasets loaded', {
        datasetCount: datasetFiles.length,
      });
    } catch (error) {
      this.logger.debug('No existing datasets found or error loading', { error });
    }
  }

  /**
   * Create a new dataset
   */
  private async createDataset(id: string, name: string): Promise<TrainingDataset> {
    const dataset: TrainingDataset = {
      id,
      name,
      description: `AI field mapping training dataset: ${name}`,
      version: '1.0.0',
      createdAt: new Date(),
      updatedAt: new Date(),
      examples: [],
      metadata: {
        totalExamples: 0,
        sourceSystemBreakdown: {},
        targetSystemBreakdown: {},
        transformationTypeBreakdown: {},
        feedbackBreakdown: {},
        successRate: 0,
        averageConfidence: 0,
      },
    };

    this.trainingData.set(id, dataset);
    await this.persistDataset(dataset);

    return dataset;
  }

  /**
   * Persist dataset to disk
   */
  private async persistDataset(dataset: TrainingDataset): Promise<void> {
    const filePath = path.join(this.storageDirectory, `${dataset.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(dataset, null, 2));
  }

  /**
   * Calculate dataset metadata
   */
  private calculateMetadata(examples: TrainingExample[]): TrainingMetadata {
    const metadata: TrainingMetadata = {
      totalExamples: examples.length,
      sourceSystemBreakdown: {},
      targetSystemBreakdown: {},
      transformationTypeBreakdown: {},
      feedbackBreakdown: {},
      successRate: 0,
      averageConfidence: 0,
    };

    if (examples.length === 0) {
      return metadata;
    }

    // Count by source system
    examples.forEach(example => {
      metadata.sourceSystemBreakdown[example.sourceSystem] =
        (metadata.sourceSystemBreakdown[example.sourceSystem] || 0) + 1;

      metadata.targetSystemBreakdown[example.targetSystem] =
        (metadata.targetSystemBreakdown[example.targetSystem] || 0) + 1;

      metadata.transformationTypeBreakdown[example.transformationType] =
        (metadata.transformationTypeBreakdown[example.transformationType] || 0) + 1;

      metadata.feedbackBreakdown[example.userFeedback] =
        (metadata.feedbackBreakdown[example.userFeedback] || 0) + 1;
    });

    // Calculate success rate
    const positiveExamples = examples.filter(e => e.userFeedback === 'positive').length;
    metadata.successRate = positiveExamples / examples.length;

    // Calculate average confidence (based on success rate)
    metadata.averageConfidence = examples.reduce((sum, e) => sum + e.successRate, 0) / examples.length;

    return metadata;
  }

  /**
   * Analyze field mapping patterns
   */
  private analyzeFieldMappingPatterns(examples: TrainingExample[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    const patterns = new Map<string, TrainingExample[]>();

    // Group by field mapping pattern
    examples.forEach(example => {
      const pattern = `${example.sourceField}->${example.targetField}`;
      if (!patterns.has(pattern)) {
        patterns.set(pattern, []);
      }
      patterns.get(pattern)!.push(example);
    });

    // Analyze each pattern
    for (const [pattern, patternExamples] of patterns.entries()) {
      if (patternExamples.length < 3) continue; // Skip patterns with too few examples

      const successfulExamples = patternExamples.filter(e => e.userFeedback === 'positive').length;
      const successRate = successfulExamples / patternExamples.length;

      if (successRate >= 0.7) { // Only include successful patterns
        insights.push({
          pattern: `Field mapping: ${pattern}`,
          confidence: successRate,
          frequency: patternExamples.length,
          successRate,
          recommendation: 'Consider using this mapping pattern for similar fields',
          examples: patternExamples.slice(0, 3),
        });
      }
    }

    return insights;
  }

  /**
   * Analyze transformation patterns
   */
  private analyzeTransformationPatterns(examples: TrainingExample[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    const patterns = new Map<string, TrainingExample[]>();

    // Group by transformation type and field types
    examples.forEach(example => {
      const pattern = `${example.transformationType}`;
      if (!patterns.has(pattern)) {
        patterns.set(pattern, []);
      }
      patterns.get(pattern)!.push(example);
    });

    for (const [transformationType, patternExamples] of patterns.entries()) {
      const successfulExamples = patternExamples.filter(e => e.userFeedback === 'positive').length;
      const successRate = successfulExamples / patternExamples.length;

      insights.push({
        pattern: `Transformation: ${transformationType}`,
        confidence: successRate,
        frequency: patternExamples.length,
        successRate,
        recommendation: `${transformationType} transformation has ${Math.round(successRate * 100)}% success rate`,
        examples: patternExamples.slice(0, 3),
      });
    }

    return insights;
  }

  /**
   * Analyze system-specific patterns
   */
  private analyzeSystemPatterns(examples: TrainingExample[]): LearningInsight[] {
    const insights: LearningInsight[] = [];
    const patterns = new Map<string, TrainingExample[]>();

    // Group by system combination
    examples.forEach(example => {
      const pattern = `${example.sourceSystem}->${example.targetSystem}`;
      if (!patterns.has(pattern)) {
        patterns.set(pattern, []);
      }
      patterns.get(pattern)!.push(example);
    });

    for (const [systemPattern, patternExamples] of patterns.entries()) {
      const successfulExamples = patternExamples.filter(e => e.userFeedback === 'positive').length;
      const successRate = successfulExamples / patternExamples.length;

      insights.push({
        pattern: `System integration: ${systemPattern}`,
        confidence: successRate,
        frequency: patternExamples.length,
        successRate,
        recommendation: `Integration pattern has ${Math.round(successRate * 100)}% success rate`,
        examples: patternExamples.slice(0, 3),
      });
    }

    return insights;
  }

  /**
   * Convert training examples to CSV format
   */
  private convertToCSV(examples: TrainingExample[]): string {
    if (examples.length === 0) return '';

    const headers = ['id', 'sourceSystem', 'targetSystem', 'sourceField', 'targetField',
      'transformationType', 'successRate', 'userFeedback', 'createdAt'];

    const rows = examples.map(example => [
      example.id,
      example.sourceSystem,
      example.targetSystem,
      example.sourceField,
      example.targetField,
      example.transformationType,
      example.successRate.toString(),
      example.userFeedback,
      example.createdAt.toISOString(),
    ]);

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  }

  /**
   * List available training datasets with basic metadata.
   */
  async listDatasets(): Promise<{ id: string; name: string; exampleCount: number; updatedAt: string }[]> {
    await this.initializationPromise;

    const results: { id: string; name: string; exampleCount: number; updatedAt: string }[] = [];
    for (const dataset of this.trainingData.values()) {
      results.push({
        id: dataset.id,
        name: dataset.name,
        exampleCount: dataset.examples.length,
        updatedAt: (dataset.updatedAt instanceof Date ? dataset.updatedAt : new Date((dataset as any).updatedAt)).toISOString(),
      });
    }
    results.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return results;
  }}



