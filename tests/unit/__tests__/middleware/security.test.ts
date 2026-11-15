import express from 'express';
import request from 'supertest';
import {
  sanitizeInput,
  preventSQLInjection,
  validateRequestSize,
  validateContentType,
} from '../../middleware/security';
import { Logger } from '../../utils/Logger';
import { BadRequestAppError } from '../../errors/AppError';

function createApp(maxSize = 1024) {
  const mockLogger = new Logger('test');
  const app = express();
  app.use(express.json());
  app.use(validateRequestSize(mockLogger, maxSize));
  app.use(validateContentType(mockLogger, ['application/json']));
  app.use(sanitizeInput(mockLogger));
  app.use(preventSQLInjection(mockLogger));
  app.post('/test', (req, res) => {
    res.json({ ok: true, body: req.body });
  });
  // Simple error handler for tests
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof BadRequestAppError) {
      res.status(err.statusCode).json({ error: { code: err.errorCode, message: err.message } });
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });
  return app;
}

describe('Security Middleware', () => {
  it('allows benign input', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send({ name: 'Alice' })
      .expect(200);
    expect(res.body).toEqual({ ok: true, body: { name: 'Alice' } });
  });

  it('rejects malicious SQL injection payloads', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send({ query: 'SELECT * FROM users; DROP TABLE users;' })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects oversized requests', async () => {
    const app = createApp(10); // 10 bytes max
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .send({ data: 'x'.repeat(20) })
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid content types', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'text/plain')
      .send('plain text')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
