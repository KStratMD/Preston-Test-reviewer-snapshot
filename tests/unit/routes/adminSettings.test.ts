import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

// requirePlatformAdmin is exercised by its own unit suite and by the
// integration suite with real JWTs; here it is a pass-through so we can pin the
// handler's validation, actor resolution, and service call in isolation.
jest.mock('../../../src/middleware/verifiedAdmin', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { createAdminSettingsRouter } from '../../../src/routes/adminSettings';

const service = { setDemoMode: jest.fn() };

async function buildAdminApp(user: { id: string } | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = user;
    next();
  });
  app.use('/api/admin/settings', await createAdminSettingsRouter(service as never));
  return app;
}

describe('admin settings router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid bodies before calling the service', async () => {
    const res = await request(await buildAdminApp({ id: 'admin-1' }))
      .post('/api/admin/settings/demo-mode')
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(service.setDemoMode).not.toHaveBeenCalled();
  });

  it('passes the verified actor and sanitized request metadata', async () => {
    service.setDemoMode.mockResolvedValue({ enabled: true });
    const res = await request(await buildAdminApp({ id: 'admin-1' }))
      .post('/api/admin/settings/demo-mode')
      .set('User-Agent', 'admin-test')
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabled: true });
    expect(service.setDemoMode).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        actorUserId: 'admin-1',
        userAgent: 'admin-test',
      }),
    );
  });

  it('never takes the actor id from the request body', async () => {
    service.setDemoMode.mockResolvedValue({ enabled: false });
    await request(await buildAdminApp({ id: 'admin-1' }))
      .post('/api/admin/settings/demo-mode')
      .send({ enabled: false, actorUserId: 'forged', userId: 'forged' })
      .expect(200);
    expect(service.setDemoMode).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'admin-1' }),
    );
  });

  it('fails closed if requirePlatformAdmin did not leave an actor id', async () => {
    const res = await request(await buildAdminApp(undefined))
      .post('/api/admin/settings/demo-mode')
      .send({ enabled: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('actor_unidentified');
    expect(service.setDemoMode).not.toHaveBeenCalled();
  });
});
