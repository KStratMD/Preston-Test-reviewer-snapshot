import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createHelpRouter } from '../../src/routes/help';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';

function createApp(processMessage: jest.Mock, identityMiddleware?: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express();
  app.use(express.json());
  if (identityMiddleware) {
    app.use(identityMiddleware);
  }
  app.use('/api/help', createHelpRouter(
    { processMessage } as never,
    {} as never,
  ));
  return app;
}

describe('identity propagation through help chat route', () => {
  it('passes SYSTEM_IDENTITY when no authenticated identity exists', async () => {
    const processMessage = jest.fn().mockResolvedValue({
      response: 'ok',
      sources: [],
      sessionId: 'session-1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
    });

    await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'How do I use mappings?' })
      .expect(200);

    expect(processMessage).toHaveBeenCalledWith(
      { message: 'How do I use mappings?', sessionId: undefined },
      SYSTEM_IDENTITY,
    );
  });

  it('passes req.user tenant identity when middleware populates it', async () => {
    const processMessage = jest.fn().mockResolvedValue({
      response: 'ok',
      sources: [],
      sessionId: 'session-1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
    });

    const app = createApp(processMessage, (req, _res, next) => {
      req.user = {
        id: 'user-route',
        username: 'route-user',
        tenantId: 'tenant-route',
        roles: [],
        permissions: [],
      };
      next();
    });

    await request(app)
      .post('/api/help/chat')
      .send({ message: 'How do I use mappings?' })
      .expect(200);

    expect(processMessage).toHaveBeenCalledWith(
      { message: 'How do I use mappings?', sessionId: undefined },
      { tenantId: 'tenant-route', userId: 'user-route' },
    );
  });
});
