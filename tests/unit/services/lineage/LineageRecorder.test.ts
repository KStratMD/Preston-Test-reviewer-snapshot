import 'reflect-metadata'; // Required for Inversify decorators in isolation-run tests
import { LineageRecorder, hashLineagePayload } from '../../../../src/services/lineage/LineageRecorder';
import type { LineageRepository } from '../../../../src/services/lineage/LineageRepository';

describe('LineageRecorder', () => {
  it('records source, transform, governance, and target with increasing sequence under one chain', async () => {
    const repo: jest.Mocked<Pick<LineageRepository, 'append'>> = { append: jest.fn(async () => undefined) };
    const recorder = new LineageRecorder(repo as unknown as LineageRepository);
    const chain = recorder.startChain({
      tenantId: 't',
      correlationId: 'corr_1',
      templateId: 'sample-v1',
    });

    await chain.sourceRead({ system: 'hubspot', entityType: 'contact', entityId: 'h1' });
    await chain.transform({ payloadHash: hashLineagePayload({ a: 1 }) });
    await chain.governanceDecision({ result: 'approved', findings: [] });
    await chain.targetWrite({ system: 'netsuite', entityType: 'customer', entityId: 'ns1' });

    expect(repo.append).toHaveBeenCalledTimes(4);
    const calls = repo.append.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.sequence)).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.eventType)).toEqual(['source_read', 'transform', 'governance_decision', 'target_write']);
    const chainIds = new Set(calls.map((c) => c.chainId));
    expect(chainIds.size).toBe(1);
    expect(calls[0].correlationId).toBe('corr_1');
    expect(calls[0].templateId).toBe('sample-v1');
  });

  it('hashLineagePayload is deterministic and prefixed sha256:', () => {
    const a = hashLineagePayload({ x: 1, y: 'z' });
    const b = hashLineagePayload({ x: 1, y: 'z' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hashLineagePayload canonicalizes object key order (PR 12 R1, Copilot finding d)', () => {
    // Same semantic payload, different property-insertion order: the
    // canonical-stringifier must sort keys so the hash is identical.
    const a = hashLineagePayload({ a: 1, b: 2 });
    const b = hashLineagePayload({ b: 2, a: 1 });
    expect(a).toBe(b);
    // Nested object — recursion through the replacer must sort at every level.
    const nestedA = hashLineagePayload({ outer: { x: 1, y: 2 }, top: true });
    const nestedB = hashLineagePayload({ top: true, outer: { y: 2, x: 1 } });
    expect(nestedA).toBe(nestedB);
    // Arrays preserve order (semantically meaningful) — different array order
    // MUST produce different hashes.
    expect(hashLineagePayload([1, 2, 3])).not.toBe(hashLineagePayload([3, 2, 1]));
  });

  it('chains started from the same recorder do not share sequence counters', async () => {
    const repo: jest.Mocked<Pick<LineageRepository, 'append'>> = { append: jest.fn(async () => undefined) };
    const recorder = new LineageRecorder(repo as unknown as LineageRepository);
    const c1 = recorder.startChain({ tenantId: 't', correlationId: 'a' });
    const c2 = recorder.startChain({ tenantId: 't', correlationId: 'b' });
    await c1.sourceRead({ system: 's', entityType: 'e', entityId: '1' });
    await c2.sourceRead({ system: 's', entityType: 'e', entityId: '2' });
    expect(repo.append.mock.calls[0][0].sequence).toBe(1);
    expect(repo.append.mock.calls[1][0].sequence).toBe(1);
    expect(repo.append.mock.calls[0][0].chainId).not.toBe(repo.append.mock.calls[1][0].chainId);
  });
});
