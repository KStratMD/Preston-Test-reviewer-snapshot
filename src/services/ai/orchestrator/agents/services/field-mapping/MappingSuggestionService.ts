import type { Logger } from '../../../../../../utils/Logger';
import type { ProviderRegistry } from '../../../../ProviderRegistry';
import type { SemanticAnalysisEngine } from '../../../../SemanticAnalysisEngine';
import type { MappingContext, MappingPattern, MappingSuggestion, TransformationRule } from '../../fieldMappingTypes';
import type { FieldMappingAlternative, FieldDefinition } from '../../../interfaces';

export interface ProviderUsageSnapshot {
  providerId: string;
  tokens?: number;
  cost?: number;
}

export interface MappingSuggestionResult {
  suggestions: MappingSuggestion[];
  providerUsage?: ProviderUsageSnapshot;
}

/**
 * Handles LLM- and heuristic-based mapping suggestion generation.
 */
export class MappingSuggestionService {
  // Field synonym dictionary for semantic field name matching
  private static readonly FIELD_SYNONYMS: Record<string, string[]> = {
    // Name fields
    'firstName': ['first_name', 'fname', 'given_name', 'forename', 'first'],
    'lastName': ['last_name', 'lname', 'surname', 'family_name', 'last'],
    'fullName': ['full_name', 'name', 'contact_name', 'person_name', 'display_name'],

    // Company/Organization
    'company': ['company_name', 'organization', 'org', 'business', 'account_name', 'firm'],

    // Contact information
    'email': ['email_address', 'e_mail', 'electronic_mail', 'mail', 'contact_email'],
    'phone': ['phone_number', 'telephone', 'tel', 'mobile', 'cell', 'contact_phone'],

    // Address
    'street': ['street_address', 'address_1', 'addr_1', 'address_line_1', 'address', 'addressLine1', 'addr1', 'address1'],
    'city': ['city_name', 'town', 'municipality'],
    'state': ['state_code', 'province', 'region'],
    'zip': ['zip_code', 'postal_code', 'postcode'],
    'country': ['country_code', 'nation'],

    // Specialized address fields (billing, shipping, mailing)
    'billingAddress': ['billing_address', 'bill_address', 'bill_addr', 'billingAddr', 'invoiceAddress', 'invoice_address'],
    'shippingAddress': ['shipping_address', 'ship_address', 'ship_addr', 'shippingAddr', 'deliveryAddress', 'delivery_address'],
    'mailingAddress': ['mailing_address', 'mail_address', 'mail_addr', 'mailingAddr', 'postal_address'],

    // Dates
    'createdDate': ['created_at', 'date_created', 'creation_date', 'created'],
    'updatedDate': ['updated_at', 'date_updated', 'modification_date', 'modified', 'last_modified'],

    // Common fields
    'id': ['identifier', 'record_id', 'entity_id', 'primary_key'],
    'status': ['state', 'current_status', 'record_status'],
    'description': ['desc', 'details', 'notes', 'comments'],
    'amount': ['total', 'value', 'price', 'cost', 'sum']
  };

  private readonly providerConfidenceBaselines: Record<string, number> = {
    openai: 1.0,
    claude: 0.97,
    gemini: 0.92,
    grok: 0.9,
    lmstudio: 0.82,
    'mock-openai': 0.75,
    'mock-claude': 0.75,
    'rule-based': 0.68,
  };

  constructor(
    private readonly logger: Logger,
    private readonly providerRegistry: ProviderRegistry,
    private readonly semanticEngine: SemanticAnalysisEngine,
    private readonly mappingPatterns: Map<string, MappingPattern>,
    private readonly similarityCache: Map<string, number>
  ) {}

  async generateSuggestions(context: MappingContext): Promise<MappingSuggestionResult> {
    const providerSuggestions = await this.generateProviderSuggestions(context);

    const coveredPairs = new Set(providerSuggestions.suggestions.map(s => `${s.sourceField}->${s.targetField}`));
    const suggestions: MappingSuggestion[] = [...providerSuggestions.suggestions];

    const heuristicBatches = await Promise.all([
      Promise.resolve(this.findExactMatches(context.sourceSchema.fields, context.targetSchema.fields)),
      this.findSemanticMatches(context),
      Promise.resolve(this.findPatternMatches(context.sourceSchema.fields, context.targetSchema.fields)),
      Promise.resolve(this.findTypeMatches(context.sourceSchema.fields, context.targetSchema.fields)),
      Promise.resolve(this.applyBusinessRules(context)),
      Promise.resolve(this.findMultiFieldMappings(context.sourceSchema.fields, context.targetSchema.fields))
    ]);

    heuristicBatches.forEach(batch => {
      batch.forEach(suggestion => {
        const key = `${suggestion.sourceField}->${suggestion.targetField}`;
        if (!coveredPairs.has(key)) {
          suggestions.push(suggestion);
          coveredPairs.add(key);
        }
      });
    });

    return {
      suggestions: this.mergeSuggestions(suggestions),
      providerUsage: providerSuggestions.providerUsage
    };
  }

  private async generateProviderSuggestions(context: MappingContext): Promise<MappingSuggestionResult> {
    const emptyResult: MappingSuggestionResult = { suggestions: [] };

    if (!context.sourceSchema.fields.length || !context.targetSchema.fields.length) {
      this.logger.warn('⚠️ Empty schema provided to generateProviderSuggestions', {
        sourceFieldCount: context.sourceSchema.fields.length,
        targetFieldCount: context.targetSchema.fields.length
      });
      return emptyResult;
    }

    this.logger.info('🔍 Calling AI provider for mapping suggestions', {
      preferredProviderId: context.preferredProviderId,
      sourceSystem: context.sourceSchema.systemName,
      targetSystem: context.targetSchema.systemName,
      sourceFieldCount: context.sourceSchema.fields.length,
      targetFieldCount: context.targetSchema.fields.length,
      sampleDataCount: context.sampleData.length
    });

    try {
      const providerResult = await this.providerRegistry.getAvailableProvider(context.preferredProviderId);

      if (!providerResult) {
        this.logger.warn('❌ No AI provider available for field mapping suggestions', {
          preferredProviderId: context.preferredProviderId
        });
        return emptyResult;
      }

      const { provider, id: providerId } = providerResult;

      const unwrappedSampleData = context.sampleData.map(sample => {
        if (sample && typeof sample === 'object' && 'sourceValues' in sample) {
          return (sample as any).sourceValues;
        }
        return sample;
      });

      const rawSuggestions = await provider.generateMappingSuggestions({
        sourceSystem: context.sourceSchema.systemName,
        targetSystem: context.targetSchema.systemName,
        sourceFields: context.sourceSchema.fields,
        targetFields: context.targetSchema.fields,
        sampleData: unwrappedSampleData
      });

      this.logger.info(`✅ AI provider (${providerId}) returned ${rawSuggestions.length} suggestions`, {
        providerId,
        suggestionCount: rawSuggestions.length,
        firstFew: rawSuggestions.slice(0, 5).map(s => `${s.sourceField} → ${s.targetField} (${Math.round(s.confidence * 100)}%)`)
      });

      const usage = (provider as any)?.getUsageMetrics?.();
      const providerUsage: ProviderUsageSnapshot | undefined = usage
        ? {
            providerId,
            tokens: usage?.tokens,
            cost: usage?.cost
          }
        : undefined;

      const mappedSuggestions = await Promise.all(
        rawSuggestions.map(async suggestion => {
          // BUG FIX: LLM sometimes returns field names with sample values like 'address1: "1009 S 200 W"'
          // Extract just the field name (everything before the first colon)
          const cleanSourceField = this.extractFieldName(suggestion.sourceField);
          const cleanTargetField = this.extractFieldName(suggestion.targetField);

          const alternatives: FieldMappingAlternative[] = (suggestion.alternatives || []).map(alt => ({
            targetField: this.extractFieldName(alt.targetField),
            confidence: this.adjustConfidenceForProvider(alt.confidence ?? 0.5, providerId),
            transformationType: alt.transformationType || 'direct',
            explanation: alt.reasoning || 'Alternative suggested by provider'
          }));

          // PERFORMANCE FIX: Skip semantic similarity calculation for LLM suggestions
          // Claude/GPT-4 already provides intelligent mapping - no need for additional semantic analysis
          // This prevents timeouts and speeds up response time from 30s to < 3s
          const semanticSimilarity = 0.85; // Trust LLM's judgment

          return {
            sourceField: cleanSourceField,
            targetField: cleanTargetField,
            confidence: this.adjustConfidenceForProvider(suggestion.confidence ?? 0.7, providerId),
            reasoning: [
              suggestion.reasoning || 'LLM provider semantic mapping recommendation',
              `Provider: ${providerId}`
            ],
            transformation: this.parseTransformation(suggestion.transformationType || 'direct'),
            alternatives,
            qualityMetrics: {
              semanticSimilarity,
              dataTypeCompatibility: 0.8,
              businessLogicAlignment: 0.75,
              historicalSuccess: 0.65,
              riskAssessment: 'low'
            },
            origin: 'llm',
            providerId,
            // Multi-field mapping support: pass through sourceFields from AI
            ...(suggestion.sourceFields && suggestion.sourceFields.length > 1 ? {
              sourceFields: suggestion.sourceFields,
              isMultiField: true
            } : {})
          } satisfies MappingSuggestion;
        })
      );

      return { suggestions: mappedSuggestions, providerUsage };
    } catch (error) {
      this.logger.error('LLM provider mapping suggestion generation failed', {
        error: String(error),
        preferredProviderId: context.preferredProviderId
      });
      return emptyResult;
    }
  }

  private adjustConfidenceForProvider(confidence: number, providerId?: string): number {
    if (!providerId) {
      return confidence;
    }

    const baseline = this.providerConfidenceBaselines[providerId] ?? 0.88;
    const adjusted = confidence * baseline;

    // Soft floor to prevent overly pessimistic scores for reliable providers
    if (baseline >= 0.95) {
      return Math.min(1, Math.max(adjusted, confidence * 0.9));
    }

    return Math.min(1, adjusted);
  }

  private findExactMatches(sourceFields: FieldDefinition[], targetFields: FieldDefinition[]): MappingSuggestion[] {
    const matches: MappingSuggestion[] = [];

    sourceFields.forEach(sourceField => {
      const exactMatch = targetFields.find(targetField =>
        sourceField.name.toLowerCase() === targetField.name.toLowerCase()
      );

      if (exactMatch) {
        matches.push({
          sourceField: sourceField.name,
          targetField: exactMatch.name,
          confidence: 0.95,
          reasoning: ['Exact field name match'],
          transformation: { type: 'direct' },
          alternatives: [],
          qualityMetrics: {
            semanticSimilarity: 1.0,
            dataTypeCompatibility: this.calculateTypeCompatibility(sourceField.type, exactMatch.type),
            businessLogicAlignment: 0.8,
            historicalSuccess: 0.9,
            riskAssessment: 'low'
          },
          origin: 'heuristic'
        });
      }
    });

    return matches;
  }

  private async findSemanticMatches(context: MappingContext): Promise<MappingSuggestion[]> {
    const matches: MappingSuggestion[] = [];
    // LOWERED threshold from 0.65 to 0.55 to catch messy field names
    const similarityThreshold = 0.55;

    for (const sourceField of context.sourceSchema.fields) {
      for (const targetField of context.targetSchema.fields) {
        // USE FAST HEURISTIC DIRECTLY instead of slow semantic engine
        // This handles messy data with fuzzy matching, abbreviations, typos
        const similarity = this.calculateSemanticSimilarityHeuristic(
          sourceField.name,
          targetField.name
        );

        if (similarity >= similarityThreshold) {
          matches.push({
            sourceField: sourceField.name,
            targetField: targetField.name,
            confidence: Math.max(0.6, Math.min(0.9, similarity + 0.15)),
            reasoning: [
              `Fuzzy name match: ${(similarity * 100).toFixed(0)}% similarity`,
              'Handles typos, abbreviations, and number substitutions'
            ],
            transformation: { type: 'direct' },
            alternatives: [],
            qualityMetrics: {
              semanticSimilarity: similarity,
              dataTypeCompatibility: this.calculateTypeCompatibility(sourceField.type, targetField.type),
              businessLogicAlignment: 0.6,
              historicalSuccess: 0.55,
              riskAssessment: similarity > 0.75 ? 'low' : 'medium'
            },
            origin: 'heuristic'
          });
        }
      }
    }

    return matches;
  }

  private findPatternMatches(sourceFields: FieldDefinition[], targetFields: FieldDefinition[]): MappingSuggestion[] {
    const matches: MappingSuggestion[] = [];

    sourceFields.forEach(sourceField => {
      this.mappingPatterns.forEach(pattern => {
        const sourceRegex = new RegExp(pattern.sourcePattern, 'i');
        const targetRegex = new RegExp(pattern.targetPattern, 'i');

        if (sourceRegex.test(sourceField.name)) {
          const matchingTargets = targetFields.filter(tf => targetRegex.test(tf.name));

          matchingTargets.forEach(targetField => {
            matches.push({
              sourceField: sourceField.name,
              targetField: targetField.name,
              confidence: pattern.confidence * 0.8,
              reasoning: [`Pattern match: ${pattern.description}`, `Usage count: ${pattern.usageCount}`],
              transformation: { type: 'direct' },
              alternatives: [],
              qualityMetrics: {
                semanticSimilarity: pattern.confidence,
                dataTypeCompatibility: this.calculateTypeCompatibility(sourceField.type, targetField.type),
                businessLogicAlignment: 0.7,
                historicalSuccess: pattern.usageCount / 500,
                riskAssessment: pattern.confidence > 0.8 ? 'low' : 'medium'
              },
              origin: 'heuristic'
            });
          });
        }
      });
    });

    return matches;
  }

  private findTypeMatches(sourceFields: FieldDefinition[], targetFields: FieldDefinition[]): MappingSuggestion[] {
    const matches: MappingSuggestion[] = [];

    sourceFields.forEach(sourceField => {
      const compatibleTargets = targetFields.filter(targetField =>
        this.calculateTypeCompatibility(sourceField.type, targetField.type) > 0.7
      );

      compatibleTargets.forEach(targetField => {
        const compatibility = this.calculateTypeCompatibility(sourceField.type, targetField.type);

        matches.push({
          sourceField: sourceField.name,
          targetField: targetField.name,
          confidence: compatibility * 0.6,
          reasoning: [`Compatible data types: ${sourceField.type} -> ${targetField.type}`],
          transformation: this.suggestTransformation(sourceField.type, targetField.type),
          alternatives: [],
          qualityMetrics: {
            semanticSimilarity: 0.5,
            dataTypeCompatibility: compatibility,
            businessLogicAlignment: 0.5,
            historicalSuccess: 0.5,
            riskAssessment: compatibility > 0.9 ? 'low' : 'medium'
          },
          origin: 'heuristic'
        });
      });
    });

    return matches;
  }

  private applyBusinessRules(context: MappingContext): MappingSuggestion[] {
    const matches: MappingSuggestion[] = [];

    context.businessRules.forEach(rule => {
      if (!rule.active) return;

      rule.sourceFields.forEach(sourceField => {
        rule.targetFields.forEach(targetField => {
          matches.push({
            sourceField,
            targetField,
            confidence: 0.9,
            reasoning: [`Business rule: ${rule.name}`, rule.description],
            transformation: rule.transformation,
            alternatives: [],
            qualityMetrics: {
              semanticSimilarity: 0.8,
              dataTypeCompatibility: 0.8,
              businessLogicAlignment: 1.0,
              historicalSuccess: 0.8,
              riskAssessment: 'low'
            },
            origin: 'heuristic'
          });
        });
      });
    });

    return matches;
  }

  /**
   * Detect multi-field mapping patterns (e.g., firstName + lastName → fullName)
   * This mirrors the frontend pattern detection for backend consistency
   */
  private findMultiFieldMappings(sourceFields: FieldDefinition[], targetFields: FieldDefinition[]): MappingSuggestion[] {
    const matches: MappingSuggestion[] = [];

    // Pattern 1: Name Concatenation (firstName + lastName → fullName)
    const firstNameField = sourceFields.find(f =>
      /^first.*name$|^fname$|^first_name$/i.test(f.name)
    );
    const lastNameField = sourceFields.find(f =>
      /^last.*name$|^lname$|^surname$|^last_name$/i.test(f.name)
    );
    const fullNameField = targetFields.find(f =>
      /^full.*name$|^name$|^display.*name$|^complete.*name$|^full_name$|^fullname$/i.test(f.name) &&
      !/first|last/i.test(f.name)
    );

    if (firstNameField && lastNameField && fullNameField) {
      matches.push({
        sourceField: `${firstNameField.name} + ${lastNameField.name}`,
        targetField: fullNameField.name,
        confidence: 0.95,
        reasoning: [
          `Multi-field pattern: Combine ${firstNameField.name} + ${lastNameField.name} → ${fullNameField.name}`,
          'High confidence name concatenation pattern'
        ],
        transformation: {
          type: 'concatenation',
          expression: `{${firstNameField.name}} {${lastNameField.name}}`
        },
        alternatives: [],
        qualityMetrics: {
          semanticSimilarity: 0.95,
          dataTypeCompatibility: 1.0,
          businessLogicAlignment: 0.9,
          historicalSuccess: 0.85,
          riskAssessment: 'low'
        },
        origin: 'heuristic',
        sourceFields: [firstNameField.name, lastNameField.name],
        isMultiField: true
      });
    }

    // Pattern 2: Address Concatenation (street + city + state + zip → fullAddress)
    const streetField = sourceFields.find(f =>
      /street|address.*1|addr.*1|address_line.*1/i.test(f.name) &&
      !/2|two|second/i.test(f.name)
    );
    const cityField = sourceFields.find(f => /^city$|.*_city$/i.test(f.name));
    const stateField = sourceFields.find(f => /^state$|^province$|.*_state$/i.test(f.name));
    const zipField = sourceFields.find(f => /zip|postal.*code|postcode/i.test(f.name));
    const fullAddressField = targetFields.find(f =>
      /full.*address|^address$|complete.*address/i.test(f.name) &&
      !/1|2|one|two|line|street/i.test(f.name)
    );

    // Allow flexible address concatenation - partial addresses are common in real-world data
    if (fullAddressField && streetField) {
      const addressComponents: string[] = [streetField.name];
      const expressionParts: string[] = [`{${streetField.name}}`];

      // Add optional components
      if (cityField) {
        addressComponents.push(cityField.name);
        expressionParts.push(`, {${cityField.name}}`);
      }
      if (stateField) {
        addressComponents.push(stateField.name);
        expressionParts.push(`, {${stateField.name}}`);
      }
      if (zipField) {
        addressComponents.push(zipField.name);
        expressionParts.push(` {${zipField.name}}`);
      }

      // Confidence based on completeness: 4 fields = 90%, 3 fields = 85%, 2 fields = 75%, 1 field = 65%
      const componentCount = addressComponents.length;
      const confidence = componentCount === 4 ? 0.90 : componentCount === 3 ? 0.85 : componentCount === 2 ? 0.75 : 0.65;

      matches.push({
        sourceField: addressComponents.join(' + '),
        targetField: fullAddressField.name,
        confidence,
        reasoning: [
          `Multi-field pattern: Combine ${componentCount} address field(s) → ${fullAddressField.name}`,
          componentCount === 4 ? 'Complete address (street, city, state, zip)' :
          componentCount === 3 ? 'Partial address (3 components)' :
          componentCount === 2 ? 'Partial address (2 components)' :
          'Minimal address (street only)'
        ],
        transformation: {
          type: 'concatenation',
          expression: expressionParts.join('')
        },
        alternatives: [],
        qualityMetrics: {
          semanticSimilarity: confidence,
          dataTypeCompatibility: 1.0,
          businessLogicAlignment: 0.85,
          historicalSuccess: 0.80,
          riskAssessment: componentCount >= 3 ? 'low' : 'medium'
        },
        origin: 'heuristic',
        sourceFields: addressComponents,
        isMultiField: true
      });
    }

    // Pattern 3: Date + Time → DateTime
    const dateField = sourceFields.find(f =>
      /^date$|.*_date$|order.*date|transaction.*date/i.test(f.name) &&
      !/time|datetime/i.test(f.name)
    );
    const timeField = sourceFields.find(f =>
      /^time$|.*_time$|hour|minute/i.test(f.name) &&
      !/date|datetime/i.test(f.name)
    );
    const dateTimeField = targetFields.find(f =>
      /datetime|timestamp|created.*at|updated.*at|modified.*at/i.test(f.name)
    );

    if (dateField && timeField && dateTimeField) {
      matches.push({
        sourceField: `${dateField.name} + ${timeField.name}`,
        targetField: dateTimeField.name,
        confidence: 0.88,
        reasoning: [
          `Multi-field pattern: Combine ${dateField.name} + ${timeField.name} → ${dateTimeField.name}`,
          'Date and time combination pattern'
        ],
        transformation: {
          type: 'calculation',
          expression: `combine_datetime({${dateField.name}}, {${timeField.name}})`
        },
        alternatives: [],
        qualityMetrics: {
          semanticSimilarity: 0.88,
          dataTypeCompatibility: 0.95,
          businessLogicAlignment: 0.80,
          historicalSuccess: 0.75,
          riskAssessment: 'medium'
        },
        origin: 'heuristic',
        sourceFields: [dateField.name, timeField.name],
        isMultiField: true
      });
    }

    // Pattern 4: Quantity × Price → Total
    const quantityField = sourceFields.find(f => /quantity|qty|amount|count/i.test(f.name));
    const priceField = sourceFields.find(f => /price|unit.*price|rate/i.test(f.name));
    const totalField = targetFields.find(f => /total|line.*total|extended.*price/i.test(f.name));

    if (quantityField && priceField && totalField) {
      matches.push({
        sourceField: `${quantityField.name} × ${priceField.name}`,
        targetField: totalField.name,
        confidence: 0.85,
        reasoning: [
          `Multi-field pattern: Calculate ${quantityField.name} × ${priceField.name} → ${totalField.name}`,
          'Quantity times price calculation pattern'
        ],
        transformation: {
          type: 'calculation',
          expression: `{${quantityField.name}} * {${priceField.name}}`
        },
        alternatives: [],
        qualityMetrics: {
          semanticSimilarity: 0.85,
          dataTypeCompatibility: 0.90,
          businessLogicAlignment: 0.95,
          historicalSuccess: 0.80,
          riskAssessment: 'low'
        },
        origin: 'heuristic',
        sourceFields: [quantityField.name, priceField.name],
        isMultiField: true
      });
    }

    return matches;
  }

  private mergeSuggestions(suggestions: MappingSuggestion[]): MappingSuggestion[] {
    const merged = new Map<string, MappingSuggestion>();

    suggestions.forEach(suggestion => {
      // Filter out invalid single-field to full-field mappings
      if (this.isInvalidSingleToFullFieldMapping(suggestion)) {
        this.logger.debug(`🚫 Blocked invalid mapping: ${suggestion.sourceField} → ${suggestion.targetField}`, {
          reason: 'Invalid single-to-full or name-to-id mapping'
        });
        return; // Skip this suggestion
      }

      const key = `${suggestion.sourceField}->${suggestion.targetField}`;
      const existing = merged.get(key);

      if (!existing || this.shouldReplaceSuggestion(existing, suggestion)) {
        if (existing) {
          suggestion.reasoning = [...new Set([...existing.reasoning, ...suggestion.reasoning])];
          suggestion.alternatives = suggestion.alternatives.length > 0 ? suggestion.alternatives : existing.alternatives;
          suggestion.qualityMetrics = suggestion.qualityMetrics || existing.qualityMetrics;
          suggestion.providerId = suggestion.providerId || existing.providerId;
          suggestion.origin = suggestion.origin || existing.origin;
        }
        merged.set(key, suggestion);
      }
    });

    return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Prevents invalid single-field to full-field mappings
   * Examples: firstName → fullName, street → fullAddress (both WRONG)
   * Multi-field patterns (firstName + lastName → fullName) are still allowed
   */
  private isInvalidSingleToFullFieldMapping(suggestion: MappingSuggestion): boolean {
    // Skip multi-field patterns (they're explicitly allowed)
    if (suggestion.isMultiField || suggestion.sourceField.includes('+')) {
      return false;
    }

    const source = suggestion.sourceField.toLowerCase();
    const target = suggestion.targetField.toLowerCase();

    // RULE 1: Prevent firstName/lastName → fullName single-field mappings
    const isPartialNameField = /^(first|last|given|middle|sur).*name/i.test(source);
    const isFullNameField = /^(full|complete|display).*name|^name$/i.test(target) && !/first|last/i.test(target);
    if (isPartialNameField && isFullNameField) {
      return true; // INVALID: Can't map firstName alone to fullName
    }

    // RULE 2: Prevent street/city/state/zip → fullAddress single-field mappings
    // BUT allow direct address mappings like billing_address → billingAddress
    const isPartialAddressComponent = /^(street|city|state|zip|postal)(_|$)/i.test(source) &&
                                       !/billing|shipping|mailing|business|home/i.test(source);
    const isFullAddressField = /^(full|complete).*address|^address$/i.test(target) && !/street|line|1|2/i.test(target);

    // Allow direct matches like billing_address → billingAddress (both contain billing/shipping prefix)
    const sourceHasAddressPrefix = /(billing|shipping|mailing|business|home).*address/i.test(source);
    const targetHasAddressPrefix = /(billing|shipping|mailing|business|home).*address/i.test(target);
    const isDirectAddressMatch = sourceHasAddressPrefix && targetHasAddressPrefix;

    if (isPartialAddressComponent && isFullAddressField && !isDirectAddressMatch) {
      return true; // INVALID: Can't map street alone to fullAddress
    }

    // RULE 3: Prevent name fields → ID fields (firstName → entityId, lastName → customerId, etc.)
    const isNameField = /(first|last|full|given|middle|sur|contact|customer|account|company).*name/i.test(source);
    const isIdField = /(entity|customer|account|contact|internal|external|record).*id|^id$/i.test(target);
    if (isNameField && isIdField) {
      return true; // INVALID: Names cannot populate ID fields (firstName → entityId is WRONG)
    }

    // RULE 4: Prevent descriptive fields → ID fields (description → id, notes → entityId, etc.)
    const isDescriptiveField = /(desc|description|note|notes|comment|remarks|memo)/i.test(source);
    if (isDescriptiveField && isIdField) {
      return true; // INVALID: Descriptions cannot populate ID fields
    }

    return false; // Valid mapping
  }

  private shouldReplaceSuggestion(existing: MappingSuggestion, candidate: MappingSuggestion): boolean {
    if (existing.origin === 'llm' && candidate.origin !== 'llm') {
      return false;
    }

    if (existing.origin !== 'llm' && candidate.origin === 'llm') {
      return true;
    }

    return candidate.confidence > existing.confidence;
  }

  private calculateTypeCompatibility(sourceType: string, targetType: string): number {
    const source = sourceType.toLowerCase();
    const target = targetType.toLowerCase();

    if (source === target) return 1.0;

    const numericTypes = ['number', 'integer', 'decimal', 'float', 'currency'];
    const textTypes = ['string', 'text', 'varchar', 'char'];
    const dateTypes = ['date', 'datetime', 'timestamp'];
    const booleanTypes = ['boolean', 'bool', 'bit'];

    const typeGroups = [numericTypes, textTypes, dateTypes, booleanTypes];

    for (const group of typeGroups) {
      if (group.includes(source) && group.includes(target)) {
        return 0.8;
      }
    }

    if ((source === 'string' && target === 'email') || (source === 'email' && target === 'string')) {
      return 0.9;
    }

    if ((source === 'string' && target === 'phone') || (source === 'phone' && target === 'string')) {
      return 0.9;
    }

    return 0.2;
  }

  private async calculateSemanticSimilarity(
    sourceField: string,
    targetField: string,
    sourceDefinition?: FieldDefinition,
    targetDefinition?: FieldDefinition,
    preferredProviderId?: string
  ): Promise<number> {
    const cacheKey = `${sourceField}->${targetField}`;
    const cached = this.similarityCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Prefer SemanticAnalysisEngine for similarity (it has its own fallbacks)
    try {
      const result = await this.semanticEngine.calculateSemanticSimilarity(
        {
          text1: sourceDefinition?.name || sourceField,
          text2: targetDefinition?.name || targetField,
          // Keep lightweight; engine will choose best path and fallback if needed
          useEmbeddings: false
        } as any,
        {
          // Pass preferred provider to semantic engine
          provider: preferredProviderId
        }
      );

      const score = Math.max(0, Math.min(1, (result as any)?.score ?? 0));
      this.similarityCache.set(cacheKey, score);
      return score;
    } catch (err) {
      // Engine unavailable or failed — use local heuristic as a safety net
      this.logger.warn('Semantic engine similarity failed, using heuristic', {
        error: String(err),
        sourceField,
        targetField
      });

      const heuristicSimilarity = this.calculateSemanticSimilarityHeuristic(sourceField, targetField);
      this.similarityCache.set(cacheKey, heuristicSimilarity);
      return heuristicSimilarity;
    }
  }

  /**
   * Normalize field name to handle various naming conventions
   * Converts camelCase, PascalCase, snake_case, kebab-case to lowercase words
   * Enhanced with better camelCase splitting and name synonyms
   */
  private static normalizeFieldName(fieldName: string): string {
    // Common abbreviation expansions (enhanced with name synonyms)
    const abbreviations: Record<string, string> = {
      // Company variants
      'cmpny': 'company',
      'compny': 'company',
      'comp': 'company',

      // Address variants
      'addr': 'address',
      'st': 'street',
      'str': 'street',
      'cty': 'city',      // NEW: ship_cty → ship_city
      'cntry': 'country', // NEW: bill_cntry → bill_country
      'zip': 'zipcode',
      'bill': 'billing',  // NEW: bill_addr → billing_address
      'ship': 'shipping', // NEW: ship_street → shipping_street

      // Counting/numbers
      'cnt': 'count',
      'num': 'number',
      'no': 'number',
      'qty': 'quantity',
      'amt': 'amount',
      'rev': 'revenue',   // NEW: rev$ → revenue

      // Contact info
      'ph': 'phone',
      'phn': 'phone',
      'tel': 'phone',
      'fax': 'fax',
      'mobile': 'mobile', // NEW: mobile_ph → mobile_phone
      'emaail': 'email',  // NEW: Common typo

      // Common business
      'dept': 'department',
      'cust': 'customer',
      'acct': 'account',
      'prod': 'product',
      'desc': 'description',
      'ref': 'reference',
      'ext': 'external',
      'actve': 'active',  // NEW: ACTVE? → active
      'web': 'website',   // NEW: web.site → website
      'sys': 'system',    // NEW: source_system, legacy_sys_id
      'crm': 'crm',       // NEW: old_crm_score
      'emp': 'employee',  // NEW: emp_cnt → employee_count (fallback)
      'employee': 'employee', // NEW: EMPLOYEE_CNT → employee_count

      // Name field synonyms (Codex enhancement)
      'fname': 'firstname',
      'lname': 'lastname',
      'given': 'firstname',
      'surname': 'lastname',
      'family': 'lastname',
      'fullname': 'fullname', // Keep as single token to avoid "name" stopword pollution
      'companyname': 'company', // Map to company (single token) - fixes false match with first_name
      'accountname': 'account', // Map to account (single token)
      'businessname': 'business', // Map to business (single token)
      'orgname': 'organization' // Map to organization (single token)
    };

    let normalized = fieldName
      // Handle leet-speak / number substitutions (common in messy data)
      .replace(/([0-9])/g, (match) => {
        const numMap: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };
        return numMap[match] || match;
      })
      // Remove special characters (keep letters, numbers, spaces, underscores, hyphens)
      .replace(/[^a-zA-Z0-9\s_-]/g, ' ')
      // IMPROVED: Better camelCase/PascalCase splitting (/([a-z])([A-Z])/g)
      // Handles: firstName → first Name, companyName → company Name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Replace underscores and hyphens with spaces
      .replace(/[_-]/g, ' ')
      .toLowerCase()
      .trim()
      // Normalize multiple spaces to single space
      .replace(/\s+/g, ' ');

    // Expand common abbreviations
    const words = normalized.split(' ');
    const expandedWords = words.map(word => abbreviations[word] || word);
    normalized = expandedWords.join(' ');

    return normalized;
  }

  /**
   * Check if two field names are synonyms based on the FIELD_SYNONYMS dictionary
   * Returns true if they normalize to the same base concept
   */
  private static hasSynonymMatch(sourceField: string, targetField: string): boolean {
    const normalizedSource = MappingSuggestionService.normalizeFieldName(sourceField);
    const normalizedTarget = MappingSuggestionService.normalizeFieldName(targetField);

    // Direct match after normalization
    if (normalizedSource === normalizedTarget) {
      return true;
    }

    // Check if both fields belong to the same synonym group
    for (const [canonical, synonyms] of Object.entries(MappingSuggestionService.FIELD_SYNONYMS)) {
      const normalizedCanonical = MappingSuggestionService.normalizeFieldName(canonical);
      const allForms = [normalizedCanonical, ...synonyms.map(s => MappingSuggestionService.normalizeFieldName(s))];

      const sourceMatches = allForms.some(form => normalizedSource.includes(form) || form.includes(normalizedSource));
      const targetMatches = allForms.some(form => normalizedTarget.includes(form) || form.includes(normalizedTarget));

      if (sourceMatches && targetMatches) {
        return true;
      }
    }

    return false;
  }

  private calculateSemanticSimilarityHeuristic(sourceField: string, targetField: string): number {
    // SPECIAL CASE: Handle nested address fields (billing_address.city, shipping_address.zip, etc.)
    // These should match to the corresponding prefixed target fields (billcity, shipzip, etc.)
    const addressMatch = sourceField.match(/(billing|shipping|mailing|business|home)_?address\.(address1?|addr1?|street|city|state|province|zip|postal|country|phone)/i);
    if (addressMatch) {
      const addressType = addressMatch[1].toLowerCase(); // "billing", "shipping", etc.
      const component = addressMatch[2].toLowerCase(); // "city", "zip", etc.

      // Map address prefix: billing → bill, shipping → ship, etc.
      const prefixMap: Record<string, string> = {
        'billing': 'bill',
        'shipping': 'ship',
        'mailing': 'mail',
        'business': 'business',
        'home': 'home'
      };

      // Map component to field suffix
      const componentMap: Record<string, string> = {
        'address1': 'addr1',
        'address': 'addr1',
        'addr1': 'addr1',
        'addr': 'addr1',
        'street': 'addr1',
        'city': 'city',
        'state': 'state',
        'province': 'state',
        'zip': 'zip',
        'postal': 'zip',
        'country': 'country',
        'phone': 'phone'
      };

      const prefix = prefixMap[addressType] || addressType;
      const suffix = componentMap[component] || component;
      const expectedTarget = `${prefix}${suffix}`.toLowerCase();

      // Check if target field matches the expected pattern
      const targetNormalized = targetField.toLowerCase().replace(/[_-]/g, '');
      if (targetNormalized === expectedTarget) {
        return 1.0; // Perfect match for nested address field
      } else if (targetNormalized.includes(prefix) && targetNormalized.includes(suffix)) {
        return 0.9; // Close match (both prefix and suffix present)
      } else if (targetNormalized.includes(suffix)) {
        return 0.3; // Component matches but wrong address type (e.g., billing.city → shipcity)
      } else {
        return 0.1; // No match - prevent bad suggestions
      }
    }

    // Use enhanced normalization for non-address fields
    const source = MappingSuggestionService.normalizeFieldName(sourceField);
    const target = MappingSuggestionService.normalizeFieldName(targetField);

    const sourceWords = source.split(' ');
    const targetWords = target.split(' ');

    let totalSimilarity = 0;
    let maxPossibleMatches = 0;

    // For each source word, find best matching target word
    sourceWords.forEach(sourceWord => {
      if (sourceWord.length < 2) return; // Skip single characters

      let bestMatch = 0;
      targetWords.forEach(targetWord => {
        if (targetWord.length < 2) return;

        // Exact match
        if (sourceWord === targetWord) {
          bestMatch = Math.max(bestMatch, 1.0);
        }
        // Substring match
        else if (sourceWord.includes(targetWord) || targetWord.includes(sourceWord)) {
          bestMatch = Math.max(bestMatch, 0.8);
        }
        // Fuzzy match for typos (Levenshtein distance)
        else {
          const similarity = this.calculateStringSimilarity(sourceWord, targetWord);
          // Only count as match if similarity > 75% (handles typos like "emaail" vs "email")
          if (similarity > 0.75) {
            bestMatch = Math.max(bestMatch, similarity * 0.9); // Slightly lower weight than exact match
          }
        }
      });

      totalSimilarity += bestMatch;
      maxPossibleMatches++;
    });

    return maxPossibleMatches > 0 ? totalSimilarity / maxPossibleMatches : 0;
  }

  /**
   * Calculate string similarity using Levenshtein distance
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    return maxLength === 0 ? 1.0 : 1.0 - (distance / maxLength);
  }

  /**
   * Levenshtein distance algorithm for fuzzy matching
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  private parseTransformation(transformationType: string): TransformationRule {
    switch (transformationType) {
      case 'direct':
        return { type: 'direct' };
      case 'lookup':
        return { type: 'lookup', lookupTable: {} };
      case 'calculation':
        return { type: 'calculation', expression: '' };
      case 'concatenation':
        return { type: 'concatenation', expression: '' };
      case 'conditional':
        return { type: 'conditional', conditions: [] };
      default:
        return { type: 'direct' };
    }
  }

  /**
   * Extract just the field name from LLM responses that may include sample values
   * Example: 'address1: "1009 S 200 W"' -> 'address1'
   * Example: 'address1' -> 'address1' (no change if already clean)
   */
  private extractFieldName(fieldString: string): string {
    if (!fieldString) return fieldString;

    // Check if field includes a colon (indicating value concatenation)
    const colonIndex = fieldString.indexOf(':');
    if (colonIndex > 0) {
      // Extract everything before the first colon and trim whitespace
      return fieldString.substring(0, colonIndex).trim();
    }

    // Field is already clean
    return fieldString.trim();
  }

  private suggestTransformation(sourceType: string, targetType: string): TransformationRule {
    if (sourceType === targetType) {
      return { type: 'direct' };
    }

    if (sourceType === 'string' && targetType === 'date') {
      return {
        type: 'calculation',
        expression: 'parseDate(sourceValue, "YYYY-MM-DD")'
      };
    }

    if (sourceType === 'string' && ['number', 'currency'].includes(targetType)) {
      return {
        type: 'calculation',
        expression: 'parseFloat(sourceValue)'
      };
    }

    return { type: 'direct' };
  }
}
