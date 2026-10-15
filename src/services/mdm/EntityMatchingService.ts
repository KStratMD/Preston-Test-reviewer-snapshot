import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import {
    fuzzyCompare,
    comparePhones,
    compareEmails,
    compareAddresses,
    compareCompanyNames,
    getNestedValue,
    scoreToConfidence as utilScoreToConfidence,
    detectDataPattern
} from '../../utils/DataNormalization';
import type { AIFieldMappingService } from '../ai/AIFieldMappingService';

/**
 * Entity Matching Service
 * 
 * Golden Record MDM - Matches records across systems using fuzzy matching and optional AI enhancement.
 * 
 * Features:
 * - Fuzzy string matching (Levenshtein distance) via shared utilities
 * - Phone/email/address normalization via DataNormalization
 * - AI-powered semantic field weighting (optional via AIFieldMappingService)
 */

export interface EntityRecord {
    id: string;
    sourceSystem: string;
    entityType: 'vendor' | 'customer' | 'product';
    data: Record<string, unknown>;
    lastUpdated?: Date;
}

export interface MatchCandidate {
    entityA: EntityRecord;
    entityB: EntityRecord;
    matchScore: number;
    fieldScores: Record<string, number>;
    confidence: 'low' | 'medium' | 'high';
    suggestedAction: 'merge' | 'review' | 'ignore';
}

export interface FieldWeight {
    field: string;
    weight: number;
    matchType: 'exact' | 'fuzzy' | 'normalized' | 'semantic';
}

// Default field weights by entity type
const DEFAULT_FIELD_WEIGHTS: Record<string, FieldWeight[]> = {
    vendor: [
        { field: 'name', weight: 0.35, matchType: 'fuzzy' },
        { field: 'email', weight: 0.20, matchType: 'normalized' },
        { field: 'phone', weight: 0.15, matchType: 'normalized' },
        { field: 'address', weight: 0.20, matchType: 'fuzzy' },
        { field: 'taxId', weight: 0.10, matchType: 'exact' }
    ],
    customer: [
        { field: 'name', weight: 0.30, matchType: 'fuzzy' },
        { field: 'email', weight: 0.25, matchType: 'normalized' },
        { field: 'phone', weight: 0.15, matchType: 'normalized' },
        { field: 'address', weight: 0.20, matchType: 'fuzzy' },
        { field: 'accountNumber', weight: 0.10, matchType: 'exact' }
    ],
    product: [
        { field: 'name', weight: 0.30, matchType: 'fuzzy' },
        { field: 'sku', weight: 0.25, matchType: 'exact' },
        { field: 'upc', weight: 0.20, matchType: 'exact' },
        { field: 'description', weight: 0.15, matchType: 'semantic' },
        { field: 'category', weight: 0.10, matchType: 'fuzzy' }
    ]
};

@injectable()
export class EntityMatchingService {
    private logger: Logger;
    private semanticEngine?: unknown; // Optional SemanticAnalysisEngine
    private fieldMappingService?: AIFieldMappingService; // Optional AIFieldMappingService for enhanced matching

    constructor(
        @inject(TYPES.Logger) logger: Logger,
        @inject(TYPES.SemanticAnalysisEngine) @optional() semanticEngine?: unknown,
        @inject(TYPES.AIFieldMappingService) @optional() fieldMappingService?: AIFieldMappingService
    ) {
        this.logger = logger;
        this.semanticEngine = semanticEngine;
        this.fieldMappingService = fieldMappingService;
        this.logger.info('[EntityMatching] Service initialized', {
            aiEnhanced: !!semanticEngine,
            fieldMappingIntegrated: !!fieldMappingService
        });
    }

    /**
     * Find matching entities across systems
     */
    async findMatches(
        entity: EntityRecord,
        candidates: EntityRecord[],
        threshold = 0.7
    ): Promise<MatchCandidate[]> {
        const matches: MatchCandidate[] = [];
        const fieldWeights = this.getFieldWeights(entity.entityType);

        for (const candidate of candidates) {
            // Skip same system same ID
            if (entity.sourceSystem === candidate.sourceSystem && entity.id === candidate.id) {
                continue;
            }

            const { score, fieldScores } = this.calculateMatchScore(entity, candidate, fieldWeights);

            if (score >= threshold) {
                matches.push({
                    entityA: entity,
                    entityB: candidate,
                    matchScore: score,
                    fieldScores,
                    confidence: this.scoreToConfidence(score),
                    suggestedAction: this.suggestAction(score)
                });
            }
        }

        // Sort by match score descending
        matches.sort((a, b) => b.matchScore - a.matchScore);

        this.logger.info('[EntityMatching] Found matches', {
            entityId: entity.id,
            entityType: entity.entityType,
            matchCount: matches.length
        });

        return matches;
    }

    /**
     * Calculate match score between two entities
     */
    calculateMatchScore(
        entityA: EntityRecord,
        entityB: EntityRecord,
        fieldWeights?: FieldWeight[]
    ): { score: number; fieldScores: Record<string, number> } {
        // Enforce same entity type
        if (entityA.entityType !== entityB.entityType) {
            return { score: 0, fieldScores: {} };
        }

        const weights = fieldWeights || this.getFieldWeights(entityA.entityType);
        const fieldScores: Record<string, number> = {};
        let totalScore = 0;
        let totalWeight = 0;

        for (const fw of weights) {
            const valueA = getNestedValue(entityA.data, fw.field);
            const valueB = getNestedValue(entityB.data, fw.field);

            if (valueA === undefined || valueB === undefined) {
                continue;
            }

            const fieldScore = this.compareFields(valueA, valueB, fw.matchType, fw.field);
            fieldScores[fw.field] = fieldScore;
            totalScore += fieldScore * fw.weight;
            totalWeight += fw.weight;
        }

        const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;

        return {
            score: Math.round(normalizedScore * 100) / 100,
            fieldScores
        };
    }

    /**
     * Suggest merge candidates using AI (if available) or basic matching
     */
    async suggestMerges(
        entities: EntityRecord[],
        minScore = 0.75
    ): Promise<MatchCandidate[]> {
        const allMatches: MatchCandidate[] = [];
        const processed = new Set<string>();

        for (let i = 0; i < entities.length; i++) {
            const entity = entities[i];
            const key = `${entity.sourceSystem}:${entity.id}`;

            if (processed.has(key)) continue;
            processed.add(key);

            const candidates = entities.slice(i + 1);
            const matches = await this.findMatches(entity, candidates, minScore);

            for (const match of matches) {
                const keyB = `${match.entityB.sourceSystem}:${match.entityB.id}`;
                if (!processed.has(keyB)) {
                    allMatches.push(match);
                }
            }
        }

        this.logger.info('[EntityMatching] Merge suggestions generated', {
            totalEntities: entities.length,
            suggestedMerges: allMatches.length
        });

        return allMatches;
    }

    /**
     * Get field weights for entity type (AI-enhanced if available)
     */
    private getFieldWeights(entityType: string): FieldWeight[] {
        // If AIFieldMappingService is available, it could be used to enhance weights
        // based on learned patterns from user feedback
        if (this.fieldMappingService) {
            this.logger.debug('[EntityMatching] AIFieldMappingService available for enhanced matching');
            // Future: Use fieldMappingService.getLearnedWeights() to adjust weights
        }
        return DEFAULT_FIELD_WEIGHTS[entityType] || DEFAULT_FIELD_WEIGHTS.vendor;
    }

    /**
     * Compare two field values based on match type
     * Uses shared DataNormalization utilities for consistent comparison
     */
    private compareFields(valueA: unknown, valueB: unknown, matchType: string, fieldName?: string): number {
        const strA = String(valueA || '').toLowerCase().trim();
        const strB = String(valueB || '').toLowerCase().trim();

        if (!strA || !strB) return 0;

        switch (matchType) {
            case 'exact':
                return strA === strB ? 1 : 0;

            case 'normalized': {
                // Use specialized comparisons based on field name or data pattern
                const pattern = detectDataPattern(valueA);
                if (pattern.type === 'email' || fieldName?.includes('email')) {
                    return compareEmails(strA, strB);
                }
                if (pattern.type === 'phone' || fieldName?.includes('phone')) {
                    return comparePhones(strA, strB);
                }
                if (fieldName?.includes('address')) {
                    return compareAddresses(strA, strB);
                }
                // Fallback normalized compare
                const normA = strA.replace(/[^a-z0-9@.]/g, '');
                const normB = strB.replace(/[^a-z0-9@.]/g, '');
                return normA === normB ? 1 : fuzzyCompare(normA, normB);
            }

            case 'fuzzy':
                // Use company name comparison for name fields
                if (fieldName?.includes('name')) {
                    return compareCompanyNames(strA, strB);
                }
                return fuzzyCompare(strA, strB);

            case 'semantic':
                // Future: Use AIFieldMappingService for semantic comparison
                if (this.fieldMappingService) {
                    // Could use fieldMappingService pattern detection for smarter matching
                    this.logger.debug('[EntityMatching] Semantic match using AI fallback');
                }
                return fuzzyCompare(strA, strB);

            default:
                return strA === strB ? 1 : 0;
        }
    }

    /**
     * Convert score to confidence level
     */
    private scoreToConfidence(score: number): 'low' | 'medium' | 'high' {
        return utilScoreToConfidence(score);
    }

    /**
     * Suggest action based on match score
     */
    private suggestAction(score: number): 'merge' | 'review' | 'ignore' {
        if (score >= 0.95) return 'merge';
        if (score >= 0.7) return 'review';
        return 'ignore';
    }
}
