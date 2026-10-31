/**
 * Task A1 (tranche 2, Workstream A): the canonical mapping contract.
 *
 * One schema, `FieldMappingSchema`, is the only description of a mapping the
 * runtime, the Blueprint exporter and any validation tooling may consume. Its
 * inferred type is asserted mutually assignable with the runtime `FieldMapping`
 * in `src/domain/mapping/MappingContract.typecheck.ts` — a `src/` file, because
 * test files compile under `isolatedModules` and `npm run typecheck` never sees
 * them. The import below only proves that file exists and loads.
 *
 * The contract separates what the engine EXECUTES (direct, lookup, calculation,
 * concatenation) from what is merely DECLARED in the type union (concatenate,
 * split, expression, conditional). Before this task the engine passed a
 * declared-only mapping's value straight through (`default:` branch), so a
 * mapping that claimed a transformation silently performed none.
 */
import '../../../../src/domain/mapping/MappingContract.typecheck';
import {
  FieldMappingSchema,
  validateMappingSet,
  assertExecutable,
  MappingContractError,
  EXECUTABLE_TRANSFORMATIONS,
  DECLARED_ONLY_TRANSFORMATIONS,
  type FieldMapping,
} from '../../../../src/domain/mapping/MappingContract';

const direct: FieldMapping = { sourceField: 'email', targetField: 'Email', transformationType: 'direct', isRequired: true };
const lookup: FieldMapping = {
  sourceField: 'code',
  targetField: 'Code',
  transformationType: 'lookup',
  isRequired: false,
  transformationConfig: { type: 'lookup', lookupTable: 'codes', mappings: { A: 'Alpha' } },
};
const calc: FieldMapping = {
  sourceField: 'qty',
  targetField: 'Qty',
  transformationType: 'calculation',
  isRequired: true,
  transformationConfig: { type: 'calculation', expression: 'parseInt(qty)' },
};
const concat: FieldMapping = {
  sourceField: 'first',
  targetField: 'Full',
  transformationType: 'concatenation',
  isRequired: false,
  transformationConfig: { type: 'concatenation', fields: ['first', 'last'], separator: ' ' },
};

describe('FieldMappingSchema', () => {
  it('accepts the four executable types and returns them unchanged', () => {
    for (const m of [direct, lookup, calc, concat]) expect(FieldMappingSchema.parse(m)).toEqual(m);
  });

  it('rejects an unknown type and unknown keys (strict, no passthrough)', () => {
    expect(() => FieldMappingSchema.parse({ ...direct, transformationType: 'uppercase' })).toThrow();
    expect(() => FieldMappingSchema.parse({ ...direct, extra: 1 })).toThrow();
    expect(() => FieldMappingSchema.parse({ ...lookup, transformationConfig: { ...lookup.transformationConfig, bogus: 1 } })).toThrow();
  });

  it('enforces the per-type config the engine actually reads', () => {
    // performLookup() throws without lookupTable; mappings alone are not enough.
    expect(() => FieldMappingSchema.parse({ ...lookup, transformationConfig: { type: 'lookup', mappings: { A: 'Alpha' } } })).toThrow(/lookupTable/);
    expect(() => FieldMappingSchema.parse({ ...calc, transformationConfig: { type: 'calculation' } })).toThrow(/expression/);
    expect(() => FieldMappingSchema.parse({ ...concat, transformationConfig: { type: 'concatenation', fields: [] } })).toThrow(/fields/);
    expect(() => FieldMappingSchema.parse({ ...concat, transformationConfig: undefined })).toThrow(/fields/);
    // Copilot on PR #1253: an empty field path is not a field.
    expect(() => FieldMappingSchema.parse({ ...concat, transformationConfig: { type: 'concatenation', fields: ['first', ''] } })).toThrow(/cannot be empty/);
  });

  it('rejects a calculation expression the engine cannot parse (Codex round 4 on PR #1253)', () => {
    expect(() => FieldMappingSchema.parse({ ...calc, transformationConfig: { type: 'calculation', expression: '1+' } })).toThrow(/not executable/);
    // The forms the repo actually uses all parse.
    for (const expression of ['parseInt(qty)', 'VALUE * 0.1', 'VALUE < 10 ? "Small" : "Large"']) {
      expect(FieldMappingSchema.parse({ ...calc, transformationConfig: { type: 'calculation', expression } }).transformationConfig?.expression).toBe(expression);
    }
  });

  it('validates cardinality as the runtime union, not as a loose object', () => {
    const agg = { resolution: 'aggregate', operator: 'join', separator: ',' } as const;
    expect(FieldMappingSchema.parse({ ...direct, cardinality: agg }).cardinality).toEqual(agg);
    const sel = { resolution: 'select_one', orderBy: [{ field: 'updatedAt', direction: 'desc' }], tieBreak: { field: 'id', direction: 'asc' } } as const;
    expect(FieldMappingSchema.parse({ ...direct, cardinality: sel }).cardinality).toEqual(sel);
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'aggregate', operator: 'average' } })).toThrow();
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'select_one' } })).toThrow(/orderBy|tieBreak/);
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'select_one', orderBy: [], tieBreak: { field: 'id', direction: 'asc' } } })).toThrow();
  });

  it('carries the aggregate rules the configuration validator enforces (Codex on PR #1253)', () => {
    // join needs a separator; a separator on any other operator is a mistake.
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'aggregate', operator: 'join' } })).toThrow(/join requires a separator/);
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'aggregate', operator: 'sum', separator: ',' } })).toThrow(/only valid for join/);
    expect(() => FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'aggregate', operator: 'join', separator: '' } })).toThrow(/cannot be empty/i);
    expect(FieldMappingSchema.parse({ ...direct, cardinality: { resolution: 'aggregate', operator: 'sum' } }).cardinality).toEqual({ resolution: 'aggregate', operator: 'sum' });
  });

  it.each(['__proto__', 'a.__proto__.b', 'constructor', 'x["prototype"]'])('rejects the magic lodash path %s as a target, source or concatenation field (Codex round 9 on PR #1253)', (path) => {
    expect(() => FieldMappingSchema.parse({ ...direct, targetField: path })).toThrow(/must not address/);
    expect(() => FieldMappingSchema.parse({ ...direct, sourceField: path })).toThrow(/must not address/);
    expect(() => FieldMappingSchema.parse({ ...concat, transformationConfig: { type: 'concatenation', fields: ['first', path] } })).toThrow(/must not address/);
  });
  it('rejects a lookup whose table cannot be resolved: a bare name with no mappings (Codex round 13)', () => {
    expect(() => FieldMappingSchema.parse({ ...lookup, transformationConfig: { type: 'lookup', lookupTable: 'named-table' } })).toThrow(/resolv/);
    // An inline JSON table resolves by itself; a name resolves through mappings.
    expect(FieldMappingSchema.parse({ ...lookup, transformationConfig: { type: 'lookup', lookupTable: '{"A":"Alpha"}' } }).transformationConfig?.lookupTable).toBe('{"A":"Alpha"}');
    expect(FieldMappingSchema.parse({ ...lookup, transformationConfig: { type: 'lookup', lookupTable: 'codes', mappings: { A: 'Alpha' } } }).transformationType).toBe('lookup');
    // JSON that is not an object is not a table either.
    expect(() => FieldMappingSchema.parse({ ...lookup, transformationConfig: { type: 'lookup', lookupTable: '[1,2]' } })).toThrow(/resolv/);
  });

  it.each(['[]', 'a.', '.a', 'a..b', 'a[]'])("rejects the path '%s' — lodash parses an EMPTY segment out of it (Codex round 13)", (bad) => {
    expect(() => FieldMappingSchema.parse({ ...direct, targetField: bad })).toThrow(/empty segment/);
    expect(() => FieldMappingSchema.parse({ ...direct, sourceField: bad })).toThrow(/empty segment/);
  });

  it('accepts a bracket-quoted key that contains a dot — the spelling for Business Central\'s "No." (Codex round 13)', () => {
    expect(FieldMappingSchema.parse({ ...direct, sourceField: '["No."]' }).sourceField).toBe('["No."]');
  });

  it('rejects an empty sourceField or targetField', () => {
    expect(() => FieldMappingSchema.parse({ ...direct, sourceField: '' })).toThrow();
    expect(() => FieldMappingSchema.parse({ ...direct, targetField: '' })).toThrow();
  });
});

describe('validateMappingSet / assertExecutable', () => {
  it('flags declared-only types unless drafts are explicitly allowed', () => {
    const set = [direct, { ...direct, targetField: 'Parts', transformationType: 'split' as const }];
    const strict = validateMappingSet(set);
    expect(strict.ok).toBe(false);
    expect(strict.issues).toHaveLength(1);
    expect(strict.issues[0]).toMatch(/split.*declared but not executable/);
    expect(strict.mappings).toEqual([]);
    const draft = validateMappingSet(set, { allowDeclaredOnly: true });
    expect(draft.ok).toBe(true);
    expect(draft.mappings).toEqual(set);
  });

  it('flags two spellings of one lodash path as the same target (Codex round 4 on PR #1253)', () => {
    for (const [x, y] of [['a.b', 'a[b]'], ['a.b', "a['b']"], ['items[0].sku', 'items.0.sku']]) {
      const r = validateMappingSet([{ ...direct, targetField: x }, { ...direct, sourceField: 'other', targetField: y }]);
      expect({ x, y, ok: r.ok }).toEqual({ x, y, ok: false });
      expect(r.issues[0]).toMatch(/addresses the same slot as/);
    }
    expect(validateMappingSet([{ ...direct, targetField: 'a.b' }, { ...direct, sourceField: 'other', targetField: 'a.c' }]).ok).toBe(true);
    // Codex round 5: a literal-dot property is a different slot from a nested path.
    expect(validateMappingSet([{ ...direct, targetField: 'a["b.c"]' }, { ...direct, sourceField: 'other', targetField: 'a.b.c' }]).ok).toBe(true);
  });

  it('flags duplicate targets and never returns a partial mapping list', () => {
    const dup = validateMappingSet([direct, { ...direct, sourceField: 'other' }]);
    expect(dup.ok).toBe(false);
    expect(dup.issues).toContain('duplicate targetField: Email');
    expect(dup.mappings).toEqual([]);
  });

  it('reports structural errors per entry with an index and path, and yields no mappings', () => {
    const r = validateMappingSet([direct, { sourceField: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.mappings).toEqual([]);
    expect(r.issues.some((i) => i.startsWith('[1] '))).toBe(true);
    expect(validateMappingSet('not an array').issues).toEqual(['mappings must be an array']);
  });

  it('pins the vocabularies and throws MappingContractError with the issues attached', () => {
    expect([...EXECUTABLE_TRANSFORMATIONS]).toEqual(['direct', 'lookup', 'calculation', 'concatenation']);
    expect([...DECLARED_ONLY_TRANSFORMATIONS]).toEqual(['concatenate', 'split', 'expression', 'conditional']);
    let caught: unknown;
    try {
      assertExecutable([{ ...direct, transformationType: 'expression' }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MappingContractError);
    expect((caught as MappingContractError).issues).toHaveLength(1);
    expect((caught as MappingContractError).message).toMatch(/mapping contract violated/);
    expect(assertExecutable([direct, lookup, calc, concat])).toEqual([direct, lookup, calc, concat]);
  });
});
