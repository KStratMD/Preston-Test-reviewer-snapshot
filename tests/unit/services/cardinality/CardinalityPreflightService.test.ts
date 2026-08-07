import 'reflect-metadata';
import {
  CardinalityPreflightService,
  CardinalityPreflightUnavailableError,
  CARDINALITY_ANALYZER_VERSION,
} from '../../../../src/services/cardinality/CardinalityPreflightService';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import { computeCombinedFingerprint } from '../../../../src/services/cardinality/fingerprint';
import { CARDINALITY_RUNTIME_CAPABILITIES } from '../../../../src/types/cardinality';
import type {
  CardinalityFindingType,
  CardinalityPlanInput,
  RelationshipEvidence,
} from '../../../../src/types/cardinality';
import type { IntegrationConfig } from '../../../../src/types';
import type { RelationshipEvidenceProvider } from '../../../../src/services/cardinality/RelationshipEvidenceProvider';
import { makeEdge, makeEvidence, makeFieldMapping } from '../../../helpers/cardinalityTestDoubles';

/**
 * Trusted preflight coordinator
 * (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "CardinalityPreflightService", "Analysis inputs and fingerprint",
 * "Error contract"). The coordinator owns direction expansion, evidence
 * acquisition/reversal, fingerprint combination, and 503 translation only —
 * it delegates all rules/math to the pure analyzer and all normalization to
 * the evidence provider.
 */

/** A fake provider resolving evidence by `${system}:${entity}` (case-insensitive). */
function makeProvider(
  resolve: (system: string, entity: string) => RelationshipEvidence | Error,
): { provider: RelationshipEvidenceProvider; getEvidence: jest.Mock } {
  const getEvidence = jest.fn(async (system: string, entity: string) => {
    const result = resolve(system, entity);
    if (result instanceof Error) throw result;
    return result;
  });
  return { provider: { getEvidence } as unknown as RelationshipEvidenceProvider, getEvidence };
}

function availableFor(system: string, entity: string, edges = makeEvidence().edges): RelationshipEvidence {
  return makeEvidence({ system, entity, status: 'available', edges });
}

function unavailableFor(system: string, entity: string): RelationshipEvidence {
  return makeEvidence({ system, entity, status: 'unavailable', edges: [], unavailableReason: 'no discovery' });
}

function makePlan(overrides: Partial<CardinalityPlanInput> = {}): CardinalityPlanInput {
  return {
    sourceSystem: 'sysA',
    targetSystem: 'sysB',
    sourceEntity: 'entA',
    targetEntity: 'entB',
    syncDirection: 'source_to_target',
    fieldMappings: [],
    strategies: [],
    keyDeclarations: { sourceRecordKeys: [], parentKeys: [], targetKeys: [] },
    ...overrides,
  };
}

function findingTypes(types: CardinalityFindingType[], type: CardinalityFindingType): number {
  return types.filter((t) => t === type).length;
}

describe('CardinalityPreflightService — runtime capability registry pin', () => {
  it('advertises no executable cardinality resolution', () => {
    // NON-NEGOTIABLE #1: capabilities start disabled. Enabling ANY capability
    // (fanOut, separateRecords, an aggregate operator, or selectOne) requires
    // an end-to-end runtime executor test proving the record-grain behavior
    // FIRST — this pin exists so no one flips a flag without that proof.
    expect(CARDINALITY_RUNTIME_CAPABILITIES).toEqual({
      fanOut: false,
      separateRecords: false,
      aggregateOperators: [],
      selectOne: false,
    });
  });
});

describe('CardinalityPreflightService — direction expansion', () => {
  it('produces one source_to_target report for a unidirectional plan', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForPlan(makePlan({ syncDirection: 'unidirectional' }), 'tenant-1');

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].direction).toBe('source_to_target');
    expect(result.reports[0].analyzerVersion).toBe(CARDINALITY_ANALYZER_VERSION);
  });

  it('produces one target_to_source report for a target_to_source plan', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForPlan(makePlan({ syncDirection: 'target_to_source' }), 'tenant-1');

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].direction).toBe('target_to_source');
  });

  it('produces both directional reports for a bidirectional plan', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForPlan(makePlan({ syncDirection: 'bidirectional' }), 'tenant-1');

    expect(result.reports).toHaveLength(2);
    expect(result.reports.map((r) => r.direction).sort()).toEqual(['source_to_target', 'target_to_source']);
  });
});

describe('CardinalityPreflightService — evidence reversal (swaps sides, not just labels)', () => {
  // The to-many edge lives ONLY in the config target system's evidence. It can
  // therefore only produce a flatten in the target_to_source direction, where
  // the config target becomes the source side AND the field mapping is reversed
  // so its path is traversed. If reversal only relabeled directions (without
  // swapping the evidence side and mapping orientation), the flatten would never
  // appear — or would appear in the wrong direction.
  const toManyOnTarget = [makeEdge({ fromEntity: 'entB', fromField: 'children', cardinality: 'one_to_many' })];

  function bidirectionalService() {
    const { provider, getEvidence } = makeProvider((system, entity) => {
      if (system === 'sysB' && entity === 'entB') return availableFor('sysB', 'entB', toManyOnTarget);
      return availableFor(system, entity, []);
    });
    const plan = makePlan({
      syncDirection: 'bidirectional',
      fieldMappings: [makeFieldMapping({ sourceField: 'plainA', targetField: 'children.name' })],
    });
    return { service: new CardinalityPreflightService(provider), plan, getEvidence };
  }

  it('detects the flatten only in the reverse direction', async () => {
    const { service, plan } = bidirectionalService();

    const result = await service.runForPlan(plan, 'tenant-1');

    const forward = result.reports.find((r) => r.direction === 'source_to_target')!;
    const reverse = result.reports.find((r) => r.direction === 'target_to_source')!;

    expect(findingTypes(forward.findings.map((f) => f.type), 'relationship_flatten')).toBe(0);
    expect(findingTypes(reverse.findings.map((f) => f.type), 'relationship_flatten')).toBe(1);
    expect(result.blocking).toBe(true);
  });

  it('acquires evidence for both oriented system/entity pairs', async () => {
    const { service, plan, getEvidence } = bidirectionalService();

    await service.runForPlan(plan, 'tenant-1');

    const calls = getEvidence.mock.calls.map(([s, e]) => `${s}:${e}`);
    expect(calls).toContain('sysA:entA');
    expect(calls).toContain('sysB:entB');
  });
});

describe('CardinalityPreflightService — unavailable evidence is a report, not an error', () => {
  it('carries the blocking unavailable finding when a system is unknown', async () => {
    const { provider } = makeProvider((system, entity) =>
      system === 'sysA' ? unavailableFor(system, entity) : availableFor(system, entity, []),
    );
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForPlan(makePlan(), 'tenant-1');

    expect(result.reports).toHaveLength(1);
    const types = result.reports[0].findings.map((f) => f.type);
    expect(findingTypes(types, 'relationship_evidence_unavailable')).toBeGreaterThanOrEqual(1);
    expect(result.blocking).toBe(true);
  });
});

describe('CardinalityPreflightService — discovery transport failure → 503', () => {
  it('translates a provider throw into a typed 503-class error', async () => {
    const { provider } = makeProvider(() => new Error('ECONNREFUSED'));
    const service = new CardinalityPreflightService(provider);

    await expect(service.runForPlan(makePlan(), 'tenant-1')).rejects.toBeInstanceOf(
      CardinalityPreflightUnavailableError,
    );
  });

  it('the error is a ServiceUnavailableAppError with status 503 (boundary-discriminable)', async () => {
    const { provider } = makeProvider(() => new Error('boom'));
    const service = new CardinalityPreflightService(provider);

    const error = await service.runForPlan(makePlan(), 'tenant-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableAppError);
    expect((error as ServiceUnavailableAppError).statusCode).toBe(503);
  });

  it('never converts a transport failure into an overrideable unavailable report', async () => {
    const { provider } = makeProvider(() => new Error('timeout'));
    const service = new CardinalityPreflightService(provider);

    await expect(service.runForPlan(makePlan(), 'tenant-1')).rejects.toThrow();
  });
});

describe('CardinalityPreflightService — combined fingerprint', () => {
  it('is deterministic for identical inputs and samples', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);
    const samples = [{ id: 1 }, { id: 2 }];

    const a = await service.runForPlan(makePlan(), 'tenant-1', samples);
    const b = await service.runForPlan(makePlan(), 'tenant-1', samples);

    expect(a.combinedFingerprint).toBe(b.combinedFingerprint);
  });

  it('changes when the samples change (override invalidation)', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const a = await service.runForPlan(makePlan(), 'tenant-1', [{ id: 1 }]);
    const b = await service.runForPlan(makePlan(), 'tenant-1', [{ id: 2 }]);

    expect(a.combinedFingerprint).not.toBe(b.combinedFingerprint);
  });

  it('is computed from direction-sorted objects, not report array order', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForPlan(makePlan({ syncDirection: 'bidirectional' }), 'tenant-1');

    const reversed = [...result.reports]
      .reverse()
      .map((r) => ({ direction: r.direction, fingerprint: r.fingerprint }));
    expect(result.combinedFingerprint).toBe(computeCombinedFingerprint(reversed));
  });
});

describe('CardinalityPreflightService — runForConfig delegates to the same runner', () => {
  function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
    return {
      id: 'cfg-1',
      tenantId: 'tenant-1',
      name: 'test',
      sourceSystem: 'sysA',
      targetSystem: 'sysB',
      sourceEntity: 'entA',
      targetEntity: 'entB',
      syncDirection: 'bidirectional',
      fieldMappings: [],
      cardinalityStrategies: [],
      ...overrides,
    } as unknown as IntegrationConfig;
  }

  it('expands a bidirectional config into two reports', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    const result = await service.runForConfig(makeConfig());

    expect(result.reports).toHaveLength(2);
    expect(result.reports.map((r) => r.direction).sort()).toEqual([
      'source_to_target',
      'target_to_source',
    ]);
  });

  it('reads the system name from a SystemConfig object shape', async () => {
    const { provider, getEvidence } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);

    await service.runForConfig(
      makeConfig({
        sourceSystem: { type: 'salesforce' },
        targetSystem: { type: 'netsuite' },
        syncDirection: 'unidirectional',
      }),
    );

    const calls = getEvidence.mock.calls.map(([s]) => s);
    expect(calls).toContain('salesforce');
    expect(calls).toContain('netsuite');
  });
});
