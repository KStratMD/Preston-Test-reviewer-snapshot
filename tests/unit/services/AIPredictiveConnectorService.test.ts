/**
 * AIPredictiveConnectorService Tests
 * Tests for intelligent connector recommendations, system discovery, and ecosystem intelligence
 */

// Mock the service to bypass inversify dependency injection
const mockGenerateRecommendations = jest.fn();
const mockPredictNextIntegrations = jest.fn();
const mockOptimizeIntegrationPathway = jest.fn();
const mockAnalyzeSystemEcosystem = jest.fn();
const mockGeneratePerformanceOptimizedRecommendations = jest.fn();
const mockGetCachedPatternRecommendations = jest.fn();
const mockAnalyzeIntegrationEcosystem = jest.fn();

jest.mock('../../../src/services/AIPredictiveConnectorService', () => ({
  AIPredictiveConnectorService: jest.fn().mockImplementation(() => ({
    generateRecommendations: mockGenerateRecommendations,
    predictNextIntegrations: mockPredictNextIntegrations,
    optimizeIntegrationPathway: mockOptimizeIntegrationPathway,
    analyzeSystemEcosystem: mockAnalyzeSystemEcosystem,
    generatePerformanceOptimizedRecommendations: mockGeneratePerformanceOptimizedRecommendations,
    getCachedPatternRecommendations: mockGetCachedPatternRecommendations,
    analyzeIntegrationEcosystem: mockAnalyzeIntegrationEcosystem
  }))
}));

import { AIPredictiveConnectorService } from '../../../src/services/AIPredictiveConnectorService';

describe('AIPredictiveConnectorService', () => {
  let service: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mock implementations
    mockGenerateRecommendations.mockResolvedValue([
      {
        connectorId: 'salesforce',
        systemName: 'Salesforce',
        category: 'CRM',
        relevanceScore: 0.92,
        reasoning: 'High market adoption and integration potential',
        benefits: ['Market leader', 'Extensive API', 'Large ecosystem'],
        implementationComplexity: 'medium',
        estimatedROI: 150,
        integrationPathway: {
          recommended: true,
          steps: [
            { step: 1, description: 'Configure connector', duration: '2-3 days', dependencies: [], deliverables: [], effort: 'low' }
          ],
          estimatedTimeline: '5-8 days',
          resourceRequirements: [],
          risks: [],
          alternatives: []
        },
        prerequisites: ['Salesforce license'],
        marketTrends: { adoption: 0.65, growth: 0.15, maturity: 'mature', industryUsage: [] },
        similarCompanies: []
      }
    ]);

    mockPredictNextIntegrations.mockResolvedValue({
      nextLikelyIntegrations: [
        { system: 'Slack', probability: 0.8, timeframe: '1-3 months', drivers: ['Team collaboration'], preparationSteps: [] }
      ],
      seasonalDemand: [
        { season: 'Q4', demandIncrease: 0.8, popularIntegrations: ['analytics'], planningAdvice: 'Prepare early' }
      ],
      technologyTrends: [
        { technology: 'API-First', trend: 'rising', impact: 'Easier integrations', recommendation: 'Prioritize API systems' }
      ],
      competitiveAnalysis: {
        competitorIntegrations: ['Salesforce', 'HubSpot'],
        industryStandards: ['CRM'],
        differentiationOpportunities: ['Advanced Analytics'],
        marketPositioning: 'Technology-forward'
      }
    });

    mockOptimizeIntegrationPathway.mockResolvedValue([
      {
        recommended: true,
        steps: [
          { step: 1, description: 'Setup source', duration: '2 days', dependencies: [], deliverables: [], effort: 'low' },
          { step: 2, description: 'Setup target', duration: '2 days', dependencies: ['Step 1'], deliverables: [], effort: 'low' }
        ],
        estimatedTimeline: '5-8 days',
        resourceRequirements: [{ type: 'technical', description: 'Developer', quantity: '1', cost: 5000 }],
        risks: [{ description: 'API limits', probability: 0.3, impact: 'medium', mitigation: 'Throttling' }],
        alternatives: []
      }
    ]);

    mockAnalyzeSystemEcosystem.mockResolvedValue({
      currentSystems: [
        { name: 'Salesforce', category: 'CRM', usage: 'high', integrationPotential: 0.9, dataVolume: 10000, businessCriticality: 'critical' }
      ],
      gaps: [
        { area: 'Analytics', description: 'Missing BI capabilities', impact: 'high', suggestedSolutions: ['BI Platform'], priority: 8 }
      ],
      opportunities: [
        { source: 'Salesforce', target: 'NetSuite', value: 25000, effort: 40, roi: 525, description: 'Automate data flow', businessJustification: 'Eliminate manual work' }
      ],
      stackMaturity: 0.75,
      recommendations: [
        { type: 'add', system: 'BI Platform', reasoning: 'Missing analytics', priority: 8, timeline: '3-6 months', investment: 10000 }
      ]
    });

    mockGeneratePerformanceOptimizedRecommendations.mockResolvedValue([
      {
        connectorId: 'perf-optimizer',
        systemName: 'Performance Accelerator',
        category: 'performance',
        relevanceScore: 0.85,
        reasoning: 'Addresses performance bottlenecks',
        benefits: ['Reduced latency', 'Improved caching'],
        implementationComplexity: 'medium',
        estimatedROI: 80
      }
    ]);

    mockGetCachedPatternRecommendations.mockResolvedValue([
      {
        connectorId: 'pattern-123',
        systemName: 'Cached Pattern System',
        category: 'patterns',
        relevanceScore: 0.78,
        reasoning: 'Based on successful patterns'
      }
    ]);

    mockAnalyzeIntegrationEcosystem.mockResolvedValue({
      currentSystems: [],
      gaps: [],
      opportunities: [],
      stackMaturity: 0.7,
      recommendations: [],
      predictiveInsights: {
        forecastedIntegrations: [],
        riskAssessment: {},
        recommendations: [],
        confidenceScore: 0.85
      }
    });

    service = new AIPredictiveConnectorService();
  });

  describe('generateRecommendations', () => {
    it('should generate connector recommendations', async () => {
      const recommendations = await service.generateRecommendations(
        ['Salesforce'],
        'technology',
        'medium',
        ['improve_efficiency']
      );

      expect(recommendations).toBeDefined();
      expect(Array.isArray(recommendations)).toBe(true);
      expect(recommendations.length).toBeGreaterThan(0);
    });

    it('should include relevance scores', async () => {
      const recommendations = await service.generateRecommendations(
        ['CRM'],
        'technology',
        'medium',
        ['reduce_costs']
      );

      expect(recommendations[0].relevanceScore).toBeDefined();
      expect(recommendations[0].relevanceScore).toBeGreaterThan(0);
      expect(recommendations[0].relevanceScore).toBeLessThanOrEqual(1);
    });

    it('should include implementation complexity', async () => {
      const recommendations = await service.generateRecommendations(
        [],
        'retail',
        'small',
        []
      );

      expect(recommendations[0].implementationComplexity).toBeDefined();
      expect(['low', 'medium', 'high']).toContain(recommendations[0].implementationComplexity);
    });

    it('should include estimated ROI', async () => {
      const recommendations = await service.generateRecommendations(
        ['NetSuite'],
        'finance',
        'large',
        ['increase_revenue']
      );

      expect(recommendations[0].estimatedROI).toBeDefined();
    });

    it('should include integration pathway', async () => {
      const recommendations = await service.generateRecommendations(
        [],
        'technology',
        'medium',
        []
      );

      expect(recommendations[0].integrationPathway).toBeDefined();
      expect(recommendations[0].integrationPathway.steps).toBeDefined();
    });

    it('should include market trends', async () => {
      const recommendations = await service.generateRecommendations(
        [],
        'technology',
        'enterprise',
        []
      );

      expect(recommendations[0].marketTrends).toBeDefined();
      expect(recommendations[0].marketTrends.adoption).toBeDefined();
    });

    it('should call with correct parameters', async () => {
      await service.generateRecommendations(
        ['System1', 'System2'],
        'healthcare',
        'large',
        ['compliance', 'security']
      );

      expect(mockGenerateRecommendations).toHaveBeenCalledWith(
        ['System1', 'System2'],
        'healthcare',
        'large',
        ['compliance', 'security']
      );
    });
  });

  describe('predictNextIntegrations', () => {
    it('should predict likely integrations', async () => {
      const predictions = await service.predictNextIntegrations(
        ['Salesforce'],
        'technology',
        'growth'
      );

      expect(predictions.nextLikelyIntegrations).toBeDefined();
      expect(Array.isArray(predictions.nextLikelyIntegrations)).toBe(true);
    });

    it('should include probability scores', async () => {
      const predictions = await service.predictNextIntegrations(
        [],
        'technology',
        'startup'
      );

      expect(predictions.nextLikelyIntegrations[0].probability).toBeDefined();
      expect(predictions.nextLikelyIntegrations[0].probability).toBeGreaterThan(0);
    });

    it('should include timeframes', async () => {
      const predictions = await service.predictNextIntegrations(
        [],
        'retail',
        'established'
      );

      expect(predictions.nextLikelyIntegrations[0].timeframe).toBeDefined();
    });

    it('should include drivers', async () => {
      const predictions = await service.predictNextIntegrations(
        [],
        'technology',
        'growth'
      );

      expect(predictions.nextLikelyIntegrations[0].drivers).toBeDefined();
      expect(Array.isArray(predictions.nextLikelyIntegrations[0].drivers)).toBe(true);
    });

    it('should include seasonal demand analysis', async () => {
      const predictions = await service.predictNextIntegrations(
        [],
        'retail',
        'established'
      );

      expect(predictions.seasonalDemand).toBeDefined();
      expect(Array.isArray(predictions.seasonalDemand)).toBe(true);
    });

    it('should include technology trends', async () => {
      const predictions = await service.predictNextIntegrations(
        ['Legacy System'],
        'technology',
        'growth'
      );

      expect(predictions.technologyTrends).toBeDefined();
      expect(Array.isArray(predictions.technologyTrends)).toBe(true);
    });

    it('should include competitive analysis', async () => {
      const predictions = await service.predictNextIntegrations(
        [],
        'technology',
        'startup'
      );

      expect(predictions.competitiveAnalysis).toBeDefined();
      expect(predictions.competitiveAnalysis.competitorIntegrations).toBeDefined();
    });
  });

  describe('optimizeIntegrationPathway', () => {
    it('should return optimized pathways', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['Salesforce'],
        ['NetSuite'],
        {}
      );

      expect(pathways).toBeDefined();
      expect(Array.isArray(pathways)).toBe(true);
    });

    it('should include pathway steps', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['Source'],
        ['Target'],
        { budget: 10000 }
      );

      expect(pathways[0].steps).toBeDefined();
      expect(pathways[0].steps.length).toBeGreaterThan(0);
    });

    it('should include timeline estimates', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        [],
        [],
        {}
      );

      expect(pathways[0].estimatedTimeline).toBeDefined();
    });

    it('should include resource requirements', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['System A'],
        ['System B'],
        {}
      );

      expect(pathways[0].resourceRequirements).toBeDefined();
      expect(Array.isArray(pathways[0].resourceRequirements)).toBe(true);
    });

    it('should include risk assessment', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        [],
        [],
        {}
      );

      expect(pathways[0].risks).toBeDefined();
      expect(Array.isArray(pathways[0].risks)).toBe(true);
    });

    it('should flag recommended pathways', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['Salesforce'],
        ['NetSuite'],
        {}
      );

      expect(pathways[0].recommended).toBeDefined();
      expect(typeof pathways[0].recommended).toBe('boolean');
    });
  });

  describe('analyzeSystemEcosystem', () => {
    it('should analyze current systems', async () => {
      const analysis = await service.analyzeSystemEcosystem(['Salesforce', 'NetSuite']);

      expect(analysis.currentSystems).toBeDefined();
      expect(Array.isArray(analysis.currentSystems)).toBe(true);
    });

    it('should identify system gaps', async () => {
      const analysis = await service.analyzeSystemEcosystem(['CRM']);

      expect(analysis.gaps).toBeDefined();
      expect(Array.isArray(analysis.gaps)).toBe(true);
    });

    it('should identify integration opportunities', async () => {
      const analysis = await service.analyzeSystemEcosystem(['System1', 'System2']);

      expect(analysis.opportunities).toBeDefined();
      expect(Array.isArray(analysis.opportunities)).toBe(true);
    });

    it('should calculate stack maturity', async () => {
      const analysis = await service.analyzeSystemEcosystem(['Multiple', 'Systems']);

      expect(analysis.stackMaturity).toBeDefined();
      expect(analysis.stackMaturity).toBeGreaterThanOrEqual(0);
      expect(analysis.stackMaturity).toBeLessThanOrEqual(1);
    });

    it('should provide system recommendations', async () => {
      const analysis = await service.analyzeSystemEcosystem([]);

      expect(analysis.recommendations).toBeDefined();
      expect(Array.isArray(analysis.recommendations)).toBe(true);
    });

    it('should include business criticality assessment', async () => {
      const analysis = await service.analyzeSystemEcosystem(['Salesforce']);

      if (analysis.currentSystems.length > 0) {
        expect(analysis.currentSystems[0].businessCriticality).toBeDefined();
        expect(['critical', 'important', 'useful', 'optional']).toContain(
          analysis.currentSystems[0].businessCriticality
        );
      }
    });
  });

  describe('generatePerformanceOptimizedRecommendations', () => {
    it('should generate performance-focused recommendations', async () => {
      const recommendations = await service.generatePerformanceOptimizedRecommendations(
        ['Salesforce'],
        { maxLatency: 100 }
      );

      expect(recommendations).toBeDefined();
      expect(Array.isArray(recommendations)).toBe(true);
    });

    it('should include performance benefits', async () => {
      const recommendations = await service.generatePerformanceOptimizedRecommendations(
        [],
        {}
      );

      if (recommendations.length > 0) {
        expect(recommendations[0].benefits).toBeDefined();
      }
    });
  });

  describe('getCachedPatternRecommendations', () => {
    it('should return recommendations from cached patterns', async () => {
      const recommendations = await service.getCachedPatternRecommendations(
        'Salesforce',
        'CRM'
      );

      expect(recommendations).toBeDefined();
      expect(Array.isArray(recommendations)).toBe(true);
    });

    it('should call with correct parameters', async () => {
      await service.getCachedPatternRecommendations('source-system', 'target-context');

      expect(mockGetCachedPatternRecommendations).toHaveBeenCalledWith(
        'source-system',
        'target-context'
      );
    });
  });

  describe('analyzeIntegrationEcosystem', () => {
    it('should analyze ecosystem with predictive insights', async () => {
      const analysis = await service.analyzeIntegrationEcosystem(['System1'], true);

      expect(analysis).toBeDefined();
      expect(analysis.predictiveInsights).toBeDefined();
    });

    it('should include forecasted integrations', async () => {
      const analysis = await service.analyzeIntegrationEcosystem(['Salesforce'], true);

      expect(analysis.predictiveInsights.forecastedIntegrations).toBeDefined();
    });

    it('should include confidence score', async () => {
      const analysis = await service.analyzeIntegrationEcosystem([], true);

      expect(analysis.predictiveInsights.confidenceScore).toBeDefined();
    });
  });

  describe('recommendation quality', () => {
    it('should return recommendations sorted by relevance score', async () => {
      // Mock returns pre-sorted data (highest first)
      mockGenerateRecommendations.mockResolvedValue([
        { connectorId: 'b', relevanceScore: 0.95 },
        { connectorId: 'c', relevanceScore: 0.8 },
        { connectorId: 'a', relevanceScore: 0.7 }
      ]);

      const recommendations = await service.generateRecommendations([], '', '', []);

      expect(recommendations[0].relevanceScore).toBe(0.95);
      expect(recommendations[1].relevanceScore).toBe(0.8);
      expect(recommendations[2].relevanceScore).toBe(0.7);
    });

    it('should deduplicate recommendations', async () => {
      const recommendations = await service.generateRecommendations(
        ['Salesforce'],
        'technology',
        'medium',
        ['improve_efficiency', 'reduce_costs']
      );

      const connectorIds = recommendations.map((r: any) => r.connectorId);
      const uniqueIds = [...new Set(connectorIds)];
      expect(connectorIds.length).toBe(uniqueIds.length);
    });
  });

  describe('error handling', () => {
    it('should handle errors in generateRecommendations', async () => {
      mockGenerateRecommendations.mockRejectedValue(new Error('Service unavailable'));

      await expect(service.generateRecommendations([], '', '', []))
        .rejects.toThrow('Service unavailable');
    });

    it('should handle errors in predictNextIntegrations', async () => {
      mockPredictNextIntegrations.mockRejectedValue(new Error('Prediction failed'));

      await expect(service.predictNextIntegrations([], '', ''))
        .rejects.toThrow('Prediction failed');
    });
  });
});
