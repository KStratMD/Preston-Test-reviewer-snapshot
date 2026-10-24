import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import type {
  LineageChainSeed,
  LineageEventInput,
  LineageEventView,
} from './LineageTypes';

@injectable()
export class LineageRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) dbService: DatabaseService) {
    this.db = dbService.getDatabase();
  }

  async append(input: LineageEventInput): Promise<void> {
    await this.db.insertInto('lineage_events').values({
      id: `lin_${randomUUID()}`,
      tenant_id: input.tenantId,
      chain_id: input.chainId,
      sequence: input.sequence,
      event_type: input.eventType,
      source_system: input.sourceSystem ?? null,
      source_entity_type: input.sourceEntityType ?? null,
      source_entity_id: input.sourceEntityId ?? null,
      target_system: input.targetSystem ?? null,
      target_entity_type: input.targetEntityType ?? null,
      target_entity_id: input.targetEntityId ?? null,
      template_id: input.templateId ?? null,
      correlation_id: input.correlationId,
      governance_result: input.governanceResult ?? null,
      payload_hash: input.payloadHash ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      occurred_at: input.occurredAtOverride ?? new Date().toISOString(),
    }).execute();
  }

  async listChain(tenantId: string, chainId: string): Promise<LineageEventView[]> {
    const rows = await this.db.selectFrom('lineage_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('chain_id', '=', chainId)
      .orderBy('sequence', 'asc')
      .execute();
    return rows.map((r) => this.rowToView(r));
  }

  async findLatestChainForRecord(input: {
    tenantId: string;
    system: string;
    entityType: string;
    entityId: string;
  }): Promise<LineageChainSeed | null> {
    // PR 12 R7 — constrain to event_type='source_read' so the query cannot
    // match a non-source-read row that happens to have populated source_*
    // columns (e.g. a future caller that records source context on a
    // governance_decision row). The schema does not enforce the convention,
    // so the query must.
    const row = await this.db.selectFrom('lineage_events')
      .select(['chain_id', 'occurred_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('event_type', '=', 'source_read')
      .where('source_system', '=', input.system)
      .where('source_entity_type', '=', input.entityType)
      .where('source_entity_id', '=', input.entityId)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return { chainId: row.chain_id, occurredAt: toIsoString(row.occurred_at) };
  }

  /**
   * Find all chain seeds where, within `withinMs` of now:
   *   (a) a source_read row exists with source_system=targetSystem,
   *       source_entity_type=entityType, source_entity_id=entityId AND
   *   (b) a target_write row exists on the SAME chain with
   *       target_system=callerSystem.
   *
   * Used by OwnershipResolver.detectLoop to spot reciprocal-write hazards.
   * Distinct from findLatestChainForRecord — that returns the most-recent
   * chain only, which produces false negatives if targetSystem read this
   * record twice in the window (the latest read may not be the one that
   * wrote back).
   *
   * Returns chain seeds (chainId + seed occurredAt) so callers can fetch
   * full chain context via listChain() if needed.
   */
  async findReciprocalChainSeeds(input: {
    tenantId: string;
    callerSystem: string;
    targetSystem: string;
    entityType: string;
    entityId: string;
    withinMs: number;
  }): Promise<{ chainId: string; occurredAt: string }[]> {
    const sinceIso = new Date(Date.now() - input.withinMs).toISOString();

    // Find chains seeded by a source_read from targetSystem on this record
    // within the window.
    const seedRows = await this.db.selectFrom('lineage_events')
      .select(['chain_id', 'occurred_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('event_type', '=', 'source_read')
      .where('source_system', '=', input.targetSystem)
      .where('source_entity_type', '=', input.entityType)
      .where('source_entity_id', '=', input.entityId)
      .where('occurred_at', '>=', sinceIso)
      .orderBy('occurred_at', 'desc')
      .execute();

    if (seedRows.length === 0) return [];

    // Deduplicate chain_ids before passing to the IN list. Multiple
    // source_read seeds on the same chain (e.g. a flow that re-reads
    // the record during retry) inflate the IN list and the per-row
    // work without changing the result. Copilot R5 (PR 13).
    const candidateChainIds = Array.from(new Set(seedRows.map((r) => r.chain_id)));

    // Find target_write rows back to callerSystem ON THE SAME RECORD on
    // those same chains, ALSO inside the window. Both target_entity_type
    // AND target_entity_id are required filters — without them, a chain
    // that read this record and wrote a DIFFERENT record back would be
    // falsely reported as a loop (Codex round 4 finding #2). The
    // occurred_at >= sinceIso filter on this side prevents a false
    // positive where the seed is recent but the write-back happened long
    // before the window opened (Copilot R8 on PR 13).
    const writeRows = await this.db.selectFrom('lineage_events')
      .select('chain_id')
      .where('tenant_id', '=', input.tenantId)
      .where('event_type', '=', 'target_write')
      .where('target_system', '=', input.callerSystem)
      .where('target_entity_type', '=', input.entityType)
      .where('target_entity_id', '=', input.entityId)
      .where('chain_id', 'in', candidateChainIds)
      .where('occurred_at', '>=', sinceIso)
      .execute();

    const matchingChainIds = new Set(writeRows.map((r) => r.chain_id));

    return seedRows
      .filter((r) => matchingChainIds.has(r.chain_id))
      .map((r) => ({ chainId: r.chain_id, occurredAt: toIsoString(r.occurred_at) }));
  }

  private rowToView(r: {
    id: string; tenant_id: string; chain_id: string; sequence: number;
    event_type: 'source_read' | 'transform' | 'governance_decision' | 'target_write';
    source_system: string | null; source_entity_type: string | null; source_entity_id: string | null;
    target_system: string | null; target_entity_type: string | null; target_entity_id: string | null;
    template_id: string | null; correlation_id: string;
    governance_result: string | null; payload_hash: string | null;
    metadata_json: string; occurred_at: string | Date;
  }): LineageEventView {
    // PR 12 R7 — JSON.parse can return any valid JSON value (null, string,
    // number, boolean, array, object). Only accept a non-null non-array
    // object; fall back to {} for everything else so consumers of
    // LineageEventView.metadata can rely on Record<string, unknown>.
    let metadata: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.metadata_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // metadata stays {}
    }
    return {
      id: r.id,
      tenantId: r.tenant_id,
      chainId: r.chain_id,
      sequence: r.sequence,
      eventType: r.event_type,
      sourceSystem: r.source_system,
      sourceEntityType: r.source_entity_type,
      sourceEntityId: r.source_entity_id,
      targetSystem: r.target_system,
      targetEntityType: r.target_entity_type,
      targetEntityId: r.target_entity_id,
      templateId: r.template_id,
      correlationId: r.correlation_id,
      governanceResult: r.governance_result,
      payloadHash: r.payload_hash,
      metadata,
      occurredAt: toIsoString(r.occurred_at),
    };
  }
}

// node-postgres returns TIMESTAMPTZ as Date; better-sqlite3 returns TEXT as
// string. Normalize at the repository boundary so LineageEventView.occurredAt
// and LineageChainSeed.occurredAt are always ISO 8601 strings (PR #846 R3).
function toIsoString(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}
