import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import type { Database as Db } from '../../../../src/database/types';
import { migration } from '../../../../src/database/migrations/049-create-lineage-events-table';
import { LineageRepository } from '../../../../src/services/lineage/LineageRepository';

describe('LineageRepository.findReciprocalChainSeeds', () => {
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

  async function seedReciprocalChain(opts: {
    tenantId?: string;
    chainId: string;
    sourceSystem: string;
    targetSystem: string;
    entityType: string;
    entityId: string;
    occurredAt: string;
  }) {
    const tenant = opts.tenantId ?? 't';
    await repo.append({
      tenantId: tenant, chainId: opts.chainId, sequence: 1, eventType: 'source_read',
      sourceSystem: opts.sourceSystem, sourceEntityType: opts.entityType, sourceEntityId: opts.entityId,
      correlationId: 'corr', templateId: 'tmpl', metadata: {},
      occurredAtOverride: opts.occurredAt,
    });
    await repo.append({
      tenantId: tenant, chainId: opts.chainId, sequence: 2, eventType: 'target_write',
      targetSystem: opts.targetSystem, targetEntityType: opts.entityType, targetEntityId: opts.entityId,
      correlationId: 'corr', templateId: 'tmpl', metadata: {},
      occurredAtOverride: opts.occurredAt,
    });
  }

  it('returns empty when no chains exist for the record', async () => {
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('skips chains where target_write entity type/id differs from source_read record (Codex round 4 #2)', async () => {
    // Chain where targetSystem (netsuite) read customer/c-1, but the
    // target_write back to callerSystem (salesforce) was for a DIFFERENT
    // record (customer/c-OTHER). Should NOT be reported as a loop.
    const now = new Date().toISOString();
    await repo.append({
      tenantId: 't', chainId: 'mismatch-chain', sequence: 1, eventType: 'source_read',
      sourceSystem: 'netsuite', sourceEntityType: 'customer', sourceEntityId: 'c-1',
      correlationId: 'corr', templateId: 'tmpl', metadata: {}, occurredAtOverride: now,
    });
    await repo.append({
      tenantId: 't', chainId: 'mismatch-chain', sequence: 2, eventType: 'target_write',
      targetSystem: 'salesforce', targetEntityType: 'customer', targetEntityId: 'c-OTHER',
      correlationId: 'corr', templateId: 'tmpl', metadata: {}, occurredAtOverride: now,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('returns matching chain when source_read(targetSystem) + target_write(callerSystem) inside window', async () => {
    const now = new Date().toISOString();
    await seedReciprocalChain({
      chainId: 'chain-A', sourceSystem: 'netsuite', targetSystem: 'salesforce',
      entityType: 'customer', entityId: 'c-1', occurredAt: now,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toHaveLength(1);
    expect(result[0].chainId).toBe('chain-A');
  });

  it('skips chains whose seed occurred_at is OUTSIDE the window', async () => {
    // 2 hours ago — outside a 60s window.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await seedReciprocalChain({
      chainId: 'old-chain', sourceSystem: 'netsuite', targetSystem: 'salesforce',
      entityType: 'customer', entityId: 'c-1', occurredAt: longAgo,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('skips chains where the target_write occurred BEFORE the window even if seed is inside (Copilot R8)', async () => {
    // Symmetry with the seed-outside-window case: when the seed read is
    // recent but the matching write-back happened long ago, the
    // reciprocal-hazard semantics ("within withinMs of NOW") require
    // both rows to fall inside the window. Prior to Copilot R8 the
    // target_write query lacked the occurred_at filter, so an old
    // write-back would falsely match a recent re-read of the same record.
    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    await repo.append({
      tenantId: 't', chainId: 'seed-recent-write-old', sequence: 1, eventType: 'source_read',
      sourceSystem: 'netsuite', sourceEntityType: 'customer', sourceEntityId: 'c-1',
      correlationId: 'corr', templateId: 'tmpl', metadata: {}, occurredAtOverride: now,
    });
    await repo.append({
      tenantId: 't', chainId: 'seed-recent-write-old', sequence: 2, eventType: 'target_write',
      targetSystem: 'salesforce', targetEntityType: 'customer', targetEntityId: 'c-1',
      correlationId: 'corr', templateId: 'tmpl', metadata: {}, occurredAtOverride: longAgo,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('skips chains that have only source_read but no target_write back (no loop hazard)', async () => {
    const now = new Date().toISOString();
    await repo.append({
      tenantId: 't', chainId: 'only-read', sequence: 1, eventType: 'source_read',
      sourceSystem: 'netsuite', sourceEntityType: 'customer', sourceEntityId: 'c-1',
      correlationId: 'corr', templateId: 'tmpl', metadata: {}, occurredAtOverride: now,
    });
    // No target_write follows.
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('skips chains for different entityType or entityId (record scoping enforced)', async () => {
    const now = new Date().toISOString();
    await seedReciprocalChain({
      chainId: 'wrong-id', sourceSystem: 'netsuite', targetSystem: 'salesforce',
      entityType: 'customer', entityId: 'OTHER-ID', occurredAt: now,
    });
    await seedReciprocalChain({
      chainId: 'wrong-type', sourceSystem: 'netsuite', targetSystem: 'salesforce',
      entityType: 'vendor', entityId: 'c-1', occurredAt: now,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });

  it('respects tenant_id isolation', async () => {
    const now = new Date().toISOString();
    await seedReciprocalChain({
      tenantId: 'other-tenant',
      chainId: 'cross-tenant', sourceSystem: 'netsuite', targetSystem: 'salesforce',
      entityType: 'customer', entityId: 'c-1', occurredAt: now,
    });
    const result = await repo.findReciprocalChainSeeds({
      tenantId: 't',
      callerSystem: 'salesforce',
      targetSystem: 'netsuite',
      entityType: 'customer',
      entityId: 'c-1',
      withinMs: 60_000,
    });
    expect(result).toEqual([]);
  });
});
