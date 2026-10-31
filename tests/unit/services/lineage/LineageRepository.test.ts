import 'reflect-metadata'; // Required for Inversify decorators in isolation-run tests
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import type { Database as Db } from '../../../../src/database/types';
import { migration } from '../../../../src/database/migrations/049-create-lineage-events-table';
import { LineageRepository } from '../../../../src/services/lineage/LineageRepository';

describe('LineageRepository', () => {
  // PR 12 R4 — db lifecycle in afterEach so destroy runs even if the test
  // body throws (prior pattern was `await db.destroy()` at end of body,
  // which leaves open handles + flaky Jest shutdown warnings on failure).
  let db: Kysely<Db>;
  let repo: LineageRepository;

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    db = new Kysely<Db>({ dialect: new SqliteDialect({ database: sqlite }) });
    const dbServiceStub = { getDatabase: () => db } as never;
    repo = new LineageRepository(dbServiceStub);
    await migration.run(db, 'sqlite');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('appends rows with metadata JSON-stringified and lists them in sequence order', async () => {
    await repo.append({
      tenantId: 't', chainId: 'c1', sequence: 1, eventType: 'source_read',
      sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h1',
      correlationId: 'corr', templateId: 'tmpl', metadata: { foo: 'bar' },
    });
    await repo.append({
      tenantId: 't', chainId: 'c1', sequence: 2, eventType: 'transform',
      correlationId: 'corr', templateId: 'tmpl', payloadHash: 'sha256:x', metadata: {},
    });

    const events = await repo.listChain('t', 'c1');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[0].metadata).toEqual({ foo: 'bar' });
    expect(events[1].sequence).toBe(2);
    expect(events[1].payloadHash).toBe('sha256:x');
  });

  it('findLatestChainForRecord returns the most recent chain for a source-record triple', async () => {
    const oldTs = new Date('2026-05-01T00:00:00Z').toISOString();
    const newTs = new Date('2026-05-23T00:00:00Z').toISOString();

    await repo.append({
      tenantId: 't', chainId: 'old', sequence: 1, eventType: 'source_read',
      sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h1',
      correlationId: 'c', metadata: {}, occurredAtOverride: oldTs,
    });
    await repo.append({
      tenantId: 't', chainId: 'new', sequence: 1, eventType: 'source_read',
      sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h1',
      correlationId: 'c', metadata: {}, occurredAtOverride: newTs,
    });

    const seed = await repo.findLatestChainForRecord({
      tenantId: 't', system: 'hubspot', entityType: 'contact', entityId: 'h1',
    });
    expect(seed?.chainId).toBe('new');
  });

  it('findLatestChainForRecord ignores non-source_read rows even when source_* columns are populated (PR 12 R7)', async () => {
    // Schema permits source_* on any event_type; the recorder convention
    // only populates them on source_read, but a non-source_read row with
    // populated source_* must NOT win the query.
    await repo.append({
      tenantId: 't', chainId: 'noise', sequence: 1, eventType: 'governance_decision',
      sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h2',
      correlationId: 'c', metadata: {},
      occurredAtOverride: new Date('2026-06-01T00:00:00Z').toISOString(),
    });
    await repo.append({
      tenantId: 't', chainId: 'real', sequence: 1, eventType: 'source_read',
      sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h2',
      correlationId: 'c', metadata: {},
      occurredAtOverride: new Date('2026-05-01T00:00:00Z').toISOString(),
    });
    const seed = await repo.findLatestChainForRecord({
      tenantId: 't', system: 'hubspot', entityType: 'contact', entityId: 'h2',
    });
    expect(seed?.chainId).toBe('real');
  });

  it('listChain coerces non-object JSON metadata to {} (PR 12 R7)', async () => {
    // Direct DB insert to simulate a row with a non-object JSON metadata
    // (e.g. accidental string/null/array). rowToView must coerce safely.
    const { sql } = await import('kysely');
    const now = new Date().toISOString();
    for (const [chainId, badJson] of [['s', '"a-string"'], ['n', 'null'], ['a', '[1,2,3]']] as const) {
      await sql`INSERT INTO lineage_events (id, tenant_id, chain_id, sequence, event_type, correlation_id, metadata_json, occurred_at)
        VALUES (${'lin_' + chainId}, 't', ${chainId}, 1, 'source_read', 'c', ${badJson}, ${now})`.execute(db);
    }
    for (const chainId of ['s', 'n', 'a']) {
      const events = await repo.listChain('t', chainId);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({});
    }
  });

  it('enforces tenant scoping on listChain', async () => {
    await repo.append({
      tenantId: 't1', chainId: 'shared', sequence: 1, eventType: 'source_read',
      correlationId: 'c', metadata: {},
    });
    await repo.append({
      tenantId: 't2', chainId: 'shared', sequence: 1, eventType: 'source_read',
      correlationId: 'c', metadata: {},
    });
    const t1 = await repo.listChain('t1', 'shared');
    expect(t1).toHaveLength(1);
    expect(t1[0].tenantId).toBe('t1');
  });
});
