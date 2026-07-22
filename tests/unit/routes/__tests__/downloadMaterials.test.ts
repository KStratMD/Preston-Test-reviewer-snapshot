import express from 'express';
import request from 'supertest';
import downloadRouter from '../downloadMaterials';

describe('downloadMaterials router', () => {
  const app = express();
  app.use('/api/download', downloadRouter);

  test('GET /api/download/strategic-materials returns a zip', async () => {
    const res = await request(app).get('/api/download/strategic-materials');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    // Should stream some bytes
    expect(res.body).toBeDefined();
  });
});

