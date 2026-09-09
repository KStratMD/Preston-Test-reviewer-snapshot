import express from 'express';
import request from 'supertest';
import {
  globalErrorHandler,
  notFoundHandler,
  setupGlobalErrorHandlers,
} from '../../middleware/errorBoundary';
import {
  ValidationAppError,
  NotFoundAppError,
  UnauthorizedAppError,
  ForbiddenAppError,
  BadRequestAppError,
  ServiceUnavailableAppError,
} from '../../errors/AppError';

describe('errorBoundary middleware', () => {
  it('handles known AppError types with expected status codes', async () => {
    const app = express();
    app.get('/validation', () => { throw new ValidationAppError('Invalid', ['field']); });
    app.get('/unauth', () => { throw new UnauthorizedAppError('No auth'); });
    app.get('/forbidden', () => { throw new ForbiddenAppError('No access'); });
    app.get('/bad', () => { throw new BadRequestAppError('Bad'); });
    app.get('/svc', () => { throw new ServiceUnavailableAppError('Down'); });
    app.get('/notfound', () => { throw new NotFoundAppError('Missing'); });
    app.use(globalErrorHandler());

    await request(app).get('/validation').expect(400);
    await request(app).get('/unauth').expect(401);
    await request(app).get('/forbidden').expect(403);
    await request(app).get('/bad').expect(400);
    await request(app).get('/svc').expect(503);
    await request(app).get('/notfound').expect(404);
  });

  it('returns 500 for unknown errors with safe payload', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error('boom'); });
    app.use(globalErrorHandler());

    const res = await request(app).get('/boom').expect(500);
    expect(res.body).toHaveProperty('error', 'Internal Server Error');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('notFoundHandler returns JSON 404 with route info', async () => {
    const app = express();
    // no routes
    app.use(notFoundHandler());
    const res = await request(app).get('/nope').expect(404);
    expect(res.body).toHaveProperty('error', 'Not Found');
    expect(res.body).toHaveProperty('path', '/nope');
  });
});

describe('setupGlobalErrorHandlers', () => {
  it('adds process listeners for uncaughtException and unhandledRejection', () => {
    const beforeUC = process.listeners('uncaughtException');
    const beforeUR = process.listeners('unhandledRejection');

    setupGlobalErrorHandlers();

    const afterUC = process.listeners('uncaughtException');
    const afterUR = process.listeners('unhandledRejection');

    // Ensure a new listener was added for each
    expect(afterUC.length).toBeGreaterThanOrEqual(beforeUC.length + 1);
    expect(afterUR.length).toBeGreaterThanOrEqual(beforeUR.length + 1);

    // Cleanup: remove any listeners added by setup to avoid side effects in Jest
    const addedUC = afterUC.filter(fn => !beforeUC.includes(fn));
    const addedUR = afterUR.filter(fn => !beforeUR.includes(fn));
    addedUC.forEach(fn => process.removeListener('uncaughtException', fn));
    addedUR.forEach(fn => process.removeListener('unhandledRejection', fn as any));
  });
});

