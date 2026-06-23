import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { reconciliationCenterRouter } from '../../../src/routes/reconciliationCenterRoutes';
import { ReconciliationExceptionNotFoundError } from '../../../src/services/reconciliationCenter/ReconciliationExceptionRepository';
import { UnknownReconcilerError, ReconcilerConfigError } from '../../../src/services/reconciliationCenter/reconcilers/Reconciler';
import { ReconciliationScheduleNotFoundError } from '../../../src/services/reconciliationCenter/ReconciliationScheduleRepository';
import type { ReconciliationCenterService } from '../../../src/services/reconciliationCenter/ReconciliationCenterService';

type RoutedSvc = Pick<ReconciliationCenterService, 'listOpen' | 'resolveException' | 'createSchedule' | 'listSchedules' | 'updateSchedule' | 'deleteSchedule'>;

function appWith(service: RoutedSvc, identity: { tenantId?: string; id?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (identity.tenantId !== undefined || identity.id !== undefined) {
      (req as unknown as { user: { tenantId?: string; id?: string } }).user = {
        tenantId: identity.tenantId,
        id: identity.id,
      };
    }
    next();
  });
  app.use('/api/reconciliation-center', reconciliationCenterRouter(service as ReconciliationCenterService));
  return app;
}

describe('reconciliationCenterRoutes', () => {
  it('lists tenant-scoped open exceptions', async () => {
    const service = {
      listOpen: jest.fn(async () => [{ id: 'rex_1', tenantId: 't_squire', status: 'open' }]),
      resolveException: jest.fn(),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });

    const res = await request(app).get('/api/reconciliation-center/exceptions');

    expect(res.status).toBe(200);
    expect(res.body.exceptions[0].id).toBe('rex_1');
    expect(service.listOpen).toHaveBeenCalledWith('t_squire');
  });

  it('rejects unauthenticated callers with 401 on list', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(),
    };
    const app = appWith(service as unknown as RoutedSvc, {});

    const res = await request(app).get('/api/reconciliation-center/exceptions');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(service.listOpen).not.toHaveBeenCalled();
  });

  it('resolves an exception with operator attribution', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(async () => undefined),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({ note: 'matched fee adjustment' });

    expect(res.status).toBe(204);
    expect(service.resolveException).toHaveBeenCalledWith({
      tenantId: 't_squire',
      exceptionId: 'rex_1',
      actorUserId: 'u_ops',
      note: 'matched fee adjustment',
    });
  });

  it('rejects unauthenticated callers with 401 on resolve', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(),
    };
    const app = appWith(service as unknown as RoutedSvc, {});

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(401);
    expect(service.resolveException).not.toHaveBeenCalled();
  });

  it('rejects resolve when req.user lacks a usable user id', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire' });

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(service.resolveException).not.toHaveBeenCalled();
  });

  it('rejects resolve when only req.tenantContext is populated (operator_identity_required)', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(),
    };
    const app = express();
    app.use(express.json());
    // Simulate the PR 4B tenantIsolation bridge — req.tenantContext only,
    // no req.user / req.auth. extractIdentityContext returns the real
    // tenantId but SYSTEM_IDENTITY.userId.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { tenantContext: { tenantId: string } }).tenantContext = { tenantId: 't_squire' };
      next();
    });
    app.use('/api/reconciliation-center', reconciliationCenterRouter(service as unknown as ReconciliationCenterService));

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'operator_identity_required' });
    expect(service.resolveException).not.toHaveBeenCalled();
  });

  it('returns 404 when the repository reports the exception is missing', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(async () => {
        throw new ReconciliationExceptionNotFoundError('t_squire', 'rex_missing');
      }),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_missing/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'exception_not_found' });
  });

  it('propagates a non-NotFoundError from resolve (500)', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(async () => {
        throw new Error('db unavailable');
      }),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(500);
  });

  it('coerces a missing note to an empty string', async () => {
    const service = {
      listOpen: jest.fn(),
      resolveException: jest.fn(async () => undefined),
    };
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });

    const res = await request(app)
      .post('/api/reconciliation-center/exceptions/rex_1/resolve')
      .send({});

    expect(res.status).toBe(204);
    expect(service.resolveException).toHaveBeenCalledWith(
      expect.objectContaining({ note: '' }),
    );
  });
});

describe('schedule routes', () => {
  const baseSvc = () => ({
    listOpen: jest.fn(), resolveException: jest.fn(),
    createSchedule: jest.fn(async (i) => ({ id: 'rsched_1', ...i, active: true, nextRunAt: 'now', createdAt: 'now', updatedAt: 'now' })),
    listSchedules: jest.fn(async () => [{ id: 'rsched_1', tenantId: 't_squire' }]),
  });

  it('POST /schedules creates a schedule (201) and persists trimmed values', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).post('/api/reconciliation-center/schedules').send({
      name: '  nightly  ', cadence: 'daily',
      handlerKey: ' netsuite_business_central_invoice_reconciliation ', integrationConfigId: '  cfg_ns_bc  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.schedule.id).toBe('rsched_1');
    expect(service.createSchedule).toHaveBeenCalledWith({
      tenantId: 't_squire',
      name: 'nightly',
      cadence: 'daily',
      handlerKey: 'netsuite_business_central_invoice_reconciliation',
      integrationConfigId: 'cfg_ns_bc',
    });
  });

  it('POST /schedules 401 without identity', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, {});
    const res = await request(app).post('/api/reconciliation-center/schedules').send({ name: 'x', cadence: 'daily', handlerKey: 'k', integrationConfigId: 'c' });
    expect(res.status).toBe(401);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it.each([
    // whitespace-only strings: the typeof-string ternary is TRUE, then trim → '' fails the !value guard
    [{ name: '   ', cadence: 'daily', handlerKey: 'k', integrationConfigId: 'c' }, 'name_required'],
    [{ name: 'x', cadence: 'daily', handlerKey: 'k', integrationConfigId: '   ' }, 'integration_config_required'],
    // missing fields: the typeof-string ternary is FALSE → '' fails the guard
    [{}, 'name_required'],
    [{ name: 'x', cadence: 'daily' }, 'integration_config_required'],
    // cadence: a string not in the set AND a missing cadence (both isValidCadence branches)
    [{ name: 'x', cadence: 'yearly', handlerKey: 'k', integrationConfigId: 'c' }, 'invalid_cadence'],
    [{ name: 'x' }, 'invalid_cadence'],
  ])('POST /schedules 400 (case %#)', async (body, errorCode) => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).post('/api/reconciliation-center/schedules').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: errorCode });
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it('POST /schedules forwards an empty handlerKey to the service (route does not gate it; service does)', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    // No handlerKey in the body → the route coerces it to '' and forwards to the
    // service, which is where handler validation lives (here the mock accepts it).
    const res = await request(app).post('/api/reconciliation-center/schedules').send({ name: 'x', cadence: 'daily', integrationConfigId: 'c' });
    expect(res.status).toBe(201);
    expect(service.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ handlerKey: '' }));
  });

  it('POST /schedules 400 unknown_handler when the service rejects the key', async () => {
    const service = baseSvc();
    service.createSchedule = jest.fn(async () => { throw new UnknownReconcilerError('nope'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).post('/api/reconciliation-center/schedules').send({ name: 'x', cadence: 'daily', handlerKey: 'nope', integrationConfigId: 'c' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_handler' });
  });

  it('POST /schedules 400 invalid_config with reasonCode when the service rejects on config validation', async () => {
    const service = baseSvc();
    service.createSchedule = jest.fn(async () => { throw new ReconcilerConfigError('config_system_pair_mismatch', 'netsuite+salesforce'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).post('/api/reconciliation-center/schedules').send({ name: 'x', cadence: 'daily', handlerKey: 'k', integrationConfigId: 'c' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_config', reason: 'config_system_pair_mismatch' });
  });

  it('POST /schedules propagates a non-UnknownReconcilerError (500)', async () => {
    const service = baseSvc();
    service.createSchedule = jest.fn(async () => { throw new Error('db unavailable'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).post('/api/reconciliation-center/schedules').send({ name: 'x', cadence: 'daily', handlerKey: 'k', integrationConfigId: 'c' });
    expect(res.status).toBe(500);
  });

  it('GET /schedules lists tenant schedules', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).get('/api/reconciliation-center/schedules');
    expect(res.status).toBe(200);
    expect(res.body.schedules[0].id).toBe('rsched_1');
    expect(service.listSchedules).toHaveBeenCalledWith('t_squire');
  });

  it('GET /schedules 401 without identity', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, {});
    const res = await request(app).get('/api/reconciliation-center/schedules');
    expect(res.status).toBe(401);
    expect(service.listSchedules).not.toHaveBeenCalled();
  });
});

describe('PATCH /schedules/:id', () => {
  const baseSvc = () => ({
    listOpen: jest.fn(), resolveException: jest.fn(),
    createSchedule: jest.fn(), listSchedules: jest.fn(),
    updateSchedule: jest.fn(async () => ({ id: 's1', tenantId: 't_squire', name: 'renamed' })),
    deleteSchedule: jest.fn(),
  });

  it('401 without identity', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, {});
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ name: 'x' });
    expect(res.status).toBe(401);
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('400 no_updates for an empty body', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_updates' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('400 invalid_cadence', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ cadence: 'yearly' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_cadence' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('400 invalid_active for a non-boolean active', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ active: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_active' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('400 name_required for a blank-after-trim name', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name_required' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('404 schedule_not_found when the service throws NotFound', async () => {
    const service = baseSvc();
    service.updateSchedule = jest.fn(async () => { throw new ReconciliationScheduleNotFoundError('t1', 's1'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ active: false });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'schedule_not_found' });
  });

  it('400 invalid_config when the service rejects on config validation', async () => {
    const service = baseSvc();
    service.updateSchedule = jest.fn(async () => { throw new ReconcilerConfigError('config_not_found'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ integrationConfigId: 'cfg_b' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_config', reason: 'config_not_found' });
  });

  it('200 with the updated schedule on success, passing trimmed name to the service', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ name: '  renamed  ' });
    expect(res.status).toBe(200);
    expect(res.body.schedule.id).toBe('s1');
    expect(service.updateSchedule).toHaveBeenCalledWith('t_squire', 's1', { name: 'renamed' });
  });

  it('200 setting cadence + active + integrationConfigId (trimmed/typed patch)', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app)
      .patch('/api/reconciliation-center/schedules/s1')
      .send({ cadence: 'weekly', active: false, integrationConfigId: '  cfg_x  ' });
    expect(res.status).toBe(200);
    expect(service.updateSchedule).toHaveBeenCalledWith('t_squire', 's1', {
      cadence: 'weekly',
      active: false,
      integrationConfigId: 'cfg_x',
    });
  });

  it('400 integration_config_required for a blank-after-trim integrationConfigId', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ integrationConfigId: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'integration_config_required' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });

  it('400 unknown_handler when the service throws UnknownReconcilerError (defensive)', async () => {
    const service = baseSvc();
    service.updateSchedule = jest.fn(async () => { throw new UnknownReconcilerError('h'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ active: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_handler' });
  });

  it('propagates a generic error (500)', async () => {
    const service = baseSvc();
    service.updateSchedule = jest.fn(async () => { throw new Error('db down'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't_squire', id: 'u_ops' });
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1').send({ active: true });
    expect(res.status).toBe(500);
  });

  it('400 no_updates when req.body is undefined (no body parser; exercises the ?? {} fallback)', async () => {
    const service = baseSvc();
    // No express.json() here, so req.body is undefined and the `req.body ?? {}`
    // fallback is taken; an undefined body yields an empty patch → no_updates.
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: { tenantId?: string; id?: string } }).user = { tenantId: 't_squire', id: 'u_ops' };
      next();
    });
    app.use('/api/reconciliation-center', reconciliationCenterRouter(service as unknown as ReconciliationCenterService));
    const res = await request(app).patch('/api/reconciliation-center/schedules/s1');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_updates' });
    expect(service.updateSchedule).not.toHaveBeenCalled();
  });
});

describe('DELETE /schedules/:id', () => {
  const baseSvc = () => ({
    listOpen: jest.fn(), resolveException: jest.fn(),
    createSchedule: jest.fn(), listSchedules: jest.fn(),
    updateSchedule: jest.fn(),
    deleteSchedule: jest.fn(async () => undefined),
  });

  it('401 without identity', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, {});
    const res = await request(app).delete('/api/reconciliation-center/schedules/s1');
    expect(res.status).toBe(401);
    expect(service.deleteSchedule).not.toHaveBeenCalled();
  });

  it('204 on success, delegating to the service', async () => {
    const service = baseSvc();
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't1', id: 'u_ops' });
    const res = await request(app).delete('/api/reconciliation-center/schedules/s1');
    expect(res.status).toBe(204);
    expect(service.deleteSchedule).toHaveBeenCalledWith('t1', 's1');
  });

  it('404 schedule_not_found when the service throws NotFound', async () => {
    const service = baseSvc();
    service.deleteSchedule = jest.fn(async () => { throw new ReconciliationScheduleNotFoundError('t1', 's1'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't1', id: 'u_ops' });
    const res = await request(app).delete('/api/reconciliation-center/schedules/s1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'schedule_not_found' });
  });

  it('propagates a generic error (500)', async () => {
    const service = baseSvc();
    service.deleteSchedule = jest.fn(async () => { throw new Error('db down'); });
    const app = appWith(service as unknown as RoutedSvc, { tenantId: 't1', id: 'u_ops' });
    const res = await request(app).delete('/api/reconciliation-center/schedules/s1');
    expect(res.status).toBe(500);
  });
});
