import { validateApplyAction } from '../../../../src/services/syncErrorAssist/applyAction';

describe('validateApplyAction', () => {
  it('accepts a well-formed create action', () => {
    const result = validateApplyAction({
      type: 'create',
      entityType: 'item',
      payload: { name: 'Widget', sku: 'W-1234' },
    });
    expect(result).toEqual({
      type: 'create',
      entityType: 'item',
      payload: { name: 'Widget', sku: 'W-1234' },
    });
  });

  it('accepts a well-formed update action', () => {
    const result = validateApplyAction({
      type: 'update',
      entityType: 'invoice',
      recordId: '5678',
      patch: { taxRate: 0.07 },
    });
    expect(result).toEqual({
      type: 'update',
      entityType: 'invoice',
      recordId: '5678',
      patch: { taxRate: 0.07 },
    });
  });

  it('rejects null', () => {
    expect(validateApplyAction(null)).toBeNull();
  });

  it('rejects unknown type', () => {
    expect(validateApplyAction({ type: 'delete', entityType: 'item' })).toBeNull();
  });

  it('rejects create missing payload', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item' })).toBeNull();
  });

  it('rejects update missing recordId', () => {
    expect(validateApplyAction({ type: 'update', entityType: 'invoice', patch: {} })).toBeNull();
  });

  it('rejects entityType empty string', () => {
    expect(validateApplyAction({ type: 'create', entityType: '', payload: {} })).toBeNull();
  });

  it('rejects payload that is an array (not a plain object)', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload: [1, 2] })).toBeNull();
  });

  it('rejects payload that is a Date instance (built-in object, not plain)', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload: new Date() })).toBeNull();
  });

  it('rejects payload that is a RegExp instance', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload: /abc/ })).toBeNull();
  });

  it('rejects payload that is a Map instance', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload: new Map() })).toBeNull();
  });

  it('rejects payload that is a Set instance', () => {
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload: new Set() })).toBeNull();
  });

  it('rejects update patch that is a Date / RegExp / Map / Set instance', () => {
    for (const v of [new Date(), /x/, new Map(), new Set()]) {
      expect(validateApplyAction({ type: 'update', entityType: 'invoice', recordId: '1', patch: v })).toBeNull();
    }
  });

  it('accepts an Object.create(null) payload (plain prototype-less object is still plain)', () => {
    const payload = Object.create(null);
    payload.name = 'Widget';
    const result = validateApplyAction({ type: 'create', entityType: 'item', payload });
    expect(result).not.toBeNull();
  });

  it('rejects payload with NESTED Date/RegExp/Map/Set instance (deep-walk guard)', () => {
    for (const v of [new Date(), /x/, new Map(), new Set()]) {
      expect(validateApplyAction({ type: 'create', entityType: 'item', payload: { meta: { ts: v } } })).toBeNull();
    }
  });

  it('rejects update patch with nested built-in instance (deep-walk guard on update path)', () => {
    expect(validateApplyAction({
      type: 'update',
      entityType: 'item',
      recordId: '123',
      patch: { attrs: { tags: new Set(['a']) } },
    })).toBeNull();
  });

  it('rejects payload with built-in instance inside nested array', () => {
    expect(validateApplyAction({
      type: 'create', entityType: 'item',
      payload: { tags: [{ at: new Date() }] },
    })).toBeNull();
  });

  it('rejects payload with function value (not JSON-safe)', () => {
    expect(validateApplyAction({
      type: 'create', entityType: 'item',
      payload: { fn: () => 1 },
    })).toBeNull();
  });

  it('accepts deeply nested plain objects + arrays + primitives', () => {
    expect(validateApplyAction({
      type: 'create', entityType: 'item',
      payload: { a: { b: [1, 'two', true, null, { c: 'deep' }] } },
    })).not.toBeNull();
  });

  it('rejects circular reference in payload (cycle detection)', () => {
    const payload: Record<string, unknown> = { name: 'Widget' };
    payload.self = payload;
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload })).toBeNull();
  });

  it('rejects own-property __proto__ at top level (prototype-pollution defense)', () => {
    // JSON.parse leaves __proto__ as a real own property (not a setter).
    const payload = JSON.parse('{"__proto__":{"polluted":true},"name":"Widget"}');
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload })).toBeNull();
  });

  it('rejects __proto__ nested anywhere in the payload', () => {
    const payload = JSON.parse('{"meta":{"nested":{"__proto__":{"polluted":true}}}}');
    expect(validateApplyAction({ type: 'create', entityType: 'item', payload })).toBeNull();
  });

  it('rejects payload with constructor key', () => {
    expect(validateApplyAction({
      type: 'create', entityType: 'item',
      payload: { constructor: { polluted: true } },
    })).toBeNull();
  });

  it('rejects payload with prototype key', () => {
    expect(validateApplyAction({
      type: 'create', entityType: 'item',
      payload: { prototype: { polluted: true } },
    })).toBeNull();
  });

  it('rejects update patch with FORBIDDEN_KEYS at any depth', () => {
    const patch = JSON.parse('{"deeply":{"nested":{"constructor":{}}}}');
    expect(validateApplyAction({
      type: 'update', entityType: 'item', recordId: '1', patch,
    })).toBeNull();
  });
});
