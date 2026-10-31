/**
 * Integration (F4): POST /api/ai/proxy/nlq derives the orchestrator tenant
 * from the VERIFIED JWT only — a forged body tenantId must never reach
 * processQuery. Real authMiddleware + real HS256 JWT.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// All mock state lives inside the factory (jest.mock is hoisted above imports).
// TOKEN-AWARE (Codex R4): authMiddleware resolves AND CACHES
// TYPES.AuthService through this same container (auth.ts:57-61), so a
// blanket `get: () => logger` would install the logger as the auth service
// and 401 every request. Discriminate by symbol description (same pattern
// as the nlActionGateRouter suite): AuthService → a stub doing REAL HS256
// verification; everything else (Logger) → the logger.
jest.mock('../../src/inversify/inversify.config', () => {
  const realJwt = jest.requireActual('jsonwebtoken') as typeof import('jsonwebtoken');
  const logger: Record<string, unknown> = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  logger.child = () => logger;
  const authService = {
    verifyJWT(token: string): Record<string, unknown> {
      const decoded = realJwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('Invalid JWT payload format');
      return decoded as Record<string, unknown>;
    },
    generateJWT(): string { throw new Error('not used in this fixture'); },
  };
  const processQuery = jest.fn(async () => ({
    success: true, query: '', resolution: null, execution: null, formattedAnswer: 'ok',
    followUpQuestions: [], relatedCapabilities: [],
    metadata: { processingTimeMs: 1, confidenceScore: 1 },
  }));
  return {
    container: {
      get: (type: symbol) => (String(type).includes('AuthService') ? authService : logger),
      getAsync: async () => ({ processQuery }),
    },
  };
});

import { createMetricsNLQRouter } from '../../src/routes/ai-proxy/MetricsNLQRouter';
import { authMiddleware } from '../../src/middleware/auth';

describe('POST /api/ai/proxy/nlq — JWT tenant beats body tenant (F4)', () => {
  it('forged body tenantId never reaches processQuery', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/ai/proxy', authMiddleware, createMetricsNLQRouter());

    const token = jwt.sign({ sub: 'user-a', tenantId: 'tenant-a' },
      process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });

    const res = await request(app).post('/api/ai/proxy/nlq')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'show me supplier metrics', tenantId: 'tenant-evil', userId: 'body-user' });
    expect(res.status).toBe(200);

    const { container } = jest.requireMock('../../src/inversify/inversify.config');
    const orchestrator = await container.getAsync();
    expect(orchestrator.processQuery).toHaveBeenCalledTimes(1);
    expect(orchestrator.processQuery).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));
    expect(orchestrator.processQuery).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-evil' }));
  });
});
