/**
 * AI Predictive Connector Recommendations Service
 * Provides intelligent system discovery, integration pathway optimization, and ecosystem intelligence
 * Enhanced for Week 7 Predictive Analytics with advanced forecasting and pattern recognition
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import { LoggingService } from './ai/logging/LoggingService';
import { TelemetryService } from './ai/telemetry/TelemetryService';
import { PredictiveAnalyticsService } from './ai/PredictiveAnalyticsService';
import {
    MappingPatternCacheService,
    type ValidationRule,
    type PatternRecommendation,
} from './ai/MappingPatternCacheService';
import {
    PerformanceOptimizationService,
    type OptimizationRecommendation,
    type SystemBottleneck,
} from './ai/PerformanceOptimizationService';
import { ROIAnalysisService } from './ai/orchestrator/agents/intelligence/ROIAnalysisService';

// --- Module-scope structural shapes for opaque inputs ---
// Loose shapes used to type-narrow `unknown` parameters and Map values that
// represent connector-like, system-like, or recommendation-like records from
// older code paths. All fields optional because runtime sources vary.

interface ConnectorRef {
    id?: string;
    name?: string;
    category?: string;
    benefits?: string[];
    cost?: number;
    prerequisites?: string[];
    apiComplexity?: 'simple' | 'medium' | 'complex' | string;
    customization?: 'none' | 'extensive' | string;
}

interface SystemRef {
    id?: string;
    name?: string;
    adoption?: number;
}

interface RecommendationRef {
    category?: string;
    title?: string;
}

interface PredictiveAnalysisShape {
    recommendations?: RecommendationRef[];
    forecasting?: {
        trendAnalysis?: { growth?: number };
        capacityPlanning?: { recommendations?: string[] };
    };
}

interface ProfileShape {
    commonSystems?: SystemRef[];
}

/** Coerce a string-or-system-ref entry to a stable string id for predictive analytics input. */
function systemRefId(s: unknown): string {
    if (typeof s === 'string') return s;
    const r = s as SystemRef;
    return r?.id || r?.name || String(s);
}

interface ConnectorRecommendation {
    connectorId: string;
    systemName: string;
    category: string;
    relevanceScore: number;
    reasoning: string;
    benefits: string[];
    implementationComplexity: 'low' | 'medium' | 'high';
    estimatedROI: number;
    integrationPathway: IntegrationPathway;
    prerequisites: string[];
    marketTrends: MarketTrend;
    similarCompanies: CompanyExample[];
}

interface IntegrationPathway {
    recommended: boolean;
    steps: PathwayStep[];
    estimatedTimeline: string;
    resourceRequirements: ResourceRequirement[];
    risks: Risk[];
    alternatives: AlternativePathway[];
}

interface PathwayStep {
    step: number;
    description: string;
    duration: string;
    dependencies: string[];
    deliverables: string[];
    effort: 'low' | 'medium' | 'high';
}

interface ResourceRequirement {
    type: 'technical' | 'business' | 'training' | 'licensing';
    description: string;
    quantity: string;
    cost?: number;
}

interface Risk {
    description: string;
    probability: number;
    impact: 'low' | 'medium' | 'high' | 'critical';
    mitigation: string;
}

interface AlternativePathway {
    name: string;
    description: string;
    tradeoffs: string[];
    suitability: number;
}

interface MarketTrend {
    adoption: number;
    growth: number;
    maturity: 'emerging' | 'growing' | 'mature' | 'declining';
    industryUsage: IndustryUsage[];
}

interface IndustryUsage {
    industry: string;
    adoptionRate: number;
    commonUseCases: string[];
}

interface CompanyExample {
    companySize: string;
    industry: string;
    challenge: string;
    solution: string;
    results: string;
}

interface SystemAnalysis {
    currentSystems: DetectedSystem[];
    gaps: SystemGap[];
    opportunities: IntegrationOpportunity[];
    stackMaturity: number;
    recommendations: SystemRecommendation[];
}

interface DetectedSystem {
    name: string;
    category: string;
    version?: string;
    usage: 'high' | 'medium' | 'low';
    integrationPotential: number;
    dataVolume: number;
    businessCriticality: 'critical' | 'important' | 'useful' | 'optional';
}

interface SystemGap {
    area: string;
    description: string;
    impact: 'high' | 'medium' | 'low';
    suggestedSolutions: string[];
    priority: number;
}

interface IntegrationOpportunity {
    source: string;
    target: string;
    value: number;
    effort: number;
    roi: number;
    description: string;
    businessJustification: string;
}

interface SystemRecommendation {
    type: 'add' | 'replace' | 'upgrade' | 'integrate';
    system: string;
    reasoning: string;
    priority: number;
    timeline: string;
    investment: number;
}

interface PredictionModel {
    nextLikelyIntegrations: NextIntegration[];
    seasonalDemand: SeasonalDemand[];
    technologyTrends: TechnologyTrend[];
    competitiveAnalysis: CompetitiveAnalysis;
}

interface NextIntegration {
    system: string;
    probability: number;
    timeframe: string;
    drivers: string[];
    preparationSteps: string[];
}

interface SeasonalDemand {
    season: string;
    demandIncrease: number;
    popularIntegrations: string[];
    planningAdvice: string;
}

interface TechnologyTrend {
    technology: string;
    trend: 'rising' | 'stable' | 'declining';
    impact: string;
    recommendation: string;
}

interface CompetitiveAnalysis {
    competitorIntegrations: string[];
    industryStandards: string[];
    differentiationOpportunities: string[];
    marketPositioning: string;
}

interface IntegrationPattern {
    sourceSystem: string;
    targetSystem: string;
    frequency: number;
    drivers: string[];
}

interface CatalogEntry {
    id: string;
    name: string;
    category: string;
    benefits?: string[];
    cost?: number;
    prerequisites?: string[];
}

@injectable()
export class AIPredictiveConnectorService {
    private systemCatalog = new Map<string, CatalogEntry[]>();
    private integrationPatterns = new Map<string, IntegrationPattern[]>();
    private industryProfiles = new Map<string, unknown>();
    private marketData = new Map<string, MarketTrend>();

    constructor(
        @inject(TYPES.LoggingService) private loggingService: LoggingService,
        @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
        @inject(TYPES.PredictiveAnalyticsService) private predictiveAnalyticsService: PredictiveAnalyticsService,
        @inject(TYPES.MappingPatternCacheService) private mappingPatternCacheService: MappingPatternCacheService,
        @inject(TYPES.PerformanceOptimizationService) private performanceOptimizationService: PerformanceOptimizationService,
        @inject(TYPES.ROIAnalysisService) private roiService: ROIAnalysisService
    ) {
        this.loggingService.info('Initializing AIPredictiveConnectorService with Week 7 enhancements');
        this.initializeSystemCatalog();
        this.initializeIntegrationPatterns();
        this.initializeIndustryProfiles();
        this.initializeMarketData();
        this.loggingService.info('AIPredictiveConnectorService initialization completed');
    }

    /**
     * Generate intelligent connector recommendations based on current stack
     * Enhanced with Week 7 predictive analytics and performance optimization
     */
    async generateRecommendations(
        currentSystems: string[],
        industry: string,
        companySize: string,
        businessGoals: string[]
    ): Promise<ConnectorRecommendation[]> {
        try {
            this.loggingService.info('Generating connector recommendations with predictive analytics', {
                currentSystems: currentSystems.length,
                industry,
                companySize,
                businessGoals: businessGoals.length
            });

            const startTime = Date.now();

            // Enhanced system analysis with predictive capabilities
            const systemAnalysis = await this.analyzeCurrentSystems(currentSystems);
            const industryProfile = this.industryProfiles.get(industry);
            const recommendations: ConnectorRecommendation[] = [];

            // Use predictive analytics to enhance gap analysis
            const predictiveAnalysis = await this.predictiveAnalyticsService.performPredictiveAnalysis({
                analysisType: 'comprehensive' as const,
                timeHorizon: '6 months',
                integrationIds: currentSystems.map(systemRefId),
                includeAlerts: true,
                confidenceThreshold: 0.8
            });

            // Analyze gaps and opportunities with predictive insights
            for (const gap of systemAnalysis.gaps) {
                const connector = await this.findConnectorForGap(gap, currentSystems, industry);
                if (connector) {
                    // Enhance with predictive scoring
                    connector.relevanceScore = await this.enhanceWithPredictiveScoring(connector, predictiveAnalysis);
                    recommendations.push(connector);
                }
            }

            // Industry-specific recommendations
            if (industryProfile) {
                const industryRecs = await this.getIndustryRecommendations(
                    industryProfile,
                    currentSystems,
                    companySize
                );
                recommendations.push(...industryRecs);
            }

            // Goal-driven recommendations with performance optimization
            for (const goal of businessGoals) {
                const goalRecs = await this.getGoalDrivenRecommendations(goal, currentSystems);
                recommendations.push(...goalRecs);
            }

            // Market trend recommendations enhanced with forecasting
            const trendRecs = await this.getTrendBasedRecommendations(currentSystems, industry);
            recommendations.push(...trendRecs);

            // Cache successful patterns for future recommendations
            await this.cacheSuccessfulPatterns(recommendations, currentSystems);

            // Remove duplicates and rank by enhanced relevance
            const uniqueRecs = this.deduplicateRecommendations(recommendations);
            const finalRecommendations = uniqueRecs
                .sort((a, b) => b.relevanceScore - a.relevanceScore)
                .slice(0, 10); // Top 10 recommendations

            const processingTime = Date.now() - startTime;

            this.telemetryService.recordMetric('connector_recommendations_generated', finalRecommendations.length, {
                industry,
                companySize,
                processingTime,
                totalCandidates: recommendations.length
            });

            this.loggingService.info('Connector recommendations generated successfully', {
                recommendationsCount: finalRecommendations.length,
                processingTimeMs: processingTime,
                topRecommendation: finalRecommendations[0]?.systemName
            });

            return finalRecommendations;

        } catch (error) {
            this.loggingService.error('Failed to generate connector recommendations', error, {
                currentSystems,
                industry,
                companySize
            });
            throw error;
        }
    }

    /**
     * Predict next likely integrations for proactive planning
     */
    async predictNextIntegrations(
        currentSystems: string[],
        industry: string,
        growthStage: string
    ): Promise<PredictionModel> {
        const patterns = this.integrationPatterns.get(industry) || [];
        const marketTrends = await this.analyzeMarketTrends(industry);

        const nextLikelyIntegrations = this.predictLikelyIntegrations(
            currentSystems,
            patterns,
            marketTrends
        );

        const seasonalDemand = this.analyzeSeasonalDemand(industry);
        const technologyTrends = this.analyzeTechnologyTrends(currentSystems);
        const competitiveAnalysis = await this.performCompetitiveAnalysis(industry);

        return {
            nextLikelyIntegrations,
            seasonalDemand,
            technologyTrends,
            competitiveAnalysis
        };
    }

    /**
     * Optimize integration pathways for complex multi-system environments
     */
    async optimizeIntegrationPathway(
        sourceSystems: string[],
        targetSystems: string[],
        constraints: unknown
    ): Promise<IntegrationPathway[]> {
        const pathways: IntegrationPathway[] = [];

        // Direct integration pathways
        for (const source of sourceSystems) {
            for (const target of targetSystems) {
                const pathway = await this.calculateDirectPathway(source, target, constraints);
                if (pathway.recommended) {
                    pathways.push(pathway);
                }
            }
        }

        // Hub-and-spoke pathways
        const hubPathways = await this.calculateHubPathways(
            sourceSystems,
            targetSystems,
            constraints
        );
        pathways.push(...hubPathways);

        // ETL/Middleware pathways
        const etlPathways = await this.calculateETLPathways(
            sourceSystems,
            targetSystems,
            constraints
        );
        pathways.push(...etlPathways);

        return pathways.sort((a, b) => {
            const aScore = this.calculatePathwayScore(a);
            const bScore = this.calculatePathwayScore(b);
            return bScore - aScore;
        });
    }

    /**
     * Analyze system ecosystem for comprehensive intelligence
     */
    async analyzeSystemEcosystem(systems: string[]): Promise<SystemAnalysis> {
        const detectedSystems = await this.detectSystemDetails(systems);
        const gaps = await this.identifySystemGaps(detectedSystems);
        const opportunities = await this.identifyIntegrationOpportunities(detectedSystems);
        const maturity = this.calculateStackMaturity(detectedSystems);
        const recommendations = await this.generateSystemRecommendations(
            detectedSystems,
            gaps,
            opportunities
        );

        return {
            currentSystems: detectedSystems,
            gaps,
            opportunities,
            stackMaturity: maturity,
            recommendations
        };
    }

    // Private implementation methods

    private async analyzeCurrentSystems(systems: string[]): Promise<SystemAnalysis> {
        return await this.analyzeSystemEcosystem(systems);
    }

    private async findConnectorForGap(
        gap: SystemGap,
        currentSystems: string[],
        industry: string
    ): Promise<ConnectorRecommendation | null> {
        const connectors = this.systemCatalog.get(gap.area);
        if (!connectors || connectors.length === 0) return null;

        const bestConnector = connectors[0]; // Simplified selection
        const marketTrend = this.marketData.get(bestConnector.name) || {
            adoption: 0.5,
            growth: 0.1,
            maturity: 'growing' as const,
            industryUsage: []
        };

        return {
            connectorId: bestConnector.id,
            systemName: bestConnector.name,
            category: bestConnector.category,
            relevanceScore: this.calculateRelevanceScore(gap, bestConnector, currentSystems),
            reasoning: `Addresses ${gap.description} with proven solutions`,
            benefits: bestConnector.benefits || [],
            implementationComplexity: this.assessComplexity(bestConnector, currentSystems),
            estimatedROI: this.calculateROI(gap.impact, bestConnector.cost || 1000),
            integrationPathway: await this.calculateDirectPathway(
                currentSystems[0] || 'Unknown',
                bestConnector.name,
                {}
            ),
            prerequisites: bestConnector.prerequisites || [],
            marketTrends: marketTrend,
            similarCompanies: this.getSimilarCompanyExamples(bestConnector.name, industry)
        };
    }

    private async getIndustryRecommendations(
        profile: unknown,
        currentSystems: string[],
        companySize: string
    ): Promise<ConnectorRecommendation[]> {
        const recommendations: ConnectorRecommendation[] = [];
        const commonSystems = (profile as ProfileShape)?.commonSystems || [];

        for (const system of commonSystems) {
            if (system.name && !currentSystems.includes(system.name)) {
                const relevance = this.calculateIndustryRelevance(system, companySize);
                if (relevance > 0.6) {
                    recommendations.push(await this.createRecommendation(system, relevance));
                }
            }
        }

        return recommendations;
    }

    private async getGoalDrivenRecommendations(
        goal: string,
        currentSystems: string[]
    ): Promise<ConnectorRecommendation[]> {
        const goalMappings: Record<string, string[]> = {
            'improve_efficiency': ['automation', 'workflow', 'productivity'],
            'reduce_costs': ['cost_optimization', 'resource_management'],
            'increase_revenue': ['sales', 'marketing', 'analytics'],
            'enhance_customer_experience': ['crm', 'support', 'communication'],
            'ensure_compliance': ['governance', 'security', 'audit']
        };

        const categories = goalMappings[goal] || [];
        const recommendations: ConnectorRecommendation[] = [];

        for (const category of categories) {
            const connectors = this.systemCatalog.get(category) || [];
            for (const connector of connectors.slice(0, 2)) { // Top 2 per category
                if (!currentSystems.includes(connector.name)) {
                    recommendations.push(await this.createRecommendation(connector, 0.8));
                }
            }
        }

        return recommendations;
    }

    private async getTrendBasedRecommendations(
        currentSystems: string[],
        industry: string
    ): Promise<ConnectorRecommendation[]> {
        const recommendations: ConnectorRecommendation[] = [];
        const emergingTrends = Array.from(this.marketData.entries())
            .filter(([_, trend]) => trend.growth > 0.3 && trend.maturity === 'growing')
            .slice(0, 3);

        for (const [systemName, trend] of emergingTrends) {
            if (!currentSystems.includes(systemName)) {
                const connector = await this.getConnectorByName(systemName);
                if (connector) {
                    recommendations.push(await this.createRecommendation(connector, 0.75));
                }
            }
        }

        return recommendations;
    }

    private predictLikelyIntegrations(
        currentSystems: string[],
        patterns: IntegrationPattern[],
        marketTrends: unknown
    ): NextIntegration[] {
        const predictions: NextIntegration[] = [];

        // Analyze patterns to predict next systems
        const systemPairs = this.generateSystemPairs(currentSystems);

        for (const pattern of patterns) {
            const probability = this.calculateIntegrationProbability(
                currentSystems,
                pattern,
                marketTrends
            );

            if (probability > 0.3) {
                predictions.push({
                    system: pattern.targetSystem,
                    probability,
                    timeframe: this.estimateTimeframe(probability),
                    drivers: pattern.drivers,
                    preparationSteps: this.generatePreparationSteps(pattern.targetSystem)
                });
            }
        }

        return predictions.sort((a, b) => b.probability - a.probability);
    }

    private analyzeSeasonalDemand(industry: string): SeasonalDemand[] {
        const seasonalPatterns: Record<string, SeasonalDemand[]> = {
            'retail': [
                {
                    season: 'Q4 Holiday Season',
                    demandIncrease: 0.8,
                    popularIntegrations: ['inventory_management', 'payment_processing', 'analytics'],
                    planningAdvice: 'Scale integrations before peak season demand'
                }
            ],
            'finance': [
                {
                    season: 'Year-End Reporting',
                    demandIncrease: 0.6,
                    popularIntegrations: ['accounting', 'compliance', 'reporting'],
                    planningAdvice: 'Implement reporting integrations early in Q4'
                }
            ]
        };

        return seasonalPatterns[industry] || [];
    }

    private analyzeTechnologyTrends(currentSystems: string[]): TechnologyTrend[] {
        return [
            {
                technology: 'API-First Architecture',
                trend: 'rising',
                impact: 'Enables easier and more flexible integrations',
                recommendation: 'Prioritize systems with robust API capabilities'
            },
            {
                technology: 'Real-time Data Streaming',
                trend: 'rising',
                impact: 'Reduces data latency and improves decision-making',
                recommendation: 'Consider event-driven integration patterns'
            },
            {
                technology: 'Low-Code Integration Platforms',
                trend: 'rising',
                impact: 'Reduces development time and technical complexity',
                recommendation: 'Evaluate low-code options for rapid deployment'
            }
        ];
    }

    private async performCompetitiveAnalysis(industry: string): Promise<CompetitiveAnalysis> {
        const competitorData: Record<string, CompetitiveAnalysis> = {
            'technology': {
                competitorIntegrations: ['Salesforce', 'HubSpot', 'Slack', 'Jira', 'GitHub'],
                industryStandards: ['CRM', 'Marketing Automation', 'Development Tools'],
                differentiationOpportunities: ['Advanced Analytics', 'Custom Workflows'],
                marketPositioning: 'Technology-forward with emphasis on developer tools'
            }
        };

        return competitorData[industry] || {
            competitorIntegrations: [],
            industryStandards: [],
            differentiationOpportunities: [],
            marketPositioning: 'Standard industry practices'
        };
    }

    private async calculateDirectPathway(
        source: string,
        target: string,
        constraints: unknown
    ): Promise<IntegrationPathway> {
        return {
            recommended: true,
            steps: [
                {
                    step: 1,
                    description: `Configure ${source} connector`,
                    duration: '2-3 days',
                    dependencies: [],
                    deliverables: ['Source system connection', 'Authentication setup'],
                    effort: 'low'
                },
                {
                    step: 2,
                    description: `Configure ${target} connector`,
                    duration: '2-3 days',
                    dependencies: ['Step 1'],
                    deliverables: ['Target system connection', 'Field mappings'],
                    effort: 'low'
                },
                {
                    step: 3,
                    description: 'Test and deploy integration',
                    duration: '1-2 days',
                    dependencies: ['Step 1', 'Step 2'],
                    deliverables: ['Integration testing', 'Production deployment'],
                    effort: 'low'
                }
            ],
            estimatedTimeline: '5-8 days',
            resourceRequirements: [
                {
                    type: 'technical',
                    description: 'Integration developer',
                    quantity: '1 person',
                    cost: 5000
                }
            ],
            risks: [
                {
                    description: 'API rate limiting during high-volume sync',
                    probability: 0.3,
                    impact: 'medium',
                    mitigation: 'Implement intelligent throttling and batch processing'
                }
            ],
            alternatives: [
                {
                    name: 'ETL Pipeline',
                    description: 'Use data pipeline for complex transformations',
                    tradeoffs: ['Higher complexity', 'More flexibility'],
                    suitability: 0.7
                }
            ]
        };
    }

    // Helper methods and data initialization

    private initializeSystemCatalog(): void {
        this.systemCatalog.set('crm', [
            {
                id: 'salesforce',
                name: 'Salesforce',
                category: 'CRM',
                benefits: ['Market leader', 'Extensive API', 'Large ecosystem'],
                cost: 2000,
                prerequisites: ['Salesforce license', 'API access']
            },
            {
                id: 'hubspot',
                name: 'HubSpot',
                category: 'CRM',
                benefits: ['Free tier available', 'Marketing automation', 'Easy setup'],
                cost: 500,
                prerequisites: ['HubSpot account']
            }
        ]);

        this.systemCatalog.set('automation', [
            {
                id: 'zapier',
                name: 'Zapier',
                category: 'Automation',
                benefits: ['No-code setup', '3000+ app integrations', 'Quick deployment'],
                cost: 300,
                prerequisites: ['Application accounts']
            }
        ]);
    }

    private initializeIntegrationPatterns(): void {
        this.integrationPatterns.set('technology', [
            {
                sourceSystem: 'Salesforce',
                targetSystem: 'Slack',
                frequency: 0.8,
                drivers: ['Team collaboration', 'Sales notifications']
            },
            {
                sourceSystem: 'GitHub',
                targetSystem: 'Jira',
                frequency: 0.9,
                drivers: ['Development workflow', 'Issue tracking']
            }
        ]);
    }

    private initializeIndustryProfiles(): void {
        this.industryProfiles.set('technology', {
            commonSystems: [
                { name: 'Salesforce', adoption: 0.7 },
                { name: 'Slack', adoption: 0.8 },
                { name: 'GitHub', adoption: 0.9 },
                { name: 'Jira', adoption: 0.6 }
            ],
            criticalIntegrations: ['CRM-Support', 'Development-Project Management'],
            complianceRequirements: ['SOC2', 'ISO 27001']
        });
    }

    private initializeMarketData(): void {
        this.marketData.set('Salesforce', {
            adoption: 0.65,
            growth: 0.15,
            maturity: 'mature',
            industryUsage: [
                { industry: 'technology', adoptionRate: 0.8, commonUseCases: ['Sales', 'Marketing'] }
            ]
        });

        this.marketData.set('Slack', {
            adoption: 0.45,
            growth: 0.25,
            maturity: 'growing',
            industryUsage: [
                { industry: 'technology', adoptionRate: 0.9, commonUseCases: ['Communication', 'Collaboration'] }
            ]
        });
    }

    // Additional helper methods for calculations and analysis

    private calculateRelevanceScore(gap: SystemGap, connector: unknown, currentSystems: string[]): number {
        let score = 0.5; // Base score

        // Higher score for addressing high-impact gaps
        if (gap.impact === 'high') score += 0.3;
        else if (gap.impact === 'medium') score += 0.2;

        // Integration potential with current systems
        score += this.calculateIntegrationPotential(connector, currentSystems) * 0.2;

        return Math.min(1.0, score);
    }

    private calculateIntegrationPotential(connector: unknown, currentSystems: string[]): number {
        // Mock calculation - would use real integration compatibility matrix
        return 0.7;
    }

    private assessComplexity(connector: unknown, currentSystems: string[]): 'low' | 'medium' | 'high' {
        // Simplified complexity assessment
        const c = connector as ConnectorRef;
        if (c?.apiComplexity === 'simple') return 'low';
        if (c?.customization === 'extensive') return 'high';
        return 'medium';
    }

    private calculateROI(impact: string, cost: number): number {
        const impactValues: Record<string, number> = { 'high': 15000, 'medium': 8000, 'low': 3000 };
        const value = impactValues[impact] || 5000;
        return this.roiService.calculateSimpleROI(value, cost);
    }

    private getSimilarCompanyExamples(systemName: string, industry: string): CompanyExample[] {
        return [
            {
                companySize: 'Medium (100-500 employees)',
                industry: industry,
                challenge: 'Manual data entry between systems',
                solution: `Implemented ${systemName} integration`,
                results: '60% reduction in manual work, 95% data accuracy'
            }
        ];
    }

    private calculateIndustryRelevance(system: unknown, companySize: string): number {
        // Mock calculation based on system adoption and company size fit
        const s = system as SystemRef;
        return (s?.adoption ?? 0) * 0.8 + (companySize === 'medium' ? 0.2 : 0.1);
    }

    private async createRecommendation(connector: unknown, relevance: number): Promise<ConnectorRecommendation> {
        const c = connector as ConnectorRef;
        const name = c?.name ?? '';
        return {
            connectorId: c?.id || name.toLowerCase(),
            systemName: name,
            category: c?.category ?? '',
            relevanceScore: relevance,
            reasoning: `Recommended based on industry best practices and market trends`,
            benefits: c?.benefits || [],
            implementationComplexity: 'medium',
            estimatedROI: this.calculateROI('medium', c?.cost || 1000),
            integrationPathway: await this.calculateDirectPathway('current', name, {}),
            prerequisites: c?.prerequisites || [],
            marketTrends: this.marketData.get(name) || {
                adoption: 0.5, growth: 0.1, maturity: 'growing', industryUsage: []
            },
            similarCompanies: []
        };
    }

    private deduplicateRecommendations(recommendations: ConnectorRecommendation[]): ConnectorRecommendation[] {
        const seen = new Set();
        return recommendations.filter(rec => {
            if (seen.has(rec.connectorId)) return false;
            seen.add(rec.connectorId);
            return true;
        });
    }

    // Additional implementation methods would continue here...
    private generateSystemPairs(systems: string[]): string[][] {
        const pairs: string[][] = [];
        for (let i = 0; i < systems.length; i++) {
            for (let j = i + 1; j < systems.length; j++) {
                const systemA = systems[i];
                const systemB = systems[j];
                if (systemA && systemB) {
                    pairs.push([systemA, systemB]);
                }
            }
        }
        return pairs;
    }

    private calculateIntegrationProbability(systems: string[], pattern: IntegrationPattern, trends: unknown): number {
        return 0.65; // Mock calculation
    }

    private estimateTimeframe(probability: number): string {
        if (probability > 0.8) return '1-3 months';
        if (probability > 0.6) return '3-6 months';
        if (probability > 0.4) return '6-12 months';
        return '12+ months';
    }

    private generatePreparationSteps(system: string): string[] {
        return [
            `Research ${system} integration capabilities`,
            'Assess current infrastructure compatibility',
            'Plan data migration strategy',
            'Prepare team training resources'
        ];
    }

    private async calculateHubPathways(sources: string[], targets: string[], constraints: unknown): Promise<IntegrationPathway[]> {
        return []; // Implementation would calculate hub-and-spoke architectures
    }

    private async calculateETLPathways(sources: string[], targets: string[], constraints: unknown): Promise<IntegrationPathway[]> {
        return []; // Implementation would calculate ETL/middleware options
    }

    private calculatePathwayScore(pathway: IntegrationPathway): number {
        // Score based on timeline, complexity, and success probability
        const timelineScore = pathway.estimatedTimeline.includes('days') ? 0.8 : 0.6;
        const complexityScore = pathway.steps.every(s => s.effort === 'low') ? 0.9 : 0.7;
        const riskScore = pathway.risks.length === 0 ? 1.0 : (1.0 - pathway.risks.length * 0.1);

        return (timelineScore + complexityScore + riskScore) / 3;
    }

    private async detectSystemDetails(systems: string[]): Promise<DetectedSystem[]> {
        return systems.map(system => ({
            name: system,
            category: 'Unknown',
            usage: 'medium',
            integrationPotential: 0.7,
            dataVolume: 1000,
            businessCriticality: 'important'
        }));
    }

    private async identifySystemGaps(systems: DetectedSystem[]): Promise<SystemGap[]> {
        return [
            {
                area: 'Analytics',
                description: 'Missing comprehensive analytics and reporting capabilities',
                impact: 'high',
                suggestedSolutions: ['Business Intelligence Platform', 'Analytics Dashboard'],
                priority: 8
            }
        ];
    }

    private async identifyIntegrationOpportunities(systems: DetectedSystem[]): Promise<IntegrationOpportunity[]> {
        return [
            {
                source: systems[0]?.name || 'System A',
                target: systems[1]?.name || 'System B',
                value: 25000,
                effort: 40,
                roi: 525,
                description: 'Automate data flow between systems',
                businessJustification: 'Eliminate manual data entry and improve accuracy'
            }
        ];
    }

    private calculateStackMaturity(systems: DetectedSystem[]): number {
        return systems.length > 0 ? 0.75 : 0.3; // Mock maturity calculation
    }

    private async generateSystemRecommendations(
        systems: DetectedSystem[],
        gaps: SystemGap[],
        opportunities: IntegrationOpportunity[]
    ): Promise<SystemRecommendation[]> {
        return gaps.map(gap => ({
            type: 'add',
            system: gap.suggestedSolutions[0] || 'Unknown',
            reasoning: gap.description,
            priority: gap.priority,
            timeline: '3-6 months',
            investment: 10000
        }));
    }

    private async analyzeMarketTrends(industry: string): Promise<unknown> {
        return { growth: 0.15, emerging: ['AI/ML', 'Real-time Analytics'] };
    }

    private async getConnectorByName(name: string): Promise<CatalogEntry | null> {
        for (const connectors of this.systemCatalog.values()) {
            const connector = connectors.find((c) => c.name === name);
            if (connector) return connector;
        }
        return null;
    }

    /**
     * Week 7 Enhancement: Enhance recommendation scoring with predictive analytics
     */
    private async enhanceWithPredictiveScoring(
        connector: ConnectorRecommendation,
        predictiveAnalysis: unknown
    ): Promise<number> {
        try {
            let enhancedScore = connector.relevanceScore;
            const analysis = predictiveAnalysis as PredictiveAnalysisShape;

            // Enhance with predictive insights
            if (analysis?.recommendations) {
                const predictiveRecommendations = analysis.recommendations;

                // Check if this connector aligns with predictive recommendations
                const alignment = predictiveRecommendations.find((rec) =>
                    rec.category === connector.category || rec.title?.includes(connector.systemName)
                );

                if (alignment) {
                    enhancedScore += 0.2; // Boost score for predictive alignment
                }
            }

            // Enhance with forecasting data
            if (analysis?.forecasting) {
                const forecast = analysis.forecasting;

                // Boost score for systems with positive growth trends
                if ((forecast.trendAnalysis?.growth ?? 0) > 0.1) {
                    enhancedScore += 0.15;
                }

                // Consider capacity planning recommendations
                if (forecast.capacityPlanning?.recommendations?.includes(connector.category)) {
                    enhancedScore += 0.1;
                }
            }

            return Math.min(1.0, enhancedScore);

        } catch (error) {
            this.loggingService.error('Failed to enhance scoring with predictive analytics', error);
            return connector.relevanceScore;
        }
    }

    /**
     * Week 7 Enhancement: Cache successful patterns for improved recommendations
     */
    private async cacheSuccessfulPatterns(
        recommendations: ConnectorRecommendation[],
        currentSystems: string[]
    ): Promise<void> {
        try {
            for (const recommendation of recommendations) {
                if (recommendation.relevanceScore > 0.8) {
                    const pattern = {
                        id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`,
                        sourceField: currentSystems.join(','),
                        targetField: recommendation.systemName,
                        transformationLogic: 'connector_recommendation',
                        confidence: recommendation.relevanceScore,
                        usageCount: 1,
                        lastUsed: new Date(),
                        successRate: 0.9,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        tags: [recommendation.category, 'connector', 'recommendation'],
                        category: 'connector_patterns',
                        systemPair: `${currentSystems[0] || 'multiple'}-${recommendation.systemName}`,
                        complexity: this.mapComplexityLevel(recommendation.implementationComplexity),
                        validationRules: [] as ValidationRule[]
                    };

                    await this.mappingPatternCacheService.cachePattern(pattern);
                }
            }

            this.telemetryService.recordMetric('patterns_cached', recommendations.length);

        } catch (error) {
            this.loggingService.error('Failed to cache successful patterns', error);
        }
    }

    /**
     * Week 7 Enhancement: Generate performance-optimized integration recommendations
     */
    async generatePerformanceOptimizedRecommendations(
        currentSystems: string[],
        performanceRequirements: unknown
    ): Promise<ConnectorRecommendation[]> {
        try {
            this.loggingService.info('Generating performance-optimized recommendations', {
                currentSystems: currentSystems.length,
                performanceRequirements
            });

            // Get performance optimization recommendations
            const optimizationRecs = await this.performanceOptimizationService.analyzePerformance();

            // Get current performance metrics
            const currentMetrics = await this.performanceOptimizationService.collectCurrentMetrics();

            const recommendations: ConnectorRecommendation[] = [];

            // Filter optimization recommendations for integration-related improvements
            for (const optimization of optimizationRecs) {
                if (optimization.category === 'performance' || optimization.category === 'cache') {
                    const connector = await this.findPerformanceConnector(optimization, currentSystems);
                    if (connector) {
                        recommendations.push(connector);
                    }
                }
            }

            // Add recommendations based on performance bottlenecks
            const bottlenecks = await this.performanceOptimizationService.detectBottlenecks();
            for (const bottleneck of bottlenecks) {
                if (bottleneck.severity > 70) {
                    const connector = await this.findBottleneckSolution(bottleneck, currentSystems);
                    if (connector) {
                        recommendations.push(connector);
                    }
                }
            }

            this.telemetryService.recordMetric('performance_recommendations_generated', recommendations.length, {
                optimizationCount: optimizationRecs.length,
                bottleneckCount: bottlenecks.length
            });

            return recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 5);

        } catch (error) {
            this.loggingService.error('Failed to generate performance-optimized recommendations', error);
            return [];
        }
    }

    /**
     * Week 7 Enhancement: Get integration recommendations from cached patterns
     */
    async getCachedPatternRecommendations(
        sourceSystem: string,
        targetContext: string
    ): Promise<ConnectorRecommendation[]> {
        try {
            this.loggingService.info('Getting recommendations from cached patterns', {
                sourceSystem,
                targetContext
            });

            const patternRecommendations = await this.mappingPatternCacheService.getRecommendations(
                sourceSystem,
                targetContext
            );

            const recommendations: ConnectorRecommendation[] = [];

            for (const patternRec of patternRecommendations) {
                const connector = await this.convertPatternToConnectorRecommendation(patternRec);
                if (connector) {
                    recommendations.push(connector);
                }
            }

            this.telemetryService.recordMetric('cached_pattern_recommendations', recommendations.length);

            return recommendations;

        } catch (error) {
            this.loggingService.error('Failed to get cached pattern recommendations', error);
            return [];
        }
    }

    /**
     * Week 7 Enhancement: Analyze integration ecosystem with predictive insights
     */
    async analyzeIntegrationEcosystem(
        systems: string[],
        includeForecasting = true
    ): Promise<SystemAnalysis & { predictiveInsights?: unknown }> {
        try {
            this.loggingService.info('Analyzing integration ecosystem with predictive insights', {
                systemsCount: systems.length,
                includeForecasting
            });

            // Get base ecosystem analysis
            const baseAnalysis = await this.analyzeSystemEcosystem(systems);

            if (!includeForecasting) {
                return baseAnalysis;
            }

            // Add predictive insights
            const predictiveAnalysis = await this.predictiveAnalyticsService.performPredictiveAnalysis({
                analysisType: 'comprehensive' as const,
                timeHorizon: '6 months',
                integrationIds: systems.map(systemRefId),
                includeAlerts: true,
                confidenceThreshold: 0.8
            });

            // Enhance analysis with predictive insights
            const enhancedAnalysis = {
                ...baseAnalysis,
                predictiveInsights: {
                    forecastedIntegrations: predictiveAnalysis.forecastingResults?.integrationLoadForecast?.scalingRecommendations || [],
                    riskAssessment: predictiveAnalysis.forecastingResults?.riskForecast,
                    recommendations: predictiveAnalysis.recommendations,
                    confidenceScore: predictiveAnalysis.confidence
                }
            };

            this.telemetryService.recordMetric('ecosystem_analysis_with_predictions', 1, {
                systemsCount: systems.length,
                opportunitiesFound: baseAnalysis.opportunities.length,
                predictiveRecommendations: predictiveAnalysis.recommendations?.length || 0
            });

            this.loggingService.info('Integration ecosystem analysis completed with predictive insights', {
                systemsAnalyzed: systems.length,
                gaps: baseAnalysis.gaps.length,
                opportunities: baseAnalysis.opportunities.length,
                predictiveRecommendations: predictiveAnalysis.recommendations?.length || 0
            });

            return enhancedAnalysis;

        } catch (error) {
            this.loggingService.error('Failed to analyze integration ecosystem', error);
            throw error;
        }
    }

    // Helper methods for Week 7 enhancements

    private async findPerformanceConnector(
        optimization: OptimizationRecommendation,
        currentSystems: string[]
    ): Promise<ConnectorRecommendation | null> {
        try {
            // Map performance optimizations to connector recommendations
            type PerformanceConnector = { name: string; category: string; benefits: string[] };
            const performanceConnectors: Record<string, PerformanceConnector> = {
                'response_time': {
                    name: 'Performance Accelerator',
                    category: 'performance',
                    benefits: ['Reduced latency', 'Improved caching', 'Optimized queries']
                },
                'memory_usage': {
                    name: 'Memory Optimizer',
                    category: 'optimization',
                    benefits: ['Memory leak detection', 'Resource management', 'Garbage collection tuning']
                }
            };

            const connectorKey = optimization.title.toLowerCase().includes('response') ? 'response_time' : 'memory_usage';
            const connector = performanceConnectors[connectorKey];

            if (!connector) return null;

            return {
                connectorId: `perf-${connectorKey}`,
                systemName: connector.name,
                category: connector.category,
                relevanceScore: Math.min(optimization.estimatedImprovement / 100, 0.95),
                reasoning: `Addresses performance issue: ${optimization.description}`,
                benefits: connector.benefits,
                implementationComplexity: optimization.effort,
                estimatedROI: optimization.estimatedImprovement,
                integrationPathway: await this.calculateDirectPathway('current', connector.name, {}),
                prerequisites: ['Performance monitoring setup'],
                marketTrends: {
                    adoption: 0.6,
                    growth: 0.2,
                    maturity: 'growing',
                    industryUsage: []
                },
                similarCompanies: []
            };

        } catch (error) {
            this.loggingService.error('Failed to find performance connector', error);
            return null;
        }
    }

    private async findBottleneckSolution(
        bottleneck: SystemBottleneck,
        currentSystems: string[]
    ): Promise<ConnectorRecommendation | null> {
        try {
            type BottleneckSolution = { name: string; category: string; benefits: string[] };
            const solutionMapping: Record<string, BottleneckSolution> = {
                'CPU': {
                    name: 'Load Balancer',
                    category: 'infrastructure',
                    benefits: ['Distribute CPU load', 'Horizontal scaling', 'Improved performance']
                },
                'Memory': {
                    name: 'Memory Manager',
                    category: 'optimization',
                    benefits: ['Memory optimization', 'Leak prevention', 'Resource monitoring']
                },
                'Network': {
                    name: 'Network Optimizer',
                    category: 'network',
                    benefits: ['Reduced latency', 'Connection pooling', 'Bandwidth optimization']
                }
            };

            const solution = solutionMapping[bottleneck.component];
            if (!solution) return null;

            return {
                connectorId: `bottleneck-${bottleneck.component.toLowerCase()}`,
                systemName: solution.name,
                category: solution.category,
                relevanceScore: Math.min(bottleneck.severity / 100, 0.9),
                reasoning: `Addresses ${bottleneck.component} bottleneck: ${bottleneck.description}`,
                benefits: solution.benefits,
                implementationComplexity: 'medium',
                estimatedROI: bottleneck.severity,
                integrationPathway: await this.calculateDirectPathway('current', solution.name, {}),
                prerequisites: ['System monitoring', 'Infrastructure access'],
                marketTrends: {
                    adoption: 0.7,
                    growth: 0.15,
                    maturity: 'mature',
                    industryUsage: []
                },
                similarCompanies: []
            };

        } catch (error) {
            this.loggingService.error('Failed to find bottleneck solution', error);
            return null;
        }
    }

    private async convertPatternToConnectorRecommendation(
        patternRec: PatternRecommendation
    ): Promise<ConnectorRecommendation | null> {
        try {
            const pattern = patternRec.pattern;
            return {
                connectorId: `pattern-${pattern.id}`,
                systemName: pattern.targetField,
                category: pattern.category,
                relevanceScore: patternRec.similarityScore,
                reasoning: patternRec.reason,
                benefits: ['Based on successful patterns', 'Proven implementation'],
                // Pre-existing latent type mismatch: MappingPattern.complexity is
                // 'simple' | 'medium' | 'complex' but implementationComplexity is
                // 'low' | 'medium' | 'high'. Preserve original runtime behavior via
                // a single boundary cast rather than introducing a remap.
                implementationComplexity: pattern.complexity as unknown as 'low' | 'medium' | 'high',
                estimatedROI: patternRec.estimatedAccuracy * 100,
                integrationPathway: await this.calculateDirectPathway(
                    pattern.sourceField,
                    pattern.targetField,
                    {}
                ),
                prerequisites: ['Pattern validation', 'Mapping verification'],
                marketTrends: {
                    adoption: 0.5,
                    growth: 0.1,
                    maturity: 'growing',
                    industryUsage: []
                },
                similarCompanies: []
            };

        } catch (error) {
            this.loggingService.error('Failed to convert pattern to recommendation', error);
            return null;
        }
    }

    private mapComplexityLevel(complexity: 'low' | 'medium' | 'high'): 'simple' | 'medium' | 'complex' {
        switch (complexity) {
            case 'low': return 'simple';
            case 'medium': return 'medium';
            case 'high': return 'complex';
            default: return 'medium';
        }
    }
}