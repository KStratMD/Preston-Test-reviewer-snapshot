import 'reflect-metadata';
import { VectorStoreService } from '../../../../../src/services/ai/rag/VectorStoreService';
import { EmbeddingService } from '../../../../../src/services/ai/rag/EmbeddingService';
import type { StoredMapping } from '../../../../../src/services/ai/rag/types';

describe('VectorStoreService', () => {
  let vectorStore: VectorStoreService;
  let embeddingService: EmbeddingService;

  beforeEach(() => {
    embeddingService = new EmbeddingService({ useOpenAI: false });
    vectorStore = new VectorStoreService({
      embeddingService,
      maxSize: 100
    });
  });

  const createMockMapping = (id: string, sourceField: string, targetField: string): StoredMapping => ({
    id,
    sourceField,
    targetField,
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    transformationType: 'direct',
    confidence: 0.9,
    reasoning: 'Test mapping',
    wasValidated: false,
    createdAt: new Date(),
    usageCount: 0
  });

  describe('store', () => {
    it('should store a mapping with its embedding', async () => {
      const mapping = createMockMapping('1', 'email', 'Email');
      const embedding = await embeddingService.embed('email to Email');

      await vectorStore.store(mapping, embedding);

      const retrieved = await vectorStore.getById('1');
      expect(retrieved).toEqual(mapping);
    });

    it('should handle multiple mappings', async () => {
      const mapping1 = createMockMapping('1', 'email', 'Email');
      const mapping2 = createMockMapping('2', 'name', 'Name');

      const embedding1 = await embeddingService.embed('email');
      const embedding2 = await embeddingService.embed('name');

      await vectorStore.store(mapping1, embedding1);
      await vectorStore.store(mapping2, embedding2);

      expect(vectorStore.getSize()).toBe(2);
    });

    it('should update existing mapping', async () => {
      const mapping = createMockMapping('1', 'email', 'Email');
      const embedding = await embeddingService.embed('email');

      await vectorStore.store(mapping, embedding);

      const updatedMapping = { ...mapping, confidence: 0.95 };
      await vectorStore.store(updatedMapping, embedding);

      const retrieved = await vectorStore.getById('1');
      expect(retrieved?.confidence).toBe(0.95);
    });

    it('should enforce max size limit', async () => {
      // Store more than max size (100)
      for (let i = 0; i < 110; i++) {
        const mapping = createMockMapping(`id-${i}`, `field${i}`, `target${i}`);
        const embedding = await embeddingService.embed(`field${i}`);
        await vectorStore.store(mapping, embedding);
      }

      expect(vectorStore.getSize()).toBeLessThanOrEqual(100);
    });
  });

  describe('storeBatch', () => {
    it('should store multiple mappings at once', async () => {
      const mappings = [
        createMockMapping('1', 'email', 'Email'),
        createMockMapping('2', 'name', 'Name'),
        createMockMapping('3', 'phone', 'Phone')
      ];

      const embeddings = await embeddingService.embedBatch(['email', 'name', 'phone']);

      await vectorStore.storeBatch(mappings, embeddings);

      expect(vectorStore.getSize()).toBe(3);
    });

    it('should throw error if mappings and embeddings lengths mismatch', async () => {
      const mappings = [createMockMapping('1', 'email', 'Email')];
      const embeddings = await embeddingService.embedBatch(['email', 'name']);

      await expect(vectorStore.storeBatch(mappings, embeddings)).rejects.toThrow();
    });

    it('should handle empty arrays', async () => {
      await vectorStore.storeBatch([], []);
      expect(vectorStore.getSize()).toBe(0);
    });
  });

  describe('retrieve', () => {
    beforeEach(async () => {
      // Store some test mappings
      const mappings = [
        createMockMapping('1', 'customer_email', 'email'),
        createMockMapping('2', 'customer_name', 'companyName'),
        createMockMapping('3', 'invoice_date', 'date'),
        createMockMapping('4', 'email_address', 'email')
      ];

      for (const mapping of mappings) {
        const text = `${mapping.sourceField} to ${mapping.targetField}`;
        const embedding = await embeddingService.embed(text);
        await vectorStore.store(mapping, embedding);
      }
    });

    it('should retrieve similar mappings', async () => {
      const queryText = 'customer email to email';
      const queryEmbedding = await embeddingService.embed(queryText);

      const results = await vectorStore.retrieve(queryEmbedding, 3);

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(3);
      expect(results[0].similarity).toBeDefined();
      expect(results[0].rank).toBe(1);
    });

    it('should sort results by similarity (descending)', async () => {
      const queryText = 'customer email';
      const queryEmbedding = await embeddingService.embed(queryText);

      const results = await vectorStore.retrieve(queryEmbedding, 10);

      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
      }
    });

    it('should assign correct ranks', async () => {
      const queryText = 'email';
      const queryEmbedding = await embeddingService.embed(queryText);

      const results = await vectorStore.retrieve(queryEmbedding, 10);

      results.forEach((result, index) => {
        expect(result.rank).toBe(index + 1);
      });
    });

    it('should filter by source system', async () => {
      // Add mapping from different source system
      const otherMapping = {
        ...createMockMapping('5', 'email', 'Email'),
        sourceSystem: 'BusinessCentral'
      };
      const embedding = await embeddingService.embed('email');
      await vectorStore.store(otherMapping, embedding);

      const queryEmbedding = await embeddingService.embed('email');
      const results = await vectorStore.retrieve(queryEmbedding, 10, {
        sourceSystem: 'Salesforce'
      });

      expect(results.every(r => r.mapping.sourceSystem === 'Salesforce')).toBe(true);
    });

    it('should filter by target system', async () => {
      const queryEmbedding = await embeddingService.embed('email');
      const results = await vectorStore.retrieve(queryEmbedding, 10, {
        targetSystem: 'NetSuite'
      });

      expect(results.every(r => r.mapping.targetSystem === 'NetSuite')).toBe(true);
    });

    it('should filter by minimum confidence', async () => {
      // Add low confidence mapping
      const lowConfMapping = { ...createMockMapping('6', 'test', 'test'), confidence: 0.5 };
      const embedding = await embeddingService.embed('test');
      await vectorStore.store(lowConfMapping, embedding);

      const queryEmbedding = await embeddingService.embed('test');
      const results = await vectorStore.retrieve(queryEmbedding, 10, {
        minConfidence: 0.8
      });

      expect(results.every(r => r.mapping.confidence >= 0.8)).toBe(true);
    });

    it('should respect topK limit', async () => {
      const queryEmbedding = await embeddingService.embed('email');
      const results = await vectorStore.retrieve(queryEmbedding, 2);

      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getById', () => {
    it('should return mapping by ID', async () => {
      const mapping = createMockMapping('test-id', 'email', 'Email');
      const embedding = await embeddingService.embed('email');

      await vectorStore.store(mapping, embedding);

      const retrieved = await vectorStore.getById('test-id');
      expect(retrieved).toEqual(mapping);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await vectorStore.getById('non-existent');
      expect(retrieved).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete mapping by ID', async () => {
      const mapping = createMockMapping('1', 'email', 'Email');
      const embedding = await embeddingService.embed('email');

      await vectorStore.store(mapping, embedding);
      expect(vectorStore.getSize()).toBe(1);

      await vectorStore.delete('1');
      expect(vectorStore.getSize()).toBe(0);

      const retrieved = await vectorStore.getById('1');
      expect(retrieved).toBeNull();
    });

    it('should handle deleting non-existent mapping', async () => {
      await vectorStore.delete('non-existent');
      // Should not throw error
    });
  });

  describe('clear', () => {
    it('should clear all mappings', async () => {
      const mapping1 = createMockMapping('1', 'email', 'Email');
      const mapping2 = createMockMapping('2', 'name', 'Name');

      const embedding1 = await embeddingService.embed('email');
      const embedding2 = await embeddingService.embed('name');

      await vectorStore.store(mapping1, embedding1);
      await vectorStore.store(mapping2, embedding2);

      expect(vectorStore.getSize()).toBe(2);

      await vectorStore.clear();
      expect(vectorStore.getSize()).toBe(0);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      const mappings = [
        { ...createMockMapping('1', 'email', 'Email'), confidence: 0.9, usageCount: 10 },
        { ...createMockMapping('2', 'name', 'Name'), confidence: 0.85, usageCount: 5 },
        { ...createMockMapping('3', 'phone', 'Phone'), sourceSystem: 'BusinessCentral', confidence: 0.95, usageCount: 15 }
      ];

      for (const mapping of mappings) {
        const embedding = await embeddingService.embed(mapping.sourceField);
        await vectorStore.store(mapping, embedding);
      }
    });

    it('should return statistics', async () => {
      const stats = await vectorStore.getStats();

      expect(stats.totalMappings).toBe(3);
      expect(stats.bySourceSystem['Salesforce']).toBe(2);
      expect(stats.bySourceSystem['BusinessCentral']).toBe(1);
      expect(stats.byTargetSystem['NetSuite']).toBe(3);
      expect(stats.averageConfidence).toBeCloseTo(0.9, 1);
    });

    it('should return most used mappings', async () => {
      const stats = await vectorStore.getStats();

      expect(stats.mostUsedMappings.length).toBeGreaterThan(0);
      expect(stats.mostUsedMappings[0].usageCount).toBeGreaterThanOrEqual(stats.mostUsedMappings[1]?.usageCount || 0);
    });

    it('should limit most used to top 10', async () => {
      // Add 15 mappings
      for (let i = 0; i < 15; i++) {
        const mapping = { ...createMockMapping(`extra-${i}`, `field${i}`, `target${i}`), usageCount: i };
        const embedding = await embeddingService.embed(`field${i}`);
        await vectorStore.store(mapping, embedding);
      }

      const stats = await vectorStore.getStats();
      expect(stats.mostUsedMappings.length).toBeLessThanOrEqual(10);
    });
  });

  describe('updateUsage', () => {
    it('should increment usage count', async () => {
      const mapping = createMockMapping('1', 'email', 'Email');
      const embedding = await embeddingService.embed('email');

      await vectorStore.store(mapping, embedding);

      await vectorStore.updateUsage('1');
      await vectorStore.updateUsage('1');

      const retrieved = await vectorStore.getById('1');
      expect(retrieved?.usageCount).toBe(2);
    });

    it('should update lastUsedAt timestamp', async () => {
      const mapping = createMockMapping('1', 'email', 'Email');
      const embedding = await embeddingService.embed('email');

      await vectorStore.store(mapping, embedding);

      const before = new Date();
      await vectorStore.updateUsage('1');

      const retrieved = await vectorStore.getById('1');
      expect(retrieved?.lastUsedAt).toBeDefined();
      expect(retrieved?.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('should handle updating non-existent mapping', async () => {
      await vectorStore.updateUsage('non-existent');
      // Should not throw error
    });
  });

  describe('findBySourceField', () => {
    beforeEach(async () => {
      const mappings = [
        createMockMapping('1', 'customer_email', 'Email'),
        createMockMapping('2', 'customer_name', 'Name'),
        createMockMapping('3', 'email_address', 'Email')
      ];

      for (const mapping of mappings) {
        const embedding = await embeddingService.embed(mapping.sourceField);
        await vectorStore.store(mapping, embedding);
      }
    });

    it('should find mappings by source field pattern', async () => {
      const results = await vectorStore.findBySourceField('email');

      expect(results.length).toBe(2); // customer_email and email_address
      expect(results.every(r => r.sourceField.toLowerCase().includes('email'))).toBe(true);
    });

    it('should be case-insensitive', async () => {
      const results = await vectorStore.findBySourceField('EMAIL');

      expect(results.length).toBe(2);
    });

    it('should return empty array if no matches', async () => {
      const results = await vectorStore.findBySourceField('nonexistent');

      expect(results.length).toBe(0);
    });
  });

  describe('findByTargetField', () => {
    beforeEach(async () => {
      const mappings = [
        createMockMapping('1', 'email1', 'Email'),
        createMockMapping('2', 'email2', 'email_address'),
        createMockMapping('3', 'name', 'Name')
      ];

      for (const mapping of mappings) {
        const embedding = await embeddingService.embed(mapping.sourceField);
        await vectorStore.store(mapping, embedding);
      }
    });

    it('should find mappings by target field pattern', async () => {
      const results = await vectorStore.findByTargetField('email');

      expect(results.length).toBe(2); // Email and email_address
    });

    it('should be case-insensitive', async () => {
      const results = await vectorStore.findByTargetField('EMAIL');

      expect(results.length).toBe(2);
    });
  });

  describe('export and import', () => {
    beforeEach(async () => {
      const mappings = [
        createMockMapping('1', 'email', 'Email'),
        createMockMapping('2', 'name', 'Name')
      ];

      for (const mapping of mappings) {
        const embedding = await embeddingService.embed(mapping.sourceField);
        await vectorStore.store(mapping, embedding);
      }
    });

    it('should export to JSON', async () => {
      const json = await vectorStore.exportToJSON();

      expect(json).toBeDefined();
      expect(typeof json).toBe('string');

      const data = JSON.parse(json);
      expect(data.mappings).toBeDefined();
      expect(data.embeddings).toBeDefined();
      expect(data.exportedAt).toBeDefined();
    });

    it('should import from JSON', async () => {
      const json = await vectorStore.exportToJSON();

      const newVectorStore = new VectorStoreService({
        embeddingService,
        maxSize: 100
      });

      await newVectorStore.importFromJSON(json);

      expect(newVectorStore.getSize()).toBe(2);

      const retrieved = await newVectorStore.getById('1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.sourceField).toBe('email');
    });

    it('should clear existing data before import', async () => {
      const json = await vectorStore.exportToJSON();

      // Add some data to vector store
      const extraMapping = createMockMapping('extra', 'extra', 'Extra');
      const embedding = await embeddingService.embed('extra');
      await vectorStore.store(extraMapping, embedding);

      expect(vectorStore.getSize()).toBe(3);

      // Import should clear and restore
      await vectorStore.importFromJSON(json);

      expect(vectorStore.getSize()).toBe(2);
    });

    it('should throw error on invalid JSON', async () => {
      await expect(vectorStore.importFromJSON('invalid json')).rejects.toThrow();
    });

    it('should throw error on missing required fields', async () => {
      await expect(vectorStore.importFromJSON('{}')).rejects.toThrow();
    });
  });

  describe('getAllMappings', () => {
    it('should return all stored mappings', async () => {
      const mappings = [
        createMockMapping('1', 'email', 'Email'),
        createMockMapping('2', 'name', 'Name'),
        createMockMapping('3', 'phone', 'Phone')
      ];

      for (const mapping of mappings) {
        const embedding = await embeddingService.embed(mapping.sourceField);
        await vectorStore.store(mapping, embedding);
      }

      const all = await vectorStore.getAllMappings();

      expect(all.length).toBe(3);
      expect(all.map(m => m.id)).toContain('1');
      expect(all.map(m => m.id)).toContain('2');
      expect(all.map(m => m.id)).toContain('3');
    });

    it('should return empty array when no mappings', async () => {
      const all = await vectorStore.getAllMappings();
      expect(all.length).toBe(0);
    });
  });
});
