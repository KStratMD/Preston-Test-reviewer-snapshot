/**
 * Hallucination Detector - Validates AI output for accuracy and consistency
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import { logger, type Logger } from '../../../utils/Logger';
import type { AgentExecutionContext, AgentResult } from './interfaces';

export interface HallucinationDetectionResult {
  isHallucination: boolean;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
  detectionMethods: DetectionMethod[];
  reasons: string[];
  recommendations: string[];
  validatedFacts: ValidatedFact[];
}

export interface DetectionMethod {
  name: string;
  score: number;
  confidence: number;
  evidence: string[];
  weight: number;
}

export interface ValidatedFact {
  claim: string;
  verified: boolean;
  confidence: number;
  source?: string;
  context?: string;
}

export interface ConsistencyCheck {
  field: string;
  values: unknown[];
  consistent: boolean;
  variance: number;
  expectedType: string;
}

export interface FactCheck {
  statement: string;
  factual: boolean;
  confidence: number;
  contradictions: string[];
  supportingEvidence: string[];
}

export interface HallucinationPattern {
  name: string;
  description: string;
  pattern: RegExp | ((text: string) => boolean);
  severity: 'low' | 'medium' | 'high';
  category: 'factual' | 'logical' | 'structural' | 'contextual';
}

@injectable()
export class HallucinationDetector {
  private knownPatterns = new Map<string, HallucinationPattern>();
  private factDatabase = new Map<string, unknown>();
  private confidenceThresholds = {
    low: 0.3,
    medium: 0.6,
    high: 0.8
  };

  constructor(@inject(TYPES.Logger) private logger: Logger) {
    this.initializePatterns();
    this.initializeFactDatabase();
  }

  /**
   * Detect hallucinations in agent output
   */
  async detectHallucination(
    output: AgentResult,
    context: AgentExecutionContext,
    inputData?: unknown
  ): Promise<HallucinationDetectionResult> {
    try {
      const detectionMethods: DetectionMethod[] = [];
      const reasons: string[] = [];
      const recommendations: string[] = [];
      const validatedFacts: ValidatedFact[] = [];

      // Method 1: Confidence-based detection
      const confidenceMethod = await this.analyzeConfidenceConsistency(output, context);
      detectionMethods.push(confidenceMethod);

      // Method 2: Consistency checking
      const consistencyMethod = await this.analyzeDataConsistency(output, inputData);
      detectionMethods.push(consistencyMethod);

      // Method 3: Pattern-based detection
      const patternMethod = await this.analyzeHallucinationPatterns(output);
      detectionMethods.push(patternMethod);

      // Method 4: Fact verification
      const factMethod = await this.verifyFactualClaims(output, context);
      detectionMethods.push(factMethod);
      validatedFacts.push(...factMethod.evidence.map(e => ({
        claim: e,
        verified: factMethod.score > 0.7,
        confidence: factMethod.confidence
      })));

      // Method 5: Logical coherence
      const logicMethod = await this.analyzeLogicalCoherence(output);
      detectionMethods.push(logicMethod);

      // Method 6: Domain knowledge validation
      const domainMethod = await this.validateDomainKnowledge(output, context);
      detectionMethods.push(domainMethod);

      // Calculate overall hallucination score
      const overallScore = this.calculateOverallScore(detectionMethods);
      const riskLevel = this.determineRiskLevel(overallScore);
      const isHallucination = overallScore > this.confidenceThresholds.medium;

      // Generate reasons and recommendations
      reasons.push(...this.generateReasons(detectionMethods, overallScore));
      recommendations.push(...this.generateRecommendations(detectionMethods, riskLevel));

      const result: HallucinationDetectionResult = {
        isHallucination,
        confidence: overallScore,
        riskLevel,
        detectionMethods,
        reasons,
        recommendations,
        validatedFacts
      };

      this.logger.info('Hallucination detection completed', {
        sessionId: context.sessionId,
        isHallucination,
        confidence: overallScore,
        riskLevel,
        methodsUsed: detectionMethods.length
      });

      return result;

    } catch (error) {
      this.logger.error('Hallucination detection failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return {
        isHallucination: true, // Conservative approach on error
        confidence: 1.0,
        riskLevel: 'high',
        detectionMethods: [],
        reasons: [`Detection failed: ${error}`],
        recommendations: ['Manual review required due to detection failure'],
        validatedFacts: []
      };
    }
  }

  /**
   * Analyze multiple agent outputs for cross-validation
   */
  async crossValidateOutputs(
    outputs: AgentResult[],
    context: AgentExecutionContext
  ): Promise<{
    consensusReached: boolean;
    consensusConfidence: number;
    outliers: number[];
    averageConfidence: number;
    consistencyScore: number;
  }> {
    if (outputs.length < 2) {
      return {
        consensusReached: false,
        consensusConfidence: 0,
        outliers: [],
        averageConfidence: outputs[0]?.confidence || 0,
        consistencyScore: 0
      };
    }

    const confidences = outputs.map(o => o.confidence);
    const averageConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

    // Check for consistency in results
    const consistencyScore = this.calculateConsistencyScore(outputs);

    // Identify outliers (outputs significantly different from consensus)
    const outliers: number[] = [];
    outputs.forEach((output, index) => {
      if (Math.abs(output.confidence - averageConfidence) > 0.3) {
        outliers.push(index);
      }
    });

    const consensusReached = outliers.length <= outputs.length * 0.2; // 80% consensus
    const consensusConfidence = consensusReached ? averageConfidence : 0;

    this.logger.info('Cross-validation completed', {
      sessionId: context.sessionId,
      outputCount: outputs.length,
      consensusReached,
      consistencyScore,
      outlierCount: outliers.length
    });

    return {
      consensusReached,
      consensusConfidence,
      outliers,
      averageConfidence,
      consistencyScore
    };
  }

  /**
   * Add known fact to database
   */
  addKnownFact(key: string, fact: unknown): void {
    this.factDatabase.set(key, fact);
    this.logger.debug('Known fact added', { key });
  }

  /**
   * Add hallucination pattern
   */
  addHallucinationPattern(pattern: HallucinationPattern): void {
    this.knownPatterns.set(pattern.name, pattern);
    this.logger.debug('Hallucination pattern added', {
      name: pattern.name,
      category: pattern.category,
      severity: pattern.severity
    });
  }

  /**
   * Update confidence thresholds
   */
  updateThresholds(thresholds: Partial<typeof this.confidenceThresholds>): void {
    this.confidenceThresholds = { ...this.confidenceThresholds, ...thresholds };
    this.logger.info('Confidence thresholds updated', { thresholds: this.confidenceThresholds });
  }

  /**
   * Get detection statistics
   */
  getDetectionStats(): {
    patternsCount: number;
    factsCount: number;
    thresholds: typeof this.confidenceThresholds;
  } {
    return {
      patternsCount: this.knownPatterns.size,
      factsCount: this.factDatabase.size,
      thresholds: this.confidenceThresholds
    };
  }

  // Private methods

  private initializePatterns(): void {
    // Factual inconsistency patterns
    this.addHallucinationPattern({
      name: 'contradictory_numbers',
      description: 'Numbers that contradict each other in the same output',
      pattern: /(\d+).*(?:different|other|another).*(\d+)/gi,
      severity: 'high',
      category: 'factual'
    });

    // Logical inconsistency patterns
    this.addHallucinationPattern({
      name: 'logical_contradiction',
      description: 'Statements that logically contradict each other',
      pattern: (text: string) => {
        const hasPositive = /\b(is|are|will|can|does)\b/gi.test(text);
        const hasNegative = /\b(is not|are not|will not|cannot|does not)\b/gi.test(text);
        return hasPositive && hasNegative;
      },
      severity: 'medium',
      category: 'logical'
    });

    // Structural inconsistency patterns
    this.addHallucinationPattern({
      name: 'malformed_data',
      description: 'Data structures that are malformed or incomplete',
      pattern: /\{[^}]*$/g, // Unclosed JSON objects
      severity: 'medium',
      category: 'structural'
    });

    // Overconfident language patterns
    this.addHallucinationPattern({
      name: 'overconfident_language',
      description: 'Language that expresses false certainty',
      pattern: /\b(definitely|certainly|absolutely|guaranteed|100%|always|never)\b/gi,
      severity: 'low',
      category: 'contextual'
    });

    // Made-up entity patterns
    this.addHallucinationPattern({
      name: 'fabricated_entities',
      description: 'References to non-existent entities or standards',
      pattern: /\b(Protocol|Standard|RFC|ISO)\s+\d{4,}/gi,
      severity: 'high',
      category: 'factual'
    });
  }

  private initializeFactDatabase(): void {
    // System integration facts
    this.addKnownFact('netsuite_record_types', [
      'customer', 'vendor', 'item', 'salesorder', 'invoice', 'contact',
      'transaction', 'employee', 'subsidiary', 'location'
    ]);

    this.addKnownFact('squire_field_types', [
      'string', 'number', 'boolean', 'date', 'currency', 'phone', 'email'
    ]);

    this.addKnownFact('common_transformation_types', [
      'direct', 'lookup', 'calculation', 'concatenation', 'conditional'
    ]);

    // Data quality standards
    this.addKnownFact('quality_dimensions', [
      'completeness', 'consistency', 'accuracy', 'validity', 'timeliness', 'uniqueness'
    ]);

    // Integration patterns
    this.addKnownFact('integration_patterns', [
      'batch', 'real_time', 'event_driven', 'api_first', 'hybrid'
    ]);
  }

  private async analyzeConfidenceConsistency(
    output: AgentResult,
    context: AgentExecutionContext
  ): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;

    // Check if confidence matches output quality
    if (output.confidence > 0.8 && output.errors && output.errors.length > 0) {
      score += 0.4;
      evidence.push('High confidence claimed despite errors present');
    }

    if (output.confidence > 0.9 && (!output.data || Object.keys(output.data).length === 0)) {
      score += 0.5;
      evidence.push('Very high confidence claimed for empty/minimal output');
    }

    // Check reasoning vs confidence alignment
    if (output.reasoning.includes('uncertain') || output.reasoning.includes('might be')) {
      if (output.confidence > 0.7) {
        score += 0.3;
        evidence.push('Uncertain language used with high confidence score');
      }
    }

    return {
      name: 'confidence_consistency',
      score,
      confidence: 0.8,
      evidence,
      weight: 0.2
    };
  }

  private async analyzeDataConsistency(
    output: AgentResult,
    inputData?: unknown
  ): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;

    if (!output.data || !inputData) {
      return {
        name: 'data_consistency',
        score: 0,
        confidence: 0.5,
        evidence: ['Insufficient data for consistency analysis'],
        weight: 0.15
      };
    }

    // Check for field name consistency
    const outputText = JSON.stringify(output.data);
    const inputText = JSON.stringify(inputData);

    // Look for completely new field names not in input
    const outputFields = this.extractFieldNames(outputText);
    const inputFields = this.extractFieldNames(inputText);

    const newFields = outputFields.filter(field => !inputFields.includes(field));
    if (newFields.length > outputFields.length * 0.5) {
      score += 0.4;
      evidence.push(`High proportion of new field names: ${newFields.length}/${outputFields.length}`);
    }

    // Check for impossible data transformations
    if (this.hasImpossibleTransformations(output.data, inputData)) {
      score += 0.6;
      evidence.push('Contains data transformations that appear impossible');
    }

    return {
      name: 'data_consistency',
      score,
      confidence: 0.7,
      evidence,
      weight: 0.25
    };
  }

  private async analyzeHallucinationPatterns(output: AgentResult): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;
    const text = JSON.stringify(output);

    for (const [name, pattern] of this.knownPatterns) {
      let matches = false;

      if (pattern.pattern instanceof RegExp) {
        matches = pattern.pattern.test(text);
      } else if (typeof pattern.pattern === 'function') {
        matches = pattern.pattern(text);
      }

      if (matches) {
        const severityWeight = { low: 0.1, medium: 0.3, high: 0.5 }[pattern.severity];
        score += severityWeight;
        evidence.push(`Pattern detected: ${pattern.description}`);
      }
    }

    return {
      name: 'pattern_analysis',
      score: Math.min(score, 1), // Cap at 1.0
      confidence: 0.9,
      evidence,
      weight: 0.2
    };
  }

  private async verifyFactualClaims(
    output: AgentResult,
    context: AgentExecutionContext
  ): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;

    if (!output.data) {
      return {
        name: 'fact_verification',
        score: 0,
        confidence: 0.5,
        evidence: ['No data to verify'],
        weight: 0.15
      };
    }

    const outputText = JSON.stringify(output.data);

    // Check against known facts
    for (const [factKey, factValue] of this.factDatabase) {
      if (this.containsFactualClaim(outputText, factKey)) {
        const isConsistent = this.verifyFactConsistency(outputText, factValue);
        if (!isConsistent) {
          score += 0.3;
          evidence.push(`Inconsistent with known fact: ${factKey}`);
        } else {
          evidence.push(`Verified fact: ${factKey}`);
        }
      }
    }

    // Check for system-specific facts
    if (context.sourceSystem === 'netsuite' || context.targetSystem === 'netsuite') {
      score += this.verifyNetSuiteFacts(outputText);
    }

    return {
      name: 'fact_verification',
      score: Math.min(score, 1),
      confidence: 0.8,
      evidence,
      weight: 0.2
    };
  }

  private async analyzeLogicalCoherence(output: AgentResult): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;

    if (!output.data || !output.reasoning) {
      return {
        name: 'logical_coherence',
        score: 0,
        confidence: 0.5,
        evidence: ['Insufficient data for logical analysis'],
        weight: 0.1
      };
    }

    const reasoning = output.reasoning;

    // Check for logical connectives
    const hasLogicalFlow = /\b(because|therefore|thus|since|so|hence)\b/gi.test(reasoning);
    if (!hasLogicalFlow && reasoning.length > 50) {
      score += 0.2;
      evidence.push('Reasoning lacks logical connectives');
    }

    // Check for circular reasoning
    if (this.hasCircularReasoning(reasoning)) {
      score += 0.4;
      evidence.push('Circular reasoning detected');
    }

    // Check for contradictory statements
    if (this.hasContradictions(reasoning)) {
      score += 0.5;
      evidence.push('Internal contradictions found');
    }

    return {
      name: 'logical_coherence',
      score,
      confidence: 0.7,
      evidence,
      weight: 0.08
    };
  }

  private async validateDomainKnowledge(
    output: AgentResult,
    context: AgentExecutionContext
  ): Promise<DetectionMethod> {
    const evidence: string[] = [];
    let score = 0;

    if (!output.data) {
      return {
        name: 'domain_validation',
        score: 0,
        confidence: 0.5,
        evidence: ['No data for domain validation'],
        weight: 0.1
      };
    }

    const outputText = JSON.stringify(output.data).toLowerCase();

    // Validate field mapping domain knowledge
    if (context.sourceSystem && context.targetSystem) {
      if (outputText.includes('mapping') || outputText.includes('field')) {
        const hasValidTransformations = this.validateTransformationTypes(outputText);
        if (!hasValidTransformations) {
          score += 0.3;
          evidence.push('Invalid transformation types detected');
        }

        const hasValidFieldTypes = this.validateFieldTypes(outputText);
        if (!hasValidFieldTypes) {
          score += 0.2;
          evidence.push('Invalid field types detected');
        }
      }
    }

    // Check for impossible confidence scores
    if (outputText.includes('confidence') && this.hasImpossibleConfidenceValues(outputText)) {
      score += 0.4;
      evidence.push('Impossible confidence values detected');
    }

    return {
      name: 'domain_validation',
      score,
      confidence: 0.8,
      evidence,
      weight: 0.1
    };
  }

  private calculateOverallScore(methods: DetectionMethod[]): number {
    if (methods.length === 0) return 0;

    const totalWeight = methods.reduce((sum, method) => sum + method.weight, 0);
    const weightedScore = methods.reduce((sum, method) => sum + (method.score * method.weight), 0);

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }

  private determineRiskLevel(score: number): 'low' | 'medium' | 'high' {
    if (score >= this.confidenceThresholds.high) return 'high';
    if (score >= this.confidenceThresholds.medium) return 'medium';
    return 'low';
  }

  private generateReasons(methods: DetectionMethod[], score: number): string[] {
    const reasons: string[] = [];

    if (score > this.confidenceThresholds.high) {
      reasons.push('High probability of hallucination detected');
    } else if (score > this.confidenceThresholds.medium) {
      reasons.push('Moderate probability of hallucination detected');
    }

    // Add specific method findings
    methods.forEach(method => {
      if (method.score > 0.3 && method.evidence.length > 0) {
        reasons.push(`${method.name}: ${method.evidence[0]}`);
      }
    });

    return reasons;
  }

  private generateRecommendations(methods: DetectionMethod[], riskLevel: 'low' | 'medium' | 'high'): string[] {
    const recommendations: string[] = [];

    switch (riskLevel) {
      case 'high':
        recommendations.push('Reject output and request regeneration');
        recommendations.push('Manual review required');
        break;
      case 'medium':
        recommendations.push('Flag for human review');
        recommendations.push('Consider using alternative AI provider');
        break;
      case 'low':
        recommendations.push('Monitor for patterns');
        break;
    }

    // Method-specific recommendations
    methods.forEach(method => {
      if (method.name === 'confidence_consistency' && method.score > 0.3) {
        recommendations.push('Recalibrate confidence scoring');
      }
      if (method.name === 'fact_verification' && method.score > 0.3) {
        recommendations.push('Update fact database with domain knowledge');
      }
    });

    return recommendations;
  }

  private extractFieldNames(text: string): string[] {
    const fieldMatches = text.match(/"([^"]+)":/g) || [];
    return fieldMatches.map(match => match.slice(1, -2));
  }

  private hasImpossibleTransformations(outputData: unknown, inputData: unknown): boolean {
    // Simple check for data that couldn't logically come from input
    const outputString = JSON.stringify(outputData);
    const inputString = JSON.stringify(inputData);

    // Check if output contains significantly more data than input could provide
    return outputString.length > inputString.length * 3;
  }

  private containsFactualClaim(text: string, factKey: string): boolean {
    return text.toLowerCase().includes(factKey.toLowerCase());
  }

  private verifyFactConsistency(text: string, factValue: unknown): boolean {
    if (Array.isArray(factValue)) {
      // Check if mentioned values are in the known list
      return factValue.some(value => text.toLowerCase().includes(value.toLowerCase()));
    }
    return true; // Default to consistent if we can't verify
  }

  private verifyNetSuiteFacts(text: string): number {
    let score = 0;
    const lowerText = text.toLowerCase();

    // Check for invalid NetSuite record types
    const netsuiteRecordTypes = this.factDatabase.get('netsuite_record_types') || [];
    if (lowerText.includes('netsuite') || lowerText.includes('record')) {
      const mentionedTypes = (netsuiteRecordTypes as string[]).filter(type =>
        lowerText.includes(type.toLowerCase())
      );
      if (mentionedTypes.length === 0 && lowerText.includes('record')) {
        score += 0.3; // Mentions records but no valid types
      }
    }

    return score;
  }

  private hasCircularReasoning(reasoning: string): boolean {
    // Simple check for obvious circular patterns
    const sentences = reasoning.split(/[.!?]+/);
    const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));
    return uniqueSentences.size < sentences.length * 0.8;
  }

  private hasContradictions(reasoning: string): boolean {
    const lowerReasoning = reasoning.toLowerCase();
    return (
      (lowerReasoning.includes('is') && lowerReasoning.includes('is not')) ||
      (lowerReasoning.includes('can') && lowerReasoning.includes('cannot')) ||
      (lowerReasoning.includes('will') && lowerReasoning.includes('will not'))
    );
  }

  private validateTransformationTypes(text: string): boolean {
    const validTypes = (this.factDatabase.get('common_transformation_types') || []) as string[];
    return validTypes.some(type => text.includes(type));
  }

  private validateFieldTypes(text: string): boolean {
    const validTypes = (this.factDatabase.get('squire_field_types') || []) as string[];
    return validTypes.some(type => text.includes(type));
  }

  private hasImpossibleConfidenceValues(text: string): boolean {
    // Check for confidence values > 1.0 or < 0.0
    const confidenceMatches = text.match(/confidence[^0-9]*([0-9.]+)/gi);
    if (!confidenceMatches) return false;

    return confidenceMatches.some(match => {
      const numMatch = match.match(/([0-9.]+)/);
      if (numMatch) {
        const value = parseFloat(numMatch[1]);
        return value > 1.0 || value < 0.0;
      }
      return false;
    });
  }

  private calculateConsistencyScore(outputs: AgentResult[]): number {
    if (outputs.length < 2) return 1;

    // Compare confidence scores
    const confidences = outputs.map(o => o.confidence);
    const confidenceVariance = this.calculateVariance(confidences);

    // Compare success rates
    const successRates = outputs.map(o => o.success ? 1 : 0);
    const successVariance = this.calculateVariance(successRates);

    // Combined consistency score (lower variance = higher consistency)
    return Math.max(0, 1 - (confidenceVariance + successVariance) / 2);
  }

  private calculateVariance(values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }
}