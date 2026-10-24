import express from 'express';
import request from 'supertest';
import { verificationOnlyGate } from '../../../src/server/verificationGate';

describe('verification-only route gate', () => {
  it('permits health probes and blocks every other method/path', async () => {
    const app = express(); app.use(verificationOnlyGate); app.get('/health', (_req, res) => res.json({ status: 'healthy' }));
    await request(app).get('/health').expect(200);
    await request(app).get('/api/data').expect(503, { status: 'verification_only' });
    await request(app).post('/health').expect(503, { status: 'verification_only' });
  });
});
