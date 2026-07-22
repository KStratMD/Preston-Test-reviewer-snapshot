/**
 * Comprehensive unit tests for UnifiedTemplateService
 * Covers: getLibrary, getTemplate, getTemplatesByCategory, searchTemplates,
 *         createTemplate, updateTemplate, deleteTemplate, importTemplates,
 *         exportTemplates, migrateOldTemplate
 */
import * as fs from 'fs';
import { UnifiedTemplateService } from '../../../src/services/UnifiedTemplateService';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue('[]'),
  writeFileSync: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('UnifiedTemplateService', () => {
  let service: UnifiedTemplateService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => {});
    service = new UnifiedTemplateService();
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(service).toBeDefined();
    });

    it('should create config directory if missing', () => {
      mockFs.existsSync.mockReturnValue(false);
      const s = new UnifiedTemplateService();
      expect(s).toBeDefined();
      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('getLibrary', () => {
    it('should return template library', () => {
      const library = service.getLibrary();
      expect(library).toBeDefined();
      expect(Array.isArray(library.templates)).toBe(true);
      expect(Array.isArray(library.categories)).toBe(true);
      expect(library.version).toBe('2.0.0');
      expect(library.lastUpdated).toBeDefined();
    });

    it('should include builtin templates', () => {
      const library = service.getLibrary();
      expect(library.templates.length).toBeGreaterThan(0);
      const builtin = library.templates.filter(t => t.source === 'builtin');
      expect(builtin.length).toBeGreaterThan(0);
    });

    it('should cache results', () => {
      const lib1 = service.getLibrary();
      const lib2 = service.getLibrary();
      expect(lib1).toBe(lib2); // Same reference = cached
    });

    it('should include categories', () => {
      const library = service.getLibrary();
      for (const cat of library.categories) {
        expect(cat.key).toBeDefined();
        expect(cat.name).toBeDefined();
      }
    });
  });

  describe('getTemplate', () => {
    it('should get a builtin template by key', () => {
      const template = service.getTemplate('suitecentral-customer');
      expect(template).toBeDefined();
      expect(template!.name).toBe('SuiteCentral: Customer Standard');
    });

    it('should return undefined for unknown key', () => {
      const template = service.getTemplate('nonexistent');
      expect(template).toBeUndefined();
    });

    it('should get salesforce-netsuite template', () => {
      const template = service.getTemplate('salesforce-netsuite-customers');
      expect(template).toBeDefined();
      expect(template!.sourceSystem).toBe('Salesforce');
      expect(template!.targetSystem).toBe('NetSuite');
    });

    it('should get payment-processor template', () => {
      const template = service.getTemplate('payment-processor-sync');
      expect(template).toBeDefined();
      expect(template!.category).toBe('Financial Management');
    });
  });

  describe('getTemplatesByCategory', () => {
    it('should get templates by category', () => {
      const templates = service.getTemplatesByCategory('customer-management');
      expect(Array.isArray(templates)).toBe(true);
    });

    it('should return empty for unknown category', () => {
      const templates = service.getTemplatesByCategory('nonexistent-category');
      expect(templates).toEqual([]);
    });
  });

  describe('searchTemplates', () => {
    it('should search by name', () => {
      const results = service.searchTemplates('customer');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should search by description', () => {
      const results = service.searchTemplates('payment');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should search by source system', () => {
      const results = service.searchTemplates('Salesforce');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should search by tag', () => {
      const results = service.searchTemplates('crm');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for unmatched search', () => {
      const results = service.searchTemplates('zzzzunmatchedzzz');
      expect(results).toEqual([]);
    });

    it('should filter by source system', () => {
      const results = service.searchTemplates('', { sourceSystem: 'Salesforce' });
      for (const r of results) {
        expect(r.sourceSystem).toBe('Salesforce');
      }
    });

    it('should filter by target system', () => {
      const results = service.searchTemplates('', { targetSystem: 'NetSuite' });
      for (const r of results) {
        expect(r.targetSystem).toBe('NetSuite');
      }
    });

    it('should filter by tags', () => {
      const results = service.searchTemplates('', { tags: ['payment'] });
      for (const r of results) {
        expect(r.tags).toContain('payment');
      }
    });

    it('should return all templates for empty query', () => {
      const results = service.searchTemplates('');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('createTemplate', () => {
    it('should create a custom template', () => {
      const template = service.createTemplate({
        name: 'My Custom Template',
        fields: [
          { source: 'a', target: 'b', transformation: 'direct', required: true },
        ],
      });
      expect(template).toBeDefined();
      expect(template.key).toBe('my-custom-template');
      expect(template.name).toBe('My Custom Template');
      expect(template.source).toBe('custom');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should throw for template without name', () => {
      expect(() => service.createTemplate({
        fields: [{ source: 'a', target: 'b', transformation: 'direct', required: true }],
      })).toThrow('Template must have a name and at least one field mapping');
    });

    it('should throw for template without fields', () => {
      expect(() => service.createTemplate({
        name: 'No Fields',
      })).toThrow('Template must have a name and at least one field mapping');
    });

    it('should throw for template with empty fields', () => {
      expect(() => service.createTemplate({
        name: 'Empty Fields',
        fields: [],
      })).toThrow('Template must have a name and at least one field mapping');
    });

    it('should use provided key if given', () => {
      const template = service.createTemplate({
        key: 'custom-key',
        name: 'Custom Key Template',
        fields: [{ source: 'x', target: 'y', transformation: 'direct', required: true }],
      });
      expect(template.key).toBe('custom-key');
    });

    it('should set default source and target systems', () => {
      const template = service.createTemplate({
        name: 'Default Systems',
        fields: [{ source: 'x', target: 'y', transformation: 'direct', required: true }],
      });
      expect(template.sourceSystem).toBe('Custom');
      expect(template.targetSystem).toBe('Custom');
    });
  });

  describe('updateTemplate', () => {
    it('should update a custom template', () => {
      // Create one first
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{
        key: 'existing-template',
        name: 'Existing',
        fields: [{ source: 'a', target: 'b', transformation: 'direct', required: true }],
        source: 'custom',
        metadata: { version: '1.0.0' },
      }]));

      const updated = service.updateTemplate('existing-template', {
        name: 'Updated Name',
      });
      expect(updated.name).toBe('Updated Name');
      expect(updated.key).toBe('existing-template'); // Key preserved
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should throw for nonexistent template', () => {
      expect(() => service.updateTemplate('nonexistent', { name: 'X' }))
        .toThrow('Template with key "nonexistent" not found or is not editable');
    });

    it('should increment version', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{
        key: 'versioned',
        name: 'Versioned',
        fields: [{ source: 'a', target: 'b', transformation: 'direct', required: true }],
        source: 'custom',
        metadata: { version: '1.0.0' },
      }]));

      const updated = service.updateTemplate('versioned', { name: 'V2' });
      expect(updated.metadata?.version).toBe('1.0.1');
    });
  });

  describe('deleteTemplate', () => {
    it('should delete a custom template', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{
        key: 'to-delete',
        name: 'Delete Me',
        fields: [],
        source: 'custom',
      }]));

      const result = service.deleteTemplate('to-delete');
      expect(result).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should return false for nonexistent template', () => {
      const result = service.deleteTemplate('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('importTemplates', () => {
    it('should import valid templates', () => {
      const result = service.importTemplates([{
        key: 'imported-1',
        name: 'Imported Template',
        description: 'Test',
        sourceSystem: 'A',
        targetSystem: 'B',
        fields: [{ source: 'a', target: 'b', transformation: 'direct', required: true }],
        category: 'custom',
        tags: [],
        source: 'custom',
      }]);
      expect(result.imported).toBe(1);
      expect(result.errors.length).toBe(0);
    });

    it('should report errors for invalid templates', () => {
      const result = service.importTemplates([{
        key: 'invalid',
        name: '',
        description: '',
        sourceSystem: '',
        targetSystem: '',
        fields: [],
        category: '',
        tags: [],
        source: 'custom',
      }]);
      expect(result.errors.length).toBe(1);
    });

    it('should handle mixed valid and invalid', () => {
      const result = service.importTemplates([
        {
          key: 'valid-one',
          name: 'Valid',
          description: 'ok',
          sourceSystem: 'A',
          targetSystem: 'B',
          fields: [{ source: 'a', target: 'b', transformation: 'direct', required: true }],
          category: 'custom',
          tags: [],
          source: 'custom',
        },
        {
          key: 'invalid-one',
          name: '',
          description: '',
          sourceSystem: '',
          targetSystem: '',
          fields: [],
          category: '',
          tags: [],
          source: 'custom',
        },
      ]);
      expect(result.imported).toBe(1);
      expect(result.errors.length).toBe(1);
    });
  });

  describe('exportTemplates', () => {
    it('should export all templates when no keys specified', () => {
      const templates = service.exportTemplates();
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should export specific templates by key', () => {
      const templates = service.exportTemplates(['suitecentral-customer']);
      expect(templates.length).toBe(1);
      expect(templates[0].key).toBe('suitecentral-customer');
    });

    it('should return empty for unmatched keys', () => {
      const templates = service.exportTemplates(['nonexistent-key']);
      expect(templates.length).toBe(0);
    });
  });

  describe('migrateOldTemplate', () => {
    it('should migrate old template format', () => {
      const result = service.migrateOldTemplate({
        key: 'old-key',
        name: 'Old Template',
        description: 'An old template',
        sourceSystem: 'OldSource',
        targetSystem: 'OldTarget',
        fields: [{ source: 'x', target: 'y' }],
        tags: ['legacy'],
      });
      expect(result.key).toBe('old-key');
      expect(result.name).toBe('Old Template');
      expect(result.source).toBe('custom');
      expect(result.fields.length).toBe(1);
    });

    it('should handle minimal old template', () => {
      const result = service.migrateOldTemplate({});
      expect(result.name).toBe('Migrated Template');
      expect(result.sourceSystem).toBe('Unknown');
      expect(result.targetSystem).toBe('Unknown');
      expect(result.source).toBe('custom');
    });

    it('should handle old template with supportedSources', () => {
      const result = service.migrateOldTemplate({
        supportedSources: ['NetSuite'],
        supportedTargets: ['SAP'],
      });
      expect(result.sourceSystem).toBe('NetSuite');
      expect(result.targetSystem).toBe('SAP');
    });

    it('should handle old template with fieldMappings instead of fields', () => {
      const result = service.migrateOldTemplate({
        fieldMappings: [{ source: 'a', target: 'b' }],
      });
      expect(result.fields.length).toBe(1);
    });
  });

  describe('template structure validation', () => {
    it('should have valid builtin template structure', () => {
      const library = service.getLibrary();
      for (const template of library.templates) {
        expect(template.key).toBeDefined();
        expect(template.name).toBeDefined();
        expect(template.description).toBeDefined();
        expect(Array.isArray(template.fields)).toBe(true);
        expect(template.source).toBeDefined();
      }
    });

    it('should have field mappings with source and target', () => {
      const template = service.getTemplate('suitecentral-customer');
      expect(template!.fields.length).toBeGreaterThan(0);
      for (const field of template!.fields) {
        expect(field.source).toBeDefined();
        expect(field.target).toBeDefined();
        expect(field.transformation).toBeDefined();
      }
    });
  });
});
