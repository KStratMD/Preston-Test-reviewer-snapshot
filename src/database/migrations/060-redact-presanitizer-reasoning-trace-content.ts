import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 060 — one-time content redaction of pre-sanitizer reasoning traces.
 *
 * Before the ReasoningTraceEngine sanitizer (same PR as this migration),
 * every recorded step persisted the agent's RAW input (including
 * FieldMappingAgent sampleData = real customer records), raw output, and raw
 * unbounded reasoning text into reasoning_traces. This migration nulls those
 * three content columns on all existing rows; every row present when 060
 * first runs predates the sanitizer by construction. Trace skeletons
 * (session/step structure, agents, confidence, timing) are preserved.
 *
 * Approved by Kerry (ledger refinement 7 decision checkpoint, trace-sanitizer
 * plan Task 5 — explicit Option A approval 2026-07-28) — destructive to raw
 * content by design. Idempotent: re-running nulls already-null columns.
 */
export const migration: MigrationModule = {
  name: 'redact_presanitizer_reasoning_trace_content',
  async run(db) {
    await sql.raw(`
      UPDATE reasoning_traces
      SET input_summary = NULL,
          output_summary = NULL,
          reasoning = NULL
      WHERE input_summary IS NOT NULL
         OR output_summary IS NOT NULL
         OR reasoning IS NOT NULL
    `).execute(db);
  },
};
