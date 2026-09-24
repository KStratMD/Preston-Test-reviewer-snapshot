/**
 * Golden Dataset Service - Phase 3 AI Accuracy Improvements
 * Manages high-quality, human-verified mapping examples for training and evaluation
 *
 * Purpose:
 * - Store curated mapping examples with verification metadata
 * - Provide training data for few-shot learning
 * - Enable accuracy measurement and benchmarking
 * - Support continuous improvement through golden set expansion
 */

import type { AISuggestion } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';
import { logger } from '../../../utils/Logger';

export interface GoldenExample {
  id: string;
  sourceSystem: string;
  targetSystem: string;
  sourceField: FieldMetadata;
  targetField: string;
  transformationType: string;
  confidence: number; // Human-verified confidence (typically 95-100%)
  reasoning: string;
  // Verification metadata
  verifiedBy: string; // User who verified this mapping
  verifiedAt: Date;
  verificationSource: 'human_review' | 'production_success' | 'expert_annotation';
  // Quality indicators
  productionUsageCount?: number; // How many times used successfully in production
  userApprovalRate?: number; // % of users who approved this mapping (0-100)
  // Context
  sampleValues?: unknown[]; // Sample values that demonstrate the mapping
  tags?: string[]; // Categorization tags (e.g., 'crm', 'erp', 'finance')
}

export interface GoldenDatasetStats {
  totalExamples: number;
  bySourceSystem: Record<string, number>;
  byTargetSystem: Record<string, number>;
  byTransformationType: Record<string, number>;
  averageConfidence: number;
  verificationSources: Record<string, number>;
}

export interface GoldenDatasetConfig {
  minConfidence?: number; // Minimum confidence for golden examples (default: 95)
  maxExamplesPerSystem?: number; // Max examples per system pair (default: 100)
  storageBackend?: 'memory' | 'filesystem' | 'database'; // Default: memory
}

export class GoldenDatasetService {
  private goldenExamples = new Map<string, GoldenExample>();
  private logger = logger;
  private config: Required<GoldenDatasetConfig>;

  constructor(config: GoldenDatasetConfig = {}) {
    this.config = {
      minConfidence: config.minConfidence ?? 95,
      maxExamplesPerSystem: config.maxExamplesPerSystem ?? 100,
      storageBackend: config.storageBackend ?? 'memory'
    };

    // Initialize with seed examples
    this.initializeSeedExamples();
  }

  /**
   * Add a golden example to the dataset
   */
  async addExample(example: Omit<GoldenExample, 'id'>): Promise<string> {
    // Validate confidence threshold
    if (example.confidence < this.config.minConfidence) {
      throw new Error(
        `Golden example confidence ${example.confidence}% is below minimum ${this.config.minConfidence}%`
      );
    }

    // Generate unique ID
    const id = this.generateExampleId(
      example.sourceSystem,
      example.targetSystem,
      example.sourceField.name,
      example.targetField
    );

    // Check if we've reached max examples for this system pair
    const systemPairKey = `${example.sourceSystem}-${example.targetSystem}`;
    const existingCount = this.getExamplesBySystemPair(example.sourceSystem, example.targetSystem).length;

    if (existingCount >= this.config.maxExamplesPerSystem) {
      this.logger.warn('Max golden examples reached for system pair', {
        systemPair: systemPairKey,
        max: this.config.maxExamplesPerSystem
      });
      // Remove lowest confidence example to make room
      this.removeLowestConfidenceExample(example.sourceSystem, example.targetSystem);
    }

    const goldenExample: GoldenExample = {
      id,
      ...example
    };

    this.goldenExamples.set(id, goldenExample);

    this.logger.info('Golden example added', {
      id,
      sourceSystem: example.sourceSystem,
      targetSystem: example.targetSystem,
      confidence: example.confidence,
      verificationSource: example.verificationSource
    });

    return id;
  }

  /**
   * Get examples for a specific system pair
   */
  getExamplesBySystemPair(sourceSystem: string, targetSystem: string): GoldenExample[] {
    return Array.from(this.goldenExamples.values())
      .filter(ex => ex.sourceSystem === sourceSystem && ex.targetSystem === targetSystem)
      .sort((a, b) => b.confidence - a.confidence); // Sort by confidence descending
  }

  /**
   * Get top N examples for few-shot learning
   */
  getTopExamples(
    sourceSystem: string,
    targetSystem: string,
    limit = 5
  ): GoldenExample[] {
    return this.getExamplesBySystemPair(sourceSystem, targetSystem)
      .slice(0, limit);
  }

  /**
   * Get examples similar to a source field (for context-aware few-shot learning)
   */
  getSimilarExamples(
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata,
    limit = 3
  ): GoldenExample[] {
    const allExamples = this.getExamplesBySystemPair(sourceSystem, targetSystem);

    // Score by similarity (field name, type)
    const scored = allExamples.map(example => {
      let score = 0;

      // Field name similarity (simple contains check)
      const sourceNameLower = sourceField.name.toLowerCase();
      const exampleNameLower = example.sourceField.name.toLowerCase();
      if (sourceNameLower === exampleNameLower) score += 100;
      else if (sourceNameLower.includes(exampleNameLower) || exampleNameLower.includes(sourceNameLower)) score += 50;

      // Type match
      if (sourceField.type === example.sourceField.type) score += 30;

      // Boost production-validated examples
      if (example.productionUsageCount && example.productionUsageCount > 10) score += 20;

      return { example, score };
    });

    // Sort by score and return top N
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.example);
  }

  /**
   * Update example with production usage data
   */
  async updateProductionMetrics(
    exampleId: string,
    metrics: { usageCount?: number; approvalRate?: number }
  ): Promise<void> {
    const example = this.goldenExamples.get(exampleId);
    if (!example) {
      throw new Error(`Golden example ${exampleId} not found`);
    }

    if (metrics.usageCount !== undefined) {
      example.productionUsageCount = (example.productionUsageCount || 0) + metrics.usageCount;
    }

    if (metrics.approvalRate !== undefined) {
      // Update approval rate (weighted average if exists)
      if (example.userApprovalRate !== undefined) {
        example.userApprovalRate = (example.userApprovalRate + metrics.approvalRate) / 2;
      } else {
        example.userApprovalRate = metrics.approvalRate;
      }
    }

    this.goldenExamples.set(exampleId, example);
  }

  /**
   * Get dataset statistics
   */
  getStats(): GoldenDatasetStats {
    const examples = Array.from(this.goldenExamples.values());

    const stats: GoldenDatasetStats = {
      totalExamples: examples.length,
      bySourceSystem: {},
      byTargetSystem: {},
      byTransformationType: {},
      averageConfidence: 0,
      verificationSources: {}
    };

    if (examples.length === 0) return stats;

    let totalConfidence = 0;

    examples.forEach(ex => {
      // Source system
      stats.bySourceSystem[ex.sourceSystem] = (stats.bySourceSystem[ex.sourceSystem] || 0) + 1;

      // Target system
      stats.byTargetSystem[ex.targetSystem] = (stats.byTargetSystem[ex.targetSystem] || 0) + 1;

      // Transformation type
      stats.byTransformationType[ex.transformationType] =
        (stats.byTransformationType[ex.transformationType] || 0) + 1;

      // Verification source
      stats.verificationSources[ex.verificationSource] =
        (stats.verificationSources[ex.verificationSource] || 0) + 1;

      totalConfidence += ex.confidence;
    });

    stats.averageConfidence = totalConfidence / examples.length;

    return stats;
  }

  /**
   * Export golden dataset for backup/sharing
   */
  exportDataset(): GoldenExample[] {
    return Array.from(this.goldenExamples.values());
  }

  /**
   * Import golden dataset from backup
   */
  async importDataset(examples: GoldenExample[]): Promise<number> {
    let imported = 0;

    for (const example of examples) {
      try {
        this.goldenExamples.set(example.id, example);
        imported++;
      } catch (error) {
        this.logger.warn('Failed to import golden example', {
          id: example.id,
          error: error.message
        });
      }
    }

    this.logger.info('Golden dataset imported', {
      imported,
      total: examples.length
    });

    return imported;
  }

  /**
   * Initialize with seed examples for common patterns
   */
  private initializeSeedExamples(): void {
    const seedExamples: Omit<GoldenExample, 'id'>[] = [
      // Salesforce → NetSuite common mappings
      {
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        sourceField: { name: 'Email', type: 'email', sampleValues: ['john@example.com'] },
        targetField: 'email',
        transformationType: 'direct',
        confidence: 100,
        reasoning: 'Direct email field mapping with exact semantic match and type compatibility',
        verifiedBy: 'system',
        verifiedAt: new Date(),
        verificationSource: 'expert_annotation',
        tags: ['crm', 'contact']
      },
      {
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        sourceField: { name: 'AccountId', type: 'string', sampleValues: ['001xx000003DGbQAAW'] },
        targetField: 'entityId',
        transformationType: 'lookup',
        confidence: 98,
        reasoning: 'Salesforce Account ID requires lookup transformation to NetSuite internal ID',
        verifiedBy: 'system',
        verifiedAt: new Date(),
        verificationSource: 'expert_annotation',
        tags: ['crm', 'reference']
      },
      {
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        sourceField: { name: 'Phone', type: 'phone', sampleValues: ['(555) 123-4567'] },
        targetField: 'phone',
        transformationType: 'calculation',
        confidence: 97,
        reasoning: 'Phone field requires format normalization for international compatibility',
        verifiedBy: 'system',
        verifiedAt: new Date(),
        verificationSource: 'expert_annotation',
        tags: ['crm', 'contact']
      },

      // Business Central → NetSuite common mappings
      {
        sourceSystem: 'BusinessCentral',
        targetSystem: 'NetSuite',
        sourceField: { name: 'No_', type: 'string', sampleValues: ['CUST-001'] },
        targetField: 'entityId',
        transformationType: 'lookup',
        confidence: 98,
        reasoning: 'Business Central No_ field maps to NetSuite entity ID via lookup table',
        verifiedBy: 'system',
        verifiedAt: new Date(),
        verificationSource: 'expert_annotation',
        tags: ['erp', 'reference']
      },
      {
        sourceSystem: 'BusinessCentral',
        targetSystem: 'NetSuite',
        sourceField: { name: 'Name', type: 'string', sampleValues: ['Acme Corporation'] },
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 100,
        reasoning: 'Direct company name mapping with exact semantic match',
        verifiedBy: 'system',
        verifiedAt: new Date(),
        verificationSource: 'expert_annotation',
        tags: ['erp', 'company']
      }
    ];

    seedExamples.forEach(example => {
      try {
        const id = this.generateExampleId(
          example.sourceSystem,
          example.targetSystem,
          example.sourceField.name,
          example.targetField
        );
        this.goldenExamples.set(id, { id, ...example });
      } catch (error) {
        this.logger.warn('Failed to initialize seed example', { error: error.message });
      }
    });

    this.logger.info('Golden dataset initialized with seed examples', {
      count: seedExamples.length
    });
  }

  private generateExampleId(
    sourceSystem: string,
    targetSystem: string,
    sourceField: string,
    targetField: string
  ): string {
    return `${sourceSystem}-${targetSystem}-${sourceField}-${targetField}`.toLowerCase().replace(/[^a-z0-9-]/g, '_');
  }

  private removeLowestConfidenceExample(sourceSystem: string, targetSystem: string): void {
    const examples = this.getExamplesBySystemPair(sourceSystem, targetSystem);
    if (examples.length === 0) return;

    // Sort by confidence ascending and remove first (lowest)
    examples.sort((a, b) => a.confidence - b.confidence);
    const toRemove = examples[0];
    this.goldenExamples.delete(toRemove.id);

    this.logger.info('Removed lowest confidence golden example', {
      id: toRemove.id,
      confidence: toRemove.confidence
    });
  }
}
