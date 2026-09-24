import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { Logger } from '../../../utils/Logger';
import type {
  ISemanticProvider,
  IPatternProvider,
  INLPProvider,
  SemanticContext,
  SemanticSimilarityResult,
  SemanticMatch,
  PatternContext,
  FieldPatternResult,
  DataTypeClassification,
  NLPContext,
  DescriptionAnalysisResult,
} from '../interfaces/IAIProvider';

/**
 * Rule-based AI provider implementation.
 * This is the current implementation that uses deterministic algorithms
 * to simulate AI capabilities for field mapping.
 */
@injectable()
export class RuleBasedAIProvider implements ISemanticProvider, IPatternProvider, INLPProvider {
  readonly name = 'Rule-Based AI Provider';
  readonly version = '1.0.0';
  readonly type = 'rule-based' as const;
  readonly isAvailable = true;

  private logger: Logger;

  // Business terminology mappings
  private readonly businessSynonyms = {
    customer: ['client', 'account', 'buyer', 'purchaser', 'consumer'],
    contact: ['person', 'individual', 'representative', 'user'],
    email: ['emailaddress', 'mail', 'electronic_mail', 'e_mail'],
    phone: ['telephone', 'mobile', 'cell', 'phonenumber', 'tel'],
    name: ['title', 'label', 'identifier', 'designation', 'company'],
    address: ['location', 'addr', 'place', 'site'],
    amount: ['value', 'sum', 'total', 'cost', 'price', 'revenue'],
    date: ['time', 'timestamp', 'datetime', 'created', 'modified'],
  };

  // Data pattern regular expressions
  private readonly dataPatterns = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    phone: /^[\+]?[1-9][\d\s\-\(\)\.]{7,20}$/,
    url: /^https?:\/\/[^\s]+$/,
    currency: /^\$?[\d,]+\.?\d{0,2}$/,
    date: /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    boolean: /^(true|false|yes|no|y|n|1|0)$/i,
    guid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  };

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  async analyzeSemanticSimilarity(
    sourceField: string,
    targetField: string,
    context?: SemanticContext,
  ): Promise<SemanticSimilarityResult> {
    const normalizedSource = this.normalizeFieldName(sourceField);
    const normalizedTarget = this.normalizeFieldName(targetField);

    // Exact match
    if (normalizedSource === normalizedTarget) {
      return {
        similarity: 0.95,
        confidence: 0.98,
        explanation: `Exact field name match: "${sourceField}" = "${targetField}"`,
        matchType: 'exact',
      };
    }

    // Partial match
    if (normalizedSource.includes(normalizedTarget) || normalizedTarget.includes(normalizedSource)) {
      const similarity = Math.max(normalizedTarget.length, normalizedSource.length) /
                        Math.min(normalizedTarget.length, normalizedSource.length) * 0.8;
      return {
        similarity: Math.min(similarity, 0.9),
        confidence: 0.85,
        explanation: `Partial field name match: "${sourceField}" ~ "${targetField}"`,
        matchType: 'partial',
      };
    }

    // Synonym match
    const synonymMatch = this.checkSynonymMatch(normalizedSource, normalizedTarget);
    if (synonymMatch.similarity > 0) {
      return {
        ...synonymMatch,
        explanation: `Synonym match: "${sourceField}" is synonymous with "${targetField}"`,
        matchType: 'synonym',
      };
    }

    // Contextual match (based on system context)
    if (context) {
      const contextualMatch = this.checkContextualMatch(sourceField, targetField, context);
      if (contextualMatch.similarity > 0) {
        return {
          ...contextualMatch,
          explanation: `Contextual match for ${context.sourceSystem} -> ${context.targetSystem}`,
          matchType: 'contextual',
        };
      }
    }

    // No significant match
    return {
      similarity: 0.1,
      confidence: 0.2,
      explanation: 'No semantic similarity detected',
      matchType: 'semantic',
    };
  }

  async findSemanticMatches(
    sourceField: string,
    candidateFields: string[],
    context?: SemanticContext,
  ): Promise<SemanticMatch[]> {
    const matches: SemanticMatch[] = [];

    for (const candidate of candidateFields) {
      const result = await this.analyzeSemanticSimilarity(sourceField, candidate, context);

      if (result.similarity > 0.3) { // Minimum threshold
        matches.push({
          field: candidate,
          similarity: result.similarity,
          confidence: result.confidence,
          explanation: result.explanation,
          matchType: result.matchType,
        });
      }
    }

    // Sort by similarity score
    return matches.sort((a, b) => b.similarity - a.similarity);
  }

  async analyzeFieldPattern(
    fieldName: string,
    sampleValues: unknown[],
    context?: PatternContext,
  ): Promise<FieldPatternResult> {
    const validValues = sampleValues.filter(v => v != null && v !== '');

    if (validValues.length === 0) {
      return {
        pattern: 'unknown',
        confidence: 0.1,
        examples: [],
        statistics: {
          totalSamples: sampleValues.length,
          matchingPatterns: 0,
          uniqueValues: 0,
          nullValues: sampleValues.length,
        },
      };
    }

    // Test each pattern
    const patternResults = await Promise.all(
      Object.entries(this.dataPatterns).map(async ([pattern, regex]) => ({
        pattern,
        matches: validValues.filter(v => regex.test(String(v))).length,
        total: validValues.length,
      })),
    );

    // Find best matching pattern
    const bestPattern = patternResults.reduce((best, current) =>
      current.matches > best.matches ? current : best,
    );

    const confidence = bestPattern.matches / bestPattern.total;

    return {
      pattern: confidence > 0.7 ? bestPattern.pattern : 'string',
      confidence,
      examples: validValues.slice(0, 5),
      statistics: {
        totalSamples: sampleValues.length,
        matchingPatterns: bestPattern.matches,
        uniqueValues: new Set(validValues).size,
        nullValues: sampleValues.length - validValues.length,
      },
    };
  }

  async classifyDataType(
    sampleValues: unknown[],
    context?: PatternContext,
  ): Promise<DataTypeClassification> {
    const validValues = sampleValues.filter(v => v != null && v !== '');

    if (validValues.length === 0) {
      return {
        primaryType: 'string',
        confidence: 0.1,
        alternativeTypes: [],
      };
    }

    // Type classification logic
    const typeScores: Record<string, number> = {};

    // Check for numbers
    const numberValues = validValues.filter(v => !isNaN(Number(v))).length;
    if (numberValues > 0) {
      typeScores.number = numberValues / validValues.length;
    }

    // Check for booleans
    const booleanValues = validValues.filter(v =>
      /^(true|false|yes|no|y|n|1|0)$/i.test(String(v)),
    ).length;
    if (booleanValues > 0) {
      typeScores.boolean = booleanValues / validValues.length;
    }

    // Check for dates
    const dateValues = validValues.filter(v => {
      const date = new Date(v as any);
      return !isNaN(date.getTime());
    }).length;
    if (dateValues > 0) {
      typeScores.date = dateValues / validValues.length;
    }

    // Check for emails
    const emailValues = validValues.filter(v =>
      this.dataPatterns.email.test(String(v)),
    ).length;
    if (emailValues > 0) {
      typeScores.email = emailValues / validValues.length;
    }

    // Default to string
    typeScores.string = 1.0;

    // Find primary type
    const primaryType = Object.entries(typeScores).reduce((a, b) =>
      typeScores[a[0]] > typeScores[b[0]] ? a : b,
    )[0];

    // Create alternatives
    const alternativeTypes = Object.entries(typeScores)
      .filter(([type]) => type !== primaryType)
      .map(([type, confidence]) => ({ type, confidence }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    return {
      primaryType,
      confidence: typeScores[primaryType],
      alternativeTypes,
    };
  }

  async analyzeFieldDescription(
    description: string,
    context?: NLPContext,
  ): Promise<DescriptionAnalysisResult> {
    const words = description.toLowerCase().split(/\s+/);
    const keywords: string[] = [];
    const businessContext: string[] = [];
    const technicalTerms: string[] = [];

    // Extract keywords and categorize terms
    for (const word of words) {
      if (word.length > 3 && !this.isStopWord(word)) {
        keywords.push(word);

        if (this.isBusinessTerm(word)) {
          businessContext.push(word);
        }

        if (this.isTechnicalTerm(word)) {
          technicalTerms.push(word);
        }
      }
    }

    // Simple intent detection
    let intent = 'unknown';
    if (description.toLowerCase().includes('identifier') || description.toLowerCase().includes('id')) {
      intent = 'identification';
    } else if (description.toLowerCase().includes('contact') || description.toLowerCase().includes('communication')) {
      intent = 'communication';
    } else if (description.toLowerCase().includes('amount') || description.toLowerCase().includes('price')) {
      intent = 'financial';
    }

    return {
      intent,
      keywords: [...new Set(keywords)],
      sentiment: 'neutral', // Rule-based doesn't do sentiment analysis
      businessContext: [...new Set(businessContext)],
      technicalTerms: [...new Set(technicalTerms)],
      confidence: keywords.length > 0 ? 0.7 : 0.3,
    };
  }

  async generateMappingExplanation(
    sourceField: string,
    targetField: string,
    confidence: number,
    context?: NLPContext,
  ): Promise<string> {
    if (confidence > 0.9) {
      return `High confidence mapping: "${sourceField}" directly maps to "${targetField}" based on semantic similarity`;
    } else if (confidence > 0.7) {
      return `Good mapping: "${sourceField}" matches "${targetField}" with strong pattern recognition`;
    } else if (confidence > 0.5) {
      return `Moderate mapping: "${sourceField}" potentially maps to "${targetField}" based on contextual analysis`;
    } else {
      return `Low confidence mapping: "${sourceField}" to "${targetField}" requires manual review`;
    }
  }

  // Helper methods
  private normalizeFieldName(name: string): string {
    return name.toLowerCase().replace(/[_\s-]/g, '').replace(/[^\w]/g, '');
  }

  private checkSynonymMatch(source: string, target: string): { similarity: number; confidence: number } {
    for (const [term, synonyms] of Object.entries(this.businessSynonyms)) {
      const sourceMatch = source.includes(term) || synonyms.some(s => source.includes(s));
      const targetMatch = target.includes(term) || synonyms.some(s => target.includes(s));

      if (sourceMatch && targetMatch) {
        return { similarity: 0.85, confidence: 0.8 };
      }
    }

    return { similarity: 0, confidence: 0 };
  }

  private checkContextualMatch(
    sourceField: string,
    targetField: string,
    context: SemanticContext,
  ): { similarity: number; confidence: number } {
    // NetSuite-specific contextual mappings
    if (context.targetSystem === 'NetSuite') {
      const netsuiteMap: Record<string, string[]> = {
        'companyname': ['name', 'company', 'organization'],
        'email': ['emailaddress', 'mail', 'contact_email'],
        'phone': ['telephone', 'mobile', 'phonenumber'],
      };

      const normalizedSource = this.normalizeFieldName(sourceField);

      for (const [netsuiteField, sourceVariants] of Object.entries(netsuiteMap)) {
        if (targetField.toLowerCase() === netsuiteField) {
          if (sourceVariants.some(variant => normalizedSource.includes(variant))) {
            return { similarity: 0.9, confidence: 0.85 };
          }
        }
      }
    }

    return { similarity: 0, confidence: 0 };
  }

  private isStopWord(word: string): boolean {
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    return stopWords.includes(word.toLowerCase());
  }

  private isBusinessTerm(word: string): boolean {
    const businessTerms = ['customer', 'client', 'account', 'revenue', 'invoice', 'order', 'product', 'service'];
    return businessTerms.includes(word.toLowerCase());
  }

  private isTechnicalTerm(word: string): boolean {
    const technicalTerms = ['api', 'database', 'field', 'record', 'sync', 'integration', 'mapping'];
    return technicalTerms.includes(word.toLowerCase());
  }
}
