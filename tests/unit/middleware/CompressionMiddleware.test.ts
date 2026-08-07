import express from 'express';
import request from 'supertest';
import { compressionMiddleware } from './CompressionMiddleware';

describe('compressionMiddleware', () => {
  it('compresses responses when gzip is accepted', async () => {
    const app = express();
    app.use(compressionMiddleware);
    app.get('/', (_req, res) => {
      res.json({ message: 'hello'.repeat(100) });
    });

    const res = await request(app).get('/').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toHaveProperty('message');
  });

  it('skips compression if encoding not supported', async () => {
    const app = express();
    app.use(compressionMiddleware);
    app.get('/', (_req, res) => {
      res.json({ message: 'plain' });
    });

    const res = await request(app).get('/').set('Accept-Encoding', 'identity').expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toHaveProperty('message', 'plain');
  });
});
