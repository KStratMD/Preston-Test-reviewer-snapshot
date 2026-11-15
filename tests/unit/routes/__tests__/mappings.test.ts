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
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

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

  // Task A3: the router refuses every request outside demo mode. These tests
  // exercise the demo behaviour, so demo is pinned on and cleared afterwards.
  beforeAll(() => setDemoModeOverride(true));
  afterAll(() => setDemoModeOverride(undefined));

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

    it('reports an unreadable store as 500 mapping_store_corrupt, never as an empty list (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File read error');
      });

      const response = await request(app)
        .get('/api/mappings')
        .expect(500);

      expect(response.body.error).toBe('mapping_store_corrupt');
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
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
          { source: 'Name', target: 'CompanyName', transformation: 'calculation', params: { expr: 'parseInt(Name)' } },
        ],
      };

      await request(app)
        .post('/api/mappings')
        .send(duplicateMapping)
        .expect(400);
    });

    it('rejects vocabulary the engine cannot execute with 400 mapping_contract (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      for (const transformation of ['format', 'conditional', 'uppercase', 'lowercase', 'trim', 'replace', 'split']) {
        const response = await request(app)
          .post('/api/mappings')
          .send({ name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation }] })
          .expect(400);
        expect(response.body.error).toBe('mapping_contract');
        expect(response.body.allowed).toEqual(['direct', 'lookup', 'calculation', 'concatenation']);
        expect(response.body.issues[0]).toMatch(new RegExp(`'${transformation}' is not executable`));
      }
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects an executable word whose params the engine would fail on (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const response = await request(app)
        .post('/api/mappings')
        .send({ name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'lookup', params: { map: { x: 'y' } } }] })
        .expect(400);
      expect(response.body.error).toBe('mapping_contract');
      expect(response.body.issues.join(' ')).toMatch(/lookupTable/);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects a calculation whose expression the engine cannot parse (Codex round 4)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const response = await request(app)
        .post('/api/mappings')
        .send({ name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'calculation', params: { expr: '1+' } }] })
        .expect(400);
      expect(response.body.error).toBe('mapping_contract');
      expect(response.body.issues.join(' ')).toMatch(/not executable/);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects two spellings of one lodash target slot as a SET, not only field by field (Codex round 5)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const response = await request(app)
        .post('/api/mappings')
        .send({ name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'x', target: 'a.b', transformation: 'direct' }, { source: 'y', target: 'a[b]', transformation: 'direct' }] })
        .expect(400);
      expect(response.body.error).toBe('mapping_contract');
      expect(response.body.issues.join(' ')).toMatch(/same slot/);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('accepts every executable word with its engine-shaped params (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const response = await request(app)
        .post('/api/mappings')
        .send({
          name: 'X', sourceSystem: 'A', targetSystem: 'B',
          fields: [
            { source: 'a', target: 'b', transformation: 'direct' },
            { source: 'c', target: 'd', transformation: 'lookup', params: { table: 'codes', map: { x: 'y' } } },
            { source: 'e', target: 'f', transformation: 'calculation', params: { expr: 'parseInt(e)' } },
            { source: 'g', target: 'h', transformation: 'concatenation', params: { fields: ['g', 'a'], separator: ' ' } },
          ],
        })
        .expect(201);
      expect(response.body.fieldCount).toBe(4);
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('should normalize mapping on creation', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const newMapping = {
        name: 'Normalize Test',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fields: [
          { source: 'MaterialNumber', target: 'ItemCode', transformation: 'direct' },
          { source: 'Description', target: 'ItemName', transformation: 'concatenation', params: { fields: ['Description'], separator: ' ' } },
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
          { source: 'Name', target: 'CompanyName', transformation: 'lookup', params: { table: 'names', map: { a: 'A' } } },
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
        fields: [{ source: 'Field1', target: 'Field2', transformation: 'calculation', params: { expr: 'parseInt(Field1)' } }],
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

    it('refuses to rewrite a store holding an entry the contract rejects (Codex round 10): 500 mapping_store_corrupt, nothing written', async () => {
      const stored = [
        { id: 'mapping-1', name: 'Fine', sourceSystem: 'Salesforce', targetSystem: 'NetSuite', fields: [{ source: 'Name', target: 'CompanyName', transformation: 'direct' }] },
        { id: 'mapping-2', name: 'Persisted before the contract', sourceSystem: 'SAP', targetSystem: 'Oracle', fields: [{ source: 'Field1', target: 'Field2', transformation: 'format' }] },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(stored));

      const response = await request(app).delete('/api/mappings/mapping-1').expect(500);
      expect(response.body.error).toBe('mapping_store_corrupt');
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      // ...and reading reports the same, never the partial list.
      const list = await request(app).get('/api/mappings').expect(500);
      expect(list.body.error).toBe('mapping_store_corrupt');
    });

    it('reports a store entry without an id as corrupt: no id-addressed route can ever reach it (Codex round 11)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ name: 'No id', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }]));
      const response = await request(app).get('/api/mappings').expect(500);
      expect(response.body.error).toBe('mapping_store_corrupt');
    });

    it('reports a store entry that fails the route schema (no fields) as corrupt too (Codex round 10)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ id: 'mapping-1', name: 'No fields', sourceSystem: 'A', targetSystem: 'B', fields: [] }]));
      const response = await request(app).get('/api/mappings').expect(500);
      expect(response.body.error).toBe('mapping_store_corrupt');
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
    it.each(['', '   '])("assigns an id when the client supplies a blank one ('%s') instead of persisting an entry the store rejects on read (Codex round 12)", async (blank) => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');
      const response = await request(app)
        .post('/api/mappings/import')
        .send({ mappings: [{ id: blank, name: 'Blank id', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }] })
        .expect(200);
      expect(response.body).toMatchObject({ imported: 1, rejected: 0 });
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(typeof written[0].id).toBe('string');
      expect(written[0].id.trim().length).toBeGreaterThan(0);
      // The store it wrote must read back — the round-11 check must accept it.
      mockFs.readFileSync.mockReturnValue(JSON.stringify(written));
      await request(app).get('/api/mappings').expect(200);
    });

    it('rejects an imported entry whose id already exists in the store or earlier in the payload (Codex round 13)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ id: 'dup', name: 'Existing', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }]));
      const entry = (id: string, name: string) => ({ id, name, sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] });
      const response = await request(app)
        .post('/api/mappings/import')
        .send({ mappings: [entry('dup', 'Clashes with the store'), entry('new', 'Fine'), entry('new', 'Clashes with the payload')] })
        .expect(200);
      expect(response.body).toMatchObject({ imported: 1, rejected: 2 });
      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.map((m: { id: string }) => m.id).sort()).toEqual(['dup', 'new']);
    });

    it('reports a store holding two entries with one id as corrupt: GET would answer one and DELETE would remove both (Codex round 13)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const entry = { name: 'Twin', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] };
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ id: 'dup', ...entry }, { id: 'dup', ...entry }]));
      const response = await request(app).delete('/api/mappings/dup').expect(500);
      expect(response.body.error).toBe('mapping_store_corrupt');
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

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

    it('counts every skipped entry as rejected — schema-invalid, duplicate-field and contract failures alike (Codex on PR #1253)', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const response = await request(app)
        .post('/api/mappings/import')
        .send([
          { name: 'ok', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] },
          { name: 'schema-invalid' },
          { name: 'dup', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }, { source: 'A', target: 'B', transformation: 'direct' }] },
          { name: 'contract', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'uppercase' }] },
        ])
        .expect(200);
      expect(response.body).toMatchObject({ imported: 1, rejected: 3, total: 1 });
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
            { source: 'Email', target: 'Email', transformation: 'direct' },
          ],
        },
        {
          id: 'mapping-2',
          name: 'Mapping B',
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          fields: [
            // Codex round 10 on PR #1253: the store is validated on read, so the
            // fixture holds words the route accepts ('uppercase' is not one).
            { source: 'Name', target: 'CompanyName', transformation: 'lookup', params: { table: 'accounts', map: { acme: 'Acme Inc' } } },
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

  describe('demo-only guard (Codex on PR #1253)', () => {
    it('answers 404 to every route the moment demo mode is switched off at runtime, reading and writing nothing', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([{ id: 'm1', name: 'M', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }]));
      setDemoModeOverride(false);
      try {
        const probes: [string, string, unknown?][] = [
          ['get', '/api/mappings'],
          ['get', '/api/mappings/m1'],
          ['get', '/api/mappings/export'],
          ['post', '/api/mappings', { name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }],
          ['put', '/api/mappings/m1', { name: 'Y' }],
          ['delete', '/api/mappings/m1'],
          ['post', '/api/mappings/import', [{ name: 'Z', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] }]],
        ];
        for (const [method, path, body] of probes) {
          const res = await (request(app) as any)[method](path).send(body);
          expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
          expect(JSON.stringify(res.body)).not.toContain('m1');
        }
        expect(mockFs.readFileSync).not.toHaveBeenCalled();
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      } finally {
        setDemoModeOverride(true);
      }
    });
  });

  describe('Edge Cases', () => {
    it('reports a corrupt JSON store as 500 mapping_store_corrupt (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json');

      const response = await request(app)
        .get('/api/mappings')
        .expect(500);

      expect(response.body.error).toBe('mapping_store_corrupt');
      // Copilot on PR #1253: the store path must not leave the server.
      expect(JSON.stringify(response.body)).not.toMatch(/mappings\.json|[\\/]config[\\/]/);
      expect(response.body).not.toHaveProperty('message');
    });

    it('refuses to WRITE over a corrupt store (Task A3): the old code would have replaced it with [] plus the new entry', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{ invalid json');

      await request(app)
        .post('/api/mappings')
        .send({ name: 'X', sourceSystem: 'A', targetSystem: 'B', fields: [{ source: 'a', target: 'b', transformation: 'direct' }] })
        .expect(500);

      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('reports a store that is not an array as corrupt (Task A3)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{"not":"an array"}');

      const response = await request(app).get('/api/mappings').expect(500);
      expect(response.body.error).toBe('mapping_store_corrupt');
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
