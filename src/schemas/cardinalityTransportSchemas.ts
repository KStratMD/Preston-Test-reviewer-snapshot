import { z } from 'zod';
import { FieldMappingSchema, CardinalityStrategySchema } from './configurationSchemas';
import type { IntegrationConfig, CardinalityOverrideRequest } from '../types';

/**
 * Strict transport envelopes for the cardinality preflight and activation gate.
 *
 * These schemas guard the request boundary. They never accept authentication
 * credentials, tenant/actor identity, relationship graphs, persisted validation
 * records, or persisted override metadata — those are resolved or authored
 * server-side. Every object is `.strict()` so an unexpected field (including a
 * credential-shaped one) is rejected rather than silently stripped.
 */

// Sample bounds shared by the preflight request and the save envelope. Byte-size
// and nesting-depth limits are enforced at the route layer against the serialized
// payload; here we bound row count and reject prototype-pollution keys plus the
// per-row field cap.
const MAX_SAMPLE_ROWS = 1000;
const MAX_FIELDS_PER_ROW = 200;
const FORBIDDEN_SAMPLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SampleRowSchema = z.record(z.string(), z.unknown())
  .refine(
    (row) => Object.keys(row).length <= MAX_FIELDS_PER_ROW,
    { message: `Sample rows cannot have more than ${MAX_FIELDS_PER_ROW} fields` },
  );

// Prototype-pollution keys (notably `__proto__`) are silently dropped by Zod's
// safe record reconstruction before any value-level refine runs, so we inspect
// the RAW rows first and fail closed, then pipe into the typed row schema.
const SampleArraySchema = z.array(z.unknown())
  .max(MAX_SAMPLE_ROWS, `Cannot supply more than ${MAX_SAMPLE_ROWS} sample rows`)
  .superRefine((rows, ctx) => {
    rows.forEach((row, index) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const key of Object.keys(row)) {
          if (FORBIDDEN_SAMPLE_KEYS.has(key)) {
            ctx.addIssue({
              code: 'custom',
              message: 'Sample rows must not contain prototype-pollution keys',
              path: [index],
            });
          }
        }
      }
    });
  })
  .pipe(z.array(SampleRowSchema));

/** The audited override request. Reason 10–2,000 chars; scope 1–200 unique keys. */
export const CardinalityOverrideRequestSchema = z.object({
  reason: z.string().trim().min(10, 'Override reason must be at least 10 characters')
    .max(2000, 'Override reason cannot exceed 2,000 characters'),
  findingKeys: z.array(z.string().min(1))
    .min(1, 'Override scope must name at least one finding key')
    .max(200, 'Override scope cannot exceed 200 finding keys')
    .refine((keys) => new Set(keys).size === keys.length, {
      message: 'Override scope cannot contain duplicate finding keys',
    }),
  reportFingerprint: z.string().min(1, 'reportFingerprint is required'),
}).strict();

/**
 * The `_cardinality` save envelope: an optional override plus optional bounded
 * samples. It is stripped before canonical schema validation and persistence.
 */
export const CardinalitySaveEnvelopeSchema = z.object({
  override: CardinalityOverrideRequestSchema.optional(),
  samples: SampleArraySchema.optional(),
}).strict();

const KeyDeclarationsSchema = z.object({
  sourceRecordKeys: z.array(z.string().min(1)).default([]),
  parentKeys: z.array(z.string().min(1)).default([]),
  targetKeys: z.array(z.string().min(1)).default([]),
}).strict();

/**
 * The preflight request: a safe mapping-plan projection plus optional samples.
 * When samples are supplied, sample profiling requires explicit parent and target
 * key declarations so uniqueness and records-per-parent can be computed.
 */
export const CardinalityPreflightRequestSchema = z.object({
  sourceSystem: z.string().min(1, 'Source system is required'),
  targetSystem: z.string().min(1, 'Target system is required'),
  sourceEntity: z.string().min(1, 'Source entity is required'),
  targetEntity: z.string().min(1, 'Target entity is required'),
  syncDirection: z.enum(['unidirectional', 'bidirectional', 'source_to_target', 'target_to_source']),
  fieldMappings: z.array(FieldMappingSchema).max(100, 'Cannot have more than 100 field mappings'),
  strategies: z.array(CardinalityStrategySchema).default([]),
  keyDeclarations: KeyDeclarationsSchema,
  samples: SampleArraySchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.samples && value.samples.length > 0) {
    if (value.keyDeclarations.parentKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Samples require at least one declared parent key',
        path: ['keyDeclarations', 'parentKeys'],
      });
    }
    if (value.keyDeclarations.targetKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Samples require at least one declared target key',
        path: ['keyDeclarations', 'targetKeys'],
      });
    }
  }
});

export type CardinalityOverrideRequestType = z.infer<typeof CardinalityOverrideRequestSchema>;
export type CardinalitySaveEnvelope = z.infer<typeof CardinalitySaveEnvelopeSchema>;
export type CardinalityPreflightRequest = z.infer<typeof CardinalityPreflightRequestSchema>;

/**
 * Active create/update transport (consumed by the configuration write route in a
 * later task). The canonical `IntegrationConfig` never carries the override or the
 * server-authored approval/validation metadata; those travel only in the stripped
 * `_cardinality` envelope or are authored by the server.
 */
export type ConfigurationWriteRequest = Omit<
  IntegrationConfig,
  'cardinalityApproval' | 'cardinalityValidation'
> & {
  _cardinality?: {
    override?: CardinalityOverrideRequest;
    samples?: Record<string, unknown>[];
  };
};
