/**
 * Task A3: the `/api/mappings` route shape is adapted to the canonical contract
 * at the boundary. Every accepted word names a type the engine executes; the
 * result passes FieldMappingSchema; anything else is a MappingContractError.
 */
import { fromRouteMapping, ROUTE_TRANSFORMATIONS } from '../../../../../src/domain/mapping/adapters/fromRouteMapping';
import { MappingContractError, EXECUTABLE_TRANSFORMATIONS } from '../../../../../src/domain/mapping/MappingContract';

describe('fromRouteMapping', () => {
  it('adapts direct, lookup, calculation and concatenation', () => {
    expect(fromRouteMapping({ source: 'a', target: 'b', transformation: 'direct' })).toEqual({
      sourceField: 'a', targetField: 'b', transformationType: 'direct', isRequired: false,
    });
    expect(fromRouteMapping({ source: 'a', target: 'b', transformation: 'lookup', params: { table: 'codes', map: { x: 'y' } } }).transformationConfig)
      .toEqual({ type: 'lookup', lookupTable: 'codes', mappings: { x: 'y' } });
    expect(fromRouteMapping({ source: 'a', target: 'b', transformation: 'calculation', params: { expr: 'parseInt(a)' } }).transformationConfig)
      .toEqual({ type: 'calculation', expression: 'parseInt(a)' });
    expect(fromRouteMapping({ source: 'a', target: 'b', transformation: 'concatenation', params: { fields: ['a', 'c'], separator: ' ' } }).transformationConfig)
      .toEqual({ type: 'concatenation', fields: ['a', 'c'], separator: ' ' });
  });

  it('accepts exactly the executable vocabulary and nothing the engine cannot run', () => {
    expect([...ROUTE_TRANSFORMATIONS]).toEqual([...EXECUTABLE_TRANSFORMATIONS]);
    for (const t of ['format', 'concatenate', 'conditional', 'uppercase', 'lowercase', 'trim', 'replace', 'split', 'expression', '']) {
      expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: t })).toThrow(MappingContractError);
    }
  });

  it('rejects an executable word whose params the engine would fail on', () => {
    // performLookup() throws without lookupTable; performCalculation needs an expression;
    // performConcatenation iterates fields. The adapter says so before the store does.
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'lookup', params: { map: { x: 'y' } } })).toThrow(/lookupTable/);
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'lookup' })).toThrow(MappingContractError);
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'calculation' })).toThrow(/expression/);
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'calculation', params: { expr: '' } })).toThrow(/expression/);
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'concatenation', params: { fields: [] } })).toThrow(/fields/);
    expect(() => fromRouteMapping({ source: 'a', target: 'b', transformation: 'concatenation', params: { fields: 'a,b' } })).toThrow(/fields/);
  });

  it('never smuggles unknown params through to the contract', () => {
    const m = fromRouteMapping({ source: 'a', target: 'b', transformation: 'direct', params: { template: '{{a}}', bogus: 1 } });
    expect(m).not.toHaveProperty('transformationConfig');
    const l = fromRouteMapping({ source: 'a', target: 'b', transformation: 'lookup', params: { table: 't', map: { a: 'b' }, bogus: 1 } });
    expect(l.transformationConfig).toEqual({ type: 'lookup', lookupTable: 't', mappings: { a: 'b' } });
  });

  it('rejects an empty source or target', () => {
    expect(() => fromRouteMapping({ source: '', target: 'b', transformation: 'direct' })).toThrow(MappingContractError);
    expect(() => fromRouteMapping({ source: 'a', target: '', transformation: 'direct' })).toThrow(MappingContractError);
  });

  it('attaches every contract issue to the thrown error', () => {
    let caught: unknown;
    try {
      fromRouteMapping({ source: 'a', target: 'b', transformation: 'lookup', params: { table: '' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MappingContractError);
    expect((caught as MappingContractError).issues[0]).toMatch(/^a -> b: /);
  });
});
