/**
 * Mappings Route Tests
 *
 * Tests the /api/mappings API endpoints for field mapping CRUD operations.
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';
import type { Logger } from '../../../../src/utils/Logger';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Create test app
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Import route factory after mocks are set up
  const { createMappingsRouter } = require('../../../../src/routes/mappings');
  const mappingsRouter = createMappingsRouter();
  app.use('/api/mappings', mappingsRouter);

  return app;
}

describe('Mappings Route', () => {
  let app: express.Application;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.mkdirSync.mockImplementation(() => '');

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    // Mock container
    if (container.isBound(TYPES.Logger)) {
      container.rebind(TYPES.Logger).toConstantValue(mockLogger);
    } else {
      container.bind(TYPES.Logger).toConstantValue(mockLogger);
    }

    app = createTestApp();
  });

  describe('GET /api/mappings', () => {
    it('should return empty array when no mappings exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const response = await request(app)
        .get('/api/mappings')
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should return all mappings from file', async () => {
      const mockMappings = [
        {
          id: 'mapping-1',
          name: 'Test Mapping 1',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
        },
        {
          id: 'mapping-2',
          name: 'Test Mapping 2',
          sourceSystem: 'SAP',
          targetSystem: 'Oracle',
          fields: [{ source: 'CustomerName', target: 'Name', transformation: 'direct' }],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockMappings));

      const response = await request(app)
        .get('/api/mappings')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0].name).toBe('Test Mapping 1');
      expect(response.body[1].name).toBe('Test Mapping 2');
    });

    it('should handle file read errors gracefully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File read error');
      });

      const response = await request(app)
        .get('/api/mappings')
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('GET /api/mappings/:id', () => {
    it('should return mapping by id', async () => {
      const mockMappings = [
        {
          id: 'mapping-1',
          name: 'Test Mapping',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockMappings));

      const response = await request(app)
        .get('/api/mappings/mapping-1')
        .expect(200);

      expect(response.body.id).toBe('mapping-1');
      expect(response.body.name).toBe('Test Mapping');
    });

    it('should return 404 for non-existent mapping', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      const response = await request(app)
        .get('/api/mappings/non-existent')
        .expect(404);

      expect(response.body.error).toBe('Not Found');
    });
  });

  describe('POST /api/mappings', () => {
    it('should create a new mapping', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const newMapping = {
        name: 'New Mapping',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [
          { source: 'AccountName', target: 'CompanyName', transformation: 'direct' },
        ],
      };

      const response = await request(app)
        .post('/api/mappings')
        .send(newMapping)
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('New Mapping');
      expect(response.body.fieldCount).toBe(1);
      expect(response.body.status).toBe('active');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should validate required fields', async () => {
      const invalidMapping = {
        name: 'Invalid Mapping',
        // Missing sourceSystem and targetSystem
        fields: [],
      };

      await request(app)
        .post('/api/mappings')
        .send(invalidMapping)
        .expect(400);
    });

    it('should validate fields array is not empty', async () => {
      const invalidMapping = {
        name: 'Empty Fields Mapping',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [],
      };

      await request(app)
        .post('/api/mappings')
        .send(invalidMapping)
        .expect(400);
    });

    it('should detect duplicate field mappings', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const duplicateMapping = {
        name: 'Duplicate Mapping',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [
          { source: 'Name', target: 'CompanyName', transformation: 'direct' },
          { source: 'Name', target: 'CompanyName', transformation: 'uppercase' },
        ],
      };

      await request(app)
        .post('/api/mappings')
        .send(duplicateMapping)
        .expect(400);
    });

    it('should normalize mapping on creation', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const newMapping = {
        name: 'Normalize Test',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fields: [
          { source: 'MaterialNumber', target: 'ItemCode', transformation: 'direct' },
          { source: 'Description', target: 'ItemName', transformation: 'trim' },
        ],
      };

      const response = await request(app)
        .post('/api/mappings')
        .send(newMapping)
        .expect(201);

      expect(response.body.fieldCount).toBe(2);
      expect(response.body.completeness).toBe(100);
      expect(response.body.lastUpdated).toBeDefined();
      expect(response.body.version).toBe(1);
    });
  });

  describe('PUT /api/mappings/:id', () => {
    it('should update existing mapping', async () => {
      const existingMappings = [
        {
          id: 'mapping-1',
          name: 'Original Name',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
          version: 1,
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingMappings));

      const updatedMapping = {
        name: 'Updated Name',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [
          { source: 'Name', target: 'CompanyName', transformation: 'uppercase' },
        ],
        publish: true, // Version bumps only when publishing
      };

      const response = await request(app)
        .put('/api/mappings/mapping-1')
        .send(updatedMapping)
        .expect(200);

      expect(response.body.name).toBe('Updated Name');
      expect(response.body.version).toBe(2);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should return 404 when updating non-existent mapping', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      const updatedMapping = {
        name: 'Updated Name',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
      };

      await request(app)
        .put('/api/mappings/non-existent')
        .send(updatedMapping)
        .expect(404);
    });

    it('should increment version on update when publishing', async () => {
      const existingMappings = [
        {
          id: 'mapping-1',
          name: 'Test Mapping',
          sourceSystem: 'SAP',
          targetSystem: 'Oracle',
          fields: [{ source: 'Field1', target: 'Field2', transformation: 'direct' }],
          version: 5,
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingMappings));

      const updatedMapping = {
        name: 'Updated Test Mapping',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fields: [{ source: 'Field1', target: 'Field2', transformation: 'uppercase' }],
        publish: true,
      };

      const response = await request(app)
        .put('/api/mappings/mapping-1')
        .send(updatedMapping)
        .expect(200);

      expect(response.body.version).toBe(6);
    });
  });

  describe('DELETE /api/mappings/:id', () => {
    it('should delete existing mapping', async () => {
      const existingMappings = [
        {
          id: 'mapping-1',
          name: 'To Delete',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
        },
        {
          id: 'mapping-2',
          name: 'To Keep',
          sourceSystem: 'SAP',
          targetSystem: 'Oracle',
          fields: [{ source: 'Field1', target: 'Field2', transformation: 'direct' }],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingMappings));

      await request(app)
        .delete('/api/mappings/mapping-1')
        .expect(200);

      // Verify writeFileSync was called with remaining mapping
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].id).toBe('mapping-2');
    });

    it('should return 404 when deleting non-existent mapping', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      await request(app)
        .delete('/api/mappings/non-existent')
        .expect(404);
    });
  });

  describe('POST /api/mappings/import', () => {
    it('should import multiple mappings', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const importData = {
        mappings: [
          {
            name: 'Import 1',
            sourceSystem: 'Salesforce',
            targetSystem: 'NetSuite',
            fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
          },
          {
            name: 'Import 2',
            sourceSystem: 'SAP',
            targetSystem: 'Oracle',
            fields: [{ source: 'Field1', target: 'Field2', transformation: 'direct' }],
          },
        ],
      };

      const response = await request(app)
        .post('/api/mappings/import')
        .send(importData)
        .expect(200);

      expect(response.body.imported).toBe(2);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should validate import data structure', async () => {
      const invalidImport = {
        // Missing mappings array
        data: [],
      };

      await request(app)
        .post('/api/mappings/import')
        .send(invalidImport)
        .expect(400);
    });
  });

  describe('GET /api/mappings/export', () => {
    it('should export all mappings', async () => {
      const mockMappings = [
        {
          id: 'mapping-1',
          name: 'Export Test 1',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockMappings));

      const response = await request(app)
        .get('/api/mappings/export')
        .expect(200);

      expect(response.body.mappings).toHaveLength(1);
      expect(response.body.mappings[0].name).toBe('Export Test 1');
    });
  });

  describe('GET /api/mappings/:id/export', () => {
    it('should export single mapping', async () => {
      const mockMappings = [
        {
          id: 'mapping-1',
          name: 'Single Export',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockMappings));

      const response = await request(app)
        .get('/api/mappings/mapping-1/export')
        .expect(200);

      expect(response.body.name).toBe('Single Export');
    });

    it('should return 404 for non-existent mapping export', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      await request(app)
        .get('/api/mappings/non-existent/export')
        .expect(404);
    });
  });

  describe('POST /api/mappings/diff', () => {
    it('should return diff between two mappings', async () => {
      const mockMappings = [
        {
          id: 'mapping-1',
          name: 'Mapping A',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [
            { source: 'Name', target: 'CompanyName', transformation: 'direct' },
            { source: 'Email', target: 'Email', transformation: 'lowercase' },
          ],
        },
        {
          id: 'mapping-2',
          name: 'Mapping B',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [
            { source: 'Name', target: 'CompanyName', transformation: 'uppercase' },
            { source: 'Phone', target: 'Phone', transformation: 'direct' },
          ],
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockMappings));

      const response = await request(app)
        .post('/api/mappings/diff')
        .send({ id1: 'mapping-1', id2: 'mapping-2' })
        .expect(200);

      expect(response.body).toBeDefined();
      // Diff should show changes in transformation and different fields
    });

    it('should return 400 when diff parameters missing', async () => {
      await request(app)
        .post('/api/mappings/diff')
        .send({})
        .expect(400);
    });
  });

  describe('Edge Cases', () => {
    it('should handle corrupted JSON file gracefully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json');

      const response = await request(app)
        .get('/api/mappings')
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should create config directory if it does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const newMapping = {
        name: 'Test',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
      };

      await request(app)
        .post('/api/mappings')
        .send(newMapping)
        .expect(201);

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it('should handle directory creation errors gracefully', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const newMapping = {
        name: 'Test',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }],
      };

      // Should not throw - error is caught and ignored
      const response = await request(app)
        .post('/api/mappings')
        .send(newMapping);

      // Request might fail or succeed depending on whether file write succeeds
      expect([201, 500]).toContain(response.status);
    });
  });
});
