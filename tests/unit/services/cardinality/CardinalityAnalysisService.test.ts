import { analyze } from '../../../../src/services/cardinality/CardinalityAnalysisService';
import { CARDINALITY_RUNTIME_CAPABILITIES } from '../../../../src/types/cardinality';
import type { CardinalityFinding, CardinalityFindingType } from '../../../../src/types/cardinality';
import {
  makeAnalysisInput,
  makeEvidence,
  makeEdge,
  makeFieldMapping,
  makeFieldMetadata,
  makeSeparateRecordsStrategy,
} from '../../../helpers/cardinalityTestDoubles';

/**
 * Pure structural analyzer + sample profiling
 * (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Findings", "Sample profiling", "Analysis inputs and fingerprint"). Covers
 * the full finding taxonomy, deterministic ordering/keys, path normalization,
 * the runtime-capability gate, and the non-negotiable privacy rule.
 */

function findingsOfType(
  findings: CardinalityFinding[],
  type: CardinalityFindingType,
): CardinalityFinding[] {
  return findings.filter((f) => f.type === type);
}

describe('analyze — relationship flatten', () => {
  it('flags a one-to-many path with no strategy as an overrideable relationship_flatten', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
    });
    const report = analyze(input);
    const flatten = findingsOfType(report.findings, 'relationship_flatten');
    expect(flatten).toHaveLength(1);
    expect(flatten[0].severity).toBe('blocking');
    expect(flatten[0].overrideable).toBe(true);
    expect(flatten[0].relationshipPath).toEqual(['contacts']);
    expect(flatten[0].mappingIndexes).toEqual([0]);
    expect(flatten[0].resolutionOptions).toEqual(['separate_records', 'fan_out']);
  });

  it('flags a many-to-many path as relationship_flatten', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'many_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
    });
    expect(findingsOfType(analyze(input).findings, 'relationship_flatten')).toHaveLength(1);
  });

  it('does not flag a one-to-one/many-to-one path', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Owner', cardinality: 'many_to_one', toEntity: 'User' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Owner.Name', targetField: 'ownerName' })],
    });
    expect(analyze(input).findings).toHaveLength(0);
  });
});

describe('analyze — path normalization (case-insensitive, complete-path match)', () => {
  it('matches Contacts.Email against a lower-case contacts strategy path', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
      // Upper-case relationship path in the strategy must still match.
      strategies: [makeSeparateRecordsStrategy({ relationshipPath: ['CONTACTS'] })],
    });
    const report = analyze(input);
    // A complete matching strategy suppresses relationship_flatten; because the
    // runtime capability is disabled it surfaces runtime_capability_missing.
    expect(findingsOfType(report.findings, 'relationship_flatten')).toHaveLength(0);
    expect(findingsOfType(report.findings, 'runtime_capability_missing')).toHaveLength(1);
  });

  it('requires the COMPLETE normalized path — a prefix-only strategy does not resolve the flatten', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [
          makeEdge({ fromEntity: 'Account', fromField: 'Contacts', toEntity: 'Contact', cardinality: 'one_to_many' }),
          makeEdge({ fromEntity: 'Contact', fromField: 'Phones', toEntity: 'Phone', cardinality: 'one_to_many' }),
        ],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Phones.Number', targetField: 'phone' })],
      strategies: [makeSeparateRecordsStrategy({ relationshipPath: ['contacts'] })], // prefix only
    });
    const report = analyze(input);
    const flatten = findingsOfType(report.findings, 'relationship_flatten');
    expect(flatten).toHaveLength(1);
    expect(flatten[0].relationshipPath).toEqual(['contacts', 'phones']);
  });
});

describe('analyze — resolution completeness and runtime capability', () => {
  it('a complete matching strategy still blocks with runtime_capability_missing (all capabilities off)', () => {
    expect(CARDINALITY_RUNTIME_CAPABILITIES.separateRecords).toBe(false);
    expect(CARDINALITY_RUNTIME_CAPABILITIES.fanOut).toBe(false);
    expect(CARDINALITY_RUNTIME_CAPABILITIES.selectOne).toBe(false);
    expect(CARDINALITY_RUNTIME_CAPABILITIES.aggregateOperators).toHaveLength(0);

    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
      strategies: [makeSeparateRecordsStrategy({ relationshipPath: ['contacts'] })],
    });
    const finding = findingsOfType(analyze(input).findings, 'runtime_capability_missing')[0];
    expect(finding.severity).toBe('blocking');
    expect(finding.overrideable).toBe(false);
  });

  it('an incomplete strategy yields a non-overrideable resolution_incomplete instead of a flatten', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
      strategies: [makeSeparateRecordsStrategy({ relationshipPath: ['contacts'], childConfigurationId: '' })],
    });
    const report = analyze(input);
    expect(findingsOfType(report.findings, 'relationship_flatten')).toHaveLength(0);
    const incomplete = findingsOfType(report.findings, 'resolution_incomplete');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].overrideable).toBe(false);
  });
});

describe('analyze — collection to scalar', () => {
  it('flags a collection-valued source field mapped to a scalar target with no field resolution', () => {
    const input = makeAnalysisInput({
      fieldMetadata: [makeFieldMetadata({ entity: 'Account', field: 'Tags', isCollection: true })],
      fieldMappings: [makeFieldMapping({ sourceField: 'Tags', targetField: 'tagList' })],
    });
    const finding = findingsOfType(analyze(input).findings, 'collection_to_scalar')[0];
    expect(finding.severity).toBe('blocking');
    expect(finding.overrideable).toBe(true);
    expect(finding.resolutionOptions).toEqual(['aggregate', 'select_one']);
  });

  it('a complete aggregate:join field resolution still blocks with runtime_capability_missing', () => {
    const input = makeAnalysisInput({
      fieldMetadata: [makeFieldMetadata({ entity: 'Account', field: 'Tags', isCollection: true })],
      fieldMappings: [
        makeFieldMapping({
          sourceField: 'Tags',
          targetField: 'tagList',
          cardinality: { resolution: 'aggregate', operator: 'join', separator: ',' },
        }),
      ],
    });
    const report = analyze(input);
    expect(findingsOfType(report.findings, 'collection_to_scalar')).toHaveLength(0);
    expect(findingsOfType(report.findings, 'runtime_capability_missing')).toHaveLength(1);
  });

  it('an aggregate:join without a separator is resolution_incomplete', () => {
    const input = makeAnalysisInput({
      fieldMetadata: [makeFieldMetadata({ entity: 'Account', field: 'Tags', isCollection: true })],
      fieldMappings: [
        makeFieldMapping({
          sourceField: 'Tags',
          targetField: 'tagList',
          cardinality: { resolution: 'aggregate', operator: 'join' },
        }),
      ],
    });
    expect(findingsOfType(analyze(input).findings, 'resolution_incomplete')).toHaveLength(1);
  });

  it('a select_one with empty ordering is resolution_incomplete', () => {
    const input = makeAnalysisInput({
      fieldMetadata: [makeFieldMetadata({ entity: 'Account', field: 'Tags', isCollection: true })],
      fieldMappings: [
        makeFieldMapping({
          sourceField: 'Tags',
          targetField: 'tagList',
          cardinality: { resolution: 'select_one', orderBy: [], tieBreak: { field: 'id', direction: 'asc' } },
        }),
      ],
    });
    expect(findingsOfType(analyze(input).findings, 'resolution_incomplete')).toHaveLength(1);
  });
});

describe('analyze — target collision', () => {
  it('flags two distinct mappings writing the same target field (non-overrideable)', () => {
    const input = makeAnalysisInput({
      fieldMappings: [
        makeFieldMapping({ sourceField: 'Email', targetField: 'email' }),
        makeFieldMapping({ sourceField: 'AltEmail', targetField: 'Email' }), // case-insensitive collision
      ],
    });
    const finding = findingsOfType(analyze(input).findings, 'target_collision')[0];
    expect(finding.overrideable).toBe(false);
    expect(finding.severity).toBe('blocking');
    expect(finding.mappingIndexes).toEqual([0, 1]);
  });

  it('flags exact-duplicate mapping records and labels them as duplicates', () => {
    const dup = makeFieldMapping({ sourceField: 'Email', targetField: 'email' });
    const input = makeAnalysisInput({ fieldMappings: [dup, { ...dup }] });
    const finding = findingsOfType(analyze(input).findings, 'target_collision')[0];
    expect(finding.overrideable).toBe(false);
    expect(finding.message.toLowerCase()).toContain('duplicate');
  });

  it('does not flag a single mapping consolidating multiple source fields', () => {
    const input = makeAnalysisInput({
      fieldMappings: [
        makeFieldMapping({
          sourceField: 'FirstName',
          targetField: 'fullName',
          transformationType: 'concatenate',
          transformationConfig: { type: 'concatenate', fields: ['FirstName', 'LastName'], separator: ' ' },
        }),
      ],
    });
    expect(findingsOfType(analyze(input).findings, 'target_collision')).toHaveLength(0);
  });

  it('does not flag one source field legitimately fanning out to multiple target fields', () => {
    const input = makeAnalysisInput({
      fieldMappings: [
        makeFieldMapping({ sourceField: 'Name', targetField: 'displayName' }),
        makeFieldMapping({ sourceField: 'Name', targetField: 'legalName' }),
      ],
    });
    expect(analyze(input).findings).toHaveLength(0);
  });
});

describe('analyze — relationship evidence availability', () => {
  it('flags unavailable source evidence as an overrideable blocking finding', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({ status: 'unavailable', unavailableReason: 'discovery down' }),
    });
    const finding = findingsOfType(analyze(input).findings, 'relationship_evidence_unavailable')[0];
    expect(finding.severity).toBe('blocking');
    expect(finding.overrideable).toBe(true);
    expect(input.direction).toBe(finding.direction);
  });

  it('flags a partial-evidence path that cannot be evaluated', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({ status: 'partial', edges: [] }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
    });
    expect(findingsOfType(analyze(input).findings, 'relationship_evidence_unavailable')).toHaveLength(1);
  });

  it('treats a dotted field with no matching edge under available evidence as a non-relationship', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({ status: 'available', edges: [] }),
      fieldMappings: [makeFieldMapping({ sourceField: 'notes.body', targetField: 'notes' })],
    });
    expect(analyze(input).findings).toHaveLength(0);
  });
});

describe('analyze — direction labels and determinism', () => {
  const flattenInput = (direction: 'source_to_target' | 'target_to_source') =>
    makeAnalysisInput({
      direction,
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' })],
    });

  it('labels findings with the analyzed direction and produces independent keys per direction', () => {
    const forward = analyze(flattenInput('source_to_target'));
    const backward = analyze(flattenInput('target_to_source'));
    expect(forward.findings[0].direction).toBe('source_to_target');
    expect(backward.findings[0].direction).toBe('target_to_source');
    expect(forward.findings[0].key).not.toBe(backward.findings[0].key);
    expect(forward.direction).toBe('source_to_target');
  });

  it('produces a deterministic, sorted finding order with keys carrying type/direction/path/mappings', () => {
    const input = makeAnalysisInput({
      sourceEvidence: makeEvidence({
        edges: [makeEdge({ fromField: 'Contacts', cardinality: 'one_to_many' })],
      }),
      fieldMappings: [
        makeFieldMapping({ sourceField: 'Contacts.Email', targetField: 'email' }),
        makeFieldMapping({ sourceField: 'Phone', targetField: 'phone' }),
        makeFieldMapping({ sourceField: 'AltPhone', targetField: 'Phone' }), // collides with prev
      ],
    });
    const first = analyze(input);
    const second = analyze(input);
    expect(first.findings.map((f) => f.key)).toEqual(second.findings.map((f) => f.key));
    const keys = first.findings.map((f) => f.key);
    expect([...keys].sort()).toEqual(keys);
    expect(keys[0]).toMatch(/\|source_to_target\|/);
  });
});

describe('analyze — fingerprint (carry-forward: key declarations + schema versions)', () => {
  const base = makeAnalysisInput({
    sourceEvidence: makeEvidence({ provenance: { source: 'api', schemaVersion: 'v1' } }),
    fieldMappings: [makeFieldMapping()],
  });

  it('is deterministic for identical input', () => {
    expect(analyze(base).fingerprint).toBe(analyze(makeAnalysisInput({ ...base })).fingerprint);
  });

  it('changes when key declarations change', () => {
    const changed = makeAnalysisInput({
      ...base,
      keyDeclarations: { sourceRecordKeys: ['id'], parentKeys: ['parentB'], targetKeys: ['externalId'] },
    });
    expect(analyze(changed).fingerprint).not.toBe(analyze(base).fingerprint);
  });

  it('changes when the evidence schema version changes', () => {
    const changed = makeAnalysisInput({
      ...base,
      sourceEvidence: makeEvidence({ provenance: { source: 'api', schemaVersion: 'v2' } }),
    });
    expect(analyze(changed).fingerprint).not.toBe(analyze(base).fingerprint);
  });

  it('changes when samples change — the sample-binding invariant', () => {
    const withA = makeAnalysisInput({ ...base, samples: [{ accountId: 'A', externalId: 'X' }] });
    const withB = makeAnalysisInput({ ...base, samples: [{ accountId: 'A', externalId: 'Y' }] });
    expect(analyze(withA).fingerprint).not.toBe(analyze(withB).fingerprint);
  });

  it('reports the analyzer version and direction from the input', () => {
    const report = analyze(makeAnalysisInput({ analyzerVersion: '9.9.9' }));
    expect(report.analyzerVersion).toBe('9.9.9');
    expect(report.direction).toBe('source_to_target');
  });
});

describe('analyze — sample-driven collisions, simulation, and privacy', () => {
  const collidingInput = () =>
    makeAnalysisInput({
      keyDeclarations: { sourceRecordKeys: ['id'], parentKeys: ['accountId'], targetKeys: ['externalId'] },
      samples: [
        { accountId: 'PARENT_SECRET', externalId: 'KEY_SECRET' },
        { accountId: 'PARENT_SECRET', externalId: 'KEY_SECRET' },
        { accountId: 'OTHER', externalId: 'UNIQUE' },
      ],
    });

  it('emits an overrideable key_collision finding for observed sample collisions', () => {
    const report = analyze(collidingInput());
    const collisions = findingsOfType(report.findings, 'key_collision');
    expect(collisions).toHaveLength(1);
    expect(collisions[0].overrideable).toBe(true);
    expect(collisions[0].severity).toBe('blocking');
  });

  it('attaches a sample-observed simulation with collision indexes and counts', () => {
    const report = analyze(collidingInput());
    expect(report.simulation).toBeDefined();
    expect(report.simulation!.inputRowCount).toBe(3);
    expect(report.simulation!.collisionRowIndexes).toEqual([0, 1]);
    expect(report.simulation!.distinctParentCount).toBe(2);
  });

  it('omits the simulation and records the unavailable check when no samples are supplied', () => {
    const report = analyze(makeAnalysisInput());
    expect(report.simulation).toBeUndefined();
    expect(report.unavailableChecks).toContain('sample_profiling');
  });

  it('PRIVACY: a serialized report leaks neither raw parent/key values nor per-key hashes', () => {
    const report = analyze(collidingInput());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('PARENT_SECRET');
    expect(serialized).not.toContain('KEY_SECRET');
    expect(serialized).not.toContain('UNIQUE');
    // Only report-local group identifiers and row indexes may reference collisions.
    expect(serialized).toContain('collision-1');
  });
});
