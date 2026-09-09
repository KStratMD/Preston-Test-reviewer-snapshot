import 'reflect-metadata';
import {
  CardinalityPreflightService,
  CardinalityPreflightUnavailableError,
  CARDINALITY_ANALYZER_VERSION,
} from '../../../../src/services/cardinality/CardinalityPreflightService';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import { computeCombinedFingerprint } from '../../../../src/services/cardinality/fingerprint';
import * as fingerprintModule from '../../../../src/services/cardinality/fingerprint';
import * as CardinalityAnalysisServiceModule from '../../../../src/services/cardinality/CardinalityAnalysisService';
import { CARDINALITY_RUNTIME_CAPABILITIES } from '../../../../src/types/cardinality';
import type {
  CardinalityFindingType,
  CardinalityPlanInput,
  RelationshipEvidence,
} from '../../../../src/types/cardinality';
import type { IntegrationConfig } from '../../../../src/types';
import { RelationshipEvidenceProvider } from '../../../../src/services/cardinality/RelationshipEvidenceProvider';
import { sampleConfigurations } from '../../../../src/examples/sample-integrations';
import { makeEdge, makeEvidence, makeFieldMapping } from '../../../helpers/cardinalityTestDoubles';
import { SchemaDiscoveryService } from '../../../../src/services/ai/validation/SchemaDiscoveryService';
import { NetSuiteSchemaIntelligence } from '../../../../src/services/ai/NetSuiteSchemaIntelligence';
import { logger } from '../../../../src/utils/Logger';
import type { Logger } from '../../../../src/utils/Logger';

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

describe('CardinalityPreflightService — B3.5 error-boundary sanitization (real discovery chain)', () => {
  // Exercises the REAL SchemaDiscoveryService -> RelationshipEvidenceProvider
  // -> CardinalityPreflightService chain (not the fake provider used above),
  // because the leak Bumble's review caught only exists in the real
  // discoverSalesforceRelationshipSchema() implementation, not in a
  // hand-written test double. Distinct sentinels per surface so a failure to
  // redact any one is individually attributable.
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeMockLogger(): Logger {
    return {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
  }

  const SECRET_TOKEN = 'leaked-token-marker';
  const SECRET_INSTANCE_URL = 'https://leaked-instance-marker.my.salesforce.com';

  function makeRealLiveDiscoveryProvider(): RelationshipEvidenceProvider {
    const schemaDiscoveryService = new SchemaDiscoveryService({
      salesforceRelationshipDiscovery: {
        mode: 'live',
        instanceUrl: SECRET_INSTANCE_URL,
        accessToken: SECRET_TOKEN,
      },
    });
    return new RelationshipEvidenceProvider({
      schemaDiscoveryService,
      netSuiteSchemaIntelligence: new NetSuiteSchemaIntelligence(makeMockLogger()),
    });
  }

  it('acquireEvidence 503: neither the outward message nor AppError.toJSON()\'s cause field leak the token, instance URL, or remote statusText', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'leaked-statustext-marker',
    }) as unknown as typeof fetch;

    const provider = makeRealLiveDiscoveryProvider();
    const service = new CardinalityPreflightService(provider);

    const error = await service
      .runForPlan(makePlan({ sourceSystem: 'salesforce', sourceEntity: 'Account', targetSystem: 'salesforce', targetEntity: 'Contact' }), 'tenant-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CardinalityPreflightUnavailableError);
    // toJSON() is what AppError's serialization exposes outward (Bumble's
    // finding: `cause: this.cause.message` reaches API responses) — asserting
    // on it, not just `.message`, is what actually proves the fix.
    const serialized = JSON.stringify((error as CardinalityPreflightUnavailableError).toJSON());
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_INSTANCE_URL);
    expect(serialized).not.toContain('leaked-statustext-marker');
  });

  it('getAdvisoryEvidence: the logged warning never contains the token, instance URL, or raw transport exception text', async () => {
    global.fetch = jest.fn().mockRejectedValue(
      new Error('connect ECONNREFUSED leaked-host-marker:443'),
    ) as unknown as typeof fetch;

    const provider = makeRealLiveDiscoveryProvider();
    const service = new CardinalityPreflightService(provider);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const evidence = await service.getAdvisoryEvidence('salesforce', 'Account');

    expect(evidence.status).toBe('unavailable');
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(SECRET_TOKEN);
    expect(loggedText).not.toContain(SECRET_INSTANCE_URL);
    expect(loggedText).not.toContain('leaked-host-marker');
    expect(loggedText).not.toContain('ECONNREFUSED');
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

describe('CardinalityPreflightService — malformed internal directional fingerprint (defense in depth)', () => {
  // The analyzer is pure and always emits well-formed digests, so this can
  // only happen if something upstream is broken. Mocking `analyze` is the
  // only way to force that internal-only condition through the real
  // composition boundary (`composeCombinedFingerprint`) without touching
  // fingerprint.ts's own validation.
  it('translates a malformed report fingerprint into the fixed 503 inability-to-decide error, with no digest leaked', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);
    const malformedFingerprint = 'not-a-real-64-char-hex-digest';

    jest.spyOn(CardinalityAnalysisServiceModule, 'analyze').mockReturnValue({
      analyzerVersion: CARDINALITY_ANALYZER_VERSION,
      direction: 'source_to_target',
      findings: [],
      fingerprint: malformedFingerprint,
      unavailableChecks: [],
    });

    const error = await service
      .runForPlan(makePlan({ syncDirection: 'unidirectional' }), 'tenant-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CardinalityPreflightUnavailableError);
    expect(error).toBeInstanceOf(ServiceUnavailableAppError);
    expect((error as ServiceUnavailableAppError).statusCode).toBe(503);
    expect((error as Error).message).toBe('Cardinality relationship evidence could not be determined');
    expect((error as Error).message).not.toContain(malformedFingerprint);
    expect(JSON.stringify((error as ServiceUnavailableAppError).toJSON?.() ?? {})).not.toContain(
      malformedFingerprint,
    );
  });
});

describe('CardinalityPreflightService — narrow catch at fingerprint composition boundary', () => {
  it('propagates an unrelated composition failure unchanged rather than reinterpreting it as a 503 policy result', async () => {
    const { provider } = makeProvider((s, e) => availableFor(s, e, []));
    const service = new CardinalityPreflightService(provider);
    const unrelatedError = new TypeError('unrelated composition bug, not a fingerprint-shape problem');

    jest.spyOn(fingerprintModule, 'computeCombinedFingerprint').mockImplementation(() => {
      throw unrelatedError;
    });

    await expect(
      service.runForPlan(makePlan({ syncDirection: 'unidirectional' }), 'tenant-1'),
    ).rejects.toBe(unrelatedError);
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

  it('shows the real boot sample path produces unavailable-evidence blockers', async () => {
    const { provider } = makeProvider((system, entity) => unavailableFor(system, entity));
    const service = new CardinalityPreflightService(provider);

    for (const config of sampleConfigurations) {
      const result = await service.runForConfig(config);
      expect(result.blocking).toBe(true);
      expect(result.reports.flatMap(report => report.findings)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'relationship_evidence_unavailable', overrideable: true }),
        ]),
      );
    }
  });
});
