/**
 * The canonical mapping contract (tranche 2, Workstream A, Task A1).
 *
 * One exported type pair — `FieldMapping` and `TransformationRule` from
 * `src/types/index.ts`, re-exported here — is the only mapping shape the
 * runtime, the Blueprint exporter, validation tooling, proposal generation and
 * any UI may consume. Legacy shapes are adapted at the boundary through explicit
 * `from*` functions (see `./adapters/`) or retired; the shrink-only gate
 * `scripts/check-mapping-contract-declarations.mjs` stops new ones appearing.
 *
 * The contract distinguishes transformation types the engine EXECUTES from
 * types that are merely DECLARED in the runtime union. Before this task,
 * `TransformationEngine.applyFieldMapping` passed a declared-only mapping's
 * value straight through its `default:` branch, so a mapping that claimed a
 * transformation silently performed none. `validateMappingSet` reports each
 * declared-only mapping as an issue unless the caller passes
 * `{ allowDeclaredOnly: true }` for a draft; `assertExecutable` throws.
 *
 * The schema is strict (no passthrough, no cast) and its inferred type is
 * asserted mutually assignable with the runtime `FieldMapping` in
 * `./MappingContract.typecheck.ts`, which `npm run typecheck` covers. Test
 * files compile under `isolatedModules` and are never type-checked, so that
 * assertion has to live in `src/`.
 */
import { z } from 'zod';
import { toPath } from 'lodash';
import { validateExpression } from '../../utils/safeExprEval';
import type { FieldMapping, TransformationRule } from '../../types';

export type { FieldMapping, TransformationRule };

/** Types `TransformationEngine.applyFieldMapping` actually executes. */
export const EXECUTABLE_TRANSFORMATIONS = ['direct', 'lookup', 'calculation', 'concatenation'] as const;
/** Types present in the runtime union that no engine branch implements. */
export const DECLARED_ONLY_TRANSFORMATIONS = ['concatenate', 'split', 'expression', 'conditional'] as const;
const ALL_TYPES = [...EXECUTABLE_TRANSFORMATIONS, ...DECLARED_ONLY_TRANSFORMATIONS] as const;

const Direction = z.enum(['asc', 'desc']);

/**
 * Path segments lodash treats specially: `_.set` refuses to write them and
 * `_.get` reads them from Object.prototype. A mapping addressing one would
 * validate, execute "successfully" and produce nothing (Codex round 9 on
 * PR #1253). They are never legitimate field names.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * True when any segment of the path is one of the forbidden names. Shared with
 * the SyncCentral legacy mapper, which indexes plain objects with the field
 * name and would otherwise write the output object's prototype (Codex round 10).
 */
export function addressesForbiddenSegment(fieldPath: string): boolean {
  return toPath(fieldPath).some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg));
}
/**
 * A lookup table is resolvable when `lookupTable` is an inline JSON object or
 * `mappings` supplies the table for the name (Codex round 13 on PR #1253: a
 * bare name with neither validated, and the engine treated the unresolved
 * lookup as a missing optional value — success with the target omitted).
 */
export function resolveLookupTable(config: { lookupTable?: string; mappings?: Record<string, unknown> }): Record<string, unknown> | undefined {
  if (typeof config.lookupTable === 'string') {
    try {
      const parsed: unknown = JSON.parse(config.lookupTable);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not inline JSON — fall through to mappings
    }
  }
  return config.mappings && typeof config.mappings === 'object' ? config.mappings : undefined;
}
const safeFieldPath = (label: string) =>
  z.string().min(1, `${label} cannot be empty`)
    // Codex round 13: lodash parses '[]', 'a.', '.a' and 'a..b' into an EMPTY
    // segment; _.set then writes the key "" and _.get reads it.
    .refine((v) => { const segs = toPath(v); return segs.length > 0 && segs.every((seg) => seg.length > 0); }, { message: `${label} must not contain an empty segment` })
    .refine(
      (v) => !addressesForbiddenSegment(v),
      { message: `${label} must not address __proto__, constructor or prototype` },
    );

/**
 * Mirrors `FieldCardinalityResolution` in `src/types/cardinality.ts`, with the
 * aggregate rules the configuration validator has always enforced (Codex on
 * PR #1253 measured that the first cut of this schema was LOOSER than the
 * legacy `FieldCardinalityResolutionSchema` it replaces): a `join` needs a
 * separator, and a separator is meaningless on any other operator.
 */
const CardinalitySchema = z
  .discriminatedUnion('resolution', [
    z
      .object({
        resolution: z.literal('aggregate'),
        operator: z.enum(['join', 'sum', 'count', 'min', 'max', 'first_non_null']),
        separator: z.string().min(1, 'Separator cannot be empty').optional(),
      })
      .strict(),
    z
      .object({
        resolution: z.literal('select_one'),
        orderBy: z.array(z.object({ field: z.string(), direction: Direction }).strict()).min(1),
        tieBreak: z.object({ field: z.string(), direction: Direction }).strict(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.resolution !== 'aggregate') return;
    if (value.operator === 'join' && value.separator === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'aggregate join requires a separator', path: ['separator'] });
    }
    if (value.operator !== 'join' && value.separator !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'separator is only valid for join aggregation', path: ['separator'] });
    }
  });

/**
 * Mirrors `FieldMapping.transformationConfig`. `type` is required because the
 * runtime type requires it; the engine itself never reads it (it switches on
 * `transformationType`), so this is a shape requirement, not a behavioural one.
 */
const TransformationConfigSchema = z
  .object({
    type: z.string(),
    // Copilot on PR #1253: an empty path is never a field; performConcatenation()
    // would hand it to _.get unchecked.
    fields: z.array(safeFieldPath('concatenation field path')).optional(),
    separator: z.string().optional(),
    lookupTable: z.string().optional(),
    keyField: z.string().optional(),
    valueField: z.string().optional(),
    expression: z.string().optional(),
    mappings: z.record(z.string(), z.unknown()).optional(),
    defaultValue: z.unknown().optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const FieldMappingSchema = z
  .object({
    // Operator-facing messages the configuration validator has always emitted
    // (tests/unit/__tests__/ConfigurationService.test.ts pins them).
    sourceField: safeFieldPath('Source field'),
    targetField: safeFieldPath('Target field'),
    transformationType: z.enum(ALL_TYPES),
    isRequired: z.boolean(),
    defaultValue: z.unknown().optional(),
    transformationConfig: TransformationConfigSchema.optional(),
    cardinality: CardinalitySchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Per-type rules match what the engine reads: performLookup() throws
    // without lookupTable; performCalculation() needs an expression;
    // performConcatenation() iterates config.fields.
    const c = m.transformationConfig;
    if (m.transformationType === 'lookup' && !c?.lookupTable) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'lookup requires transformationConfig.lookupTable' });
    } else if (m.transformationType === 'lookup' && c && !resolveLookupTable(c)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lookup table '${c.lookupTable}' cannot be resolved: provide transformationConfig.mappings or an inline JSON object table` });
    }
    if (m.transformationType === 'calculation') {
      if (!c?.expression) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'calculation requires transformationConfig.expression' });
      } else {
        // Codex round 4 on PR #1253: a malformed expression ('1+') passed the
        // shape check and was stored; the engine's own parser is the test.
        const parsed = validateExpression(c.expression);
        if (!parsed.valid) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `calculation expression is not executable: ${parsed.error ?? 'invalid'}`, path: ['transformationConfig', 'expression'] });
        }
      }
    }
    if (m.transformationType === 'concatenation' && !(c?.fields && c.fields.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'concatenation requires non-empty transformationConfig.fields' });
    }
  });

export class MappingContractError extends Error {
  constructor(public readonly issues: string[]) {
    super(`mapping contract violated: ${issues.join('; ')}`);
    this.name = 'MappingContractError';
  }
}

export interface MappingSetValidation {
  ok: boolean;
  issues: string[];
  /** The parsed mappings when `ok`; always `[]` otherwise — never a partial list. */
  mappings: FieldMapping[];
}

/**
 * Validate a whole mapping set. Structural failures are reported per entry
 * (`[index] path: message`) and short-circuit the semantic checks; a set with
 * any issue yields no mappings, so a caller can never act on a partial list.
 */
export function validateMappingSet(input: unknown, opts: { allowDeclaredOnly?: boolean } = {}): MappingSetValidation {
  if (!Array.isArray(input)) return { ok: false, issues: ['mappings must be an array'], mappings: [] };
  const issues: string[] = [];
  const mappings: FieldMapping[] = [];
  input.forEach((entry, i) => {
    const parsed = FieldMappingSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push(`[${i}] ${issue.path.join('.') || 'mapping'}: ${issue.message}`);
      return;
    }
    mappings.push(parsed.data);
  });
  if (issues.length > 0) return { ok: false, issues, mappings: [] };

  // Codex round 4 on PR #1253: the engine writes with lodash `_.set`, for which
  // `a.b`, `a[b]` and `a['b']` are the same slot. Compare normalised paths, or
  // two spellings silently overwrite each other.
  const seen = new Map<string, string>();
  for (const m of mappings) {
    // Segments as JSON, not a '.'-join: a["b.c"] and a.b.c are different slots (Codex round 5).
    const slot = JSON.stringify(toPath(m.targetField));
    const prior = seen.get(slot);
    if (prior !== undefined) {
      issues.push(prior === m.targetField ? `duplicate targetField: ${m.targetField}` : `duplicate targetField: ${m.targetField} addresses the same slot as ${prior}`);
    } else {
      seen.set(slot, m.targetField);
    }
    if (!opts.allowDeclaredOnly && (DECLARED_ONLY_TRANSFORMATIONS as readonly string[]).includes(m.transformationType)) {
      issues.push(`${m.sourceField} -> ${m.targetField}: transformationType '${m.transformationType}' is declared but not executable`);
    }
  }
  return { ok: issues.length === 0, issues, mappings: issues.length === 0 ? mappings : [] };
}

/** Validate strictly (no drafts) and throw `MappingContractError` on any issue. */
export function assertExecutable(input: unknown): FieldMapping[] {
  const result = validateMappingSet(input);
  if (!result.ok) throw new MappingContractError(result.issues);
  return result.mappings;
}
