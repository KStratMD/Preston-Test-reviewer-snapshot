import { createHash, randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { LineageRepository } from './LineageRepository';

/**
 * Recursively sort object keys so semantically-equal payloads produce
 * byte-identical serialization. Arrays preserve order (order is semantically
 * meaningful for arrays). PR 12 R1 (Copilot finding d) — `JSON.stringify`
 * alone preserves property-insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * hash to different values even though they're equivalent. For lineage
 * tracking, the same payload reprocessed should produce the same hash.
 *
 * Inline implementation (rather than pulling in `safe-stable-stringify`)
 * keeps the dependency surface minimal.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function hashLineagePayload(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalStringify(value ?? null)).digest('hex')}`;
}

export interface LineageChainHandle {
  chainId: string;
  sourceRead: (record: { system: string; entityType: string; entityId: string }) => Promise<void>;
  transform: (record: { payloadHash: string }) => Promise<void>;
  governanceDecision: (record: { result: string; findings: string[] }) => Promise<void>;
  targetWrite: (record: { system: string; entityType: string; entityId: string }) => Promise<void>;
}

@injectable()
export class LineageRecorder {
  constructor(@inject(TYPES.LineageRepository) private readonly repo: LineageRepository) {}

  startChain(input: { tenantId: string; correlationId: string; templateId?: string }): LineageChainHandle {
    const chainId = `lin_${randomUUID()}`;
    let sequence = 0;

    return {
      chainId,
      sourceRead: async (record) => {
        sequence += 1;
        await this.repo.append({
          tenantId: input.tenantId,
          chainId,
          sequence,
          eventType: 'source_read',
          sourceSystem: record.system,
          sourceEntityType: record.entityType,
          sourceEntityId: record.entityId,
          correlationId: input.correlationId,
          templateId: input.templateId ?? null,
          metadata: {},
        });
      },
      transform: async (record) => {
        sequence += 1;
        await this.repo.append({
          tenantId: input.tenantId,
          chainId,
          sequence,
          eventType: 'transform',
          payloadHash: record.payloadHash,
          correlationId: input.correlationId,
          templateId: input.templateId ?? null,
          metadata: {},
        });
      },
      governanceDecision: async (record) => {
        sequence += 1;
        await this.repo.append({
          tenantId: input.tenantId,
          chainId,
          sequence,
          eventType: 'governance_decision',
          governanceResult: record.result,
          correlationId: input.correlationId,
          templateId: input.templateId ?? null,
          metadata: { findings: record.findings },
        });
      },
      targetWrite: async (record) => {
        sequence += 1;
        await this.repo.append({
          tenantId: input.tenantId,
          chainId,
          sequence,
          eventType: 'target_write',
          targetSystem: record.system,
          targetEntityType: record.entityType,
          targetEntityId: record.entityId,
          correlationId: input.correlationId,
          templateId: input.templateId ?? null,
          metadata: {},
        });
      },
    };
  }
}
