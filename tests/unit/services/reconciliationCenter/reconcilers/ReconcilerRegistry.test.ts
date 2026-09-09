import {
  ReconcilerRegistry,
  UnknownReconcilerError,
} from '../../../../../src/services/reconciliationCenter/reconcilers/Reconciler';
import type { Reconciler } from '../../../../../src/services/reconciliationCenter/reconcilers/Reconciler';

const stub = (key: string): Reconciler => ({ key, validateConfig: jest.fn(), run: jest.fn().mockResolvedValue([]) });

describe('ReconcilerRegistry', () => {
  it('returns a registered reconciler by key', () => {
    const reg = new ReconcilerRegistry();
    const r = stub('k1');
    reg.register(r);
    expect(reg.get('k1')).toBe(r);
  });

  it('throws UnknownReconcilerError for an unregistered key', () => {
    const reg = new ReconcilerRegistry();
    expect(() => reg.get('nope')).toThrow(UnknownReconcilerError);
    expect(() => reg.get('nope')).toThrow(/nope/);
  });

  it('last registration for a key wins', () => {
    const reg = new ReconcilerRegistry();
    const a = stub('k');
    const b = stub('k');
    reg.register(a);
    reg.register(b);
    expect(reg.get('k')).toBe(b);
  });

  it('has() reports whether a key is registered', () => {
    const registry = new ReconcilerRegistry();
    registry.register({ key: 'k1', validateConfig: jest.fn(), run: async () => [] });
    expect(registry.has('k1')).toBe(true);
    expect(registry.has('missing')).toBe(false);
    expect(registry.has('')).toBe(false);
  });
});
