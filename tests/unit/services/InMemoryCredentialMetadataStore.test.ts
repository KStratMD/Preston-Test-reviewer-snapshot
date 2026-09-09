/**
 * InMemoryCredentialMetadataStore Unit Tests
 * Tests for in-memory credential metadata storage
 */

import 'reflect-metadata';
import { InMemoryCredentialMetadataStore } from '../../../src/services/InMemoryCredentialMetadataStore';
import type { CredentialMetadata } from '../../../src/types';

describe('InMemoryCredentialMetadataStore', () => {
  let store: InMemoryCredentialMetadataStore;

  const sampleMetadata: CredentialMetadata = {
    id: 'cred-123',
    connectorId: 'salesforce',
    name: 'Salesforce Production',
    type: 'oauth2',
    environment: 'production',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    store = new InMemoryCredentialMetadataStore();
  });

  describe('loadAll()', () => {
    it('should return empty array when store is empty', async () => {
      const result = await store.loadAll();

      expect(result).toEqual([]);
    });

    it('should return all stored metadata', async () => {
      await store.save('key1', sampleMetadata);
      await store.save('key2', { ...sampleMetadata, id: 'cred-456' });

      const result = await store.loadAll();

      expect(result.length).toBe(2);
    });

    it('should return array of CredentialMetadata objects', async () => {
      await store.save('key1', sampleMetadata);

      const result = await store.loadAll();

      expect(result[0]).toEqual(sampleMetadata);
    });
  });

  describe('save()', () => {
    it('should store metadata by key', async () => {
      await store.save('key1', sampleMetadata);

      const all = await store.loadAll();
      expect(all.length).toBe(1);
      expect(all[0]).toEqual(sampleMetadata);
    });

    it('should overwrite existing metadata for same key', async () => {
      await store.save('key1', sampleMetadata);
      const updatedMetadata = { ...sampleMetadata, name: 'Updated Name' };
      await store.save('key1', updatedMetadata);

      const all = await store.loadAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe('Updated Name');
    });

    it('should store multiple entries with different keys', async () => {
      await store.save('key1', sampleMetadata);
      await store.save('key2', { ...sampleMetadata, id: 'cred-456' });
      await store.save('key3', { ...sampleMetadata, id: 'cred-789' });

      const all = await store.loadAll();
      expect(all.length).toBe(3);
    });
  });

  describe('delete()', () => {
    it('should remove metadata by key', async () => {
      await store.save('key1', sampleMetadata);
      await store.delete('key1');

      const all = await store.loadAll();
      expect(all.length).toBe(0);
    });

    it('should not throw for non-existent key', async () => {
      await expect(store.delete('nonexistent')).resolves.not.toThrow();
    });

    it('should only remove specified key', async () => {
      await store.save('key1', sampleMetadata);
      await store.save('key2', { ...sampleMetadata, id: 'cred-456' });
      await store.delete('key1');

      const all = await store.loadAll();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe('cred-456');
    });

    it('should allow re-adding after delete', async () => {
      await store.save('key1', sampleMetadata);
      await store.delete('key1');
      await store.save('key1', { ...sampleMetadata, name: 'New Entry' });

      const all = await store.loadAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe('New Entry');
    });
  });

  describe('integration scenarios', () => {
    it('should handle CRUD operations in sequence', async () => {
      // Create
      await store.save('connector1', sampleMetadata);
      expect((await store.loadAll()).length).toBe(1);

      // Read
      const all = await store.loadAll();
      expect(all[0]).toEqual(sampleMetadata);

      // Update
      await store.save('connector1', { ...sampleMetadata, name: 'Updated' });
      const updated = await store.loadAll();
      expect(updated[0].name).toBe('Updated');

      // Delete
      await store.delete('connector1');
      expect((await store.loadAll()).length).toBe(0);
    });

    it('should handle multiple concurrent saves', async () => {
      const saves = Array.from({ length: 10 }, (_, i) =>
        store.save(`key${i}`, { ...sampleMetadata, id: `cred-${i}` })
      );

      await Promise.all(saves);

      const all = await store.loadAll();
      expect(all.length).toBe(10);
    });

    it('should maintain data integrity with mixed operations', async () => {
      await store.save('a', { ...sampleMetadata, id: 'a' });
      await store.save('b', { ...sampleMetadata, id: 'b' });
      await store.delete('a');
      await store.save('c', { ...sampleMetadata, id: 'c' });
      await store.save('b', { ...sampleMetadata, id: 'b-updated' });

      const all = await store.loadAll();
      expect(all.length).toBe(2);

      const ids = all.map(m => m.id);
      expect(ids).toContain('b-updated');
      expect(ids).toContain('c');
      expect(ids).not.toContain('a');
    });
  });
});
