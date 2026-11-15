/**
 * Compile-time only. `npm run typecheck` fails if the canonical schema's
 * inferred type and the runtime `FieldMapping` diverge. This lives in `src/`
 * deliberately: test files are compiled with `isolatedModules`
 * (tsconfig.test.json) and are not covered by typecheck, so an assertion placed
 * in a test would be silently erased.
 *
 * Three checks per object shape, applied to every nested shape:
 * - Mutual assignability catches a changed key type or a new REQUIRED key on
 *   either side, but structural typing lets an object that merely LACKS an
 *   optional key stay assignable (measured while landing A1: deleting
 *   `required?` from the schema left it green). Key-set equality catches that.
 * - Assignability is also blind to `readonly` (Codex round 1 on PR #1253), so
 *   readonly key sets are compared.
 * - None of it is recursive, so the checks are repeated for
 *   `transformationConfig`, both `cardinality` variants, and the `orderBy`
 *   element / `tieBreak` inside `select_one` (Codex round 2: dropping
 *   `separator` from the schema's aggregate variant compiled clean).
 *
 * WHY OBJECT-TYPED CONSTANTS. A first cut combined the three checks as
 * `[A, B, C] extends [true, true, true]`; that is vacuous, because `never` is
 * assignable to `true`, so one failing check disappeared inside the tuple.
 * Measured: a `readonly` added inside the runtime `tieBreak` compiled clean.
 * Assigning `{ keys: true }` to a type whose `keys` is `never` does fail, so
 * each shape's checks are the property types of one constant.
 *
 * Nothing here runs. The exported constants exist only so the file is a module
 * with values the compiler must resolve.
 */
import type { z } from 'zod';
import type { FieldMapping } from '../../types';
import type { FieldMappingSchema } from './MappingContract';

type Inferred = z.infer<typeof FieldMappingSchema>;

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type KeysEqual<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : never
  : never;
type IfEquals<X, Y, T, F> = (<G>() => G extends X ? 1 : 2) extends <G>() => G extends Y ? 1 : 2 ? T : F;
/** The keys of T declared `readonly` — detected by comparing the property with its `-readonly` twin. */
type ReadonlyKeys<T> = { [K in keyof T]-?: IfEquals<{ [Q in K]: T[K] }, { -readonly [Q in K]: T[K] }, never, K> }[keyof T];
/** One shape's three checks as property types; a failing check is `never` and refuses `true`. */
type Checks<A, B> = {
  assignable: MutuallyAssignable<A, B>;
  keys: KeysEqual<A, B>;
  readonlyKeys: IfEquals<ReadonlyKeys<A>, ReadonlyKeys<B>, true, never>;
};
const PASS = { assignable: true, keys: true, readonlyKeys: true } as const;

export const _fieldMapping: Checks<Inferred, FieldMapping> = PASS;

type InferredConfig = NonNullable<Inferred['transformationConfig']>;
type RuntimeConfig = NonNullable<FieldMapping['transformationConfig']>;
export const _transformationConfig: Checks<InferredConfig, RuntimeConfig> = PASS;

type InferredCardinality = NonNullable<Inferred['cardinality']>;
type RuntimeCardinality = NonNullable<FieldMapping['cardinality']>;
type Variant<U, R extends string> = Extract<U, { resolution: R }>;
export const _cardinalityAggregate: Checks<Variant<InferredCardinality, 'aggregate'>, Variant<RuntimeCardinality, 'aggregate'>> = PASS;
export const _cardinalitySelectOne: Checks<Variant<InferredCardinality, 'select_one'>, Variant<RuntimeCardinality, 'select_one'>> = PASS;
export const _cardinalityTieBreak: Checks<Variant<InferredCardinality, 'select_one'>['tieBreak'], Variant<RuntimeCardinality, 'select_one'>['tieBreak']> = PASS;
export const _cardinalityOrderByElement: Checks<
  Variant<InferredCardinality, 'select_one'>['orderBy'][number],
  Variant<RuntimeCardinality, 'select_one'>['orderBy'][number]
> = PASS;
