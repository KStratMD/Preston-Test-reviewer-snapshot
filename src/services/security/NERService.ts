/**
 * Named Entity Recognition (NER) Service
 * Pattern-based entity detection for personal names, locations, and organizations
 *
 * Detects:
 * - Person names (using common name patterns and title prefixes)
 * - Geographic locations (cities, states, countries, addresses)
 * - Organizations (companies, institutions)
 *
 * Note: This is a pattern-based implementation. For production,
 * consider integrating ML-based NER models like spaCy, Stanford NER, or Azure Cognitive Services
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';

export interface EntityDetectionResult {
  detected: boolean;
  entities: DetectedEntity[];
  entityTypes: string[];
  confidence: number;
}

export interface DetectedEntity {
  type: 'PERSON' | 'LOCATION' | 'ORGANIZATION' | 'ADDRESS';
  value: string;
  confidence: number;
  context?: string;
  field?: string;
}

@injectable()
export class NERService {
  // Common name prefixes/titles
  private readonly titlePrefixes = new Set([
    'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Rev', 'Hon', 'Sir', 'Dame',
    'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Rev.', 'Hon.'
  ]);

  // Common first names (subset for pattern matching)
  private readonly commonFirstNames = new Set([
    'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda',
    'William', 'Barbara', 'David', 'Elizabeth', 'Richard', 'Susan', 'Joseph', 'Jessica',
    'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Nancy', 'Daniel', 'Lisa'
  ]);

  // US State abbreviations
  private readonly usStates = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
  ]);

  // Common organization suffixes
  private readonly orgSuffixes = new Set([
    'Inc', 'Inc.', 'LLC', 'Corp', 'Corp.', 'Co', 'Co.', 'Ltd', 'Ltd.',
    'LLP', 'LP', 'Corporation', 'Company', 'Incorporated', 'Limited',
    'Partners', 'Group', 'Holdings', 'Solutions', 'Technologies', 'Services'
  ]);

  // Patterns for entity detection
  private readonly patterns = {
    // Person name with title: "Dr. John Smith"
    personWithTitle: /\b(Mr|Mrs|Ms|Dr|Prof|Rev|Hon|Sir|Dame)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,

    // Street address: "123 Main St"
    streetAddress: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Place|Pl)\b/gi,

    // City, State ZIP: "New York, NY 10001"
    cityStateZip: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/g,

    // Organization with suffix: "Acme Corp."
    organizationWithSuffix: /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+(Inc\.?|LLC|Corp\.?|Co\.?|Ltd\.?|LLP|LP)\b/g,

    // Capitalized multi-word phrases (potential organizations/locations)
    capitalizedPhrase: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g
  };

  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.logger.info('NER Service initialized', {
      capabilities: ['Person detection', 'Location detection', 'Organization detection'],
      approach: 'Pattern-based (consider ML models for production)'
    });
  }

  /**
   * Detect named entities in data
   */
  async detectEntities(data: unknown): Promise<EntityDetectionResult> {
    const entities: DetectedEntity[] = [];
    const entityTypes = new Set<string>();

    try {
      this.scanForEntities(data, '', entities, entityTypes);

      // Calculate overall confidence based on detection methods
      const confidence = this.calculateConfidence(entities);

      const result: EntityDetectionResult = {
        detected: entities.length > 0,
        entities,
        entityTypes: Array.from(entityTypes),
        confidence
      };

      this.logger.info('Entity detection completed', {
        entitiesFound: entities.length,
        entityTypes: Array.from(entityTypes),
        confidence
      });

      return result;

    } catch (error) {
      this.logger.error('Entity detection failed', { error: String(error) });
      return {
        detected: false,
        entities: [],
        entityTypes: [],
        confidence: 0
      };
    }
  }

  /**
   * Recursively scan data structure for entities
   */
  private scanForEntities(
    obj: unknown,
    path: string,
    entities: DetectedEntity[],
    entityTypes: Set<string>
  ): void {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === 'string') {
      this.detectInString(obj, path, entities, entityTypes);
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.scanForEntities(item, `${path}[${index}]`, entities, entityTypes);
      });
    } else if (typeof obj === 'object') {
      Object.entries(obj).forEach(([key, value]) => {
        const newPath = path ? `${path}.${key}` : key;
        this.scanForEntities(value, newPath, entities, entityTypes);
      });
    }
  }

  /**
   * Detect entities in a string
   */
  private detectInString(
    str: string,
    field: string,
    entities: DetectedEntity[],
    entityTypes: Set<string>
  ): void {
    // Detect persons with titles
    const personMatches = str.matchAll(this.patterns.personWithTitle);
    for (const match of personMatches) {
      entities.push({
        type: 'PERSON',
        value: match[0],
        confidence: 0.9,
        context: `Detected person with title: ${match[1]}`,
        field
      });
      entityTypes.add('PERSON');
    }

    // Detect street addresses
    const addressMatches = str.matchAll(this.patterns.streetAddress);
    for (const match of addressMatches) {
      entities.push({
        type: 'ADDRESS',
        value: match[0],
        confidence: 0.85,
        context: 'Detected street address pattern',
        field
      });
      entityTypes.add('ADDRESS');
    }

    // Detect city, state, ZIP
    const cityStateMatches = str.matchAll(this.patterns.cityStateZip);
    for (const match of cityStateMatches) {
      if (this.usStates.has(match[2])) {
        entities.push({
          type: 'LOCATION',
          value: match[0],
          confidence: 0.95,
          context: `City: ${match[1]}, State: ${match[2]}, ZIP: ${match[3]}`,
          field
        });
        entityTypes.add('LOCATION');
      }
    }

    // Detect organizations with suffixes
    const orgMatches = str.matchAll(this.patterns.organizationWithSuffix);
    for (const match of orgMatches) {
      if (this.orgSuffixes.has(match[2])) {
        entities.push({
          type: 'ORGANIZATION',
          value: match[0],
          confidence: 0.85,
          context: `Organization with suffix: ${match[2]}`,
          field
        });
        entityTypes.add('ORGANIZATION');
      }
    }

    // Detect capitalized phrases (lower confidence - could be many things)
    const phraseMatches = str.matchAll(this.patterns.capitalizedPhrase);
    for (const match of phraseMatches) {
      // Skip if already detected in other patterns
      const alreadyDetected = entities.some(e => e.value === match[0]);
      if (alreadyDetected) {
        continue;
      }

      // Check if first word is a common first name
      const firstWord = match[0].split(' ')[0];
      if (this.commonFirstNames.has(firstWord)) {
        entities.push({
          type: 'PERSON',
          value: match[0],
          confidence: 0.6,
          context: 'Detected potential person name (common first name)',
          field
        });
        entityTypes.add('PERSON');
      } else if (match[0].split(' ').length >= 2) {
        // Multi-word capitalized phrase - likely organization or location
        entities.push({
          type: 'ORGANIZATION',
          value: match[0],
          confidence: 0.5,
          context: 'Detected potential organization/location (capitalized phrase)',
          field
        });
        entityTypes.add('ORGANIZATION');
      }
    }
  }

  /**
   * Calculate overall confidence based on detection methods
   */
  private calculateConfidence(entities: DetectedEntity[]): number {
    if (entities.length === 0) {
      return 0;
    }

    const avgConfidence = entities.reduce((sum, entity) => sum + entity.confidence, 0) / entities.length;
    return Math.round(avgConfidence * 100) / 100;
  }

  /**
   * Detect potential personal identifiable information (combining with DLP)
   */
  async detectPII(data: unknown): Promise<{
    hasPII: boolean;
    piiCategories: string[];
    entities: DetectedEntity[];
    recommendation: string;
  }> {
    const result = await this.detectEntities(data);

    const piiCategories: string[] = [];
    const piiEntities: DetectedEntity[] = [];

    // Filter for high-confidence person/address detections
    result.entities.forEach(entity => {
      if (entity.type === 'PERSON' && entity.confidence >= 0.7) {
        piiCategories.push('person_name');
        piiEntities.push(entity);
      } else if (entity.type === 'ADDRESS' && entity.confidence >= 0.8) {
        piiCategories.push('physical_address');
        piiEntities.push(entity);
      }
    });

    const hasPII = piiEntities.length > 0;

    let recommendation = 'No high-confidence PII detected via NER';
    if (hasPII) {
      recommendation = `Detected ${piiEntities.length} high-confidence PII entities (names/addresses). Consider DLP redaction.`;
    }

    return {
      hasPII,
      piiCategories: Array.from(new Set(piiCategories)),
      entities: piiEntities,
      recommendation
    };
  }

  /**
   * Redact detected entities from text
   */
  redactEntities(text: string, entities: DetectedEntity[]): string {
    let redacted = text;

    entities.forEach(entity => {
      const redactionMap: Record<string, string> = {
        'PERSON': '[REDACTED NAME]',
        'LOCATION': '[REDACTED LOCATION]',
        'ORGANIZATION': '[REDACTED ORG]',
        'ADDRESS': '[REDACTED ADDRESS]'
      };

      redacted = redacted.replace(entity.value, redactionMap[entity.type] || '[REDACTED]');
    });

    return redacted;
  }
}
