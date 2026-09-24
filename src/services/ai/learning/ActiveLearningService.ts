/**
 * Active Learning Service - Phase 3 AI Accuracy Improvements
 * Captures user feedback and continuously improves AI suggestions
 *
 * Purpose:
 * - Learn from user corrections and approvals
 * - Identify patterns in user preferences
 * - Adapt suggestions based on historical feedback
 * - Feed high-quality examples back into golden dataset
 */

import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { AISuggestion } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';
import { GoldenDatasetService, type GoldenExample } from './GoldenDatasetService';
import { logger } from '../../../utils/Logger';
import { AutonomousDecisionEngine } from '../../AutonomousDecisionEngine';

export type FeedbackType = 'approved' | 'rejected' | 'corrected' | 'skipped';

export interface UserFeedback {
  id: string;
  timestamp: Date;
  userId: string;
  sessionId: string;

  // Original AI suggestion
  originalSuggestion: AISuggestion;

  // User action
  feedbackType: FeedbackType;

  // If corrected, what was the correction
  correctedMapping?: {
    targetField: string;
    transformationType: string;
    reasoning?: string;
  };

  // Context
  sourceSystem: string;
  targetSystem: string;
  sourceFieldMetadata: FieldMetadata;
  sampleData?: unknown[];

  // Quality indicators
  userConfidence?: number; // User's confidence in their correction (1-5 stars)
  timeToDecision?: number; // Milliseconds spent on decision
}

export interface LearningInsights {
  // Overall metrics
  totalFeedback: number;
  approvalRate: number; // % of suggestions approved
  correctionRate: number; // % of suggestions corrected
  rejectionRate: number; // % of suggestions rejected

  // Pattern analysis
  commonCorrections: {
    pattern: string;
    count: number;
    examples: UserFeedback[];
  }[];

  // System-specific metrics
  bySystemPair: Record<string, {
    approvalRate: number;
    averageTimeToDecision: number;
  }>;

  // Transformation type insights
  byTransformationType: Record<string, {
    approvalRate: number;
    correctionRate: number;
  }>;

  // Confidence calibration
  confidenceAccuracy: {
    confidenceRange: string; // e.g., "90-100%"
    actualApprovalRate: number;
  }[];
}

export interface ActiveLearningConfig {
  minFeedbackForGoldenSet?: number; // Min feedback count before adding to golden set (default: 3)
  minApprovalRateForGoldenSet?: number; // Min approval rate for golden set (default: 90%)
  feedbackRetentionDays?: number; // How long to keep feedback (default: 365)
  enableAutoGoldenSetPromotion?: boolean; // Auto-promote to golden set (default: true)
}

@injectable()
export class ActiveLearningService {
  private feedbackStore = new Map<string, UserFeedback>();
  private goldenDataset: GoldenDatasetService;
  private logger = logger;
  private config: Required<ActiveLearningConfig>;
  private autonomousDecisionEngine: AutonomousDecisionEngine | null;

  constructor(
    @inject(TYPES.GoldenDatasetService) goldenDataset: GoldenDatasetService,
    @inject(TYPES.AutonomousDecisionEngine) @optional() autonomousDecisionEngine: AutonomousDecisionEngine | null = null,
    @inject('ActiveLearningConfig') config: ActiveLearningConfig = {}
  ) {
    this.goldenDataset = goldenDataset;
    this.autonomousDecisionEngine = autonomousDecisionEngine;
    this.config = {
      minFeedbackForGoldenSet: config.minFeedbackForGoldenSet ?? 3,
      minApprovalRateForGoldenSet: config.minApprovalRateForGoldenSet ?? 90,
      feedbackRetentionDays: config.feedbackRetentionDays ?? 365,
      enableAutoGoldenSetPromotion: config.enableAutoGoldenSetPromotion ?? true
    };
  }

  /**
   * Record user feedback on an AI suggestion
   */
  async recordFeedback(feedback: Omit<UserFeedback, 'id' | 'timestamp'>): Promise<string> {
    const id = this.generateFeedbackId();
    const completeFeedback: UserFeedback = {
      id,
      timestamp: new Date(),
      ...feedback
    };

    this.feedbackStore.set(id, completeFeedback);

    this.logger.info('User feedback recorded', {
      id,
      feedbackType: feedback.feedbackType,
      sourceSystem: feedback.sourceSystem,
      targetSystem: feedback.targetSystem,
      originalSuggestion: `${feedback.originalSuggestion.sourceField} → ${feedback.originalSuggestion.targetField}`
    });

    // Check if this feedback should promote the mapping to golden dataset
    if (this.config.enableAutoGoldenSetPromotion) {
      await this.checkGoldenSetPromotion(completeFeedback);
    }

    return id;
  }

  /**
   * Get adaptive suggestions based on historical feedback
   */
  async getAdaptiveSuggestions(
    baseSuggestions: AISuggestion[],
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata
  ): Promise<AISuggestion[]> {
    // Get historical feedback for similar mappings
    const similarFeedback = this.getSimilarFeedback(sourceSystem, targetSystem, sourceField);

    if (similarFeedback.length === 0) {
      // No historical data, return base suggestions
      return baseSuggestions;
    }

    // Adjust confidence based on historical approval rates
    const adjusted = baseSuggestions.map(suggestion => {
      const historicalMatch = similarFeedback.find(fb =>
        fb.originalSuggestion.targetField === suggestion.targetField &&
        fb.originalSuggestion.transformationType === suggestion.transformationType
      );

      if (!historicalMatch) return suggestion;

      // Calculate historical approval rate for this specific mapping
      const sameMapping = similarFeedback.filter(fb =>
        fb.originalSuggestion.targetField === suggestion.targetField &&
        fb.originalSuggestion.transformationType === suggestion.transformationType
      );

      const approvals = sameMapping.filter(fb => fb.feedbackType === 'approved').length;
      const approvalRate = (approvals / sameMapping.length) * 100;

      // Adjust confidence based on approval rate
      let adjustedConfidence = suggestion.confidence || 70;

      if (approvalRate >= 90) {
        // High historical approval - boost confidence
        adjustedConfidence = Math.min(100, adjustedConfidence + 10);
      } else if (approvalRate < 50) {
        // Low historical approval - decrease confidence
        adjustedConfidence = Math.max(0, adjustedConfidence - 20);
      }

      return {
        ...suggestion,
        confidence: adjustedConfidence,
        reasoning: `${suggestion.reasoning || ''} [Historical approval rate: ${approvalRate.toFixed(0)}% based on ${sameMapping.length} previous decisions]`
      };
    });

    // Sort by adjusted confidence
    return adjusted.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }

  /**
   * Get learning insights from accumulated feedback
   */
  getInsights(): LearningInsights {
    const allFeedback = Array.from(this.feedbackStore.values());

    if (allFeedback.length === 0) {
      return {
        totalFeedback: 0,
        approvalRate: 0,
        correctionRate: 0,
        rejectionRate: 0,
        commonCorrections: [],
        bySystemPair: {},
        byTransformationType: {},
        confidenceAccuracy: []
      };
    }

    const total = allFeedback.length;
    const approved = allFeedback.filter(fb => fb.feedbackType === 'approved').length;
    const corrected = allFeedback.filter(fb => fb.feedbackType === 'corrected').length;
    const rejected = allFeedback.filter(fb => fb.feedbackType === 'rejected').length;

    // Common correction patterns
    const corrections = allFeedback.filter(fb => fb.feedbackType === 'corrected' && fb.correctedMapping);
    const correctionPatterns = new Map<string, UserFeedback[]>();

    corrections.forEach(fb => {
      if (!fb.correctedMapping) return;
      const pattern = `${fb.originalSuggestion.targetField} → ${fb.correctedMapping.targetField} (${fb.correctedMapping.transformationType})`;
      if (!correctionPatterns.has(pattern)) {
        correctionPatterns.set(pattern, []);
      }
      correctionPatterns.get(pattern)!.push(fb);
    });

    const commonCorrections = Array.from(correctionPatterns.entries())
      .map(([pattern, examples]) => ({ pattern, count: examples.length, examples }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10

    // By system pair
    const bySystemPair: Record<string, { approvalRate: number; averageTimeToDecision: number }> = {};
    const systemPairs = new Set(allFeedback.map(fb => `${fb.sourceSystem}-${fb.targetSystem}`));

    systemPairs.forEach(pair => {
      const [source, target] = pair.split('-');
      const pairFeedback = allFeedback.filter(fb => fb.sourceSystem === source && fb.targetSystem === target);
      const pairApprovals = pairFeedback.filter(fb => fb.feedbackType === 'approved').length;
      const timesToDecision = pairFeedback
        .filter(fb => fb.timeToDecision)
        .map(fb => fb.timeToDecision!);

      bySystemPair[pair] = {
        approvalRate: (pairApprovals / pairFeedback.length) * 100,
        averageTimeToDecision: timesToDecision.length > 0
          ? timesToDecision.reduce((sum, t) => sum + t, 0) / timesToDecision.length
          : 0
      };
    });

    // By transformation type
    const byTransformationType: Record<string, { approvalRate: number; correctionRate: number }> = {};
    const transformationTypes = new Set(allFeedback.map(fb => fb.originalSuggestion.transformationType));

    transformationTypes.forEach(type => {
      const typeFeedback = allFeedback.filter(fb => fb.originalSuggestion.transformationType === type);
      const typeApprovals = typeFeedback.filter(fb => fb.feedbackType === 'approved').length;
      const typeCorrections = typeFeedback.filter(fb => fb.feedbackType === 'corrected').length;

      byTransformationType[type] = {
        approvalRate: (typeApprovals / typeFeedback.length) * 100,
        correctionRate: (typeCorrections / typeFeedback.length) * 100
      };
    });

    // Confidence accuracy
    const confidenceRanges = [
      { min: 90, max: 100, label: '90-100%' },
      { min: 75, max: 89, label: '75-89%' },
      { min: 70, max: 74, label: '70-74%' }
    ];

    const confidenceAccuracy = confidenceRanges.map(range => {
      const inRange = allFeedback.filter(fb => {
        const conf = fb.originalSuggestion.confidence || 70;
        return conf >= range.min && conf <= range.max;
      });
      const rangeApprovals = inRange.filter(fb => fb.feedbackType === 'approved').length;

      return {
        confidenceRange: range.label,
        actualApprovalRate: inRange.length > 0 ? (rangeApprovals / inRange.length) * 100 : 0
      };
    });

    return {
      totalFeedback: total,
      approvalRate: (approved / total) * 100,
      correctionRate: (corrected / total) * 100,
      rejectionRate: (rejected / total) * 100,
      commonCorrections,
      bySystemPair,
      byTransformationType,
      confidenceAccuracy
    };
  }

  /**
   * Export feedback for analysis
   */
  exportFeedback(startDate?: Date, endDate?: Date): UserFeedback[] {
    let feedback = Array.from(this.feedbackStore.values());

    if (startDate) {
      feedback = feedback.filter(fb => fb.timestamp >= startDate);
    }

    if (endDate) {
      feedback = feedback.filter(fb => fb.timestamp <= endDate);
    }

    return feedback.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Check if feedback should promote mapping to golden dataset
   */
  private async checkGoldenSetPromotion(feedback: UserFeedback): Promise<void> {
    // Only promote approved or highly confident corrections
    if (feedback.feedbackType !== 'approved' &&
      !(feedback.feedbackType === 'corrected' && (feedback.userConfidence || 0) >= 4)) {
      return;
    }

    const targetField = feedback.feedbackType === 'corrected'
      ? feedback.correctedMapping!.targetField
      : feedback.originalSuggestion.targetField;

    const transformationType = feedback.feedbackType === 'corrected'
      ? feedback.correctedMapping!.transformationType
      : feedback.originalSuggestion.transformationType;

    // Check how many times this specific mapping has been approved
    const similarFeedback = Array.from(this.feedbackStore.values()).filter(fb =>
      fb.sourceSystem === feedback.sourceSystem &&
      fb.targetSystem === feedback.targetSystem &&
      fb.sourceFieldMetadata.name === feedback.sourceFieldMetadata.name &&
      (fb.originalSuggestion.targetField === targetField ||
        fb.correctedMapping?.targetField === targetField)
    );

    const approvals = similarFeedback.filter(fb =>
      fb.feedbackType === 'approved' ||
      (fb.feedbackType === 'corrected' && (fb.userConfidence || 0) >= 4)
    ).length;

    const approvalRate = (approvals / similarFeedback.length) * 100;

    // Check configured thresholds first (P1 fix: ensure thresholds are respected)
    if (similarFeedback.length < this.config.minFeedbackForGoldenSet) {
      this.logger.debug('Insufficient feedback for golden set promotion', {
        current: similarFeedback.length,
        required: this.config.minFeedbackForGoldenSet
      });
      return;
    }

    if (approvalRate < this.config.minApprovalRateForGoldenSet) {
      this.logger.debug('Approval rate below threshold for golden set promotion', {
        current: approvalRate,
        required: this.config.minApprovalRateForGoldenSet
      });
      return;
    }

    // Determine if we should promote based on decision engine or thresholds
    let shouldPromote: boolean;
    let decisionReason: string;

    if (this.autonomousDecisionEngine) {
      // Use Autonomous Decision Engine to decide on promotion
      const decisionContext = {
        action: 'promote_to_golden_set',
        entityType: 'field_mapping',
        confidence: approvalRate / 100,
        source: 'active_learning',
        metadata: {
          feedbackCount: similarFeedback.length,
          approvalRate,
          sourceField: feedback.sourceFieldMetadata.name,
          targetField,
        }
      };

      const decision = await this.autonomousDecisionEngine.evaluate(decisionContext);
      shouldPromote = decision.approved;
      decisionReason = decision.reason || 'Approved by decision engine';

      if (!shouldPromote) {
        this.logger.info('Mapping promotion to golden dataset rejected by Autonomous Decision Engine', {
          sourceField: feedback.sourceFieldMetadata.name,
          targetField,
          reason: decision.reason
        });
        return;
      }
    } else {
      // Standalone mode: use configured thresholds (already passed above)
      shouldPromote = true;
      decisionReason = `Met configured thresholds (${similarFeedback.length} feedback, ${approvalRate.toFixed(1)}% approval rate)`;
      this.logger.debug('AutonomousDecisionEngine not available, using threshold-based promotion');
    }

    if (shouldPromote) {
      // Promote to golden dataset
      try {
        await this.goldenDataset.addExample({
          sourceSystem: feedback.sourceSystem,
          targetSystem: feedback.targetSystem,
          sourceField: feedback.sourceFieldMetadata,
          targetField,
          transformationType,
          confidence: Math.min(100, 70 + approvalRate / 3), // Scale approval rate to confidence
          reasoning: feedback.correctedMapping?.reasoning ||
            feedback.originalSuggestion.reasoning ||
            'Promoted from active learning based on consistent user approval',
          verifiedBy: feedback.userId,
          verifiedAt: new Date(),
          verificationSource: 'production_success',
          productionUsageCount: similarFeedback.length,
          userApprovalRate: approvalRate,
          sampleValues: feedback.sampleData,
          tags: ['active-learning', feedback.sourceSystem.toLowerCase(), feedback.targetSystem.toLowerCase()]
        });

        this.logger.info('Mapping promoted to golden dataset', {
          sourceField: feedback.sourceFieldMetadata.name,
          targetField,
          approvals,
          approvalRate,
          totalFeedback: similarFeedback.length,
          decisionReason
        });
      } catch (error) {
        this.logger.warn('Failed to promote mapping to golden dataset', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Get similar feedback for adaptive learning
   */
  private getSimilarFeedback(
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata
  ): UserFeedback[] {
    return Array.from(this.feedbackStore.values()).filter(fb => {
      // Same system pair
      if (fb.sourceSystem !== sourceSystem || fb.targetSystem !== targetSystem) {
        return false;
      }

      // Similar field (name or type match)
      const sameFieldName = fb.sourceFieldMetadata.name.toLowerCase() === sourceField.name.toLowerCase();
      const sameFieldType = fb.sourceFieldMetadata.type === sourceField.type;

      return sameFieldName || sameFieldType;
    });
  }

  private generateFeedbackId(): string {
    return `feedback-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
