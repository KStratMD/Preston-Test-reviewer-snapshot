import { WorkflowPayloadCache } from '../../../../../src/services/workflowCentral/payload/WorkflowPayloadCache';
import type { WorkflowExternalRecordReference } from '../../../../../src/services/workflowCentral/payload/WorkflowPayload';

const refA: WorkflowExternalRecordReference = {
  system: 'netsuite',
  recordType: 'vendor',
  recordId: 'V-1',
  fieldsOfInterest: ['name', 'tax_id'],
};

const refB: WorkflowExternalRecordReference = {
  system: 'netsuite',
  recordType: 'vendor',
  recordId: 'V-2',
};

describe('WorkflowPayloadCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-18T12:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns undefined on cache miss', () => {
    const cache = new WorkflowPayloadCache();
    expect(cache.get('tenant-A', refA)).toBeUndefined();
  });

  it('stores and retrieves a value by tenantId+ref', () => {
    const cache = new WorkflowPayloadCache();
    const fields = { name: 'Acme', tax_id: '12-3456789' };
    cache.set('tenant-A', refA, { fields, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-A', refA)).toEqual({ fields, resolvedAt: '2026-05-18T12:00:00Z' });
  });

  it('different tenants do NOT share cache entries (tenant isolation)', () => {
    const cache = new WorkflowPayloadCache();
    cache.set('tenant-A', refA, { fields: { name: 'AcmeA' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-B', refA)).toBeUndefined();
  });

  it('different refs within same tenant do NOT share cache entries', () => {
    const cache = new WorkflowPayloadCache();
    cache.set('tenant-A', refA, { fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-A', refB)).toBeUndefined();
  });

  it('different fieldsOfInterest on same ref → different cache keys', () => {
    const cache = new WorkflowPayloadCache();
    const refLimited: WorkflowExternalRecordReference = { ...refA, fieldsOfInterest: ['name'] };
    cache.set('tenant-A', refA, { fields: { name: 'Acme', tax_id: '12-3456789' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-A', refLimited)).toBeUndefined();
  });

  it('same fieldsOfInterest in different order produces SAME cache key', () => {
    const cache = new WorkflowPayloadCache();
    const ref1: WorkflowExternalRecordReference = { ...refA, fieldsOfInterest: ['name', 'tax_id'] };
    const ref2: WorkflowExternalRecordReference = { ...refA, fieldsOfInterest: ['tax_id', 'name'] };
    cache.set('tenant-A', ref1, { fields: { name: 'Acme', tax_id: '12-3456789' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-A', ref2)).toBeDefined();
  });

  it('entries expire after TTL elapses', () => {
    const cache = new WorkflowPayloadCache({ ttlMs: 30_000 });
    cache.set('tenant-A', refA, { fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.get('tenant-A', refA)).toBeDefined();
    jest.advanceTimersByTime(29_999);
    expect(cache.get('tenant-A', refA)).toBeDefined();
    jest.advanceTimersByTime(2);
    expect(cache.get('tenant-A', refA)).toBeUndefined();
  });

  it('defaults TTL to 30000ms when no option provided', () => {
    const cache = new WorkflowPayloadCache();
    cache.set('tenant-A', refA, { fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' });
    jest.advanceTimersByTime(30_000);
    expect(cache.get('tenant-A', refA)).toBeDefined();
    jest.advanceTimersByTime(1);
    expect(cache.get('tenant-A', refA)).toBeUndefined();
  });

  it('reads WORKFLOW_PAYLOAD_CACHE_TTL_MS env override', () => {
    const prev = process.env.WORKFLOW_PAYLOAD_CACHE_TTL_MS;
    process.env.WORKFLOW_PAYLOAD_CACHE_TTL_MS = '5000';
    try {
      const cache = new WorkflowPayloadCache();
      cache.set('tenant-A', refA, { fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' });
      jest.advanceTimersByTime(5_001);
      expect(cache.get('tenant-A', refA)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_PAYLOAD_CACHE_TTL_MS;
      else process.env.WORKFLOW_PAYLOAD_CACHE_TTL_MS = prev;
    }
  });

  it('invalidate(tenantId) removes all entries for that tenant only', () => {
    const cache = new WorkflowPayloadCache();
    cache.set('tenant-A', refA, { fields: { name: 'AcmeA' }, resolvedAt: '2026-05-18T12:00:00Z' });
    cache.set('tenant-A', refB, { fields: { name: 'AcmeB' }, resolvedAt: '2026-05-18T12:00:00Z' });
    cache.set('tenant-B', refA, { fields: { name: 'AcmeB-tenantB' }, resolvedAt: '2026-05-18T12:00:00Z' });

    cache.invalidate('tenant-A');

    expect(cache.get('tenant-A', refA)).toBeUndefined();
    expect(cache.get('tenant-A', refB)).toBeUndefined();
    expect(cache.get('tenant-B', refA)).toBeDefined();
  });

  it('enforces max-entries bound via FIFO eviction', () => {
    const cache = new WorkflowPayloadCache({ maxEntries: 3 });
    const refs = [1, 2, 3, 4].map((n): WorkflowExternalRecordReference => ({
      system: 'netsuite', recordType: 'vendor', recordId: `V-${n}`,
    }));
    refs.forEach((r) => cache.set('tenant-A', r, { fields: { name: r.recordId }, resolvedAt: '2026-05-18T12:00:00Z' }));

    // Oldest entry (V-1) evicted to make room for V-4
    expect(cache.get('tenant-A', refs[0])).toBeUndefined();
    expect(cache.get('tenant-A', refs[1])).toBeDefined();
    expect(cache.get('tenant-A', refs[2])).toBeDefined();
    expect(cache.get('tenant-A', refs[3])).toBeDefined();
  });

  it('reads WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES env override', () => {
    const prev = process.env.WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES;
    process.env.WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES = '2';
    try {
      const cache = new WorkflowPayloadCache();
      const refs = [1, 2, 3].map((n): WorkflowExternalRecordReference => ({
        system: 'netsuite', recordType: 'vendor', recordId: `V-${n}`,
      }));
      refs.forEach((r) => cache.set('tenant-A', r, { fields: { name: r.recordId }, resolvedAt: '2026-05-18T12:00:00Z' }));
      expect(cache.get('tenant-A', refs[0])).toBeUndefined();
      expect(cache.get('tenant-A', refs[2])).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES;
      else process.env.WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES = prev;
    }
  });

  it('lazy-evicts expired entries on get without separate cleanup pass', () => {
    const cache = new WorkflowPayloadCache({ ttlMs: 1000 });
    cache.set('tenant-A', refA, { fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' });
    jest.advanceTimersByTime(1500);
    expect(cache.get('tenant-A', refA)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('size() reports current entry count (lazy eviction inclusive)', () => {
    const cache = new WorkflowPayloadCache();
    expect(cache.size()).toBe(0);
    cache.set('tenant-A', refA, { fields: { name: 'A' }, resolvedAt: '2026-05-18T12:00:00Z' });
    cache.set('tenant-A', refB, { fields: { name: 'B' }, resolvedAt: '2026-05-18T12:00:00Z' });
    expect(cache.size()).toBe(2);
  });
});
