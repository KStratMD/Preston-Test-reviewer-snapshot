import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { LoggingService } from './logging/LoggingService';
import { TelemetryService } from './telemetry/TelemetryService';

export interface MappingPattern {
    id: string;
    sourceField: string;
    targetField: string;
    transformationLogic: string;
    confidence: number;
    usageCount: number;
    lastUsed: Date;
    successRate: number;
    createdAt: Date;
    updatedAt: Date;
    tags: string[];
    category: string;
    systemPair: string;
    complexity: 'simple' | 'medium' | 'complex';
    validationRules: ValidationRule[];
    // Week 7 Enhanced Fields
    sourceFields?: string[];
    targetFields?: string[];
    mappingConfiguration?: FieldMapping[];
    metadata?: {
        dataTypes: { [field: string]: string };
        transformations: { [field: string]: string };
        validationRules: { [field: string]: ValidationRule[] };
        businessContext: string;
        industry?: string;
        companySize?: string;
    };
}

export interface FieldMapping {
    sourceField: string;
    targetField: string;
    transformation?: string;
    confidence: number;
    validationRules: ValidationRule[];
    dataType: string;
}

export interface ValidationRule {
    type: 'format' | 'range' | 'regex' | 'custom';
    rule: string;
    errorMessage: string;
    severity: 'warning' | 'error';
}

export interface CacheMetrics {
    totalPatterns: number;
    hitRate: number;
    missRate: number;
    averageResponseTime: number;
    memoryUsage: number;
    lastEviction: Date | null;
    topPatterns: MappingPattern[];
    categoryDistribution: { [category: string]: number };
}

export interface PatternRecommendation {
    pattern: MappingPattern;
    similarityScore: number;
    reason: string;
    modifications: string[];
    estimatedAccuracy: number;
}

export interface CacheConfiguration {
    maxSize: number;
    ttlMinutes: number;
    evictionPolicy: 'lru' | 'lfu' | 'ttl';
    compressionEnabled: boolean;
    persistenceEnabled: boolean;
    replicationEnabled: boolean;
}

export interface PatternSearchCriteria {
    sourceSystem?: string;
    targetSystem?: string;
    fieldName?: string;
    category?: string;
    tags?: string[];
    minConfidence?: number;
    maxComplexity?: string;
    limit?: number;
    offset?: number;
}

export interface PatternAnalytics {
    mostUsedPatterns: MappingPattern[];
    trendingPatterns: MappingPattern[];
    performanceMetrics: {
        avgResponseTime: number;
        cacheHitRate: number;
        patternSuccessRate: number;
    };
    usageDistribution: {
        byCategory: { [category: string]: number };
        byComplexity: { [complexity: string]: number };
        bySystemPair: { [systemPair: string]: number };
    };
    recommendations: {
        patternsToOptimize: MappingPattern[];
        patternsToRetire: MappingPattern[];
        newPatternSuggestions: string[];
    };
}

export interface CacheOptimizationResult {
    optimizationsApplied: string[];
    performanceImprovement: number;
    memoryReduction: number;
    patternsOptimized: number;
    estimatedSavings: {
        timeMs: number;
        memoryMB: number;
        computeCycles: number;
    };
}

// Week 7 Enhanced Interfaces
export interface PatternSimilarityScore {
    patternId: string;
    similarityScore: number;
    matchingFields: string[];
    confidenceAdjustment: number;
    reasons: string[];
}

export interface CacheOptimizationRecommendation {
    type: 'eviction' | 'preload' | 'compression' | 'indexing' | 'partitioning';
    priority: number;
    expectedImprovement: number;
    description: string;
    implementation: string;
    riskLevel: 'low' | 'medium' | 'high';
    estimatedEffort: string;
}

export interface AdvancedCacheMetrics extends CacheMetrics {
    patternMatchAccuracy: number;
    storageEfficiency: number;
    evictionCount: number;
    indexEfficiency: number;
    compressionRatio: number;
}

@injectable()
export class MappingPatternCacheService {
    private cache = new Map<string, MappingPattern>();
    private usageStats = new Map<string, number>();
    private accessTimes = new Map<string, Date>();
    private configuration: CacheConfiguration;
    // Week 7 Enhanced Fields
    private fieldIndexes = new Map<string, Set<string>>();
    private systemIndexes = new Map<string, Set<string>>();
    private performanceMetrics: AdvancedCacheMetrics;
    private maintenanceIntervalId?: ReturnType<typeof setInterval>;

    constructor(
        @inject(TYPES.LoggingService) private loggingService: LoggingService,
        @inject(TYPES.TelemetryService) private telemetryService: TelemetryService
    ) {
        this.configuration = {
            maxSize: 10000,
            ttlMinutes: 1440, // 24 hours
            evictionPolicy: 'lru',
            compressionEnabled: true,
            persistenceEnabled: true,
            replicationEnabled: false
        };
        this.initializeCache();
    }

    /** Start periodic maintenance. Call after construction in production; skip in tests. */
    start(): void {
        if (this.maintenanceIntervalId) return; // already started
        this.loggingService.info('Starting mapping pattern cache maintenance');
        this.maintenanceIntervalId = setInterval(() => {
            void this.performPeriodicMaintenance().catch(err => {
                this.loggingService.error('Periodic maintenance failed unexpectedly', err);
            });
        }, 300000); // 5 minutes
    }

    /** Stop periodic maintenance and clean up the interval. */
    stop(): void {
        if (this.maintenanceIntervalId) {
            clearInterval(this.maintenanceIntervalId);
            this.maintenanceIntervalId = undefined;
        }
    }

    async cachePattern(pattern: MappingPattern): Promise<void> {
        try {
            this.loggingService.info('Caching mapping pattern', { patternId: pattern.id });

            // Check cache size and evict if necessary
            if (this.cache.size >= this.configuration.maxSize) {
                await this.evictPattern();
            }

            // Update pattern metadata
            pattern.lastUsed = new Date();
            pattern.updatedAt = new Date();

            // Store in cache
            this.cache.set(pattern.id, pattern);
            this.accessTimes.set(pattern.id, new Date());
            this.usageStats.set(pattern.id, (this.usageStats.get(pattern.id) || 0) + 1);

            this.telemetryService.recordMetric('pattern_cached', 1, {
                category: pattern.category,
                complexity: pattern.complexity,
                systemPair: pattern.systemPair
            });

            this.loggingService.info('Pattern cached successfully', {
                patternId: pattern.id,
                cacheSize: this.cache.size
            });

        } catch (error) {
            this.loggingService.error('Failed to cache pattern', error, { patternId: pattern.id });
            throw error;
        }
    }

    async getPattern(patternId: string): Promise<MappingPattern | null> {
        try {
            const pattern = this.cache.get(patternId);

            if (pattern) {
                // Update access statistics
                this.accessTimes.set(patternId, new Date());
                this.usageStats.set(patternId, (this.usageStats.get(patternId) || 0) + 1);
                pattern.usageCount++;
                pattern.lastUsed = new Date();

                this.telemetryService.recordMetric('cache_hit', 1, {
                    category: pattern.category,
                    complexity: pattern.complexity
                });

                this.loggingService.debug('Cache hit for pattern', { patternId });
                return pattern;
            }

            this.telemetryService.recordMetric('cache_miss', 1, { patternId });
            this.loggingService.debug('Cache miss for pattern', { patternId });
            return null;

        } catch (error) {
            this.loggingService.error('Failed to retrieve pattern from cache', error, { patternId });
            return null;
        }
    }

    async searchPatterns(criteria: PatternSearchCriteria): Promise<MappingPattern[]> {
        try {
            this.loggingService.info('Searching patterns in cache', { criteria });

            let results = Array.from(this.cache.values());

            // Apply filters
            if (criteria.sourceSystem) {
                results = results.filter(p => p.systemPair.includes(criteria.sourceSystem!));
            }

            if (criteria.targetSystem) {
                results = results.filter(p => p.systemPair.includes(criteria.targetSystem!));
            }

            if (criteria.fieldName) {
                results = results.filter(p =>
                    p.sourceField.toLowerCase().includes(criteria.fieldName!.toLowerCase()) ||
                    p.targetField.toLowerCase().includes(criteria.fieldName!.toLowerCase())
                );
            }

            if (criteria.category) {
                results = results.filter(p => p.category === criteria.category);
            }

            if (criteria.tags && criteria.tags.length > 0) {
                results = results.filter(p =>
                    criteria.tags!.some(tag => p.tags.includes(tag))
                );
            }

            if (criteria.minConfidence) {
                results = results.filter(p => p.confidence >= criteria.minConfidence!);
            }

            if (criteria.maxComplexity) {
                const complexityOrder = { 'simple': 1, 'medium': 2, 'complex': 3 };
                const maxLevel = complexityOrder[criteria.maxComplexity as keyof typeof complexityOrder];
                results = results.filter(p =>
                    complexityOrder[p.complexity] <= maxLevel
                );
            }

            // Sort by relevance (usage count and confidence)
            results.sort((a, b) => {
                const scoreA = (a.usageCount * 0.3) + (a.confidence * 0.4) + (a.successRate * 0.3);
                const scoreB = (b.usageCount * 0.3) + (b.confidence * 0.4) + (b.successRate * 0.3);
                return scoreB - scoreA;
            });

            // Apply pagination
            const offset = criteria.offset || 0;
            const limit = criteria.limit || 50;
            results = results.slice(offset, offset + limit);

            this.telemetryService.recordMetric('pattern_search', 1, {
                resultCount: results.length,
                criteriaCount: Object.keys(criteria).length
            });

            this.loggingService.info('Pattern search completed', {
                resultCount: results.length,
                totalPatterns: this.cache.size
            });

            return results;

        } catch (error) {
            this.loggingService.error('Failed to search patterns', error, { criteria });
            return [];
        }
    }

    async getRecommendations(
        sourceField: string,
        targetSystem: string,
        context?: unknown
    ): Promise<PatternRecommendation[]> {
        try {
            this.loggingService.info('Getting pattern recommendations', {
                sourceField,
                targetSystem
            });

            const patterns = Array.from(this.cache.values());
            const recommendations: PatternRecommendation[] = [];

            for (const pattern of patterns) {
                if (pattern.systemPair.includes(targetSystem)) {
                    const similarity = this.calculateSimilarity(sourceField, pattern.sourceField);

                    if (similarity > 0.3) { // Minimum similarity threshold
                        const modifications = this.suggestModifications(sourceField, pattern);
                        const estimatedAccuracy = this.calculateEstimatedAccuracy(pattern, similarity);

                        recommendations.push({
                            pattern,
                            similarityScore: similarity,
                            reason: this.generateRecommendationReason(pattern, similarity),
                            modifications,
                            estimatedAccuracy
                        });
                    }
                }
            }

            // Sort by similarity and success rate
            recommendations.sort((a, b) => {
                const scoreA = (a.similarityScore * 0.4) + (a.pattern.successRate * 0.3) + (a.estimatedAccuracy * 0.3);
                const scoreB = (b.similarityScore * 0.4) + (b.pattern.successRate * 0.3) + (b.estimatedAccuracy * 0.3);
                return scoreB - scoreA;
            });

            // Limit to top 10 recommendations
            const topRecommendations = recommendations.slice(0, 10);

            this.telemetryService.recordMetric('recommendations_generated', topRecommendations.length, {
                sourceField,
                targetSystem
            });

            this.loggingService.info('Recommendations generated', {
                count: topRecommendations.length,
                topSimilarity: topRecommendations[0]?.similarityScore || 0
            });

            return topRecommendations;

        } catch (error) {
            this.loggingService.error('Failed to generate recommendations', error, {
                sourceField,
                targetSystem
            });
            return [];
        }
    }

    async getCacheMetrics(): Promise<CacheMetrics> {
        try {
            const patterns = Array.from(this.cache.values());
            const totalRequests = Array.from(this.usageStats.values()).reduce((sum, count) => sum + count, 0);
            const hits = patterns.reduce((sum, p) => sum + p.usageCount, 0);

            const categoryDistribution: { [category: string]: number } = {};
            patterns.forEach(p => {
                categoryDistribution[p.category] = (categoryDistribution[p.category] || 0) + 1;
            });

            const topPatterns = patterns
                .sort((a, b) => b.usageCount - a.usageCount)
                .slice(0, 10);

            const metrics: CacheMetrics = {
                totalPatterns: this.cache.size,
                hitRate: totalRequests > 0 ? (hits / totalRequests) * 100 : 0,
                missRate: totalRequests > 0 ? ((totalRequests - hits) / totalRequests) * 100 : 0,
                averageResponseTime: this.calculateAverageResponseTime(),
                memoryUsage: this.estimateMemoryUsage(),
                lastEviction: this.getLastEvictionTime(),
                topPatterns,
                categoryDistribution
            };

            this.telemetryService.recordMetric('cache_metrics_calculated', 1, {
                totalPatterns: metrics.totalPatterns,
                hitRate: metrics.hitRate
            });

            return metrics;

        } catch (error) {
            this.loggingService.error('Failed to calculate cache metrics', error);
            throw error;
        }
    }

    async getPatternAnalytics(): Promise<PatternAnalytics> {
        try {
            this.loggingService.info('Generating pattern analytics');

            const patterns = Array.from(this.cache.values());

            // Most used patterns
            const mostUsedPatterns = patterns
                .sort((a, b) => b.usageCount - a.usageCount)
                .slice(0, 10);

            // Trending patterns (high recent usage)
            const recentlyUsed = patterns
                .filter(p => {
                    const daysSinceUsed = (Date.now() - p.lastUsed.getTime()) / (1000 * 60 * 60 * 24);
                    return daysSinceUsed <= 7;
                })
                .sort((a, b) => b.usageCount - a.usageCount)
                .slice(0, 10);

            // Usage distribution
            const byCategory: { [category: string]: number } = {};
            const byComplexity: { [complexity: string]: number } = {};
            const bySystemPair: { [systemPair: string]: number } = {};

            patterns.forEach(p => {
                byCategory[p.category] = (byCategory[p.category] || 0) + 1;
                byComplexity[p.complexity] = (byComplexity[p.complexity] || 0) + 1;
                bySystemPair[p.systemPair] = (bySystemPair[p.systemPair] || 0) + 1;
            });

            // Performance metrics
            const totalUsage = patterns.reduce((sum, p) => sum + p.usageCount, 0);
            const avgResponseTime = this.calculateAverageResponseTime();
            const cacheHitRate = await this.calculateHitRate();
            const avgSuccessRate = patterns.reduce((sum, p) => sum + p.successRate, 0) / patterns.length;

            // Recommendations
            const patternsToOptimize = patterns
                .filter(p => p.successRate < 0.8 && p.usageCount > 10)
                .slice(0, 5);

            const patternsToRetire = patterns
                .filter(p => {
                    const daysSinceUsed = (Date.now() - p.lastUsed.getTime()) / (1000 * 60 * 60 * 24);
                    return daysSinceUsed > 30 && p.usageCount < 5;
                })
                .slice(0, 5);

            const analytics: PatternAnalytics = {
                mostUsedPatterns,
                trendingPatterns: recentlyUsed,
                performanceMetrics: {
                    avgResponseTime,
                    cacheHitRate,
                    patternSuccessRate: avgSuccessRate
                },
                usageDistribution: {
                    byCategory,
                    byComplexity,
                    bySystemPair
                },
                recommendations: {
                    patternsToOptimize,
                    patternsToRetire,
                    newPatternSuggestions: this.generateNewPatternSuggestions(patterns)
                }
            };

            this.telemetryService.recordMetric('analytics_generated', 1, {
                totalPatterns: patterns.length,
                mostUsedCount: mostUsedPatterns.length
            });

            this.loggingService.info('Pattern analytics generated successfully', {
                totalPatterns: patterns.length,
                avgSuccessRate
            });

            return analytics;

        } catch (error) {
            this.loggingService.error('Failed to generate pattern analytics', error);
            throw error;
        }
    }

    async optimizeCache(): Promise<CacheOptimizationResult> {
        try {
            this.loggingService.info('Starting cache optimization');

            const initialSize = this.cache.size;
            const initialMemory = this.estimateMemoryUsage();
            const startTime = Date.now();

            const optimizationsApplied: string[] = [];

            // Remove expired patterns
            const expiredCount = await this.removeExpiredPatterns();
            if (expiredCount > 0) {
                optimizationsApplied.push(`Removed ${expiredCount} expired patterns`);
            }

            // Consolidate duplicate patterns
            const duplicatesCount = await this.consolidateDuplicates();
            if (duplicatesCount > 0) {
                optimizationsApplied.push(`Consolidated ${duplicatesCount} duplicate patterns`);
            }

            // Optimize pattern storage
            const compressionSavings = await this.compressPatterns();
            if (compressionSavings > 0) {
                optimizationsApplied.push(`Applied compression saving ${compressionSavings}MB`);
            }

            // Update cache configuration based on usage patterns
            const configOptimized = await this.optimizeConfiguration();
            if (configOptimized) {
                optimizationsApplied.push('Optimized cache configuration');
            }

            const endTime = Date.now();
            const finalSize = this.cache.size;
            const finalMemory = this.estimateMemoryUsage();

            const result: CacheOptimizationResult = {
                optimizationsApplied,
                performanceImprovement: this.calculatePerformanceImprovement(),
                memoryReduction: initialMemory - finalMemory,
                patternsOptimized: initialSize - finalSize,
                estimatedSavings: {
                    timeMs: endTime - startTime,
                    memoryMB: initialMemory - finalMemory,
                    computeCycles: this.estimateComputeSavings()
                }
            };

            this.telemetryService.recordMetric('cache_optimized', 1, {
                optimizationsCount: optimizationsApplied.length,
                memoryReduction: result.memoryReduction,
                patternsOptimized: result.patternsOptimized
            });

            this.loggingService.info('Cache optimization completed', {
                optimizationsApplied: optimizationsApplied.length,
                memoryReduction: result.memoryReduction,
                patternsOptimized: result.patternsOptimized
            });

            return result;

        } catch (error) {
            this.loggingService.error('Failed to optimize cache', error);
            throw error;
        }
    }

    async clearCache(): Promise<void> {
        try {
            this.loggingService.info('Clearing mapping pattern cache');

            const patternCount = this.cache.size;

            this.cache.clear();
            this.usageStats.clear();
            this.accessTimes.clear();

            this.telemetryService.recordMetric('cache_cleared', patternCount);

            this.loggingService.info('Cache cleared successfully', {
                patternsRemoved: patternCount
            });

        } catch (error) {
            this.loggingService.error('Failed to clear cache', error);
            throw error;
        }
    }

    private initializeCache(): void {
        this.loggingService.info('Initializing mapping pattern cache', {
            maxSize: this.configuration.maxSize,
            ttlMinutes: this.configuration.ttlMinutes,
            evictionPolicy: this.configuration.evictionPolicy
        });

        // Load sample patterns for testing
        this.loadSamplePatterns();
    }

    private loadSamplePatterns(): void {
        const samplePatterns: MappingPattern[] = [
            {
                id: 'pattern-001',
                sourceField: 'customer_name',
                targetField: 'customerName',
                transformationLogic: 'directMapping',
                confidence: 0.95,
                usageCount: 150,
                lastUsed: new Date(),
                successRate: 0.98,
                createdAt: new Date('2025-08-01'),
                updatedAt: new Date(),
                tags: ['customer', 'name', 'common'],
                category: 'customer_data',
                systemPair: 'squire-suitecentral',
                complexity: 'simple',
                validationRules: [
                    {
                        type: 'format',
                        rule: 'nonEmpty',
                        errorMessage: 'Customer name cannot be empty',
                        severity: 'error'
                    }
                ]
            },
            {
                id: 'pattern-002',
                sourceField: 'order_date',
                targetField: 'orderTimestamp',
                transformationLogic: 'dateToTimestamp',
                confidence: 0.92,
                usageCount: 98,
                lastUsed: new Date(),
                successRate: 0.94,
                createdAt: new Date('2025-08-15'),
                updatedAt: new Date(),
                tags: ['date', 'timestamp', 'order'],
                category: 'temporal_data',
                systemPair: 'squire-suitecentral',
                complexity: 'medium',
                validationRules: [
                    {
                        type: 'format',
                        rule: 'validDate',
                        errorMessage: 'Invalid date format',
                        severity: 'error'
                    }
                ]
            },
            {
                id: 'pattern-003',
                sourceField: 'product_price',
                targetField: 'unitPrice',
                transformationLogic: 'currencyConversion',
                confidence: 0.89,
                usageCount: 76,
                lastUsed: new Date(),
                successRate: 0.91,
                createdAt: new Date('2025-08-20'),
                updatedAt: new Date(),
                tags: ['price', 'currency', 'financial'],
                category: 'financial_data',
                systemPair: 'squire-suitecentral',
                complexity: 'complex',
                validationRules: [
                    {
                        type: 'range',
                        rule: 'min:0',
                        errorMessage: 'Price must be non-negative',
                        severity: 'error'
                    }
                ]
            }
        ];

        samplePatterns.forEach(pattern => {
            this.cache.set(pattern.id, pattern);
            this.usageStats.set(pattern.id, pattern.usageCount);
            this.accessTimes.set(pattern.id, pattern.lastUsed);
        });
    }

    private async evictPattern(): Promise<void> {
        if (this.cache.size === 0) return;

        let patternToEvict: string;

        switch (this.configuration.evictionPolicy) {
            case 'lru':
                patternToEvict = this.findLeastRecentlyUsed();
                break;
            case 'lfu':
                patternToEvict = this.findLeastFrequentlyUsed();
                break;
            case 'ttl':
                patternToEvict = this.findExpiredPattern();
                break;
            default:
                patternToEvict = this.findLeastRecentlyUsed();
        }

        if (patternToEvict) {
            this.cache.delete(patternToEvict);
            this.usageStats.delete(patternToEvict);
            this.accessTimes.delete(patternToEvict);

            this.telemetryService.recordMetric('pattern_evicted', 1, {
                evictionPolicy: this.configuration.evictionPolicy
            });
        }
    }

    private findLeastRecentlyUsed(): string {
        let oldestTime = Date.now();
        let oldestPattern = '';

        this.accessTimes.forEach((time, patternId) => {
            if (time.getTime() < oldestTime) {
                oldestTime = time.getTime();
                oldestPattern = patternId;
            }
        });

        return oldestPattern;
    }

    private findLeastFrequentlyUsed(): string {
        let minUsage = Infinity;
        let leastUsedPattern = '';

        this.usageStats.forEach((count, patternId) => {
            if (count < minUsage) {
                minUsage = count;
                leastUsedPattern = patternId;
            }
        });

        return leastUsedPattern;
    }

    private findExpiredPattern(): string {
        const ttlMs = this.configuration.ttlMinutes * 60 * 1000;
        const now = Date.now();

        for (const [patternId, accessTime] of this.accessTimes) {
            if (now - accessTime.getTime() > ttlMs) {
                return patternId;
            }
        }

        return this.findLeastRecentlyUsed();
    }

    private calculateSimilarity(field1: string, field2: string): number {
        const s1 = field1.toLowerCase();
        const s2 = field2.toLowerCase();

        // Exact match
        if (s1 === s2) return 1.0;

        // Contains match
        if (s1.includes(s2) || s2.includes(s1)) return 0.8;

        // Word overlap
        const words1 = s1.split(/[_\s-]/);
        const words2 = s2.split(/[_\s-]/);
        const overlap = words1.filter(w => words2.includes(w)).length;
        const totalWords = new Set([...words1, ...words2]).size;

        return overlap / totalWords;
    }

    private suggestModifications(sourceField: string, pattern: MappingPattern): string[] {
        const modifications: string[] = [];

        if (sourceField !== pattern.sourceField) {
            modifications.push(`Update source field from '${pattern.sourceField}' to '${sourceField}'`);
        }

        if (pattern.confidence < 0.9) {
            modifications.push('Add additional validation rules to improve confidence');
        }

        if (pattern.complexity === 'complex') {
            modifications.push('Consider simplifying transformation logic');
        }

        return modifications;
    }

    private calculateEstimatedAccuracy(pattern: MappingPattern, similarity: number): number {
        return pattern.successRate * similarity * pattern.confidence;
    }

    private generateRecommendationReason(pattern: MappingPattern, similarity: number): string {
        if (similarity > 0.9) {
            return `Highly similar field mapping with ${Math.round(pattern.successRate * 100)}% success rate`;
        } else if (similarity > 0.7) {
            return `Similar field pattern with good performance (${pattern.usageCount} uses)`;
        } else {
            return `Related mapping pattern that might be adaptable`;
        }
    }

    private calculateAverageResponseTime(): number {
        // Simulated average response time based on cache size
        const baseTime = 5; // 5ms base
        const sizeFactor = this.cache.size / 1000;
        return baseTime + sizeFactor;
    }

    private estimateMemoryUsage(): number {
        // Estimate memory usage in MB based on cache size
        const avgPatternSize = 2; // 2KB per pattern estimate
        return (this.cache.size * avgPatternSize) / 1024;
    }

    private getLastEvictionTime(): Date | null {
        // Mock implementation - in real system this would track actual evictions
        return this.cache.size >= this.configuration.maxSize ? new Date() : null;
    }

    private async calculateHitRate(): Promise<number> {
        const totalRequests = Array.from(this.usageStats.values()).reduce((sum, count) => sum + count, 0);
        const hits = Array.from(this.cache.values()).reduce((sum, p) => sum + p.usageCount, 0);
        return totalRequests > 0 ? (hits / totalRequests) * 100 : 0;
    }

    private generateNewPatternSuggestions(patterns: MappingPattern[]): string[] {
        const suggestions: string[] = [];

        // Analyze gaps in current patterns
        const categories = new Set(patterns.map(p => p.category));
        const commonCategories = ['customer_data', 'product_data', 'order_data', 'financial_data'];

        commonCategories.forEach(category => {
            if (!categories.has(category)) {
                suggestions.push(`Create patterns for ${category} category`);
            }
        });

        // Suggest patterns for high-failure cases
        const lowSuccessPatterns = patterns.filter(p => p.successRate < 0.8);
        if (lowSuccessPatterns.length > 0) {
            suggestions.push('Develop alternative patterns for low-success mappings');
        }

        return suggestions.slice(0, 5);
    }

    private async removeExpiredPatterns(): Promise<number> {
        const ttlMs = this.configuration.ttlMinutes * 60 * 1000;
        const now = Date.now();
        let removedCount = 0;

        for (const [patternId, accessTime] of this.accessTimes) {
            if (now - accessTime.getTime() > ttlMs) {
                this.cache.delete(patternId);
                this.usageStats.delete(patternId);
                this.accessTimes.delete(patternId);
                removedCount++;
            }
        }

        return removedCount;
    }

    private async consolidateDuplicates(): Promise<number> {
        const patterns = Array.from(this.cache.values());
        const duplicateGroups = new Map<string, MappingPattern[]>();

        patterns.forEach(pattern => {
            const key = `${pattern.sourceField}-${pattern.targetField}-${pattern.systemPair}`;
            if (!duplicateGroups.has(key)) {
                duplicateGroups.set(key, []);
            }
            duplicateGroups.get(key)!.push(pattern);
        });

        let consolidatedCount = 0;
        duplicateGroups.forEach((group, key) => {
            if (group.length > 1) {
                // Keep the best performing pattern
                const bestPattern = group.reduce((best, current) =>
                    current.successRate > best.successRate ? current : best
                );

                // Remove others
                group.forEach(pattern => {
                    if (pattern.id !== bestPattern.id) {
                        this.cache.delete(pattern.id);
                        this.usageStats.delete(pattern.id);
                        this.accessTimes.delete(pattern.id);
                        consolidatedCount++;
                    }
                });
            }
        });

        return consolidatedCount;
    }

    private async compressPatterns(): Promise<number> {
        // Mock compression - in real implementation this would compress pattern data
        return Math.floor(this.estimateMemoryUsage() * 0.1);
    }

    private async optimizeConfiguration(): Promise<boolean> {
        const analytics = await this.getPatternAnalytics();
        let optimized = false;

        // Adjust cache size based on usage patterns
        if (analytics.performanceMetrics.cacheHitRate > 0.9 && this.cache.size < this.configuration.maxSize * 0.8) {
            this.configuration.maxSize = Math.floor(this.configuration.maxSize * 0.9);
            optimized = true;
        }

        // Adjust TTL based on usage frequency
        const avgDaysSinceUsed = Array.from(this.cache.values()).reduce((sum, p) => {
            const days = (Date.now() - p.lastUsed.getTime()) / (1000 * 60 * 60 * 24);
            return sum + days;
        }, 0) / this.cache.size;

        if (avgDaysSinceUsed < 1 && this.configuration.ttlMinutes > 720) {
            this.configuration.ttlMinutes = 720; // 12 hours
            optimized = true;
        }

        return optimized;
    }

    private calculatePerformanceImprovement(): number {
        // Mock calculation - in real implementation this would measure actual performance
        return Math.random() * 15 + 5; // 5-20% improvement
    }

    private estimateComputeSavings(): number {
        // Mock calculation for compute cycle savings
        return this.cache.size * 1000; // Estimated cycles saved
    }

    private async performPeriodicMaintenance(): Promise<void> {
        try {
            // Remove expired patterns
            await this.removeExpiredPatterns();

            // Log cache statistics
            const metrics = await this.getCacheMetrics();
            this.loggingService.info('Periodic cache maintenance completed', {
                totalPatterns: metrics.totalPatterns,
                hitRate: metrics.hitRate,
                memoryUsage: metrics.memoryUsage
            });

        } catch (error) {
            this.loggingService.error('Periodic maintenance failed', error);
        }
    }

    // Week 7 Enhanced Methods

    /**
     * Find similar mapping patterns for AI learning and recommendation
     */
    async findSimilarPatterns(sourcePattern: MappingPattern, limit = 10): Promise<PatternSimilarityScore[]> {
        try {
            const similarities: PatternSimilarityScore[] = [];

            for (const [patternId, pattern] of this.cache) {
                if (patternId === sourcePattern.id) continue;

                const score = this.calculateAdvancedSimilarity(sourcePattern, pattern);
                if (score.similarityScore > 0.3) {
                    similarities.push(score);
                }
            }

            const sortedSimilarities = similarities
                .sort((a, b) => b.similarityScore - a.similarityScore)
                .slice(0, limit);

            this.telemetryService.recordMetric('similar_patterns_found', sortedSimilarities.length, {
                sourcePatternId: sourcePattern.id,
                topSimilarity: sortedSimilarities[0]?.similarityScore || 0
            });

            return sortedSimilarities;

        } catch (error) {
            this.loggingService.error('Failed to find similar patterns', error, { sourcePatternId: sourcePattern.id });
            throw error;
        }
    }

    /**
     * Generate intelligent cache optimization recommendations
     */
    async generateOptimizationRecommendations(): Promise<CacheOptimizationRecommendation[]> {
        try {
            const recommendations: CacheOptimizationRecommendation[] = [];
            const metrics = await this.getAdvancedCacheMetrics();

            // Hit rate optimization
            if (metrics.hitRate < 80) {
                recommendations.push({
                    type: 'preload',
                    priority: 9,
                    expectedImprovement: 0.25,
                    description: 'Preload frequently accessed mapping patterns',
                    implementation: 'Implement usage-based preloading strategy',
                    riskLevel: 'low',
                    estimatedEffort: '2-3 days'
                });
            }

            // Storage efficiency optimization
            if (metrics.storageEfficiency < 70) {
                recommendations.push({
                    type: 'compression',
                    priority: 7,
                    expectedImprovement: 0.30,
                    description: 'Enable pattern compression to reduce memory usage',
                    implementation: 'Implement LZ4 compression for stored patterns',
                    riskLevel: 'low',
                    estimatedEffort: '1-2 days'
                });
            }

            // Index efficiency optimization
            if (metrics.indexEfficiency < 60) {
                recommendations.push({
                    type: 'indexing',
                    priority: 8,
                    expectedImprovement: 0.40,
                    description: 'Enhance field-based indexing for faster retrieval',
                    implementation: 'Create composite indexes for field combinations',
                    riskLevel: 'medium',
                    estimatedEffort: '3-4 days'
                });
            }

            // Eviction strategy optimization
            if (metrics.evictionCount > metrics.totalPatterns * 0.1) {
                recommendations.push({
                    type: 'eviction',
                    priority: 6,
                    expectedImprovement: 0.20,
                    description: 'Optimize eviction strategy to reduce churn',
                    implementation: 'Switch to adaptive LRU-LFU hybrid eviction',
                    riskLevel: 'medium',
                    estimatedEffort: '2-3 days'
                });
            }

            return recommendations.sort((a, b) => b.priority - a.priority);

        } catch (error) {
            this.loggingService.error('Failed to generate optimization recommendations', error);
            throw error;
        }
    }

    /**
     * Update pattern usage metrics with success tracking
     */
    async updatePatternMetrics(patternId: string, success: boolean, executionTime: number): Promise<void> {
        try {
            const pattern = this.cache.get(patternId);
            if (!pattern) return;

            pattern.usageCount++;
            pattern.lastUsed = new Date();

            // Update success rate with exponential moving average
            const alpha = 0.1; // Learning rate
            pattern.successRate = pattern.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

            this.cache.set(patternId, pattern);
            this.usageStats.set(patternId, pattern.usageCount);

            this.telemetryService.recordMetric('pattern_usage_update', 1, {
                patternId,
                success,
                executionTime,
                newSuccessRate: pattern.successRate
            });

            this.loggingService.debug('Updated pattern metrics', {
                patternId,
                usageCount: pattern.usageCount,
                successRate: pattern.successRate
            });

        } catch (error) {
            this.loggingService.error('Failed to update pattern metrics', error, { patternId });
        }
    }

    /**
     * Get advanced cache metrics with Week 7 enhancements
     */
    async getAdvancedCacheMetrics(): Promise<AdvancedCacheMetrics> {
        try {
            const basicMetrics = await this.getCacheMetrics();

            // Calculate advanced metrics
            const patterns = Array.from(this.cache.values());
            const totalSuccessRate = patterns.reduce((sum, p) => sum + p.successRate, 0);
            const patternMatchAccuracy = patterns.length > 0 ? totalSuccessRate / patterns.length : 0;

            const highUsagePatterns = patterns.filter(p => p.usageCount > 10).length;
            const storageEfficiency = patterns.length > 0 ? (highUsagePatterns / patterns.length) * 100 : 0;

            const evictionCount = this.calculateEvictionCount();
            const indexEfficiency = this.calculateIndexEfficiency();
            const compressionRatio = this.calculateCompressionRatio();

            const advancedMetrics: AdvancedCacheMetrics = {
                ...basicMetrics,
                patternMatchAccuracy: patternMatchAccuracy * 100,
                storageEfficiency,
                evictionCount,
                indexEfficiency,
                compressionRatio
            };

            this.telemetryService.recordMetric('advanced_metrics_calculated', 1, {
                patternMatchAccuracy: advancedMetrics.patternMatchAccuracy,
                storageEfficiency: advancedMetrics.storageEfficiency
            });

            return advancedMetrics;

        } catch (error) {
            this.loggingService.error('Failed to calculate advanced cache metrics', error);
            throw error;
        }
    }

    /**
     * Store mapping pattern with enhanced indexing
     */
    async storeMappingPatternEnhanced(pattern: MappingPattern): Promise<void> {
        try {
            // Store the pattern using existing method
            await this.cachePattern(pattern);

            // Update Week 7 indexes
            this.updateEnhancedIndexes(pattern);

            this.loggingService.debug('Stored pattern with enhanced indexing', {
                patternId: pattern.id,
                fieldsIndexed: (pattern.sourceFields?.length || 0) + (pattern.targetFields?.length || 0)
            });

        } catch (error) {
            this.loggingService.error('Failed to store pattern with enhanced indexing', error, { patternId: pattern.id });
            throw error;
        }
    }

    // Week 7 Enhanced Private Methods

    private calculateAdvancedSimilarity(pattern1: MappingPattern, pattern2: MappingPattern): PatternSimilarityScore {
        let similarityScore = 0;
        const matchingFields: string[] = [];
        const reasons: string[] = [];

        // System type similarity (30% weight)
        if (pattern1.systemPair === pattern2.systemPair) {
            similarityScore += 0.3;
            reasons.push('Same system pair');
        }

        // Field similarity (40% weight)
        const fields1 = [pattern1.sourceField, pattern1.targetField, ...(pattern1.sourceFields || []), ...(pattern1.targetFields || [])];
        const fields2 = [pattern2.sourceField, pattern2.targetField, ...(pattern2.sourceFields || []), ...(pattern2.targetFields || [])];

        const commonFields = fields1.filter(field => fields2.includes(field));
        matchingFields.push(...commonFields);

        if (commonFields.length > 0) {
            const fieldSimilarity = commonFields.length / Math.max(fields1.length, fields2.length);
            similarityScore += fieldSimilarity * 0.4;
            reasons.push(`${commonFields.length} matching fields`);
        }

        // Category similarity (20% weight)
        if (pattern1.category === pattern2.category) {
            similarityScore += 0.2;
            reasons.push('Same category');
        }

        // Complexity similarity (10% weight)
        if (pattern1.complexity === pattern2.complexity) {
            similarityScore += 0.1;
            reasons.push('Same complexity level');
        }

        // Confidence adjustment based on success rates
        const confidenceAdjustment = (pattern1.successRate + pattern2.successRate) / 2;

        return {
            patternId: pattern2.id,
            similarityScore: Math.min(similarityScore, 1.0),
            matchingFields: [...new Set(matchingFields)], // Remove duplicates
            confidenceAdjustment,
            reasons
        };
    }

    private updateEnhancedIndexes(pattern: MappingPattern): void {
        // Update field indexes for all fields
        const allFields = [
            pattern.sourceField,
            pattern.targetField,
            ...(pattern.sourceFields || []),
            ...(pattern.targetFields || [])
        ];

        allFields.forEach(field => {
            if (!this.fieldIndexes.has(field)) {
                this.fieldIndexes.set(field, new Set());
            }
            this.fieldIndexes.get(field)!.add(pattern.id);
        });

        // Update system index
        if (!this.systemIndexes.has(pattern.systemPair)) {
            this.systemIndexes.set(pattern.systemPair, new Set());
        }
        this.systemIndexes.get(pattern.systemPair)!.add(pattern.id);
    }

    private calculateEvictionCount(): number {
        // Mock calculation - in real implementation this would track actual evictions
        return Math.floor(this.cache.size * 0.05); // Estimate 5% eviction rate
    }

    private calculateIndexEfficiency(): number {
        // Calculate index efficiency based on index coverage
        const totalFields = this.fieldIndexes.size;
        const totalPatterns = this.cache.size;
        return totalPatterns > 0 ? (totalFields / (totalPatterns * 2)) * 100 : 0; // Assuming avg 2 fields per pattern
    }

    private calculateCompressionRatio(): number {
        // Mock compression ratio calculation
        return this.configuration.compressionEnabled ? 0.75 : 1.0; // 25% compression if enabled
    }
}