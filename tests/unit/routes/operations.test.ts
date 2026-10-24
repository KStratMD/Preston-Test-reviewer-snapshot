/**
 * OperationalDashboard catch-block logging regression (same class as the
 * ComplianceRouter fix in PR #892 and governance/operationsRouter in PR #891):
 * Logger.error only attaches its 2nd arg to the structured log context when it
 * is an Error instance. All three catch blocks previously passed `{ error }`
 * (a plain object), silently dropping the error detail from the emitted log.
 *
 * Each test throws a NON-Error from the DistributedCache dependency and
 * asserts the logger receives a real Error carrying the thrown detail
 * (red before the fix, green after).
 */

import express from 'express';
import request from 'supertest';
import { OperationalDashboard } from '../../../src/routes/operations';
import { logger } from '../../../src/utils/Logger';

jest.mock('../../../src/utils/DistributedCache', () => ({
  getDistributedCache: jest.fn(),
}));

import { getDistributedCache } from '../../../src/utils/DistributedCache';

const mockedGetDistributedCache = jest.mocked(getDistributedCache);

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/ops', new OperationalDashboard().getRouter());
  return app;
}

describe('OperationalDashboard catch-block logging', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('GET /health: non-Error throw reaches logger.error as a real Error', async () => {
    mockedGetDistributedCache.mockReturnValue({
      getHealth: jest.fn().mockRejectedValue('cache backend offline'),
    } as never);

    const res = await request(buildApp()).get('/ops/health');

    expect(res.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith('Health check failed', expect.any(Error));
    const forwarded = errorSpy.mock.calls[0][1] as Error;
    expect(forwarded.message).toContain('cache backend offline');
  });

  it('GET /metrics: non-Error throw reaches logger.error as a real Error', async () => {
    mockedGetDistributedCache.mockReturnValue({
      getMetrics: jest.fn().mockRejectedValue('metrics backend offline'),
    } as never);

    const res = await request(buildApp()).get('/ops/metrics');

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith('Failed to get metrics', expect.any(Error));
    const forwarded = errorSpy.mock.calls[0][1] as Error;
    expect(forwarded.message).toContain('metrics backend offline');
  });

  it('POST /cache/clear: non-Error throw reaches logger.error as a real Error', async () => {
    mockedGetDistributedCache.mockReturnValue({
      clear: jest.fn().mockRejectedValue('clear failed upstream'),
    } as never);

    const res = await request(buildApp()).post('/ops/cache/clear').send({ type: 'distributed' });

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith('Failed to clear cache', expect.any(Error));
    const forwarded = errorSpy.mock.calls[0][1] as Error;
    expect(forwarded.message).toContain('clear failed upstream');
  });

  it('an Error throw is forwarded as-is (not double-wrapped)', async () => {
    const original = new Error('real error instance');
    mockedGetDistributedCache.mockReturnValue({
      getMetrics: jest.fn().mockRejectedValue(original),
    } as never);

    const res = await request(buildApp()).get('/ops/metrics');

    expect(res.status).toBe(500);
    expect(errorSpy.mock.calls[0][1]).toBe(original);
  });
});
