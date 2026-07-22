/**
 * Supplier Risk Scoring Service
 * 
 * Dynamic supplier risk scoring with real-time updates based on
 * payment history, delivery performance, and compliance status.
 * 
 * Phase 2 Implementation - AI-Enhanced SuiteCentral 2.0
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';
import { fetchModuleData, useRealModuleApis } from '../../utils/moduleHttpClient';

// Risk level classification
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// Risk trend direction
type RiskTrend = 'improving' | 'stable' | 'worsening';

/**
 * Risk factor contributing to overall score
 */
interface RiskFactor {
    id: string;
    name: string;
    category: 'financial' | 'operational' | 'compliance' | 'relationship';
    weight: number;  // 0-1
    score: number;  // 0-100 (higher = more risk)
    description: string;
    dataSource: string;
    lastUpdated: string;
}

/**
 * Historical risk score data point
 */
interface RiskHistoryPoint {
    timestamp: string;
    overallScore: number;
    riskLevel: RiskLevel;
    factors: Record<string, number>;
    triggeredAlerts: string[];
}

/**
 * Risk alert for significant changes
 */
interface RiskAlert {
    id: string;
    supplierId: string;
    supplierName: string;
    severity: RiskLevel;
    type: 'score_increase' | 'threshold_breach' | 'compliance_issue' | 'payment_issue' | 'delivery_issue';
    title: string;
    message: string;
    previousScore?: number;
    currentScore: number;
    recommendedActions: string[];
    createdAt: string;
    acknowledged: boolean;
}

/**
 * Complete supplier risk profile
 */
export interface SupplierRiskProfile {
    supplierId: string;
    supplierName: string;
    category: string;
    overallRiskScore: number;  // 0-100
    riskLevel: RiskLevel;
    riskTrend: RiskTrend;
    factors: RiskFactor[];
    recentAlerts: RiskAlert[];
    recommendations: string[];
    lastAssessment: string;
    nextAssessmentDue: string;
}

/**
 * Summary response for all suppliers
 */
export interface SupplierRiskSummaryResponse {
    success: boolean;
    timestamp: string;
    summary: {
        totalSuppliers: number;
        byRiskLevel: Record<RiskLevel, number>;
        averageScore: number;
        suppliersRequiringAttention: number;
    };
    topRisks: SupplierRiskProfile[];
    recentAlerts: RiskAlert[];
}

/**
 * Configuration for risk scoring
 */
interface RiskScoringConfig {
    // Category weights
    categoryWeights: {
        financial: number;
        operational: number;
        compliance: number;
        relationship: number;
    };
    // Thresholds
    lowRiskMax: number;
    mediumRiskMax: number;
    highRiskMax: number;
    // Alert thresholds
    significantScoreChange: number;
    alertCooldownHours: number;
}

const DEFAULT_CONFIG: RiskScoringConfig = {
    categoryWeights: {
        financial: 0.3,
        operational: 0.35,
        compliance: 0.25,
        relationship: 0.1,
    },
    lowRiskMax: 25,
    mediumRiskMax: 50,
    highRiskMax: 75,
    significantScoreChange: 10,
    alertCooldownHours: 24,
};

/**
 * Mock supplier data for demo mode
 */
const MOCK_SUPPLIERS = [
    { id: 'sup-001', name: 'Acme Manufacturing', category: 'Raw Materials', baseRisk: 15 },
    { id: 'sup-002', name: 'Global Logistics Inc', category: 'Shipping', baseRisk: 22 },
    { id: 'sup-003', name: 'TechParts Ltd', category: 'Components', baseRisk: 45 },
    { id: 'sup-004', name: 'Quality Supplies Co', category: 'Office Supplies', baseRisk: 12 },
    { id: 'sup-005', name: 'FastShip Express', category: 'Shipping', baseRisk: 55 },
    { id: 'sup-006', name: 'Pacific Parts', category: 'Components', baseRisk: 32 },
    { id: 'sup-007', name: 'Green Energy Systems', category: 'Equipment', baseRisk: 28 },
    { id: 'sup-008', name: 'Reliable Chemicals', category: 'Raw Materials', baseRisk: 68 },
    { id: 'sup-009', name: 'Metro Distribution', category: 'Logistics', baseRisk: 18 },
    { id: 'sup-010', name: 'Alpine Components', category: 'Components', baseRisk: 82 },
];

/**
 * API endpoints for supplier risk data sources
 */
const SUPPLIER_API_ENDPOINTS = {
    suppliers: '/api/supplier-central/vendors',
    paymentHistory: '/api/payment-central/vendor-payments',
    qualityData: '/api/quality-central/vendor-quality',
    contracts: '/api/contract-central/vendor-contracts',
};

/** Supplier data structure from API */
interface SupplierData {
    id: string;
    name: string;
    category: string;
    baseRisk?: number;
}

@injectable()
export class SupplierRiskScoringService {
    private readonly logger: Logger;
    private readonly config: RiskScoringConfig;
    private riskProfiles = new Map<string, SupplierRiskProfile>();
    private riskHistory = new Map<string, RiskHistoryPoint[]>();
    private alerts: RiskAlert[] = [];
    private suppliers: SupplierData[] = [...MOCK_SUPPLIERS];
    private dataInitialized = false;

    constructor(
        @inject(TYPES.Logger) loggerInstance?: Logger
    ) {
        this.logger = loggerInstance || logger;
        this.config = DEFAULT_CONFIG;
        this.initializeMockData();
    }

    /**
     * Fetch real supplier data from SupplierCentral API if feature flag enabled.
     * Falls back to mock data if API is unavailable.
     */
    private async fetchRealSuppliers(): Promise<SupplierData[]> {
        const baseUrl = process.env.MODULE_API_BASE_URL || 'http://localhost:3000';
        const endpoint = `${baseUrl}${SUPPLIER_API_ENDPOINTS.suppliers}`;

        const result = await fetchModuleData<{ suppliers?: SupplierData[]; vendors?: SupplierData[] }>(
            endpoint,
            { suppliers: MOCK_SUPPLIERS },
            this.logger,
            { timeoutMs: 5000 }
        );

        // Handle both 'suppliers' and 'vendors' response formats
        const suppliers = result.suppliers || result.vendors || MOCK_SUPPLIERS;

        // Ensure baseRisk is set (calculate from other data or default to 30)
        return suppliers.map(sup => ({
            ...sup,
            baseRisk: sup.baseRisk ?? 30,
        }));
    }

    /**
     * Ensure data is initialized, fetching real data if feature flag enabled.
     * This is called lazily before risk calculations to support async data fetching.
     */
    private async ensureDataInitialized(): Promise<void> {
        if (this.dataInitialized && !useRealModuleApis()) {
            return; // Already initialized with mock data
        }

        if (useRealModuleApis()) {
            try {
                const realSuppliers = await this.fetchRealSuppliers();
                this.suppliers = realSuppliers;

                // Clear mock data and rebuild profiles/history for real suppliers
                // This ensures risk calculations use only real supplier data
                this.riskProfiles.clear();
                this.riskHistory.clear();
                this.alerts = [];

                // Regenerate profiles for all real suppliers
                for (const supplier of this.suppliers) {
                    const profile = this.generateRiskProfile(supplier);
                    this.riskProfiles.set(supplier.id, profile);

                    const history = this.generateRiskHistory(supplier.id, supplier.baseRisk ?? 30);
                    this.riskHistory.set(supplier.id, history);
                }

                this.logger.info('Using real SupplierCentral data', {
                    count: realSuppliers.length,
                });
            } catch (error) {
                this.logger.warn('Failed to fetch real suppliers, using mock data', { error });
                this.suppliers = [...MOCK_SUPPLIERS];
            }
        }

        this.dataInitialized = true;
    }

    /**
     * Initialize mock supplier risk data
     */
    private initializeMockData(): void {
        for (const supplier of MOCK_SUPPLIERS) {
            const profile = this.generateRiskProfile(supplier);
            this.riskProfiles.set(supplier.id, profile);

            // Generate historical data
            const history = this.generateRiskHistory(supplier.id, supplier.baseRisk);
            this.riskHistory.set(supplier.id, history);
        }

        // Generate some sample alerts
        this.generateSampleAlerts();

        this.logger.info('SupplierRiskScoringService initialized with mock data', {
            suppliers: MOCK_SUPPLIERS.length,
            alerts: this.alerts.length,
        });
    }

    /**
     * Generate a complete risk profile for a supplier
     */
    private generateRiskProfile(supplier: { id: string; name: string; category: string; baseRisk?: number }): SupplierRiskProfile {
        const baseRisk = supplier.baseRisk ?? 30; // Default to medium risk
        const factors = this.generateRiskFactors(baseRisk);
        const overallScore = this.calculateOverallScore(factors);
        const riskLevel = this.getRiskLevel(overallScore);

        return {
            supplierId: supplier.id,
            supplierName: supplier.name,
            category: supplier.category,
            overallRiskScore: overallScore,
            riskLevel,
            riskTrend: this.determineTrend(overallScore, baseRisk),
            factors,
            recentAlerts: [],
            recommendations: this.generateRecommendations(riskLevel, factors),
            lastAssessment: new Date().toISOString(),
            nextAssessmentDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
    }

    /**
     * Generate risk factors for a supplier
     */
    private generateRiskFactors(baseRisk: number): RiskFactor[] {
        const variation = () => (Math.random() - 0.5) * 20;

        return [
            // Financial factors
            {
                id: 'payment-history',
                name: 'Payment History',
                category: 'financial',
                weight: 0.4,
                score: Math.max(0, Math.min(100, baseRisk + variation())),
                description: 'Based on payment timeliness and dispute rate',
                dataSource: 'PaymentCentral',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'credit-risk',
                name: 'Credit Risk',
                category: 'financial',
                weight: 0.3,
                score: Math.max(0, Math.min(100, baseRisk * 0.8 + variation())),
                description: 'Based on financial stability indicators',
                dataSource: 'External Credit Bureau',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'pricing-volatility',
                name: 'Pricing Volatility',
                category: 'financial',
                weight: 0.3,
                score: Math.max(0, Math.min(100, baseRisk * 0.6 + variation())),
                description: 'Based on price change frequency and magnitude',
                dataSource: 'Contract History',
                lastUpdated: new Date().toISOString(),
            },

            // Operational factors
            {
                id: 'delivery-performance',
                name: 'Delivery Performance',
                category: 'operational',
                weight: 0.4,
                score: Math.max(0, Math.min(100, baseRisk + variation())),
                description: 'Based on on-time delivery rate',
                dataSource: 'SupplierCentral',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'quality-issues',
                name: 'Quality Issues',
                category: 'operational',
                weight: 0.35,
                score: Math.max(0, Math.min(100, baseRisk * 0.9 + variation())),
                description: 'Based on defect rate and returns',
                dataSource: 'QualityCentral',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'capacity-risk',
                name: 'Capacity Risk',
                category: 'operational',
                weight: 0.25,
                score: Math.max(0, Math.min(100, baseRisk * 0.7 + variation())),
                description: 'Based on fulfillment capability',
                dataSource: 'Order History',
                lastUpdated: new Date().toISOString(),
            },

            // Compliance factors
            {
                id: 'document-compliance',
                name: 'Document Compliance',
                category: 'compliance',
                weight: 0.4,
                score: Math.max(0, Math.min(100, baseRisk * 0.5 + variation())),
                description: 'Based on W-9, COI, and certification status',
                dataSource: 'VendorOnboarding',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'regulatory-risk',
                name: 'Regulatory Risk',
                category: 'compliance',
                weight: 0.35,
                score: Math.max(0, Math.min(100, baseRisk * 0.4 + variation())),
                description: 'Based on industry regulations and audits',
                dataSource: 'Compliance Database',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'insurance-coverage',
                name: 'Insurance Coverage',
                category: 'compliance',
                weight: 0.25,
                score: Math.max(0, Math.min(100, baseRisk * 0.3 + variation())),
                description: 'Based on coverage adequacy and expiration',
                dataSource: 'COI Repository',
                lastUpdated: new Date().toISOString(),
            },

            // Relationship factors
            {
                id: 'relationship-tenure',
                name: 'Relationship Tenure',
                category: 'relationship',
                weight: 0.5,
                score: Math.max(0, Math.min(100, 100 - baseRisk + variation())),
                description: 'Based on years of business relationship',
                dataSource: 'Vendor Master',
                lastUpdated: new Date().toISOString(),
            },
            {
                id: 'communication-score',
                name: 'Communication Score',
                category: 'relationship',
                weight: 0.5,
                score: Math.max(0, Math.min(100, baseRisk * 0.6 + variation())),
                description: 'Based on responsiveness and cooperation',
                dataSource: 'Interaction History',
                lastUpdated: new Date().toISOString(),
            },
        ];
    }

    /**
     * Calculate overall risk score from factors
     */
    private calculateOverallScore(factors: RiskFactor[]): number {
        const weights = this.config.categoryWeights;

        // Group factors by category
        const byCategory: Record<string, RiskFactor[]> = {
            financial: [],
            operational: [],
            compliance: [],
            relationship: [],
        };

        for (const factor of factors) {
            byCategory[factor.category]?.push(factor);
        }

        // Calculate weighted average for each category
        const categoryScores: Record<string, number> = {};
        for (const [category, categoryFactors] of Object.entries(byCategory)) {
            if (categoryFactors.length === 0) continue;

            const totalWeight = categoryFactors.reduce((sum, f) => sum + f.weight, 0);
            categoryScores[category] = categoryFactors.reduce((sum, f) => {
                return sum + (f.score * f.weight / totalWeight);
            }, 0);
        }

        // Calculate overall weighted score
        let overallScore = 0;
        for (const [category, weight] of Object.entries(weights)) {
            overallScore += (categoryScores[category] || 0) * weight;
        }

        return Math.round(overallScore);
    }

    /**
     * Determine risk level from score
     */
    private getRiskLevel(score: number): RiskLevel {
        if (score <= this.config.lowRiskMax) return 'low';
        if (score <= this.config.mediumRiskMax) return 'medium';
        if (score <= this.config.highRiskMax) return 'high';
        return 'critical';
    }

    /**
     * Determine risk trend
     */
    private determineTrend(currentScore: number, baseScore: number): RiskTrend {
        const diff = currentScore - baseScore;
        if (diff > 5) return 'worsening';
        if (diff < -5) return 'improving';
        return 'stable';
    }

    /**
     * Generate recommendations based on risk profile
     */
    private generateRecommendations(riskLevel: RiskLevel, factors: RiskFactor[]): string[] {
        const recommendations: string[] = [];

        // Sort factors by score (highest risk first)
        const sortedFactors = [...factors].sort((a, b) => b.score - a.score);
        const topRiskFactors = sortedFactors.slice(0, 3);

        for (const factor of topRiskFactors) {
            if (factor.score > 60) {
                switch (factor.id) {
                    case 'payment-history':
                        recommendations.push('Review payment terms and consider early payment incentives');
                        break;
                    case 'delivery-performance':
                        recommendations.push('Schedule quarterly business review to address delivery issues');
                        break;
                    case 'quality-issues':
                        recommendations.push('Implement incoming quality inspection for high-value orders');
                        break;
                    case 'document-compliance':
                        recommendations.push('Request updated compliance documentation');
                        break;
                    case 'credit-risk':
                        recommendations.push('Consider requiring payment guarantees or reducing credit exposure');
                        break;
                }
            }
        }

        // Add level-specific recommendations
        if (riskLevel === 'critical') {
            recommendations.unshift('PRIORITY: Develop contingency sourcing plan');
            recommendations.push('Escalate to procurement leadership');
        } else if (riskLevel === 'high') {
            recommendations.unshift('Schedule risk mitigation meeting within 2 weeks');
        } else if (riskLevel === 'low') {
            recommendations.push('Consider for preferred supplier status');
        }

        return recommendations;
    }

    /**
     * Generate historical risk data
     */
    private generateRiskHistory(supplierId: string, baseRisk: number): RiskHistoryPoint[] {
        const history: RiskHistoryPoint[] = [];
        const now = Date.now();

        // Generate 30 days of history
        for (let i = 30; i >= 0; i--) {
            const timestamp = new Date(now - i * 24 * 60 * 60 * 1000).toISOString();
            const variation = (Math.random() - 0.5) * 15;
            const score = Math.max(0, Math.min(100, baseRisk + variation));

            history.push({
                timestamp,
                overallScore: Math.round(score),
                riskLevel: this.getRiskLevel(score),
                factors: {
                    financial: Math.round(score * 0.9 + Math.random() * 10),
                    operational: Math.round(score + Math.random() * 10 - 5),
                    compliance: Math.round(score * 0.7 + Math.random() * 20),
                    relationship: Math.round(100 - score + Math.random() * 10),
                },
                triggeredAlerts: [],
            });
        }

        return history;
    }

    /**
     * Generate sample alerts
     */
    private generateSampleAlerts(): void {
        const highRiskSuppliers = MOCK_SUPPLIERS.filter(s => s.baseRisk > 50);

        for (const supplier of highRiskSuppliers) {
            this.alerts.push({
                id: `alert-${supplier.id}-${Date.now()}`,
                supplierId: supplier.id,
                supplierName: supplier.name,
                severity: supplier.baseRisk > 75 ? 'critical' : 'high',
                type: 'score_increase',
                title: `Elevated Risk Score for ${supplier.name}`,
                message: `Risk score has increased to ${supplier.baseRisk}, exceeding threshold`,
                previousScore: supplier.baseRisk - 12,
                currentScore: supplier.baseRisk,
                recommendedActions: [
                    'Review recent transactions',
                    'Schedule supplier review meeting',
                    'Assess alternative suppliers',
                ],
                createdAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
                acknowledged: false,
            });
        }
    }

    /**
     * Get risk summary for all suppliers.
     * Uses real API data when USE_REAL_MODULE_APIS=true, otherwise uses mock data.
     */
    async getRiskSummary(): Promise<SupplierRiskSummaryResponse> {
        this.logger.info('Generating supplier risk summary');

        // Ensure we have the latest supplier data
        await this.ensureDataInitialized();

        const profiles = Array.from(this.riskProfiles.values());

        // Calculate summary stats
        const byRiskLevel: Record<RiskLevel, number> = {
            low: 0,
            medium: 0,
            high: 0,
            critical: 0,
        };

        let totalScore = 0;
        for (const profile of profiles) {
            byRiskLevel[profile.riskLevel]++;
            totalScore += profile.overallRiskScore;
        }

        // Get top risks
        const topRisks = [...profiles]
            .sort((a, b) => b.overallRiskScore - a.overallRiskScore)
            .slice(0, 5);

        // Get recent unacknowledged alerts
        const recentAlerts = this.alerts
            .filter(a => !a.acknowledged)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 10);

        return {
            success: true,
            timestamp: new Date().toISOString(),
            summary: {
                totalSuppliers: profiles.length,
                byRiskLevel,
                averageScore: Math.round(totalScore / profiles.length),
                suppliersRequiringAttention: byRiskLevel.high + byRiskLevel.critical,
            },
            topRisks,
            recentAlerts,
        };
    }

    /**
     * Get risk profile for a specific supplier.
     * Uses real API data when USE_REAL_MODULE_APIS=true, otherwise uses mock data.
     */
    async getSupplierRisk(supplierId: string): Promise<SupplierRiskProfile | null> {
        // Ensure we have the latest supplier data
        await this.ensureDataInitialized();

        const profile = this.riskProfiles.get(supplierId);

        if (!profile) {
            this.logger.warn('Supplier not found', { supplierId });
            return null;
        }

        // Attach relevant alerts
        profile.recentAlerts = this.alerts
            .filter(a => a.supplierId === supplierId)
            .slice(0, 5);

        return profile;
    }

    /**
     * Get risk score history for a supplier
     */
    async getSupplierRiskHistory(supplierId: string, days = 30): Promise<RiskHistoryPoint[]> {
        const history = this.riskHistory.get(supplierId);

        if (!history) {
            this.logger.warn('No history for supplier', { supplierId });
            return [];
        }

        // Return last N days
        return history.slice(-days);
    }

    /**
     * Recalculate risk score for a supplier (triggered by new data).
     * Uses real API data when USE_REAL_MODULE_APIS=true, otherwise uses mock data.
     */
    async recalculateRisk(supplierId: string): Promise<SupplierRiskProfile | null> {
        // Ensure we have the latest supplier data
        await this.ensureDataInitialized();

        const supplier = this.suppliers.find(s => s.id === supplierId);

        if (!supplier) {
            return null;
        }

        // Regenerate profile with fresh factors
        const newProfile = this.generateRiskProfile(supplier);

        // Check for significant change
        const oldProfile = this.riskProfiles.get(supplierId);
        if (oldProfile) {
            const scoreDiff = Math.abs(newProfile.overallRiskScore - oldProfile.overallRiskScore);

            if (scoreDiff >= this.config.significantScoreChange) {
                this.createAlert(newProfile, oldProfile.overallRiskScore);
            }
        }

        this.riskProfiles.set(supplierId, newProfile);

        return newProfile;
    }

    /**
     * Create an alert for significant risk change
     */
    private createAlert(profile: SupplierRiskProfile, previousScore: number): void {
        const isIncrease = profile.overallRiskScore > previousScore;

        this.alerts.unshift({
            id: `alert-${profile.supplierId}-${Date.now()}`,
            supplierId: profile.supplierId,
            supplierName: profile.supplierName,
            severity: profile.riskLevel,
            type: isIncrease ? 'score_increase' : 'threshold_breach',
            title: isIncrease
                ? `Risk Score Increased for ${profile.supplierName}`
                : `Risk Score Improved for ${profile.supplierName}`,
            message: `Risk score changed from ${previousScore} to ${profile.overallRiskScore}`,
            previousScore,
            currentScore: profile.overallRiskScore,
            recommendedActions: profile.recommendations,
            createdAt: new Date().toISOString(),
            acknowledged: false,
        });

        this.logger.info('Risk alert created', {
            supplierId: profile.supplierId,
            previousScore,
            newScore: profile.overallRiskScore,
        });
    }
}
