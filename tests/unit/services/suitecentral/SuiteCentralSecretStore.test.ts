import { SuiteCentralSecretStore } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralSecretStore';
import { SuiteCentralValidationError } from '../../../../src/services/suitecentral/controlPlane/errors';

function makeStore() {
  const secretManager = {
    setSecret: jest.fn(async () => undefined),
    getSecret: jest.fn(async () => ({ value: 'plaintext-secret' })),
    deleteSecret: jest.fn(async () => undefined),
  };
  const store = new SuiteCentralSecretStore(secretManager as never);
  return { store, secretManager };
}

describe('SuiteCentralSecretStore', () => {
  describe('referenceFor', () => {
    it('is a deterministic, PII-free suitecentral-<sha256> reference', () => {
      const { store } = makeStore();
      const ref = store.referenceFor('tenant A', 'profile/1');
      expect(ref).toMatch(/^suitecentral-[a-f0-9]{64}$/);
      expect(store.referenceFor('tenant A', 'profile/1')).toBe(ref);
    });

    it('differs by tenant and profile', () => {
      const { store } = makeStore();
      expect(store.referenceFor('tenant B', 'profile/1')).not.toBe(store.referenceFor('tenant A', 'profile/1'));
      expect(store.referenceFor('tenant A', 'profile/2')).not.toBe(store.referenceFor('tenant A', 'profile/1'));
    });

    it('does not collide across separator boundaries', () => {
      const { store } = makeStore();
      expect(store.referenceFor('a', 'bc')).not.toBe(store.referenceFor('ab', 'c'));
    });

    it('is injective even when a component contains the separator (NUL)', () => {
      const { store } = makeStore();
      const NUL = String.fromCharCode(0);
      // Under a plain NUL-delimited join these would collide; JSON keeps them distinct.
      expect(store.referenceFor('a' + NUL + 'b', 'c')).not.toBe(store.referenceFor('a', 'b' + NUL + 'c'));
    });
  });

  describe('store and resolve', () => {
    it('stores under the deterministic reference and returns it', async () => {
      const { store, secretManager } = makeStore();
      const ref = await store.store('tenant-a', 'p1', 'super-secret');
      expect(ref).toBe(store.referenceFor('tenant-a', 'p1'));
      expect(secretManager.setSecret).toHaveBeenCalledWith(ref, 'super-secret');
    });

    it('resolves the value for a matching reference with no-cache, no-env-fallback', async () => {
      const { store, secretManager } = makeStore();
      const ref = store.referenceFor('tenant-a', 'p1');
      const value = await store.resolve({ tenantId: 'tenant-a', profileId: 'p1', storedRef: ref });
      expect(value).toBe('plaintext-secret');
      // SuiteCentral secrets must never be cached and must fail closed on a
      // provider outage rather than falling back to process.env.
      expect(secretManager.getSecret).toHaveBeenCalledWith(ref, { bypassCache: true, noEnvFallback: true });
    });
  });

  describe('reference verification (fail-closed, no backend round-trip)', () => {
    it('rejects a forged reference before touching the backend', async () => {
      const { store, secretManager } = makeStore();
      await expect(
        store.resolve({ tenantId: 'tenant-a', profileId: 'p1', storedRef: 'forged' }),
      ).rejects.toMatchObject({ code: 'secret_reference_mismatch' });
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });

    it('rejects another tenant reference so a read cannot cross tenants', async () => {
      const { store, secretManager } = makeStore();
      const otherTenantRef = store.referenceFor('tenant-b', 'p1');
      await expect(
        store.resolve({ tenantId: 'tenant-a', profileId: 'p1', storedRef: otherTenantRef }),
      ).rejects.toBeInstanceOf(SuiteCentralValidationError);
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });

    it('rotate and delete also verify the reference first', async () => {
      const { store, secretManager } = makeStore();
      await expect(store.rotate('tenant-a', 'p1', 'forged', 'new')).rejects.toMatchObject({ code: 'secret_reference_mismatch' });
      await expect(store.delete('tenant-a', 'p1', 'forged')).rejects.toMatchObject({ code: 'secret_reference_mismatch' });
      expect(secretManager.setSecret).not.toHaveBeenCalled();
      expect(secretManager.deleteSecret).not.toHaveBeenCalled();
    });

    it('rotate and delete succeed with a matching reference', async () => {
      const { store, secretManager } = makeStore();
      const ref = store.referenceFor('tenant-a', 'p1');
      await store.rotate('tenant-a', 'p1', ref, 'new-secret');
      expect(secretManager.setSecret).toHaveBeenCalledWith(ref, 'new-secret');
      await store.delete('tenant-a', 'p1', ref);
      expect(secretManager.deleteSecret).toHaveBeenCalledWith(ref);
    });
  });
});
