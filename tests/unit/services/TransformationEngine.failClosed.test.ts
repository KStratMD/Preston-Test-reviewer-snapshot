/**
 * Task A2 (tranche 2, Workstream A): the engine fails closed.
 *
 * Before this task, `applyFieldMapping`'s `default:` branch returned the source
 * value unchanged for any transformation type it had no implementation for, so
 * a mapping declaring `split`, `expression`, `conditional` or `concatenate`
 * passed its input straight through and the record was reported transformed.
 * `transformRecord()` then returned partial fields with no indication anything
 * was missing.
 *
 * Now: a declared-only type is an `UnsupportedTransformationError`, recorded by
 * `transform()` as `severity: 'error'` on the mapping's own target field
 * regardless of `isRequired`; a structurally invalid mapping set is rejected up
 * front as the `general` error; and `transformRecord()` throws
 * `TransformationFailedError` whenever the result is not a success.
 *
 * The rejection sits BEFORE the source-value lookup in `applyFieldMapping`,
 * because an optional mapping whose source field is missing returns early with
 * `{ value: undefined, warnings }` and would never reach the switch's `default`.
 */
import {
  TransformationEngine,
  UnsupportedTransformationError,
  TransformationFailedError,
} from '../../../src/services/TransformationEngine';
import type { FieldMapping } from '../../../src/types';

const createLogger = () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });
const buildEngine = () => new TransformationEngine(createLogger() as any);

const record = { id: 'r1', externalId: 'r1', fields: { first: 'Ada', last: 'Lovelace', code: 'A', qty: '3' }, metadata: {} } as any;
const optionalSplit: FieldMapping = {
  sourceField: 'first',
  targetField: 'parts',
  transformationType: 'split',
  isRequired: false,
  transformationConfig: { type: 'split', separator: ' ' },
};

describe('TransformationEngine fails closed', () => {
  let engine: TransformationEngine;
  beforeEach(() => {
    engine = buildEngine();
  });

  it('transform() reports an OPTIONAL unsupported mapping as an error attributed to its target field', async () => {
    const r = await engine.transform({ sourceData: record, mappings: [optionalSplit], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors).toEqual([
      expect.objectContaining({ field: 'parts', severity: 'error', message: expect.stringMatching(/declared but not executable/) }),
    ]);
  });

  it.each(['concatenate', 'expression', 'conditional'] as const)('transform() rejects the declared-only type %s the same way', async (t) => {
    const r = await engine.transform({ sourceData: record, mappings: [{ ...optionalSplit, transformationType: t, transformationConfig: { type: t } }], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'parts', severity: 'error' });
  });

  it('transform() reports a structurally invalid mapping set as a general error and executes nothing', async () => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 1 } as never], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].field).toBe('general');
    expect(r.errors[0].message).toMatch(/mapping set invalid/);
    expect(r.errors[0].message).toMatch(/\[0\] sourceField/);
    // The general-failure shape is pre-existing: transformedData echoes the
    // untouched source record. Nothing was executed — no target field appears.
    expect(r.transformedData.fields).toEqual(record.fields);
  });

  it('transform() rejects a lookup whose config the engine could not execute, before executing anything', async () => {
    // performLookup() would throw at runtime; the structural check says so up front.
    const r = await engine.transform({
      sourceData: record,
      mappings: [
        { sourceField: 'first', targetField: 'FirstName', transformationType: 'direct', isRequired: true },
        { sourceField: 'code', targetField: 'CodeName', transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup' } },
      ],
      rules: [],
    });
    expect(r.success).toBe(false);
    expect(r.errors[0].field).toBe('general');
    expect(r.errors[0].message).toMatch(/\[1\] mapping: lookup requires transformationConfig.lookupTable/);
    // The valid direct mapping in the same set was NOT executed: no FirstName.
    expect(r.transformedData.fields).toEqual(record.fields);
    expect(r.transformedData.fields).not.toHaveProperty('FirstName');
  });

  it('a __proto__ target is rejected structurally — before this it validated, _.set wrote nothing, and the record was reported transformed (Codex round 9)', async () => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'first', targetField: '__proto__', transformationType: 'direct', isRequired: true }], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'general', message: expect.stringMatching(/must not address/) });
    await expect(engine.transformRecord(record, [{ sourceField: 'first', targetField: '__proto__', transformationType: 'direct', isRequired: true }], [])).rejects.toThrow(TransformationFailedError);
  });
  it('transformRecord() throws instead of returning partial fields', async () => {
    await expect(engine.transformRecord(record, [optionalSplit], [])).rejects.toThrow(TransformationFailedError);
  });

  it('transformRecord() carries the per-field errors on the thrown error', async () => {
    let caught: unknown;
    try {
      await engine.transformRecord(record, [optionalSplit], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransformationFailedError);
    expect((caught as TransformationFailedError).errors).toEqual([expect.objectContaining({ field: 'parts', severity: 'error' })]);
    expect((caught as TransformationFailedError).message).toMatch(/parts: .*declared but not executable/);
  });

  it('transformRecord() still executes direct, lookup, calculation and concatenation', async () => {
    const out = await engine.transformRecord(
      record,
      [
        { sourceField: 'first', targetField: 'FirstName', transformationType: 'direct', isRequired: true },
        { sourceField: 'code', targetField: 'CodeName', transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup', lookupTable: 'codes', mappings: { A: 'Alpha' } } },
        { sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(qty)' } },
        { sourceField: 'first', targetField: 'Full', transformationType: 'concatenation', isRequired: false, transformationConfig: { type: 'concatenation', fields: ['first', 'last'], separator: ' ' } },
      ],
      [],
    );
    expect(out).toMatchObject({ FirstName: 'Ada', CodeName: 'Alpha', Qty: 3, Full: 'Ada Lovelace' });
  });

  it('an OPTIONAL mapping whose execution fails is an error, not a warning (Codex round 3: an expression that fails at run time is a mapping defect, not missing data)', async () => {
    // 'qty * ghost' PARSES (so it passes the contract, which since round 4 runs
    // the engine's parser) and fails at evaluation: ghost is not a field.
    const failing: FieldMapping = { sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: false, transformationConfig: { type: 'calculation', expression: 'qty * ghost' } };
    const r = await engine.transform({ sourceData: record, mappings: [failing], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'Qty', severity: 'error' });
    await expect(engine.transformRecord(record, [failing], [])).rejects.toThrow(TransformationFailedError);
  });

  it('a syntactically malformed expression is rejected structurally, before anything executes (Codex round 4)', async () => {
    const r = await engine.transform({
      sourceData: record,
      mappings: [{ sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: false, transformationConfig: { type: 'calculation', expression: '1+' } }],
      rules: [],
    });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'general', message: expect.stringMatching(/not executable/) });
  });

  it('parseInt(VALUE) resolves VALUE to the selected source value, not to a field named VALUE (Codex round 10)', async () => {
    const mapping: FieldMapping = { sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(VALUE)' } };
    const r = await engine.transform({ sourceData: record, mappings: [mapping], rules: [] });
    expect(r.errors).toEqual([]);
    expect(r.success).toBe(true);
    expect(r.transformedData.fields).toHaveProperty('Qty', 3);
  });

  it('parseInt(field) fails when the referenced field is absent instead of producing NaN (Codex round 3)', async () => {
    const mapping: FieldMapping = { sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(ghost)' } };
    const r = await engine.transform({ sourceData: record, mappings: [mapping], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'Qty', severity: 'error', message: expect.stringMatching(/ghost is missing/) });
    expect(r.transformedData.fields).not.toHaveProperty('Qty');
  });

  it.each(['VALUE / 0', 'qty * 1e308 * 1e308', '-VALUE / 0'])('a calculation whose result is non-finite (%s) is an error, not a written Infinity (Codex round 5)', async (expression) => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'qty', targetField: 'Qty', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression } }], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'Qty', severity: 'error', message: expect.stringMatching(/non-finite/) });
    expect(r.transformedData.fields).not.toHaveProperty('Qty');
  });

  it.each([
    ['a string', 'VALUE < 10 ? "Small" : "Large"', 'Small'],
    ['a boolean', 'qty > 1', true],
    ['a finite number', 'qty * 2', 6],
  ])('a calculation may yield %s — the contract is "a finite number or another scalar", not "a number" (Codex round 7)', async (_label, expression, expected) => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'qty', targetField: 'Out', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression } }], rules: [] });
    expect(r.success).toBe(true);
    expect((r.transformedData.fields as Record<string, unknown>).Out).toEqual(expected);
  });

  it('VALUE is a bound variable, not text spliced into the expression — a source string "null" stays a string (Codex round 9)', async () => {
    const src = { ...record, fields: { ...record.fields, text: 'null' } };
    const r = await engine.transform({ sourceData: src, mappings: [{ sourceField: 'text', targetField: 'Out', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: "VALUE == null ? 'MISSING' : 'PRESENT'" } }], rules: [] });
    expect(r.success).toBe(true);
    expect((r.transformedData.fields as Record<string, unknown>).Out).toBe('PRESENT');
    // ...and VALUE still carries the source value for arithmetic (the repo's own `VALUE * 0.1`).
    const n = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'qty', targetField: 'Tenth', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'VALUE * 0.1' } }], rules: [] });
    expect(n.success).toBe(true);
    expect((n.transformedData.fields as Record<string, unknown>).Tenth).toBeCloseTo(0.3, 5);
  });
  it('a string literal that happens to spell "null" is a legitimate result (Copilot on PR #1253: the old check scanned the expression TEXT)', async () => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'qty', targetField: 'Out', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'VALUE < 10 ? "null" : "x"' } }], rules: [] });
    expect(r.success).toBe(true);
    expect((r.transformedData.fields as Record<string, unknown>).Out).toBe('null');
  });
  it.each(['undefined', 'null'])('a calculation whose result is %s is an error (nothing nullish is written)', async (expression) => {
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'qty', targetField: 'Out', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression } }], rules: [] });
    expect(r.success).toBe(false);
    expect(r.transformedData.fields).not.toHaveProperty('Out');
  });
  it('parseInt(field) fails on an overflowing digit string instead of writing Infinity (Codex round 8)', async () => {
    const huge = { ...record, fields: { ...record.fields, big: '9'.repeat(400) } };
    const mapping: FieldMapping = { sourceField: 'big', targetField: 'N', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(big)' } };
    const r = await engine.transform({ sourceData: huge, mappings: [mapping], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0].message).toMatch(/not a finite number/);
    expect(r.transformedData.fields).not.toHaveProperty('N');
  });

  it('parseInt(field) fails on a non-numeric value instead of writing NaN (Codex round 3)', async () => {
    const mapping: FieldMapping = { sourceField: 'first', targetField: 'N', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(first)' } };
    const r = await engine.transform({ sourceData: record, mappings: [mapping], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0].message).toMatch(/is not a finite number/);
  });
  it('a required mapping whose source is missing is still an ordinary required-field error, not an unsupported-type error', async () => {
    const r = await engine.transform({
      sourceData: { ...record, fields: {} },
      mappings: [{ sourceField: 'first', targetField: 'FirstName', transformationType: 'direct', isRequired: true }],
      rules: [],
    });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'FirstName', severity: 'error', message: expect.stringMatching(/Required source field/) });
  });

  it('an OPTIONAL mapping whose source is missing stays a warning (the fail-closed change is scoped to unsupported types)', async () => {
    const r = await engine.transform({
      sourceData: { ...record, fields: {} },
      mappings: [{ sourceField: 'first', targetField: 'FirstName', transformationType: 'direct', isRequired: false }],
      rules: [],
    });
    expect(r.success).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Missing optional source field/.test(w))).toBe(true);
  });

  it('a declared-only type is rejected even when its optional source field is missing (rejection precedes the missing-value early return)', async () => {
    await expect(engine['applyFieldMapping']({ ...record, fields: {} }, optionalSplit)).rejects.toThrow(UnsupportedTransformationError);
    const out = await engine.transform({ sourceData: { ...record, fields: {} }, mappings: [optionalSplit], rules: [] });
    expect(out.success).toBe(false);
    expect(out.errors[0]).toMatchObject({ field: 'parts', severity: 'error' });
  });

  it('a lookup whose table cannot be resolved is an error even when the mapping is optional (Codex round 13)', async () => {
    const mapping: FieldMapping = { sourceField: 'code', targetField: 'Code', transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup', lookupTable: 'named-table' } };
    const r = await engine.transform({ sourceData: record, mappings: [mapping], rules: [] });
    expect(r.success).toBe(false);
    // The contract refuses it structurally first (field 'general'); the engine's own
    // guard in performLookup() is defence in depth behind that.
    expect(r.errors[0]).toMatchObject({ severity: 'error', message: expect.stringMatching(/resolv/) });
    expect(r.transformedData.fields).not.toHaveProperty('Code');
  });

  it.each(['toString', 'hasOwnProperty', 'valueOf'])("a REQUIRED source named '%s' that the record does not own is missing, not Object.prototype's function (Codex round 13)", async (sourceField) => {
    const mapping: FieldMapping = { sourceField, targetField: 'leaked', transformationType: 'direct', isRequired: true };
    const r = await engine.transform({ sourceData: record, mappings: [mapping], rules: [] });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: 'leaked', severity: 'error', message: expect.stringMatching(/missing/) });
    expect(r.transformedData.fields).not.toHaveProperty('leaked');
  });

  it('an OPTIONAL source the record does not own produces no field — the record still wins when it owns the name', async () => {
    const own = { ...record, fields: { ...record.fields, toString: 'owned' } };
    const optional: FieldMapping = { sourceField: 'toString', targetField: 'T', transformationType: 'direct', isRequired: false };
    expect((await engine.transform({ sourceData: record, mappings: [optional], rules: [] })).transformedData.fields).not.toHaveProperty('T');
    expect((await engine.transform({ sourceData: own, mappings: [optional], rules: [] })).transformedData.fields).toHaveProperty('T', 'owned');
  });

  it.each(['TRANSFORMATION', 'VALIDATION', 'ENRICHMENT', 'FILTER'] as const)("a transformation rule of declared-only type %s is an error, never a warning beside success:true (Codex round 13)", async (type) => {
    const rule = { id: 'r1', name: 'legacy', type, action: 'transform' as const, parameters: { targetField: 'first' } };
    const r = await engine.transform({ sourceData: record, mappings: [{ sourceField: 'first', targetField: 'first', transformationType: 'direct', isRequired: true }], rules: [rule as any] });
    expect(r.success).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ rule: 'r1', severity: 'error', message: expect.stringMatching(/declared but not executable/) })]);
    expect(r.warnings).not.toEqual(expect.arrayContaining([expect.stringMatching(/Unknown rule type/)]));
  });

  describe('lookups are never served from a cache keyed by table NAME (Codex round 14)', () => {
    const lookupOn = (targetField: string, mappings: Record<string, unknown>, required = false): FieldMapping =>
      ({ sourceField: 'code', targetField, transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup', lookupTable: 'shared', mappings, required } });

    it('two mappings sharing a table name but not a table each resolve through their own', async () => {
      const r = await engine.transform({ sourceData: record, mappings: [lookupOn('first_', { A: 'ONE' }), lookupOn('second_', { A: 'TWO' })], rules: [] });
      expect(r.errors).toEqual([]);
      expect(r.transformedData.fields).toMatchObject({ first_: 'ONE', second_: 'TWO' });
    });

    it('an optional miss on a table+value never satisfies a lookup whose config says required, for the same table+value later', async () => {
      const first = await engine.transform({ sourceData: record, mappings: [lookupOn('opt', { Z: 'z' })], rules: [] });
      expect(first.success).toBe(true);
      const second = await engine.transform({ sourceData: record, mappings: [lookupOn('req', { Z: 'z' }, true)], rules: [] });
      expect(second.success).toBe(false);
      expect(second.errors[0]).toMatchObject({ field: 'req', severity: 'error', message: expect.stringMatching(/Lookup value not found/) });
    });
  });

  describe('operator words are rewritten OUTSIDE string literals only (Codex round 14)', () => {
    const setFlag = (condition: string) => ({ id: 'r1', name: 'n', type: 'business_logic' as const, action: 'transform' as const, condition, parameters: { type: 'business_logic', expression: '1', context: { targetField: 'flag' } } });
    const mapping: FieldMapping = { sourceField: 'status', targetField: 'status', transformationType: 'direct', isRequired: true };
    const withStatus = (status: string) => ({ ...record, fields: { ...record.fields, status } });

    it('a string literal "and" stays a string: the rule applies when the field holds "and"', async () => {
      const r = await engine.transform({ sourceData: withStatus('and'), mappings: [mapping], rules: [setFlag('status == "and"') as any] });
      expect(r.errors).toEqual([]);
      expect(r.transformedData.fields).toHaveProperty('flag', 1);
    });

    it('...and the operator word outside literals still works', async () => {
      const r = await engine.transform({ sourceData: withStatus('open'), mappings: [mapping], rules: [setFlag('status == "open" and qty gt 1') as any] });
      expect(r.errors).toEqual([]);
      expect(r.transformedData.fields).toHaveProperty('flag', 1);
    });
  });

  describe('business_logic expressions bind ${path} references as VALUES (Codex round 14)', () => {
    const rule = (expression: string) => ({ id: 'b1', name: 'n', type: 'business_logic' as const, action: 'transform' as const, parameters: { type: 'business_logic', expression, context: { targetField: 'out' } } });
    const mapping: FieldMapping = { sourceField: 'payload', targetField: 'payload', transformationType: 'direct', isRequired: true };
    const withPayload = (payload: string) => ({ ...record, fields: { ...record.fields, payload } });

    it('a generated reference name never shadows a real field named like it (Codex round 15: __ref0 = 100 was overwritten)', async () => {
      const src = { ...record, fields: { ...record.fields, payload: 1, __ref0: 100 } };
      const both: FieldMapping[] = [{ sourceField: 'payload', targetField: 'payload', transformationType: 'direct', isRequired: true }, { sourceField: '__ref0', targetField: '__ref0', transformationType: 'direct', isRequired: true }];
      const r = await engine.transform({ sourceData: src, mappings: both, rules: [rule('${payload} + __ref0') as any] });
      expect(r.errors).toEqual([]);
      expect(r.transformedData.fields).toHaveProperty('out', 101);
    });

    it('a generated name never reuses the name of a NON-scalar field either: bare __ref0 stays unknown, not the reference (Codex round 16)', async () => {
      const src = { ...record, fields: { ...record.fields, payload: 1, __ref0: { not: 'scalar' } } };
      const both: FieldMapping[] = [{ sourceField: 'payload', targetField: 'payload', transformationType: 'direct', isRequired: true }, { sourceField: '__ref0', targetField: '__ref0', transformationType: 'direct', isRequired: true }];
      const r = await engine.transform({ sourceData: src, mappings: both, rules: [rule('${payload} + __ref0') as any] });
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ rule: 'b1', severity: 'error', message: expect.stringMatching(/__ref0/) })]);
      expect(r.transformedData.fields).not.toHaveProperty('out');
    });

    it.each([[{ a: 1 }], [[2]], [[2, 3]]])('a ${path} reference to %j is an error, never the number the evaluator coerced it to (Codex round 15)', async (payload) => {
      const src = { ...record, fields: { ...record.fields, payload } };
      const r = await engine.transform({ sourceData: src, mappings: [mapping], rules: [rule('${payload}') as any] });
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ rule: 'b1', severity: 'error', message: expect.stringMatching(/not a scalar/) })]);
      expect(r.transformedData.fields).not.toHaveProperty('out');
    });

    it.each(['__proto__.polluted', 'constructor.prototype.polluted', 'a..b', '[]'])("a business_logic targetField of '%s' is an error, not a silent no-op write reported as success (Codex round 15)", async (targetField) => {
      const bad = { id: 'b1', name: 'n', type: 'business_logic' as const, action: 'transform' as const, parameters: { type: 'business_logic', expression: '1', context: { targetField } } };
      const r = await engine.transform({ sourceData: withPayload('x'), mappings: [mapping], rules: [bad as any] });
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ rule: 'b1', severity: 'error', message: expect.stringMatching(/target path/) })]);
    });

    it.each(['hello', 'true', 'false', 'null', '1 + 1'])("the string %j comes through as itself, not as expression source", async (payload) => {
      const r = await engine.transform({ sourceData: withPayload(payload), mappings: [mapping], rules: [rule('${payload}') as any] });
      expect(r.errors).toEqual([]);
      expect(r.transformedData.fields).toHaveProperty('out', payload);
    });
  });

  describe('rule conditions are evaluated over BOUND fields, never spliced text (Codex round 13)', () => {
    const rule = (condition: string) => ({ id: 'r1', name: 'n', type: 'enrichment' as const, action: 'enrich' as const, condition, parameters: { targetField: 'flag', value: 'on' } });
    const flagMapping: FieldMapping = { sourceField: 'first', targetField: 'first', transformationType: 'direct', isRequired: true };

    it('a bare field reference resolves to the record\'s own value', async () => {
      const r = await engine.transform({ sourceData: record, mappings: [flagMapping], rules: [rule('qty != null and first == "Ada"') as any] });
      expect(r.errors).toEqual([]);
      expect(r.success).toBe(true);
    });

    it('a ${path} reference to an OBJECT is an error, never a number the evaluator coerced it to (Codex round 15: {a:1} evaluated as 0)', async () => {
      const nested = { ...record, fields: { ...record.fields, addr: { city: 'Paris' } } };
      const r = await engine.transform({ sourceData: nested, mappings: [flagMapping], rules: [rule('${addr} != null') as any] });
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ rule: 'r1', severity: 'error', message: expect.stringMatching(/not a scalar/) })]);
    });

    it('a bare identifier naming an OBJECT field is unknown to the condition, not a coerced number (Codex round 15)', async () => {
      const nested = { ...record, fields: { ...record.fields, addr: { city: 'Paris' } } };
      const r = await engine.transform({ sourceData: nested, mappings: [flagMapping], rules: [rule('addr != null') as any] });
      expect(r.success).toBe(false);
      expect(r.errors[0]).toMatchObject({ rule: 'r1', severity: 'error' });
    });

    it('a ${path} reference holding quotes stays a value (the old splice escaped quotes too — this pins that binding keeps it so)', async () => {
      const quoted = { ...record, fields: { ...record.fields, first: '" == "" or "' } };
      const r = await engine.transform({ sourceData: quoted, mappings: [flagMapping], rules: [rule('${first} == "Ada"') as any] });
      expect(r.errors).toEqual([]);
      expect(r.success).toBe(true);
      expect(r.transformedData.fields).not.toHaveProperty('flag');
    });

    it('a ${path} to a field the record does not own is null, not Object.prototype', async () => {
      const r = await engine.transform({ sourceData: record, mappings: [flagMapping], rules: [rule('${toString} == null') as any] });
      expect(r.errors).toEqual([]);
      expect(r.success).toBe(true);
    });

    it('a condition that cannot be parsed is an error against its rule, not a silent skip', async () => {
      const r = await engine.transform({ sourceData: record, mappings: [flagMapping], rules: [rule('a b c') as any] });
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([expect.objectContaining({ rule: 'r1', severity: 'error', message: expect.stringMatching(/could not be parsed/) })]);
    });
  });

  it('the default branch throws UnsupportedTransformationError with the type and source field attached', async () => {
    let caught: unknown;
    try {
      await engine['applyFieldMapping'](record, optionalSplit);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedTransformationError);
    expect(caught).toMatchObject({ transformationType: 'split', sourceField: 'first' });
  });
});
