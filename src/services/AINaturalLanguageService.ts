/**
 * AI Natural Language Configuration Service
 * Enables conversational integration setup and natural language troubleshooting
 *
 * Enhanced with optional Help Chat RAG integration (Phase 2)
 * - Provides documentation references in troubleshooting responses
 * - Gracefully degrades if Help Chat unavailable
 */

import { logger } from '../utils/Logger';
import type { DocumentationKnowledgeBase } from './help/DocumentationKnowledgeBase';
import type { DocumentRetrievalResult } from './help/types';

interface NLConfigRequest {
    text: string;
    context?: IntegrationContext;
    userId?: string;
    sessionId?: string;
}

interface IntegrationContext {
    existingIntegrations: string[];
    availableSystems: string[];
    userRole: string;
    organizationSize: 'small' | 'medium' | 'large' | 'enterprise';
}

interface NLConfigResponse {
    intent: ConfigurationIntent;
    confidence: number;
    extractedEntities: ExtractedEntity[];
    suggestedConfiguration: IntegrationConfiguration;
    clarificationQuestions: string[];
    alternativeInterpretations: AlternativeInterpretation[];
    nextSteps: string[];
}

interface ConfigurationIntent {
    action: 'create' | 'modify' | 'delete' | 'troubleshoot' | 'explain' | 'optimize';
    target: 'integration' | 'field_mapping' | 'schedule' | 'transformation' | 'authentication';
    confidence: number;
}

interface ExtractedEntity {
    type: 'system' | 'frequency' | 'direction' | 'field' | 'condition' | 'time' | 'data_type';
    value: string;
    confidence: number;
    position: [number, number];
    alternatives: string[];
}

interface IntegrationConfiguration {
    sourceSystem: string;
    targetSystem: string;
    syncDirection: 'unidirectional' | 'bidirectional';
    syncMode: 'realtime' | 'scheduled' | 'manual';
    schedule?: ScheduleConfiguration;
    fieldMappings: FieldMapping[];
    transformationRules: TransformationRule[];
    businessRules: BusinessRule[];
    confidence: number;
}

interface ScheduleConfiguration {
    frequency: 'realtime' | 'every_minute' | 'every_5_minutes' | 'every_15_minutes' | 'hourly' | 'daily' | 'weekly';
    time?: string;
    timezone: string;
    businessHoursOnly: boolean;
}

interface FieldMapping {
    sourceField: string;
    targetField: string;
    transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation';
    transformationValue?: string;
    confidence: number;
}

interface TransformationRule {
    field: string;
    rule: string;
    condition?: string;
    action: string;
    confidence: number;
}

interface BusinessRule {
    name: string;
    condition: string;
    action: string;
    priority: number;
    confidence: number;
}

interface AlternativeInterpretation {
    interpretation: string;
    confidence: number;
    configuration: Partial<IntegrationConfiguration>;
}

interface TroubleshootingResponse {
    issue: string;
    diagnosis: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    possibleCauses: string[];
    solutions: Solution[];
    preventiveMeasures: string[];
    estimatedResolutionTime: string;
    relatedDocumentation?: DocumentRetrievalResult[]; // Phase 2: Optional doc references
}

interface Solution {
    description: string;
    steps: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    successProbability: number;
    requirements: string[];
}

export class AINaturalLanguageService {
    private intentClassifier: IntentClassifier;
    private entityExtractor: EntityExtractor;
    private configurationGenerator: ConfigurationGenerator;
    private troubleshootingEngine: TroubleshootingEngine;
    private conversationHistory = new Map<string, ConversationContext[]>();
    private helpChat?: DocumentationKnowledgeBase; // Phase 2: Optional Help Chat RAG

    constructor(helpChat?: DocumentationKnowledgeBase) {
        this.intentClassifier = new IntentClassifier();
        this.entityExtractor = new EntityExtractor();
        this.configurationGenerator = new ConfigurationGenerator();
        this.troubleshootingEngine = new TroubleshootingEngine();
        this.helpChat = helpChat;

        if (this.helpChat) {
            logger.info('AINaturalLanguageService initialized with Help Chat RAG integration', {
                context: 'AINaturalLanguageService',
                helpChatEnabled: true
            });
        }
    }

    /**
     * Process natural language configuration request
     */
    async processConfigurationRequest(request: NLConfigRequest): Promise<NLConfigResponse> {
        // Classify intent
        const intent = await this.intentClassifier.classify(request.text);
        
        // Extract entities
        const entities = await this.entityExtractor.extract(request.text, intent);
        
        // Generate configuration based on intent and entities
        const configuration = await this.configurationGenerator.generate(intent, entities, request.context);
        
        // Generate clarification questions if confidence is low
        const clarifications = this.generateClarificationQuestions(intent, entities, configuration);
        
        // Generate alternative interpretations
        const alternatives = await this.generateAlternativeInterpretations(request.text, intent, entities);
        
        // Determine next steps
        const nextSteps = this.determineNextSteps(intent, configuration, clarifications);
        
        // Store conversation context
        this.updateConversationHistory(request.sessionId || 'default', {
            request,
            intent,
            entities,
            configuration
        });

        return {
            intent,
            confidence: Math.min(intent.confidence, ...entities.map(e => e.confidence)),
            extractedEntities: entities,
            suggestedConfiguration: configuration,
            clarificationQuestions: clarifications,
            alternativeInterpretations: alternatives,
            nextSteps
        };
    }

    /**
     * Handle troubleshooting requests in natural language
     *
     * Phase 2 Enhancement: Includes related documentation if Help Chat available
     */
    async troubleshootWithNL(issue: string, context?: IntegrationContext): Promise<TroubleshootingResponse> {
        // Step 1: Get core diagnosis from troubleshooting engine
        const diagnosis = await this.troubleshootingEngine.diagnose(issue, context);

        // Step 2: Optionally enhance with documentation (Phase 2)
        if (this.helpChat) {
            try {
                logger.debug('Fetching related documentation for troubleshooting', {
                    context: 'AINaturalLanguageService',
                    issue: issue.substring(0, 100)
                });

                // Query Help Chat for related documentation
                const relatedDocs = await this.helpChat.findSimilarChunks(issue, 3, 0.6);

                if (relatedDocs.length > 0) {
                    diagnosis.relatedDocumentation = relatedDocs;

                    logger.info('Enhanced troubleshooting response with documentation', {
                        context: 'AINaturalLanguageService',
                        docsFound: relatedDocs.length
                    });
                }
            } catch (error) {
                // Graceful degradation: continue without documentation
                logger.warn('Failed to fetch related documentation for troubleshooting', {
                    context: 'AINaturalLanguageService',
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        return diagnosis;
    }

    /**
     * Explain configuration in natural language
     */
    async explainConfiguration(configId: string): Promise<string> {
        const config = await this.getConfiguration(configId);
        return this.generateExplanation(config);
    }

    /**
     * Generate documentation automatically
     */
    async generateDocumentation(integrationId: string): Promise<string> {
        const integration = await this.getIntegration(integrationId);
        const config = integration.configuration;
        
        const explanation = this.generateExplanation(config);
        const businessValue = this.explainBusinessValue(config);
        const technicalDetails = this.generateTechnicalDetails(config);
        const troubleshooting = this.generateTroubleshootingGuide(config);
        
        return `
# Integration Documentation: ${integration.name}

## Overview
${explanation}

## Business Value
${businessValue}

## Technical Configuration
${technicalDetails}

## Troubleshooting Guide
${troubleshooting}

---
*Generated automatically by AI Natural Language Service*
        `.trim();
    }

    /**
     * Convert complex configurations to simple natural language
     */
    private generateExplanation(config: IntegrationConfiguration): string {
        const direction = config.syncDirection === 'bidirectional' ? 'synchronizes data between' : 'sends data from';
        const frequency = this.explainFrequency(config.schedule?.frequency || 'manual');
        
        let explanation = `This integration ${direction} ${config.sourceSystem} and ${config.targetSystem}`;
        
        if (config.schedule && config.syncMode === 'scheduled') {
            explanation += ` ${frequency}`;
        } else if (config.syncMode === 'realtime') {
            explanation += ` in real-time whenever data changes`;
        }
        
        if (config.fieldMappings.length > 0) {
            explanation += `. It maps ${config.fieldMappings.length} fields`;
            
            const transformations = config.fieldMappings.filter(f => f.transformationType !== 'direct');
            if (transformations.length > 0) {
                explanation += `, including ${transformations.length} data transformations`;
            }
        }
        
        if (config.businessRules.length > 0) {
            explanation += ` and applies ${config.businessRules.length} business rules to ensure data quality and compliance`;
        }
        
        return explanation + '.';
    }

    private explainBusinessValue(config: IntegrationConfiguration): string {
        const benefits = [];
        
        if (config.syncMode === 'realtime') {
            benefits.push('Real-time data synchronization eliminates manual data entry and reduces errors');
        }
        
        if (config.syncDirection === 'bidirectional') {
            benefits.push('Bidirectional sync keeps both systems in perfect alignment');
        }
        
        const transformations = config.fieldMappings.filter(f => f.transformationType !== 'direct');
        if (transformations.length > 0) {
            benefits.push('Automated data transformations ensure consistent data formats across systems');
        }
        
        if (config.businessRules.length > 0) {
            benefits.push('Business rules enforce data quality and business logic automatically');
        }
        
        return benefits.join('. ') + '.';
    }

    private generateTechnicalDetails(config: IntegrationConfiguration): string {
        let details = `**Source System:** ${config.sourceSystem}\n`;
        details += `**Target System:** ${config.targetSystem}\n`;
        details += `**Sync Direction:** ${config.syncDirection}\n`;
        details += `**Sync Mode:** ${config.syncMode}\n`;
        
        if (config.schedule) {
            details += `**Schedule:** ${config.schedule.frequency}`;
            if (config.schedule.time) details += ` at ${config.schedule.time}`;
            details += `\n`;
        }
        
        details += `**Field Mappings:** ${config.fieldMappings.length}\n`;
        details += `**Business Rules:** ${config.businessRules.length}\n`;
        
        return details;
    }

    private generateTroubleshootingGuide(config: IntegrationConfiguration): string {
        const guide = [];
        
        guide.push('### Common Issues and Solutions');
        guide.push('');
        guide.push('**Connection Issues:**');
        guide.push('- Verify API credentials and endpoints');
        guide.push('- Check network connectivity and firewall settings');
        guide.push('- Ensure authentication tokens are valid and not expired');
        guide.push('');
        
        if (config.fieldMappings.some(f => f.transformationType !== 'direct')) {
            guide.push('**Data Transformation Issues:**');
            guide.push('- Validate source data formats match expected patterns');
            guide.push('- Check transformation logic for edge cases');
            guide.push('- Review field mapping configurations');
            guide.push('');
        }
        
        if (config.businessRules.length > 0) {
            guide.push('**Business Rule Failures:**');
            guide.push('- Review business rule conditions and logic');
            guide.push('- Check for conflicting rules or circular dependencies');
            guide.push('- Validate input data meets rule requirements');
            guide.push('');
        }
        
        guide.push('**Performance Issues:**');
        guide.push('- Monitor sync duration and resource usage');
        guide.push('- Consider implementing pagination for large datasets');
        guide.push('- Review sync frequency and adjust if necessary');
        
        return guide.join('\n');
    }

    private explainFrequency(frequency: string): string {
        const explanations: Record<string, string> = {
            'realtime': 'continuously',
            'every_minute': 'every minute',
            'every_5_minutes': 'every 5 minutes',
            'every_15_minutes': 'every 15 minutes',
            'hourly': 'every hour',
            'daily': 'once daily',
            'weekly': 'once per week',
            'manual': 'when triggered manually'
        };
        return explanations[frequency] || frequency;
    }

    private generateClarificationQuestions(
        intent: ConfigurationIntent,
        entities: ExtractedEntity[],
        config: IntegrationConfiguration
    ): string[] {
        const questions: string[] = [];
        
        // Check for missing critical entities
        if (!entities.some(e => e.type === 'system') && config.confidence < 0.8) {
            questions.push('Which systems would you like to integrate? (e.g., Salesforce, NetSuite, etc.)');
        }
        
        if (intent.action === 'create' && !entities.some(e => e.type === 'direction')) {
            questions.push('Should data flow in one direction or both directions between the systems?');
        }
        
        if (intent.action === 'create' && !entities.some(e => e.type === 'frequency')) {
            questions.push('How often should the data sync? (e.g., real-time, hourly, daily)');
        }
        
        if (entities.some(e => e.type === 'field') && entities.filter(e => e.type === 'field').length === 1) {
            questions.push('Are there other fields you\'d like to include in this integration?');
        }
        
        return questions;
    }

    private async generateAlternativeInterpretations(
        text: string,
        intent: ConfigurationIntent,
        entities: ExtractedEntity[]
    ): Promise<AlternativeInterpretation[]> {
        const alternatives: AlternativeInterpretation[] = [];
        
        // Generate alternative interpretations based on ambiguous entities
        const ambiguousEntities = entities.filter(e => e.confidence < 0.7);
        
        for (const entity of ambiguousEntities) {
            for (const alternative of entity.alternatives.slice(0, 2)) {
                const altConfig = await this.configurationGenerator.generate(
                    intent,
                    entities.map(e => e === entity ? { ...e, value: alternative } : e),
                    undefined
                );
                
                alternatives.push({
                    interpretation: `Did you mean "${alternative}" instead of "${entity.value}"?`,
                    confidence: 0.6,
                    configuration: altConfig
                });
            }
        }
        
        return alternatives;
    }

    private determineNextSteps(
        intent: ConfigurationIntent,
        config: IntegrationConfiguration,
        clarifications: string[]
    ): string[] {
        const steps: string[] = [];
        
        if (clarifications.length > 0) {
            steps.push('Please answer the clarification questions above');
            return steps;
        }
        
        switch (intent.action) {
            case 'create':
                steps.push('Review the suggested configuration');
                steps.push('Test the integration with sample data');
                steps.push('Deploy to production when ready');
                break;
                
            case 'modify':
                steps.push('Review the proposed changes');
                steps.push('Backup current configuration');
                steps.push('Apply changes and test');
                break;
                
            case 'troubleshoot':
                steps.push('Review the diagnostic information');
                steps.push('Follow the suggested solutions');
                steps.push('Monitor the integration after fixes');
                break;
        }
        
        return steps;
    }

    private updateConversationHistory(sessionId: string, context: ConversationContext): void {
        const history = this.conversationHistory.get(sessionId) || [];
        history.push(context);
        
        // Keep only last 10 exchanges
        if (history.length > 10) {
            history.shift();
        }
        
        this.conversationHistory.set(sessionId, history);
    }

    // Mock methods for data retrieval (would connect to real data sources)
    private async getConfiguration(configId: string): Promise<IntegrationConfiguration> {
        return {
            sourceSystem: 'Salesforce',
            targetSystem: 'NetSuite',
            syncDirection: 'bidirectional',
            syncMode: 'scheduled',
            schedule: {
                frequency: 'hourly',
                timezone: 'UTC',
                businessHoursOnly: false
            },
            fieldMappings: [],
            transformationRules: [],
            businessRules: [],
            confidence: 0.9
        };
    }

    private async getIntegration(integrationId: string): Promise<{
        id: string;
        name: string;
        configuration: IntegrationConfiguration;
    }> {
        return {
            id: integrationId,
            name: 'Salesforce to NetSuite Customer Sync',
            configuration: await this.getConfiguration('config-1')
        };
    }
}

interface ConversationContext {
    request: NLConfigRequest;
    intent: ConfigurationIntent;
    entities: ExtractedEntity[];
    configuration: IntegrationConfiguration;
    timestamp?: Date;
}

/**
 * Intent Classification Service
 */
class IntentClassifier {
    private patterns = new Map<string, RegExp[]>();

    constructor() {
        this.initializePatterns();
    }

    async classify(text: string): Promise<ConfigurationIntent> {
        const normalizedText = text.toLowerCase();
        
        for (const [intentKey, patterns] of this.patterns.entries()) {
            for (const pattern of patterns) {
                if (pattern.test(normalizedText)) {
                    const [action, target] = intentKey.split('_');
                    return {
                        action: action as any,
                        target: target as any,
                        confidence: this.calculateConfidence(text, pattern)
                    };
                }
            }
        }
        
        // Default intent if no patterns match
        return {
            action: 'create',
            target: 'integration',
            confidence: 0.3
        };
    }

    private initializePatterns(): void {
        // Create integration patterns
        this.patterns.set('create_integration', [
            /(?:create|set up|build|make|establish).*(?:integration|sync|connection)/,
            /sync.*(?:from|to|between).*(?:salesforce|netsuite|dynamics)/,
            /connect.*(?:salesforce|netsuite|dynamics).*(?:to|with)/,
            /i need to integrate/,
            /how do i sync/
        ]);

        // Modify integration patterns
        this.patterns.set('modify_integration', [
            /(?:change|modify|update|edit|alter).*(?:integration|sync|mapping)/,
            /add.*(?:field|mapping|rule)/,
            /remove.*(?:field|mapping|rule)/,
            /update the sync/
        ]);

        // Troubleshoot patterns
        this.patterns.set('troubleshoot_integration', [
            /(?:fix|troubleshoot|debug|resolve).*(?:integration|sync|error|issue|problem)/,
            /why is.*(?:not working|failing|slow)/,
            /(?:error|problem|issue).*with.*sync/,
            /integration.*(?:broken|failed|stopped)/
        ]);

        // Schedule patterns
        this.patterns.set('modify_schedule', [
            /(?:change|set|update).*(?:schedule|frequency|time)/,
            /sync.*(?:every|daily|hourly|weekly)/,
            /run.*(?:every|at|once)/
        ]);

        // Field mapping patterns
        this.patterns.set('modify_field_mapping', [
            /map.*(?:field|column|data)/,
            /(?:field|column).*(?:mapping|correspondence)/,
            /transform.*(?:field|data|value)/
        ]);
    }

    private calculateConfidence(text: string, pattern: RegExp): number {
        const matches = text.match(pattern);
        if (!matches) return 0.3;
        
        // Higher confidence for longer matches and multiple keywords
        const matchLength = matches[0].length;
        const textLength = text.length;
        const coverage = matchLength / textLength;
        
        return Math.min(0.95, 0.5 + coverage);
    }
}

/**
 * Entity Extraction Service
 */
class EntityExtractor {
    private entityPatterns = new Map<string, RegExp[]>();

    constructor() {
        this.initializeEntityPatterns();
    }

    async extract(text: string, intent: ConfigurationIntent): Promise<ExtractedEntity[]> {
        const entities: ExtractedEntity[] = [];
        const normalizedText = text.toLowerCase();

        for (const [entityType, patterns] of this.entityPatterns.entries()) {
            for (const pattern of patterns) {
                const matches = normalizedText.matchAll(new RegExp(pattern, 'gi'));
                
                for (const match of matches) {
                    if (match.index !== undefined) {
                        entities.push({
                            type: entityType as any,
                            value: match[1] || match[0],
                            confidence: this.calculateEntityConfidence(match[0], entityType),
                            position: [match.index, match.index + match[0].length],
                            alternatives: this.getAlternatives(match[0], entityType)
                        });
                    }
                }
            }
        }

        return this.deduplicateEntities(entities);
    }

    private initializeEntityPatterns(): void {
        // System patterns
        this.entityPatterns.set('system', [
            /\b(salesforce|sf)\b/,
            /\b(netsuite|ns)\b/,
            /\b(dynamics|d365)\b/,
            /\b(sap)\b/,
            /\b(oracle)\b/,
            /\b(business central|bc)\b/
        ]);

        // Frequency patterns
        this.entityPatterns.set('frequency', [
            /\b(real-?time|instantly|immediately)\b/,
            /\b(every|each)\s+(\d+)?\s*(minute|hour|day|week)s?\b/,
            /\b(hourly|daily|weekly|monthly)\b/,
            /\b(once|twice)\s+(per|a|an)\s+(minute|hour|day|week|month)\b/
        ]);

        // Direction patterns
        this.entityPatterns.set('direction', [
            /\b(bidirectional|both\s+directions|two-?way)\b/,
            /\b(unidirectional|one-?way|from.*to)\b/,
            /\b(sync\s+from|send\s+from|push\s+to)\b/
        ]);

        // Field patterns
        this.entityPatterns.set('field', [
            /\b(customer|account|contact|lead|opportunity)\s+(name|id|email|phone)\b/,
            /\b(first\s+name|last\s+name|full\s+name|email\s+address)\b/,
            /\b(address|city|state|zip|country)\b/,
            /\b(price|amount|total|quantity)\b/
        ]);

        // Time patterns
        this.entityPatterns.set('time', [
            /\bat\s+(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))\b/,
            /\bat\s+(\d{1,2}(?::\d{2})?)\b/,
            /\b(morning|afternoon|evening|night)\b/
        ]);
    }

    private calculateEntityConfidence(match: string, entityType: string): number {
        // Higher confidence for exact system names, lower for abbreviated forms
        const confidenceMap: Record<string, number> = {
            'salesforce': 0.95, 'sf': 0.8,
            'netsuite': 0.95, 'ns': 0.8,
            'dynamics': 0.9, 'd365': 0.8,
            'real-time': 0.95, 'hourly': 0.9,
            'bidirectional': 0.95, 'two-way': 0.85
        };
        
        return confidenceMap[match.toLowerCase()] || 0.7;
    }

    private getAlternatives(match: string, entityType: string): string[] {
        const alternatives = new Map();
        
        alternatives.set('sf', ['Salesforce']);
        alternatives.set('ns', ['NetSuite']);
        alternatives.set('d365', ['Dynamics 365']);
        alternatives.set('real-time', ['immediately', 'instantly']);
        alternatives.set('hourly', ['every hour', 'once per hour']);
        
        return alternatives.get(match.toLowerCase()) || [];
    }

    private deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
        const seen = new Set();
        return entities.filter(entity => {
            const key = `${entity.type}:${entity.value}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

/**
 * Configuration Generation Service
 */
class ConfigurationGenerator {
    async generate(
        intent: ConfigurationIntent,
        entities: ExtractedEntity[],
        context?: IntegrationContext
    ): Promise<IntegrationConfiguration> {
        const systems = entities.filter(e => e.type === 'system').map(e => e.value);
        const frequencies = entities.filter(e => e.type === 'frequency');
        const directions = entities.filter(e => e.type === 'direction');
        const fields = entities.filter(e => e.type === 'field');

        const config: IntegrationConfiguration = {
            sourceSystem: systems[0] || 'Unknown',
            targetSystem: systems[1] || systems[0] || 'Unknown',
            syncDirection: this.determineSyncDirection(directions),
            syncMode: this.determineSyncMode(frequencies),
            fieldMappings: this.generateFieldMappings(fields),
            transformationRules: [],
            businessRules: [],
            confidence: this.calculateOverallConfidence(entities)
        };

        if (config.syncMode === 'scheduled') {
            config.schedule = this.generateSchedule(frequencies, entities);
        }

        return config;
    }

    private determineSyncDirection(directions: ExtractedEntity[]): 'unidirectional' | 'bidirectional' {
        if (directions.length === 0) return 'unidirectional';
        
        const direction = directions[0]?.value.toLowerCase() || '';
        if (direction.includes('bidirectional') || direction.includes('both') || direction.includes('two-way')) {
            return 'bidirectional';
        }
        
        return 'unidirectional';
    }

    private determineSyncMode(frequencies: ExtractedEntity[]): 'realtime' | 'scheduled' | 'manual' {
        if (frequencies.length === 0) return 'scheduled';
        
        const frequency = frequencies[0]?.value.toLowerCase() || '';
        if (frequency.includes('real-time') || frequency.includes('instantly')) {
            return 'realtime';
        }
        
        return 'scheduled';
    }

    private generateFieldMappings(fields: ExtractedEntity[]): FieldMapping[] {
        return fields.map(field => ({
            sourceField: field.value,
            targetField: this.suggestTargetField(field.value),
            transformationType: 'direct',
            confidence: field.confidence
        }));
    }

    private suggestTargetField(sourceField: string): string {
        const mappings: Record<string, string> = {
            'customer name': 'account_name',
            'email': 'primary_email',
            'phone': 'phone_number',
            'address': 'billing_address'
        };
        
        return mappings[sourceField.toLowerCase()] || sourceField;
    }

    private generateSchedule(frequencies: ExtractedEntity[], allEntities: ExtractedEntity[]): ScheduleConfiguration {
        const frequency = frequencies[0]?.value.toLowerCase() || 'hourly';
        const times = allEntities.filter(e => e.type === 'time');
        
        return {
            frequency: this.mapFrequency(frequency),
            time: times[0]?.value,
            timezone: 'UTC',
            businessHoursOnly: false
        };
    }

    private mapFrequency(frequency: string): ScheduleConfiguration['frequency'] {
        if (frequency.includes('minute')) return 'every_15_minutes';
        if (frequency.includes('hour')) return 'hourly';
        if (frequency.includes('day')) return 'daily';
        if (frequency.includes('week')) return 'weekly';
        return 'hourly';
    }

    private calculateOverallConfidence(entities: ExtractedEntity[]): number {
        if (entities.length === 0) return 0.3;
        
        const avgConfidence = entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length;
        
        // Bonus for having system entities (most critical)
        const hasSystemEntities = entities.some(e => e.type === 'system');
        const systemBonus = hasSystemEntities ? 0.1 : 0;
        
        return Math.min(0.95, avgConfidence + systemBonus);
    }
}

/**
 * Troubleshooting Engine
 */
class TroubleshootingEngine {
    async diagnose(issue: string, context?: IntegrationContext): Promise<TroubleshootingResponse> {
        const normalizedIssue = issue.toLowerCase();
        
        // Classify the type of issue
        const issueType = this.classifyIssue(normalizedIssue);
        
        // Generate diagnosis based on issue type
        const diagnosis = this.generateDiagnosis(issueType, normalizedIssue);
        
        // Provide solutions
        const solutions = this.generateSolutions(issueType);
        
        return {
            issue: issue,
            diagnosis: (diagnosis as any).description,
            severity: (diagnosis as any).severity,
            possibleCauses: (diagnosis as any).causes,
            solutions,
            preventiveMeasures: this.getPreventiveMeasures(issueType),
            estimatedResolutionTime: (diagnosis as any).resolutionTime
        };
    }

    private classifyIssue(issue: string): string {
        if (issue.includes('connection') || issue.includes('timeout') || issue.includes('unreachable')) {
            return 'connection';
        }
        if (issue.includes('authentication') || issue.includes('unauthorized') || issue.includes('token')) {
            return 'authentication';
        }
        if (issue.includes('data') || issue.includes('field') || issue.includes('mapping')) {
            return 'data_mapping';
        }
        if (issue.includes('slow') || issue.includes('performance') || issue.includes('taking long')) {
            return 'performance';
        }
        if (issue.includes('error') || issue.includes('failed') || issue.includes('not working')) {
            return 'general_error';
        }
        
        return 'unknown';
    }

    private generateDiagnosis(issueType: string, issue: string): unknown {
        const diagnoses: Record<string, {
            description: string;
            severity: 'low' | 'medium' | 'high' | 'critical';
            causes: string[];
            resolutionTime: string;
        }> = {
            connection: {
                description: 'Network connectivity issue detected between systems',
                severity: 'high' as const,
                causes: ['Network firewall blocking requests', 'API endpoint unavailable', 'DNS resolution issues'],
                resolutionTime: '15-30 minutes'
            },
            authentication: {
                description: 'Authentication failure - invalid or expired credentials',
                severity: 'critical' as const,
                causes: ['Expired API tokens', 'Invalid credentials', 'Insufficient permissions'],
                resolutionTime: '5-15 minutes'
            },
            data_mapping: {
                description: 'Data transformation or field mapping issue',
                severity: 'medium' as const,
                causes: ['Incorrect field mappings', 'Data format mismatch', 'Missing required fields'],
                resolutionTime: '30-60 minutes'
            },
            performance: {
                description: 'Performance degradation in integration processing',
                severity: 'medium' as const,
                causes: ['Large dataset processing', 'API rate limiting', 'System resource constraints'],
                resolutionTime: '1-2 hours'
            },
            general_error: {
                description: 'General integration failure requiring investigation',
                severity: 'high' as const,
                causes: ['Configuration errors', 'System maintenance', 'Data quality issues'],
                resolutionTime: '30 minutes - 2 hours'
            }
        };

        return diagnoses[issueType] || diagnoses.general_error;
    }

    private generateSolutions(issueType: string): Solution[] {
        const solutionMap: Record<string, Solution[]> = {
            connection: [
                {
                    description: 'Verify network connectivity and firewall settings',
                    steps: [
                        'Check if API endpoints are reachable',
                        'Verify firewall allows outbound connections',
                        'Test DNS resolution for target domains'
                    ],
                    complexity: 'simple' as const,
                    successProbability: 0.8,
                    requirements: ['Network access', 'Firewall configuration']
                }
            ],
            authentication: [
                {
                    description: 'Refresh authentication credentials',
                    steps: [
                        'Generate new API tokens or refresh existing ones',
                        'Verify user permissions in target system',
                        'Update integration configuration with new credentials'
                    ],
                    complexity: 'simple' as const,
                    successProbability: 0.95,
                    requirements: ['Admin access to both systems']
                }
            ]
        };

        return solutionMap[issueType] || [];
    }

    private getPreventiveMeasures(issueType: string): string[] {
        const measures: Record<string, string[]> = {
            connection: ['Set up connection monitoring', 'Implement retry logic with exponential backoff'],
            authentication: ['Enable automatic token refresh', 'Set up expiration alerts'],
            data_mapping: ['Implement data validation rules', 'Add comprehensive error logging'],
            performance: ['Monitor integration performance metrics', 'Implement intelligent throttling']
        };

        return measures[issueType] || ['Regular integration health checks', 'Comprehensive monitoring setup'];
    }
}