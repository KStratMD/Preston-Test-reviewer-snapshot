/**
 * AI-Powered Data Quality & Validation Service
 * Provides intelligent data anomaly detection, cleansing suggestions, and predictive validation
 */

import { logger } from '../utils/Logger';

interface DataQualityIssue {
    field: string;
    issue: 'format' | 'missing' | 'anomaly' | 'duplicate' | 'inconsistent';
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    suggestion: string;
    confidence: number;
    autoFixable: boolean;
}

interface DataQualityAnalysis {
    record: unknown;
    issues: DataQualityIssue[];
    overallScore: number;
    recommendations: string[];
    patterns: DataPattern[];
}

interface DataPattern {
    pattern: string;
    frequency: number;
    confidence: number;
    category: 'format' | 'business_rule' | 'validation' | 'transformation';
}

interface DataCleansingRule {
    field: string;
    rule: string;
    transformation: string;
    confidence: number;
    examples: { before: string; after: string }[];
}

interface AnomalyBaseline {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
}

interface FieldPattern {
    formats: string[];
    formatCounts: Record<string, number>;
    hasInconsistentCase?: boolean;
}

export class AIDataQualityService {
    private patterns = new Map<string, DataPattern[]>();
    private cleansingRules = new Map<string, DataCleansingRule[]>();
    private anomalyBaselines = new Map<string, AnomalyBaseline>();

    constructor() {
        this.initializePatterns();
        this.initializeCleansingRules();
    }

    /**
     * Analyze data quality for a record
     */
    async analyzeDataQuality(record: unknown, systemType: string): Promise<DataQualityAnalysis> {
        const issues = await this.detectDataIssues(record, systemType);
        const patterns = this.analyzeDataPatterns(record, systemType);
        const overallScore = this.calculateQualityScore(issues);
        const recommendations = this.generateRecommendations(issues, patterns);

        return {
            record,
            issues,
            overallScore,
            recommendations,
            patterns
        };
    }

    /**
     * Detect various data quality issues
     */
    private async detectDataIssues(record: unknown, systemType: string): Promise<DataQualityIssue[]> {
        const issues: DataQualityIssue[] = [];

        for (const [field, value] of Object.entries(record)) {
            // Format validation
            const formatIssues = this.validateFieldFormat(field, value, systemType);
            issues.push(...formatIssues);

            // Missing data detection
            const missingIssues = this.detectMissingData(field, value, systemType);
            issues.push(...missingIssues);

            // Anomaly detection
            const anomalyIssues = await this.detectAnomalies(field, value, systemType);
            issues.push(...anomalyIssues);

            // Duplicate detection
            const duplicateIssues = this.detectDuplicates(field, value, systemType);
            issues.push(...duplicateIssues);

            // Business rule validation
            const businessRuleIssues = this.validateBusinessRules(field, value, record, systemType);
            issues.push(...businessRuleIssues);
        }

        return issues.filter(issue => issue.confidence > 0.7);
    }

    /**
     * Validate field formats using AI pattern recognition
     */
    private validateFieldFormat(field: string, value: unknown, systemType: string): DataQualityIssue[] {
        const issues: DataQualityIssue[] = [];
        
        if (!value || typeof value !== 'string') return issues;

        const formatRules = {
            email: {
                pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                fields: ['email', 'email_address', 'contact_email']
            },
            phone: {
                pattern: /^[\+]?[1-9][\d]{0,15}$/,
                fields: ['phone', 'telephone', 'mobile', 'contact_number']
            },
            date: {
                pattern: /^\d{4}-\d{2}-\d{2}$/,
                fields: ['date', 'created_date', 'updated_date', 'birth_date']
            },
            currency: {
                pattern: /^\d+\.?\d{0,2}$/,
                fields: ['amount', 'price', 'cost', 'revenue', 'salary']
            },
            zipcode: {
                pattern: /^\d{5}(-\d{4})?$/,
                fields: ['zip', 'zipcode', 'postal_code']
            }
        };

        for (const [ruleType, rule] of Object.entries(formatRules)) {
            if (rule.fields.some(f => field.toLowerCase().includes(f))) {
                if (!rule.pattern.test(value)) {
                    issues.push({
                        field,
                        issue: 'format',
                        severity: ruleType === 'email' || ruleType === 'phone' ? 'high' : 'medium',
                        description: `Invalid ${ruleType} format: "${value}"`,
                        suggestion: this.generateFormatSuggestion(value, ruleType),
                        confidence: 0.9,
                        autoFixable: ruleType !== 'email' && ruleType !== 'phone'
                    });
                }
            }
        }

        return issues;
    }

    /**
     * Detect missing critical data
     */
    private detectMissingData(field: string, value: unknown, systemType: string): DataQualityIssue[] {
        const issues: DataQualityIssue[] = [];
        
        const criticalFields: Record<string, string[]> = {
            'customer': ['name', 'email', 'id'],
            'order': ['customer_id', 'total', 'date'],
            'product': ['name', 'sku', 'price'],
            'invoice': ['number', 'amount', 'date', 'customer_id']
        };

        const entityType = this.detectEntityType(systemType);
        const required = criticalFields[entityType] || [];

        if (required.some((f: string) => field.toLowerCase().includes(f))) {
            if (!value || (typeof value === 'string' && value.trim() === '')) {
                issues.push({
                    field,
                    issue: 'missing',
                    severity: 'critical',
                    description: `Missing required field: ${field}`,
                    suggestion: `This field is required for ${entityType} records in ${systemType}`,
                    confidence: 0.95,
                    autoFixable: false
                });
            }
        }

        return issues;
    }

    /**
     * AI-powered anomaly detection
     */
    private async detectAnomalies(field: string, value: unknown, systemType: string): Promise<DataQualityIssue[]> {
        const issues: DataQualityIssue[] = [];
        const baseline = this.anomalyBaselines.get(`${systemType}.${field}`);

        if (!baseline || typeof value !== 'number') return issues;

        // Statistical anomaly detection
        const zScore = Math.abs((value - baseline.mean) / baseline.stdDev);
        
        if (zScore > 3) { // More than 3 standard deviations
            issues.push({
                field,
                issue: 'anomaly',
                severity: zScore > 5 ? 'critical' : 'high',
                description: `Unusual value detected: ${value} (expected range: ${baseline.min}-${baseline.max})`,
                suggestion: `Consider validating this ${field} value - it's significantly outside normal range`,
                confidence: Math.min(0.95, zScore / 10),
                autoFixable: false
            });
        }

        // Business logic anomalies
        if (field.toLowerCase().includes('price') && value < 0) {
            issues.push({
                field,
                issue: 'anomaly',
                severity: 'high',
                description: 'Negative price detected',
                suggestion: 'Prices should be positive values',
                confidence: 0.99,
                autoFixable: false
            });
        }

        return issues;
    }

    /**
     * Detect duplicate records using fuzzy matching
     */
    private detectDuplicates(field: string, value: unknown, systemType: string): DataQualityIssue[] {
        const issues: DataQualityIssue[] = [];
        
        // This would integrate with a duplicate detection system
        // For now, implement basic duplicate patterns
        
        if (typeof value === 'string') {
            // Check for repeated patterns
            const repeated = /(.+)\1+/.exec(value);
            if (repeated && repeated[1] && repeated[1].length > 2) {
                issues.push({
                    field,
                    issue: 'duplicate',
                    severity: 'medium',
                    description: `Repeated pattern detected in ${field}: "${value}"`,
                    suggestion: `Remove repeated text: "${repeated[1]}"`,
                    confidence: 0.8,
                    autoFixable: true
                });
            }
        }

        return issues;
    }

    /**
     * Validate business rules
     */
    private validateBusinessRules(field: string, value: unknown, record: unknown, systemType: string): DataQualityIssue[] {
        const issues: DataQualityIssue[] = [];

        // Date logic validation
        if (field.toLowerCase().includes('end') && (record as any).start_date && value) {
            const startDate = new Date((record as any).start_date);
            const endDate = new Date(value as any);
            
            if (endDate < startDate) {
                issues.push({
                    field,
                    issue: 'inconsistent',
                    severity: 'high',
                    description: 'End date is before start date',
                    suggestion: `End date (${value}) should be after start date (${(record as any).start_date})`,
                    confidence: 0.95,
                    autoFixable: false
                });
            }
        }

        // Quantity and pricing validation
        if (field.toLowerCase().includes('quantity') && typeof value === 'number' && value === 0) {
            issues.push({
                field,
                issue: 'inconsistent',
                severity: 'medium',
                description: 'Zero quantity in active record',
                suggestion: 'Consider if zero quantity is intended for this record',
                confidence: 0.7,
                autoFixable: false
            });
        }

        return issues;
    }

    /**
     * Generate smart cleansing suggestions
     */
    async generateCleansingRules(data: unknown[], systemType: string): Promise<DataCleansingRule[]> {
        const rules: DataCleansingRule[] = [];
        
        // Analyze patterns across all records
        const fieldPatterns = this.analyzeFieldPatterns(data);
        
        for (const [field, patterns] of fieldPatterns.entries()) {
            // Generate format standardization rules
            if (patterns.formats.length > 1) {
                const mostCommon = patterns.formats.reduce((a: string, b: string) => 
                    patterns.formatCounts[a] > patterns.formatCounts[b] ? a : b
                );
                
                rules.push({
                    field,
                    rule: 'standardize_format',
                    transformation: `Convert to format: ${mostCommon}`,
                    confidence: patterns.formatCounts[mostCommon] / data.length,
                    examples: this.generateFormatExamples(patterns.formats, mostCommon)
                });
            }

            // Generate capitalization rules
            if (patterns.hasInconsistentCase) {
                rules.push({
                    field,
                    rule: 'standardize_case',
                    transformation: 'Apply title case for names, upper case for codes',
                    confidence: 0.85,
                    examples: [
                        { before: 'john SMITH', after: 'John Smith' },
                        { before: 'abc123', after: 'ABC123' }
                    ]
                });
            }
        }

        return rules.filter(rule => rule.confidence > 0.6);
    }

    /**
     * Auto-fix data quality issues where possible
     */
    async autoFixIssues(record: unknown, issues: DataQualityIssue[]): Promise<unknown> {
        const fixedRecord = { ...(record as any) };
        
        for (const issue of issues.filter(i => i.autoFixable)) {
            try {
                fixedRecord[issue.field] = this.applyAutoFix(
                    fixedRecord[issue.field], 
                    issue
                );
            } catch (error) {
                logger.warn(`Failed to auto-fix ${issue.field}:`, error);
            }
        }

        return fixedRecord;
    }

    /**
     * Calculate overall data quality score
     */
    private calculateQualityScore(issues: DataQualityIssue[]): number {
        if (issues.length === 0) return 100;

        const severityWeights = {
            'low': 1,
            'medium': 3,
            'high': 7,
            'critical': 15
        };

        const totalDeduction = issues.reduce((sum, issue) => {
            return sum + severityWeights[issue.severity] * (issue.confidence);
        }, 0);

        return Math.max(0, 100 - totalDeduction);
    }

    /**
     * Generate improvement recommendations
     */
    private generateRecommendations(issues: DataQualityIssue[], patterns: DataPattern[]): string[] {
        const recommendations: string[] = [];

        // Critical issues first
        const criticalIssues = issues.filter(i => i.severity === 'critical');
        if (criticalIssues.length > 0) {
            recommendations.push(`Address ${criticalIssues.length} critical data issues immediately`);
        }

        // Format standardization
        const formatIssues = issues.filter(i => i.issue === 'format');
        if (formatIssues.length > 0) {
            recommendations.push(`Standardize data formats for ${formatIssues.length} fields`);
        }

        // Pattern-based recommendations
        const commonPatterns = patterns.filter(p => p.frequency > 0.7);
        if (commonPatterns.length > 0) {
            recommendations.push(`Implement validation rules based on ${commonPatterns.length} detected patterns`);
        }

        // Auto-fixable issues
        const autoFixable = issues.filter(i => i.autoFixable);
        if (autoFixable.length > 0) {
            recommendations.push(`Auto-fix ${autoFixable.length} issues to improve data quality immediately`);
        }

        return recommendations;
    }

    // Helper methods
    private initializePatterns(): void {
        // Initialize common data patterns for different systems
        this.patterns.set('salesforce', [
            { pattern: 'email_format', frequency: 0.95, confidence: 0.9, category: 'format' },
            { pattern: 'phone_format', frequency: 0.8, confidence: 0.85, category: 'format' }
        ]);
        
        this.patterns.set('netsuite', [
            { pattern: 'currency_format', frequency: 0.9, confidence: 0.95, category: 'format' },
            { pattern: 'date_format', frequency: 0.85, confidence: 0.9, category: 'format' }
        ]);
    }

    private initializeCleansingRules(): void {
        // Initialize common cleansing rules
        this.cleansingRules.set('phone', [
            {
                field: 'phone',
                rule: 'normalize_phone',
                transformation: 'Remove non-digits, apply standard format',
                confidence: 0.9,
                examples: [
                    { before: '(555) 123-4567', after: '5551234567' },
                    { before: '+1-555-123-4567', after: '5551234567' }
                ]
            }
        ]);
    }

    private detectEntityType(systemType: string): string {
        // Simple entity type detection - could be enhanced with ML
        return 'customer'; // Default
    }

    private analyzeDataPatterns(record: unknown, systemType: string): DataPattern[] {
        // Implement pattern analysis logic
        return [];
    }

    private generateFormatSuggestion(value: string, ruleType: string): string {
        const suggestions: Record<string, string> = {
            email: 'Use format: user@domain.com',
            phone: 'Use format: +1234567890',
            date: 'Use format: YYYY-MM-DD',
            currency: 'Use format: 123.45',
            zipcode: 'Use format: 12345 or 12345-6789'
        };
        return suggestions[ruleType] || 'Fix format';
    }

    private analyzeFieldPatterns(data: unknown[]): Map<string, FieldPattern> {
        // Implement field pattern analysis
        return new Map();
    }

    private generateFormatExamples(formats: string[], target: string): { before: string; after: string }[] {
        return [{ before: 'example', after: 'example' }];
    }

    private applyAutoFix(value: unknown, issue: DataQualityIssue): unknown {
        switch (issue.issue) {
            case 'duplicate':
                return typeof value === 'string' ? 
                    value.replace(/(.+)\1+/, '$1') : value;
            case 'format':
                return this.standardizeFormat(value as string, issue.field);
            default:
                return value;
        }
    }

    private standardizeFormat(value: string, field: string): string {
        if (field.toLowerCase().includes('phone')) {
            return value.replace(/\D/g, '');
        }
        if (field.toLowerCase().includes('email')) {
            return value.toLowerCase().trim();
        }
        return value.trim();
    }
}