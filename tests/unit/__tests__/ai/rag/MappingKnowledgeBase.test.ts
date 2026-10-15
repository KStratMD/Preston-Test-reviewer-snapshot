import 'reflect-metadata';
import { MappingKnowledgeBase, type MappingInput } from '../../../../../src/services/ai/rag/MappingKnowledgeBase';
import { EmbeddingService } from '../../../../../src/services/ai/rag/EmbeddingService';
import { VectorStoreService } from '../../../../../src/services/ai/rag/VectorStoreService';
import type { AISuggestion } from '../../../../../src/services/ai/providers/types';

describe('MappingKnowledgeBase', () => {
  let knowledgeBase: MappingKnowledgeBase;
  let embeddingService: EmbeddingService;
  let vectorStore: VectorStoreService;

  beforeEach(() => {
    embeddingService = new EmbeddingService({ useOpenAI: false });
    vectorStore = new VectorStoreService({
      embeddingService,
      maxSize: 100
    });

    knowledgeBase = new MappingKnowledgeBase(embeddingService, vectorStore, {
      enabled: true,
      topK: 5,
      minSimilarity: 0.7,
      minConfidenceToStore: 0.75
    });
  });

  const createMockMappingInput = (sourceField: string, targetField: string): MappingInput => ({
    sourceField,
    targetField,
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    transformationType: 'direct',
    confidence: 0.9,
    reasoning: 'Test mapping',
    sourceFieldType: 'string',
    targetFieldType: 'string',
    wasValidated: false
  });

  describe('addMapping', () => {
    it('should add a mapping to the knowledge base', async () => {
      const input = createMockMappingInput('email', 'Email');
      const id = await knowledgeBase.addMapping(input);

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');

      const retrieved = await knowledgeBase.getMappingById(id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.sourceField).toBe('email');
      expect(retrieved?.targetField).toBe('Email');
    });

    it('should reject mappings below confidence threshold', async () => {
      const lowConfInput = {
        ...createMockMappingInput('email', 'Email'),
        confidence: 0.5 // Below 0.75 threshold
      };

      await expect(knowledgeBase.addMapping(lowConfInput)).rejects.toThrow();
    });

    it('should accept mappings at or above threshold', async () => {
      const inputs = [
        { ...createMockMappingInput('email', 'Email'), confidence: 0.75 }, // At threshold
        { ...createMockMappingInput('name', 'Name'), confidence: 0.85 }, // Above threshold
        { ...createMockMappingInput('phone', 'Phone'), confidence: 0.95 } // Well above
      ];

      for (const input of inputs) {
        const id = await knowledgeBase.addMapping(input);
        expect(id).toBeDefined();
      }
    });

    it('should store validation information', async () => {
      const input = {
        ...createMockMappingInput('email', 'Email'),
        wasValidated: true,
        validationScore: 0.92
      };

      const id = await knowledgeBase.addMapping(input);
      const retrieved = await knowledgeBase.getMappingById(id);

      expect(retrieved?.wasValidated).toBe(true);
      expect(retrieved?.validationScore).toBe(0.92);
    });

    it('should store field metadata', async () => {
      const input = {
        ...createMockMappingInput('email', 'Email'),
        sourceFieldType: 'string',
        targetFieldType: 'string',
        sampleValues: ['test@example.com', 'user@test.com']
      };

      const id = await knowledgeBase.addMapping(input);
      const retrieved = await knowledgeBase.getMappingById(id);

      expect(retrieved?.sourceFieldType).toBe('string');
      expect(retrieved?.targetFieldType).toBe('string');
      expect(retrieved?.sampleValues).toEqual(['test@example.com', 'user@test.com']);
    });
  });

  describe('addMappingBatch', () => {
    it('should add multiple mappings', async () => {
      const inputs = [
        createMockMappingInput('email', 'Email'),
        createMockMappingInput('name', 'Name'),
        createMockMappingInput('phone', 'Phone')
      ];

      const ids = await knowledgeBase.addMappingBatch(inputs);

      expect(ids.length).toBe(3);
      expect(ids.every(id => typeof id === 'string')).toBe(true);
    });

    it('should skip mappings below confidence threshold', async () => {
      const inputs = [
        { ...createMockMappingInput('email', 'Email'), confidence: 0.9 }, // Accept
        { ...createMockMappingInput('name', 'Name'), confidence: 0.5 }, // Reject
        { ...createMockMappingInput('phone', 'Phone'), confidence: 0.85 } // Accept
      ];

      const ids = await knowledgeBase.addMappingBatch(inputs);

      expect(ids.length).toBe(2); // Only 2 accepted
    });

    it('should handle empty array', async () => {
      const ids = await knowledgeBase.addMappingBatch([]);
      expect(ids.length).toBe(0);
    });
  });

  describe('findSimilarMappings', () => {
    beforeEach(async () => {
      // Populate knowledge base with test mappings
      const inputs = [
        createMockMappingInput('customer_email', 'email'),
        createMockMappingInput('customer_name', 'companyName'),
        createMockMappingInput('invoice_date', 'date'),
        createMockMappingInput('email_address', 'email')
      ];

      await knowledgeBase.addMappingBatch(inputs);
    });

    it('should find similar mappings', async () => {
      const results = await knowledgeBase.findSimilarMappings(
        'customer_email',
        'Salesforce',
        'NetSuite'
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).toBeDefined();
      expect(results[0].rank).toBe(1);
    });

    it('should return results sorted by similarity', async () => {
      const results = await knowledgeBase.findSimilarMappings(
        'email',
        'Salesforce',
        'NetSuite'
      );

      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
      }
    });

    it('should respect topK configuration', async () => {
      // Default topK is 5
      const results = await knowledgeBase.findSimilarMappings(
        'email',
        'Salesforce',
        'NetSuite'
      );

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should filter by minimum similarity', async () => {
      // Default minSimilarity is 0.7
      const results = await knowledgeBase.findSimilarMappings(
        'completely_different_field',
        'Salesforce',
        'NetSuite'
      );

      expect(results.every(r => r.similarity >= 0.7)).toBe(true);
    });

    it('should use field type context when provided', async () => {
      const results = await knowledgeBase.findSimilarMappings(
        'email_field',
        'Salesforce',
        'NetSuite',
        {
          sourceFieldType: 'string',
          targetFieldType: 'string'
        }
      );

      expect(results).toBeDefined();
    });

    it('should use sample values context when provided', async () => {
      const results = await knowledgeBase.findSimilarMappings(
        'email_field',
        'Salesforce',
        'NetSuite',
        {
          sampleValues: ['test@example.com', 'user@test.com']
        }
      );

      expect(results).toBeDefined();
    });

    it('should update usage statistics for retrieved mappings', async () => {
      const results = await knowledgeBase.findSimilarMappings(
        'customer_email',
        'Salesforce',
        'NetSuite'
      );

      if (results.length > 0) {
        const mapping = await knowledgeBase.getMappingById(results[0].mapping.id);
        expect(mapping?.usageCount).toBeGreaterThan(0);
        expect(mapping?.lastUsedAt).toBeDefined();
      }
    });
  });

  describe('buildRAGContext', () => {
    beforeEach(async () => {
      const inputs = [
        createMockMappingInput('customer_email', 'email'),
        createMockMappingInput('customer_name', 'companyName')
      ];

      await knowledgeBase.addMappingBatch(inputs);
    });

    it('should build RAG context', async () => {
      const context = await knowledgeBase.buildRAGContext(
        'customer_email',
        'Salesforce',
        'NetSuite'
      );

      expect(context).toBeDefined();
      expect(context.similarMappings).toBeDefined();
      expect(context.retrievalTime).toBeDefined();
      expect(context.embeddingMethod).toBe('local');
    });

    it('should measure retrieval time', async () => {
      const context = await knowledgeBase.buildRAGContext(
        'email',
        'Salesforce',
        'NetSuite'
      );

      expect(context.retrievalTime).toBeGreaterThanOrEqual(0); // Can be 0ms if very fast
      expect(context.retrievalTime).toBeLessThan(1000); // Should be fast
    });

    it('should include field context', async () => {
      const context = await knowledgeBase.buildRAGContext(
        'email',
        'Salesforce',
        'NetSuite',
        {
          sourceFieldType: 'string',
          sampleValues: ['test@example.com']
        }
      );

      expect(context).toBeDefined();
    });
  });

  describe('learnFromSuggestions', () => {
    it('should convert AI suggestions to stored mappings', async () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'email',
          targetField: 'Email',
          transformationType: 'direct',
          confidence: 0.9,
          reasoning: 'Direct mapping'
        },
        {
          sourceField: 'name',
          targetField: 'Name',
          transformationType: 'direct',
          confidence: 0.85
        }
      ];

      const ids = await knowledgeBase.learnFromSuggestions(
        suggestions,
        'Salesforce',
        'NetSuite',
        true,
        0.92
      );

      expect(ids.length).toBe(2);

      const mapping = await knowledgeBase.getMappingById(ids[0]);
      expect(mapping?.wasValidated).toBe(true);
      expect(mapping?.validationScore).toBe(0.92);
    });

    it('should skip low confidence suggestions', async () => {
      const suggestions: AISuggestion[] = [
        { sourceField: 'email', targetField: 'Email', transformationType: 'direct', confidence: 0.9 },
        { sourceField: 'name', targetField: 'Name', transformationType: 'direct', confidence: 0.5 }, // Too low
        { sourceField: 'phone', targetField: 'Phone', transformationType: 'direct', confidence: 0.85 }
      ];

      const ids = await knowledgeBase.learnFromSuggestions(
        suggestions,
        'Salesforce',
        'NetSuite'
      );

      expect(ids.length).toBe(2); // Only 2 accepted
    });

    it('should handle empty suggestions array', async () => {
      const ids = await knowledgeBase.learnFromSuggestions(
        [],
        'Salesforce',
        'NetSuite'
      );

      expect(ids.length).toBe(0);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      const inputs = [
        { ...createMockMappingInput('email', 'Email'), confidence: 0.9 },
        { ...createMockMappingInput('name', 'Name'), confidence: 0.85 },
        { ...createMockMappingInput('phone', 'Phone'), confidence: 0.95, sourceSystem: 'BusinessCentral' }
      ];

      await knowledgeBase.addMappingBatch(inputs);
    });

    it('should return knowledge base statistics', async () => {
      const stats = await knowledgeBase.getStats();

      expect(stats).toBeDefined();
      expect(stats.totalMappings).toBe(3);
      expect(stats.bySourceSystem['Salesforce']).toBe(2);
      expect(stats.bySourceSystem['BusinessCentral']).toBe(1);
      expect(stats.byTargetSystem['NetSuite']).toBe(3);
      expect(stats.averageConfidence).toBeCloseTo(0.9, 1);
    });

    it('should include most used mappings', async () => {
      const stats = await knowledgeBase.getStats();

      expect(stats.mostUsedMappings).toBeDefined();
      expect(Array.isArray(stats.mostUsedMappings)).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear all mappings', async () => {
      const inputs = [
        createMockMappingInput('email', 'Email'),
        createMockMappingInput('name', 'Name')
      ];

      await knowledgeBase.addMappingBatch(inputs);

      let stats = await knowledgeBase.getStats();
      expect(stats.totalMappings).toBe(2);

      await knowledgeBase.clear();

      stats = await knowledgeBase.getStats();
      expect(stats.totalMappings).toBe(0);
    });
  });

  describe('getMappingById', () => {
    it('should retrieve mapping by ID', async () => {
      const input = createMockMappingInput('email', 'Email');
      const id = await knowledgeBase.addMapping(input);

      const retrieved = await knowledgeBase.getMappingById(id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(id);
      expect(retrieved?.sourceField).toBe('email');
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await knowledgeBase.getMappingById('non-existent-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('deleteMapping', () => {
    it('should delete mapping by ID', async () => {
      const input = createMockMappingInput('email', 'Email');
      const id = await knowledgeBase.addMapping(input);

      await knowledgeBase.deleteMapping(id);

      const retrieved = await knowledgeBase.getMappingById(id);
      expect(retrieved).toBeNull();
    });
  });

  describe('export and import', () => {
    beforeEach(async () => {
      const inputs = [
        createMockMappingInput('email', 'Email'),
        createMockMappingInput('name', 'Name')
      ];

      await knowledgeBase.addMappingBatch(inputs);
    });

    it('should export knowledge base to JSON', async () => {
      const json = await knowledgeBase.export();

      expect(json).toBeDefined();
      expect(typeof json).toBe('string');

      const data = JSON.parse(json);
      expect(data.mappings).toBeDefined();
      expect(data.embeddings).toBeDefined();
    });

    it('should import knowledge base from JSON', async () => {
      const json = await knowledgeBase.export();

      const newEmbeddingService = new EmbeddingService({ useOpenAI: false });
      const newVectorStore = new VectorStoreService({
        embeddingService: newEmbeddingService,
        maxSize: 100
      });
      const newKnowledgeBase = new MappingKnowledgeBase(newEmbeddingService, newVectorStore);

      await newKnowledgeBase.import(json);

      const stats = await newKnowledgeBase.getStats();
      expect(stats.totalMappings).toBe(2);
    });
  });

  describe('configuration', () => {
    it('should get current configuration', () => {
      const config = knowledgeBase.getConfig();

      expect(config).toBeDefined();
      expect(config.enabled).toBe(true);
      expect(config.topK).toBe(5);
      expect(config.minSimilarity).toBe(0.7);
      expect(config.minConfidenceToStore).toBe(0.75);
    });

    it('should update configuration', () => {
      knowledgeBase.updateConfig({
        topK: 10,
        minSimilarity: 0.8
      });

      const config = knowledgeBase.getConfig();
      expect(config.topK).toBe(10);
      expect(config.minSimilarity).toBe(0.8);
      expect(config.minConfidenceToStore).toBe(0.75); // Unchanged
    });

    it('should return empty results when disabled', async () => {
      knowledgeBase.updateConfig({ enabled: false });

      const results = await knowledgeBase.findSimilarMappings(
        'email',
        'Salesforce',
        'NetSuite'
      );

      expect(results.length).toBe(0);
    });

    it('should use custom topK in retrieval', async () => {
      const inputs = Array.from({ length: 10 }, (_, i) =>
        createMockMappingInput(`field${i}`, `target${i}`)
      );

      await knowledgeBase.addMappingBatch(inputs);

      knowledgeBase.updateConfig({ topK: 3 });

      const results = await knowledgeBase.findSimilarMappings(
        'field0',
        'Salesforce',
        'NetSuite'
      );

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('edge cases', () => {
    it('should handle mappings with minimal information', async () => {
      const minimalInput: MappingInput = {
        sourceField: 'email',
        targetField: 'Email',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        transformationType: 'direct',
        confidence: 0.9
        // No optional fields
      };

      const id = await knowledgeBase.addMapping(minimalInput);
      expect(id).toBeDefined();

      const retrieved = await knowledgeBase.getMappingById(id);
      expect(retrieved).toBeDefined();
    });

    it('should handle mappings with all optional fields', async () => {
      const fullInput: MappingInput = {
        sourceField: 'email',
        targetField: 'Email',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        transformationType: 'direct',
        confidence: 0.9,
        reasoning: 'Test reasoning',
        sourceFieldType: 'string',
        targetFieldType: 'string',
        sampleValues: ['test@example.com'],
        wasValidated: true,
        validationScore: 0.95
      };

      const id = await knowledgeBase.addMapping(fullInput);
      const retrieved = await knowledgeBase.getMappingById(id);

      expect(retrieved?.reasoning).toBe('Test reasoning');
      expect(retrieved?.sourceFieldType).toBe('string');
      expect(retrieved?.wasValidated).toBe(true);
    });

    it('should handle special characters in field names', async () => {
      const input = createMockMappingInput('customer_email_address', 'email');
      const id = await knowledgeBase.addMapping(input);

      expect(id).toBeDefined();
    });

    it('should handle unicode characters', async () => {
      const input = {
        ...createMockMappingInput('名前', 'name'),
        reasoning: '日本語のテスト'
      };

      const id = await knowledgeBase.addMapping(input);
      const retrieved = await knowledgeBase.getMappingById(id);

      expect(retrieved?.sourceField).toBe('名前');
      expect(retrieved?.reasoning).toBe('日本語のテスト');
    });
  });
});
