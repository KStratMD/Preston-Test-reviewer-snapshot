/**
 * Mapping Templates Route Tests
 * Session 10 - Targeting simple file-based routes for B grade (50% coverage)
 *
 * Tests the /api/mapping-templates API endpoints for template management.
 * Uses fs mocks to avoid file system dependencies.
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs';

// Mock fs module before importing route
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock logger before requiring route
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// Create test app
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Import route factory after mocks are set up
  const { createMappingTemplatesRouter } = require('../../../../src/routes/mappingTemplates');
  const router = createMappingTemplatesRouter();
  app.use('/api/mapping-templates', router);

  return app;
}

describe('Mapping Templates Route', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock: empty custom templates file
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => '');

    app = createTestApp();
  });

  describe('GET /api/mapping-templates', () => {
    it('should return all templates (builtin + custom)', async () => {
      const response = await request(app)
        .get('/api/mapping-templates')
        .expect(200);

      expect(response.body).toHaveProperty('templates');
      expect(Array.isArray(response.body.templates)).toBe(true);
      // Should have builtin templates
      expect(response.body.templates.length).toBeGreaterThan(0);
      // Check for known builtin template
      const salesforceNetSuite = response.body.templates.find(
        (t: any) => t.key === 'salesforce-netsuite-customers'
      );
      expect(salesforceNetSuite).toBeDefined();
      expect(salesforceNetSuite.source).toBe('builtin');
    });

    it('should include custom templates when they exist', async () => {
      const customTemplates = [
        {
          key: 'custom-test',
          name: 'Custom Test Template',
          description: 'Test custom template',
          fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customTemplates));

      const response = await request(app)
        .get('/api/mapping-templates')
        .expect(200);

      expect(response.body.templates).toBeDefined();
      const customTemplate = response.body.templates.find((t: any) => t.key === 'custom-test');
      expect(customTemplate).toBeDefined();
      expect(customTemplate.source).toBe('custom');
    });

    it('should handle corrupted custom templates file gracefully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const response = await request(app)
        .get('/api/mapping-templates')
        .expect(200);

      // Should still return builtin templates
      expect(response.body.templates.length).toBeGreaterThan(0);
      // All should be builtin
      const allBuiltin = response.body.templates.every((t: any) => t.source === 'builtin');
      expect(allBuiltin).toBe(true);
    });
  });

  describe('GET /api/mapping-templates/:key', () => {
    it('should return specific builtin template by key', async () => {
      const response = await request(app)
        .get('/api/mapping-templates/salesforce-netsuite-customers')
        .expect(200);

      expect(response.body.key).toBe('salesforce-netsuite-customers');
      expect(response.body.name).toBe('Salesforce to NetSuite Customer Sync');
      expect(response.body.source).toBe('builtin');
      expect(Array.isArray(response.body.fields)).toBe(true);
      expect(response.body.fields.length).toBeGreaterThan(0);
    });

    it('should return specific custom template by key', async () => {
      const customTemplates = [
        {
          key: 'my-custom',
          name: 'My Custom Template',
          fields: [{ source: 'x', target: 'y', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customTemplates));

      const response = await request(app)
        .get('/api/mapping-templates/my-custom')
        .expect(200);

      expect(response.body.key).toBe('my-custom');
      expect(response.body.name).toBe('My Custom Template');
      expect(response.body.source).toBe('custom');
    });

    it('should return 404 for non-existent template', async () => {
      const response = await request(app)
        .get('/api/mapping-templates/non-existent-key')
        .expect(404);

      expect(response.body.error).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/mapping-templates', () => {
    it('should create a new custom template', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const newTemplate = {
        name: 'New Custom Template',
        description: 'Test description',
        sourceSystem: 'System A',
        targetSystem: 'System B',
        fields: [
          { source: 'field1', target: 'field2', transformation: 'direct' },
        ],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(201);

      expect(response.body.key).toBeDefined();
      expect(response.body.name).toBe('New Custom Template');
      expect(response.body.source).toBe('custom');
      expect(response.body.fields).toHaveLength(1);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should generate key from name if not provided', async () => {
      const newTemplate = {
        name: 'Test Template Name',
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(201);

      // Key should be slugified name
      expect(response.body.key).toBe('test-template-name');
    });

    it('should use provided key if valid', async () => {
      const newTemplate = {
        key: 'my-custom-key',
        name: 'Template Name',
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(201);

      expect(response.body.key).toBe('my-custom-key');
    });

    it('should update existing template if key matches', async () => {
      const existingTemplates = [
        {
          key: 'existing-key',
          name: 'Old Name',
          fields: [{ source: 'old', target: 'old', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingTemplates));

      const updatedTemplate = {
        key: 'existing-key',
        name: 'Updated Name',
        fields: [{ source: 'new', target: 'new', transformation: 'direct' }],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(updatedTemplate)
        .expect(201);

      expect(response.body.key).toBe('existing-key');
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.fields[0].source).toBe('new');
    });

    it('should return 400 for missing name', async () => {
      const invalidTemplate = {
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(invalidTemplate)
        .expect(400);

      expect(response.body.error).toBe('INVALID_TEMPLATE');
    });

    it('should return 400 for missing fields', async () => {
      const invalidTemplate = {
        name: 'Test Template',
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(invalidTemplate)
        .expect(400);

      expect(response.body.error).toBe('INVALID_TEMPLATE');
    });

    it('should return 400 for invalid fields array', async () => {
      const invalidTemplate = {
        name: 'Test Template',
        fields: 'not an array',
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(invalidTemplate)
        .expect(400);

      expect(response.body.error).toBe('INVALID_TEMPLATE');
    });

    it('should handle tags array if provided', async () => {
      const newTemplate = {
        name: 'Tagged Template',
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
        tags: ['tag1', 'tag2', 'tag3'],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(201);

      expect(response.body.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should filter empty tags', async () => {
      const newTemplate = {
        name: 'Tagged Template',
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
        tags: ['tag1', '', '  ', 'tag2'],
      };

      const response = await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(201);

      expect(response.body.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('DELETE /api/mapping-templates/:key', () => {
    it('should delete custom template', async () => {
      const customTemplates = [
        {
          key: 'to-delete',
          name: 'Template to Delete',
          fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customTemplates));

      const response = await request(app)
        .delete('/api/mapping-templates/to-delete')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should return 404 for non-existent template', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app)
        .delete('/api/mapping-templates/non-existent')
        .expect(404);

      expect(response.body.error).toBe('NOT_FOUND_OR_BUILTIN');
    });

    it('should return 404 when trying to delete builtin template', async () => {
      // Builtin templates are not in custom store, so deletion should fail
      const response = await request(app)
        .delete('/api/mapping-templates/salesforce-netsuite-customers')
        .expect(404);

      expect(response.body.error).toBe('NOT_FOUND_OR_BUILTIN');
    });
  });

  describe('GET /api/mapping-templates/export/all', () => {
    it('should export all templates as JSON', async () => {
      const response = await request(app)
        .get('/api/mapping-templates/export/all')
        .expect(200);

      expect(response.type).toContain('application/json');
      const body = response.body;
      expect(body).toHaveProperty('templates');
      expect(Array.isArray(body.templates)).toBe(true);
      expect(body.templates.length).toBeGreaterThan(0);
    });

    it('should include both builtin and custom templates in export', async () => {
      const customTemplates = [
        {
          key: 'custom-export',
          name: 'Custom Export Template',
          fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customTemplates));

      const response = await request(app)
        .get('/api/mapping-templates/export/all')
        .expect(200);

      const hasBuiltin = response.body.templates.some((t: any) => t.source === 'builtin');
      const hasCustom = response.body.templates.some((t: any) => t.key === 'custom-export');
      expect(hasBuiltin).toBe(true);
      expect(hasCustom).toBe(true);
    });
  });

  describe('POST /api/mapping-templates/import', () => {
    it('should import templates from array', async () => {
      const importPayload = [
        {
          key: 'imported-1',
          name: 'Imported Template 1',
          fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
        },
        {
          key: 'imported-2',
          name: 'Imported Template 2',
          fields: [{ source: 'x', target: 'y', transformation: 'direct' }],
        },
      ];

      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send(importPayload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(2);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should import templates from object with templates property', async () => {
      const importPayload = {
        templates: [
          {
            key: 'imported',
            name: 'Imported Template',
            fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
          },
        ],
      };

      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send(importPayload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(1);
    });

    it('should merge imported templates with existing custom templates', async () => {
      const existingTemplates = [
        {
          key: 'existing',
          name: 'Existing Template',
          fields: [{ source: 'e', target: 'e', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingTemplates));

      const importPayload = [
        {
          key: 'new-import',
          name: 'New Imported Template',
          fields: [{ source: 'n', target: 'n', transformation: 'direct' }],
        },
      ];

      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send(importPayload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(1);
    });

    it('should overwrite existing template with same key during import', async () => {
      const existingTemplates = [
        {
          key: 'duplicate-key',
          name: 'Old Name',
          fields: [{ source: 'old', target: 'old', transformation: 'direct' }],
          source: 'custom',
        },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingTemplates));

      const importPayload = [
        {
          key: 'duplicate-key',
          name: 'New Name',
          fields: [{ source: 'new', target: 'new', transformation: 'direct' }],
        },
      ];

      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send(importPayload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(1);
    });

    it('should skip invalid templates during import', async () => {
      const importPayload = [
        {
          key: 'valid',
          name: 'Valid Template',
          fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
        },
        {
          // Missing key and name
          fields: [],
        },
        {
          name: 'No Fields Template',
          // Missing fields
        },
        'invalid string item',
        null,
      ];

      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send(importPayload)
        .expect(200);

      expect(response.body.success).toBe(true);
      // Only 1 valid template should be imported
      expect(response.body.imported).toBe(1);
    });

    it('should handle invalid import payload as empty array', async () => {
      // Invalid payload defaults to [] and imports 0 templates
      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send('invalid string')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(0);
    });

    it('should handle empty import array', async () => {
      const response = await request(app)
        .post('/api/mapping-templates/import')
        .send([])
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.imported).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle file system write errors gracefully', async () => {
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const newTemplate = {
        name: 'Test Template',
        fields: [{ source: 'a', target: 'b', transformation: 'direct' }],
      };

      // Should throw and be caught by error handler
      await request(app)
        .post('/api/mapping-templates')
        .send(newTemplate)
        .expect(500);
    });

    it('should handle directory creation during initialization', async () => {
      // This tests the getStorePath() directory creation logic
      mockFs.existsSync.mockReturnValueOnce(false); // Directory doesn't exist
      mockFs.mkdirSync.mockImplementation(() => '');

      const response = await request(app)
        .get('/api/mapping-templates')
        .expect(200);

      expect(response.body.templates).toBeDefined();
    });

    it('should handle directory creation failure gracefully', async () => {
      mockFs.existsSync.mockReturnValueOnce(false);
      mockFs.mkdirSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      // Should still work (error is silently caught)
      const response = await request(app)
        .get('/api/mapping-templates')
        .expect(200);

      expect(response.body.templates).toBeDefined();
    });
  });
});
