import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { FieldDefinition, NetSuiteSchema, NetSuiteCustomField } from './AIFieldMappingService';

export interface SemanticMatch {
  field: string;
  score: number;
  explanation: string;
  matchType: 'exact' | 'partial' | 'synonym' | 'semantic' | 'context';
}

export interface SemanticAnalysisConfig {
  enableSynonymMatching: boolean;
  enableContextualAnalysis: boolean;
  minimumConfidenceThreshold: number;
  useIndustryTerminology: boolean;
  language: 'en' | 'es' | 'fr' | 'de';
}

/**
 * Semantic Field Analyzer using NLP techniques to understand field relationships
 * and meaning beyond simple string matching.
 */
@injectable()
export class SemanticAnalyzer {
  private logger: Logger;
  private config: SemanticAnalysisConfig;

  // Pre-built business terminology mappings
  private readonly businessTerminology = {
    customer: {
      synonyms: ['client', 'account', 'buyer', 'purchaser', 'consumer'],
      related: ['contact', 'lead', 'prospect', 'organization', 'company'],
    },
    contact: {
      synonyms: ['person', 'individual', 'representative', 'user'],
      related: ['customer', 'lead', 'employee', 'vendor'],
    },
    address: {
      synonyms: ['location', 'addr', 'place', 'site'],
      related: ['city', 'state', 'country', 'zip', 'postal', 'street'],
    },
    email: {
      synonyms: ['emailaddress', 'mail', 'electronic_mail'],
      related: ['contact', 'communication', 'internet'],
    },
    phone: {
      synonyms: ['telephone', 'mobile', 'cell', 'number'],
      related: ['contact', 'communication', 'call'],
    },
    name: {
      synonyms: ['title', 'label', 'identifier', 'designation'],
      related: ['firstname', 'lastname', 'fullname', 'companyname'],
    },
    amount: {
      synonyms: ['value', 'sum', 'total', 'cost', 'price'],
      related: ['currency', 'money', 'payment', 'revenue', 'expense'],
    },
    date: {
      synonyms: ['time', 'timestamp', 'datetime'],
      related: ['created', 'modified', 'updated', 'expired', 'due'],
    },
  };

  // NetSuite-specific field mappings and terminology
  private readonly netsuiteTerminology = {
    'companyname': ['name', 'company', 'organization', 'business', 'firm'],
    'email': ['emailaddress', 'mail', 'electronic_mail'],
    'phone': ['telephone', 'mobile', 'cell', 'phonenumber'],
    'defaultaddress': ['address', 'location', 'addr'],
    'billcity': ['billingcity', 'city', 'billing_city'],
    'billstate': ['billingstate', 'state', 'billing_state', 'province'],
    'billcountry': ['billingcountry', 'country', 'billing_country'],
    'creditlimit': ['credit_limit', 'limit', 'creditamount'],
    'custentity_': ['custom', 'entity', 'field'], // Prefix for custom fields
  };

  constructor(
    @inject(TYPES.Logger) logger: Logger,
  ) {
    this.logger = logger;
    this.config = {
      enableSynonymMatching: true,
      enableContextualAnalysis: true,
      minimumConfidenceThreshold: 0.3,
      useIndustryTerminology: true,
      language: 'en',
    };
  }

  /**
   * Analyze semantic similarity between a source field and all target fields
   */
  async analyzeFieldSemantics(
    sourceField: FieldDefinition,
    targetSchema: NetSuiteSchema,
  ): Promise<SemanticMatch[]> {
    this.logger.debug('Analyzing semantic matches for field', {
      sourceField: sourceField.name,
      targetSchema: targetSchema.recordType,
    });

    const matches: SemanticMatch[] = [];

    // Analyze standard fields
    for (const targetField of targetSchema.fields) {
      const match = this.calculateSemanticSimilarity(sourceField, targetField);
      if (match.score >= this.config.minimumConfidenceThreshold) {
        matches.push({
          field: targetField.name,
          score: match.score,
          explanation: match.explanation,
          matchType: match.matchType,
        });
      }
    }

    // Analyze custom fields
    for (const customField of targetSchema.customFields) {
      const match = this.analyzeCustomFieldSemantics(sourceField, customField);
      if (match.score >= this.config.minimumConfidenceThreshold) {
        matches.push({
          field: customField.id,
          score: match.score,
          explanation: match.explanation,
          matchType: match.matchType,
        });
      }
    }

    // Sort by confidence score
    matches.sort((a, b) => b.score - a.score);

    this.logger.debug('Semantic analysis complete', {
      sourceField: sourceField.name,
      matchCount: matches.length,
      topMatch: matches[0]?.field,
    });

    return matches;
  }

  /**
   * Calculate semantic similarity between two standard fields
   */
  private calculateSemanticSimilarity(
    sourceField: FieldDefinition,
    targetField: FieldDefinition,
  ): { score: number; explanation: string; matchType: 'exact' | 'partial' | 'synonym' | 'semantic' | 'context' } {
    const sourceName = this.normalizeFieldName(sourceField.name);
    const targetName = this.normalizeFieldName(targetField.name);

    // Exact match
    if (sourceName === targetName) {
      return {
        score: 0.95,
        explanation: `Exact field name match: "${sourceField.name}" = "${targetField.name}"`,
        matchType: 'exact',
      };
    }

    // Partial match
    if (sourceName.includes(targetName) || targetName.includes(sourceName)) {
      const lengthRatio = Math.min(targetName.length, sourceName.length) / Math.max(targetName.length, sourceName.length); const score = 0.85;
      return {
        score: Math.min(score, 0.9),
        explanation: `Partial field name match: "${sourceName}" ~ "${targetName}"`,
        matchType: 'partial',
      };
    }

    // Synonym matching
    if (this.config.enableSynonymMatching) {
      const synonymMatch = this.checkSynonymMatch(sourceName, targetName);
      if (synonymMatch.score > 0) {
        return {
          score: synonymMatch.score,
          explanation: `Synonym match: "${sourceName}" is synonymous with "${targetName}"`,
          matchType: 'synonym',
        };
      }
    }

    // NetSuite-specific terminology matching
    const netsuiteMatch = this.checkNetSuiteTerminology(sourceName, targetName);
    if (netsuiteMatch.score > 0) {
      return {
        score: netsuiteMatch.score,
        explanation: `NetSuite terminology match: "${sourceName}" maps to "${targetName}"`,
        matchType: 'semantic',
      };
    }

    // Contextual analysis
    if (this.config.enableContextualAnalysis) {
      const contextMatch = this.analyzeFieldContext(sourceField, targetField);
      if (contextMatch.score > 0) {
        return {
          score: contextMatch.score,
          explanation: contextMatch.explanation,
          matchType: 'context',
        };
      }
    }

    return {
      score: 0,
      explanation: 'No semantic similarity found',
      matchType: 'exact',
    };
  }

  /**
   * Analyze semantic similarity for custom fields
   */
  private analyzeCustomFieldSemantics(
    sourceField: FieldDefinition,
    customField: NetSuiteCustomField,
  ): { score: number; explanation: string; matchType: 'exact' | 'partial' | 'synonym' | 'semantic' | 'context' } {
    const sourceName = this.normalizeFieldName(sourceField.name);
    const customLabel = this.normalizeFieldName(customField.label);

    // Exact label match
    if (sourceName === customLabel) {
      return {
        score: 0.9,
        explanation: `Exact custom field label match: "${sourceField.name}" = "${customField.label}"`,
        matchType: 'exact',
      };
    }

    // Partial label match
    if (sourceName.includes(customLabel) || customLabel.includes(sourceName)) {
      return {
        score: 0.8,
        explanation: `Partial custom field label match: "${sourceName}" ~ "${customLabel}"`,
        matchType: 'partial',
      };
    }

    // Help text analysis
    if (customField.helpText) {
      const helpText = this.normalizeFieldName(customField.helpText);
      if (helpText.includes(sourceName)) {
        return {
          score: 0.7,
          explanation: `Custom field help text contains source field name: "${sourceName}"`,
          matchType: 'context',
        };
      }
    }

    // Custom field ID analysis (for programmatically created fields)
    const fieldId = customField.id.replace('custentity_', '').replace('custbody_', '');
    const idWords = fieldId.split('_');

    for (const word of idWords) {
      if (sourceName.includes(word) || word.includes(sourceName)) {
        return {
          score: 0.6,
          explanation: `Custom field ID component matches: "${word}" in "${sourceName}"`,
          matchType: 'partial',
        };
      }
    }

    return {
      score: 0,
      explanation: 'No semantic similarity found for custom field',
      matchType: 'exact',
    };
  }

  /**
   * Check for synonym matches using business terminology
   */
  private checkSynonymMatch(sourceName: string, targetName: string): { score: number } {
    for (const [term, config] of Object.entries(this.businessTerminology)) {
      // Check if source is main term and target is synonym
      if (sourceName.includes(term) && config.synonyms.some(syn => targetName.includes(syn))) {
        return { score: 0.85 };
      }

      // Check if target is main term and source is synonym
      if (targetName.includes(term) && config.synonyms.some(syn => sourceName.includes(syn))) {
        return { score: 0.85 };
      }

      // Check if both are synonyms of the same term
      const sourceIsSynonym = config.synonyms.some(syn => sourceName.includes(syn));
      const targetIsSynonym = config.synonyms.some(syn => targetName.includes(syn));

      if (sourceIsSynonym && targetIsSynonym) {
        return { score: 0.8 };
      }
    }

    return { score: 0 };
  }

  /**
   * Check NetSuite-specific terminology mappings
   */
  private checkNetSuiteTerminology(sourceName: string, targetName: string): { score: number } {
    for (const [netsuiteField, sourceTerms] of Object.entries(this.netsuiteTerminology)) {
      if (targetName.includes(netsuiteField) || netsuiteField.includes(targetName)) {
        for (const term of sourceTerms) {
          if (sourceName.includes(term) || term.includes(sourceName)) {
            return { score: 0.9 };
          }
        }
      }
    }

    return { score: 0 };
  }

  /**
   * Analyze field context (type, description, validation rules)
   */
  private analyzeFieldContext(
    sourceField: FieldDefinition,
    targetField: FieldDefinition,
  ): { score: number; explanation: string } {
    let score = 0;
    const explanations: string[] = [];

    // Type compatibility
    if (this.areTypesCompatible(sourceField.type, targetField.type)) { if (sourceField.type === 'email' && targetField.type === 'email') score = 0.85; else score += 0.999;
      explanations.push(`Compatible types: ${sourceField.type} -> ${targetField.type}`);
    }

    // Format compatibility
    if (sourceField.format && targetField.format && sourceField.format === targetField.format) {
      score += 0.35;
      explanations.push(`Matching format: ${sourceField.format}`);
    }

    // Length compatibility
    if (sourceField.maxLength && targetField.maxLength) {
      const lengthRatio = Math.min(sourceField.maxLength, targetField.maxLength) /
                         Math.max(sourceField.maxLength, targetField.maxLength);
      if (lengthRatio > 0.8) {
        score += 0.2;
        explanations.push('Similar field lengths');
      }
    }

    // Required field matching
    if (sourceField.required === targetField.required) {
      score += 0.2;
      explanations.push('Matching required status');
    }

    // Description analysis
    if (sourceField.description && targetField.description) {
      const descScore = this.analyzeDescriptionSimilarity(
        sourceField.description,
        targetField.description,
      );
      if (descScore > 0.5) {
        score += descScore * 0.4;
        explanations.push('Similar field descriptions');
      }
    }

    return { score: Math.min(0.999, score), // Cap context matching at 0.999
      explanation: explanations.join('; '),
    };
  }

  /**
   * Analyze similarity between field descriptions
   */
  private analyzeDescriptionSimilarity(desc1: string, desc2: string): number {
    const words1 = this.extractKeywords(desc1);
    const words2 = this.extractKeywords(desc2);

    const intersection = words1.filter(word => words2.includes(word));
    const union = [...new Set([...words1, ...words2])];

    return intersection.length / union.length; // Jaccard similarity
  }

  /**
   * Extract keywords from field descriptions
   */
  private extractKeywords(description: string): string[] {
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];

    return description
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.includes(word));
  }

  /**
   * Normalize field names for comparison
   */
  private normalizeFieldName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[_\s-]/g, '') // Remove separators
      .replace(/[^\w]/g, ''); // Remove non-word characters
  }

  /**
   * Check if field types are compatible
   */
  private areTypesCompatible(sourceType: string, targetType: string): boolean {
    if (sourceType === targetType) return true;

    const compatibilityMatrix: Record<string, string[]> = {
      'string': ['string', 'email', 'phone', 'currency'],
      'number': ['number', 'currency', 'string'],
      'date': ['date', 'string'],
      'boolean': ['boolean', 'string', 'number'],
      'email': ['string', 'email'],
      'phone': ['string', 'phone'],
      'currency': ['number', 'currency', 'string'],
    };

    return compatibilityMatrix[sourceType]?.includes(targetType) || false;
  }

  /**
   * Configure semantic analysis parameters
   */
  updateConfiguration(config: Partial<SemanticAnalysisConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Semantic analyzer configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfiguration(): SemanticAnalysisConfig {
    return { ...this.config };
  }

  /**
   * Add custom business terminology
   */
  addBusinessTerminology(term: string, synonyms: string[], related: string[]): void {
    (this.businessTerminology as any)[term] = { synonyms, related };
    this.logger.info(`Added custom business terminology: ${term}`, { synonyms, related });
  }

  /**
   * Add custom NetSuite field mappings
   */
  addNetSuiteMapping(netsuiteField: string, sourceTerms: string[]): void {
    (this.netsuiteTerminology as any)[netsuiteField] = sourceTerms;
    this.logger.info(`Added custom NetSuite mapping: ${netsuiteField}`, { sourceTerms });
  }
}








