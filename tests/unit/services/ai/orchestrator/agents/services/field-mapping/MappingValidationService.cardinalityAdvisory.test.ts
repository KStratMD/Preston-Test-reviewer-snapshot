/**
 * Task 10 ("Suggestion-time advisory warnings through shared evidence") —
 * unit tests for MappingValidationService.applyCardinalityAdvisories, run
 * against the SAME pure analyzer the activation gate uses (never a
 * duplicated/looser rule set).
 *
 * See docs/superpowers/plans/2026-07-26-cardinality-preflight.md Task 10 Step 1:
 *   - a one-to-many suggestion gets ONE bounded confidence penalty and a
 *     reasoning warning;
 *   - unavailable evidence warns WITHOUT a penalty;
 *   - an analyzer failure never throws out of validateMappings (never 500s
 *     the suggestion request);
 *   - the advisory context never authorizes anything and never drops a
 *     suggestion.
 */

import { MappingValidationService } from '../../../../../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingValidationService';
import type { MappingSuggestion } from '../../../../../../../../src/services/ai/orchestrator/agents/fieldMappingTypes';
import type { CardinalityAdvisoryContext, FieldMappingInput } from '../../../../../../../../src/services/ai/orchestrator/interfaces';
import type { RelationshipEvidence } from '../../../../../../../../src/types/cardinality';

function makeSuggestion(overrides: Partial<MappingSuggestion> = {}): MappingSuggestion {
  return {
    sourceField: 'Name',
    targetField: 'name',
    confidence: 0.9,
    reasoning: ['Exact name match'],
    transformation: { type: 'direct' },
    alternatives: [],
    qualityMetrics: {
      semanticSimilarity: 0.9,
      dataTypeCompatibility: 1,
      businessLogicAlignment: 0.9,
      historicalSuccess: 0.9,
      riskAssessment: 'low',
    },
    origin: 'llm',
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<RelationshipEvidence> = {}): RelationshipEvidence {
  return {
    system: 'salesforce',
    entity: 'Account',
    status: 'available',
    edges: [],
    provenance: { source: 'api' },
    ...overrides,
  };
}

function makeAdvisory(overrides: Partial<CardinalityAdvisoryContext> = {}): CardinalityAdvisoryContext {
  return {
    analyzerVersion: '1.0.0',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    sourceEvidence: makeEvidence(),
    targetEvidence: makeEvidence({ system: 'netsuite', entity: 'Customer' }),
    ...overrides,
  };
}

function makeInput(overrides: Partial<FieldMappingInput> = {}): FieldMappingInput {
  return {
    sourceFields: [{ name: 'Name', type: 'string' }],
    targetFields: [{ name: 'name', type: 'string' }],
    ...overrides,
  };
}

describe('MappingValidationService cardinality advisories (Task 10)', () => {
  let service: MappingValidationService;

  beforeEach(() => {
    service = new MappingValidationService();
  });

  it('applies exactly one bounded confidence penalty and a reasoning warning for a one-to-many relationship crossing', () => {
    const suggestion = makeSuggestion({ sourceField: 'Contacts.Name', targetField: 'name', confidence: 0.9 });
    const advisory = makeAdvisory({
      sourceEvidence: makeEvidence({
        edges: [
          {
            fromEntity: 'Account',
            fromField: 'contacts',
            toEntity: 'Contact',
            toField: 'AccountId',
            cardinality: 'one_to_many',
            direction: 'source_to_target',
            required: false,
          },
        ],
      }),
    });
    const input = makeInput({
      sourceFields: [{ name: 'Contacts.Name', type: 'string' }],
      cardinalityAdvisory: advisory,
    });

    const [validated] = service.validateMappings([suggestion], input, 0.5);

    // Bounded: 0.9 * 0.7 = 0.63, well above the 0.05 floor.
    expect(validated.confidence).toBeCloseTo(0.63, 5);
    expect(validated.cardinalityWarnings).toBeDefined();
    expect(validated.cardinalityWarnings!.length).toBeGreaterThan(0);
    expect(validated.cardinalityWarnings!.join(' ')).toMatch(/to-many relationship/i);
  });

  it('never applies the penalty twice for one suggestion even when it is referenced by multiple findings', () => {
    // Two mappings write the SAME target field (target_collision, penalizing)
    // AND the first mapping also crosses a to-many relationship
    // (relationship_flatten, penalizing) — index 0 is referenced by two
    // distinct penalizing findings.
    const suggestions = [
      makeSuggestion({ sourceField: 'Contacts.Name', targetField: 'name', confidence: 0.9 }),
      makeSuggestion({ sourceField: 'AltName', targetField: 'name', confidence: 0.9 }),
    ];
    const advisory = makeAdvisory({
      sourceEvidence: makeEvidence({
        edges: [
          {
            fromEntity: 'Account',
            fromField: 'contacts',
            toEntity: 'Contact',
            toField: 'AccountId',
            cardinality: 'one_to_many',
            direction: 'source_to_target',
            required: false,
          },
        ],
      }),
    });
    const input = makeInput({
      sourceFields: [
        { name: 'Contacts.Name', type: 'string' },
        { name: 'AltName', type: 'string' },
      ],
      cardinalityAdvisory: advisory,
    });

    const [first] = service.validateMappings(suggestions, input, 0.5);

    // If the 0.7 factor were applied twice, confidence would be ~0.441; the
    // single-application floor keeps it at 0.63.
    expect(first.confidence).toBeCloseTo(0.63, 5);
  });

  it('warns without any confidence penalty when relationship evidence is unavailable', () => {
    const suggestion = makeSuggestion({ sourceField: 'Name', targetField: 'name', confidence: 0.9 });
    const advisory = makeAdvisory({
      sourceEvidence: makeEvidence({ status: 'unavailable', unavailableReason: 'no discovery' }),
    });
    const input = makeInput({ cardinalityAdvisory: advisory });

    const [validated] = service.validateMappings([suggestion], input, 0.5);

    expect(validated.confidence).toBeCloseTo(0.9, 5);
    expect(validated.cardinalityWarnings).toBeDefined();
    expect(validated.cardinalityWarnings!.join(' ')).toMatch(/unavailable/i);
  });

  it('never filters out a suggestion — findings only annotate, never authorize or reject', () => {
    const suggestion = makeSuggestion({ sourceField: 'Contacts.Name', targetField: 'name', confidence: 0.9 });
    const advisory = makeAdvisory({
      sourceEvidence: makeEvidence({
        edges: [
          {
            fromEntity: 'Account',
            fromField: 'contacts',
            toEntity: 'Contact',
            toField: 'AccountId',
            cardinality: 'one_to_many',
            direction: 'source_to_target',
            required: false,
          },
        ],
      }),
    });
    const input = makeInput({
      sourceFields: [{ name: 'Contacts.Name', type: 'string' }],
      cardinalityAdvisory: advisory,
    });

    const validated = service.validateMappings([suggestion], input, 0.5);

    expect(validated).toHaveLength(1);
  });

  it('leaves mappings untouched (no throw) when no cardinality advisory context is supplied', () => {
    const suggestion = makeSuggestion();
    const input = makeInput();

    const validated = service.validateMappings([suggestion], input, 0.5);

    expect(validated).toHaveLength(1);
    expect(validated[0].confidence).toBeCloseTo(0.9, 5);
    expect(validated[0].cardinalityWarnings).toBeUndefined();
  });

  it('never throws out of validateMappings even if the advisory context is malformed (never 500s the request)', () => {
    const suggestion = makeSuggestion();
    // Malformed: evidence is present but missing required nested fields,
    // which would throw inside the analyzer if uncaught.
    const input = makeInput({
      cardinalityAdvisory: {
        analyzerVersion: '1.0.0',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        sourceEntity: 'Account',
        targetEntity: 'Customer',
        sourceEvidence: null as unknown as RelationshipEvidence,
        targetEvidence: null as unknown as RelationshipEvidence,
      },
    });

    let validated: ReturnType<MappingValidationService['validateMappings']> = [];
    expect(() => {
      validated = service.validateMappings([suggestion], input, 0.5);
    }).not.toThrow();
    expect(validated).toHaveLength(1);
  });
});
