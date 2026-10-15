import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { BaseConnector, type AuthenticationProbe } from '../../../src/core/BaseConnector';
import { Logger } from '../../../src/utils/Logger';
import type { AuthConfig } from '../../../src/types';
import { inspect } from 'node:util';

jest.useRealTimers();

function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function settle<T>(promise: Promise<T>) {
  return promise.then(value => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }));
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
const logger = new Logger('AuthenticationLifecycleTests');
beforeEach(() => {
  for (const method of ['debug', 'info', 'warn', 'error'] as const) jest.spyOn(logger, method).mockImplementation(() => {});
});

class LifecycleConnector extends BaseConnector {
  readonly attempt = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
  probe?: AuthenticationProbe;
  constructor() { super('fixture', 'fixture', logger); this.maxRetries = 1; }
  async initialize(config: AuthConfig): Promise<void> { this.resetAuthentication(); this.authConfig = config; }
  protected async performAuthentication(probe: AuthenticationProbe): Promise<boolean> {
    this.probe = probe;
    const result = await this.attempt();
    if (result) this.httpClient.defaults.headers.common.Authorization = `Bearer ${this.attempt.mock.calls.length}`;
    return result;
  }
  getSystemInfo = jest.fn();
  create = jest.fn(); read = jest.fn(); update = jest.fn(); delete = jest.fn(); list = jest.fn(); search = jest.fn();
  ensure(): Promise<void> { return this.ensureAuthenticated(); }
  request(url = '/business', sensitive = false, method = 'GET'): Promise<unknown> {
    const config = { url, method };
    return sensitive ? this.makeSensitiveRequest(config, '/redacted') : this.makeRequest(config);
  }
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  get authenticated(): boolean { return this.isAuthenticated; }
  get authorization(): unknown { return this.httpClient.defaults.headers.common.Authorization; }
  protected async delay(): Promise<void> {}
}
const config: AuthConfig = { type: 'api_key', credentials: { apiKey: 'fixture-key' } };
const success = (request: InternalAxiosRequestConfig) => ({ status: 200, statusText: 'OK', data: {}, headers: {}, config: request });
function unauthorized(request: InternalAxiosRequestConfig) {
  return new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', request, undefined,
    { ...success(request), status: 401, statusText: 'Unauthorized' });
}

describe('shared authentication lifecycle', () => {
  it.each([401, 403, 500, 'setup'] as const)('does not expose credential-probe secrets through errors or logs (status=%s)', async status => {
    const c = new LifecycleConnector(); await c.initialize(config);
    const canary = 'credential-probe-canary';
    c.attempt.mockImplementation(async () => {
      await c.probe?.request({ method: 'POST', url: `/token/${canary}`, headers: { Authorization: canary }, data: { secret: canary } });
      return true;
    });
    c.setAdapter(async request => {
      if (status === 'setup') throw new Error(canary);
      throw new AxiosError(canary, 'ERR_BAD_RESPONSE', request, { secret: canary }, { ...success(request), status, data: { secret: canary } });
    });
    const result = await settle(c.authenticate());
    expect(result.status).toBe('rejected');
    const logs = ['debug', 'info', 'warn', 'error'].flatMap(method => (logger[method as keyof Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>] as jest.Mock).mock.calls);
    expect(inspect({ result, logs }, { depth: 20 })).not.toContain(canary);
    expect(c.authenticated).toBe(false);
  });
  it.each([false, true])('coalesces overlapping 401 refreshes (refused=%s)', async refused => {
    const c = new LifecycleConnector(); await c.initialize(config); await c.authenticate();
    const refreshing = barrier(), releaseRefresh = barrier(), bothSent = barrier();
    let initialRequests = 0;
    c.attempt.mockImplementation(async () => { refreshing.release(); await releaseRefresh.promise; return !refused; });
    c.setAdapter(async request => {
      if (request.headers.Authorization === 'Bearer 1') {
        initialRequests++; if (initialRequests === 2) bothSent.release();
        await bothSent.promise;
        throw unauthorized(request);
      }
      return success(request);
    });
    const first = settle(c.request('/one')), second = settle(c.request('/two', true));
    await refreshing.promise; await checkpoint(); const attemptsDuringRefresh = c.attempt.mock.calls.length;
    releaseRefresh.release(); const results = await Promise.all([first, second]);
    expect(attemptsDuringRefresh).toBe(2); expect(c.attempt).toHaveBeenCalledTimes(2);
    expect(results.map(result => result.status)).toEqual(refused ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
    expect(c.authenticated).toBe(!refused);
  });

  it('joins a forced refresh even when already authenticated, without blocking another instance', async () => {
    const c = new LifecycleConnector(), other = new LifecycleConnector();
    await c.initialize(config); await other.initialize(config); await c.authenticate();
    const entered = barrier(), release = barrier(); let calls = 0;
    c.attempt.mockImplementation(async () => { entered.release(); await release.promise; return true; });
    c.setAdapter(async request => { calls++; return success(request); });
    other.setAdapter(async request => success(request));
    const first = c.authenticate(); await entered.promise;
    const joined = c.authenticate(); expect(joined).toBe(first);
    const request = c.request(), ensure = c.ensure();
    await other.request(); await checkpoint(); const before = calls;
    release.release(); await Promise.all([first, joined, request, ensure]);
    expect(before).toBe(0); expect(calls).toBe(1); expect(c.attempt).toHaveBeenCalledTimes(2);
    expect(other.attempt).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('expires the probe capability at settlement (sensitive=%s)', async sensitive => {
    const c = new LifecycleConnector(); await c.initialize(config);
    const dispatch = jest.fn(async request => success(request)); c.setAdapter(dispatch);
    await c.authenticate(); const probe = c.probe;
    if (!probe) throw new Error('fixture did not receive capability');
    await expect(sensitive ? probe.requestSensitive({ url: '/late' }, '/redacted') : probe.request({ url: '/late' })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(c.authenticated).toBe(true);
  });

  it.each([401, 403])('a probe %s is terminal and its failed attempt releases waiters', async status => {
    const c = new LifecycleConnector(); await c.initialize(config);
    c.attempt.mockImplementation(async () => { await c.probe?.request({ url: '/token' }); return true; });
    const dispatch = jest.fn(async request => {
      throw new AxiosError('refused', 'ERR_BAD_REQUEST', request, undefined, { ...success(request), status });
    });
    c.setAdapter(dispatch);
    await expect(c.request()).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1); expect(c.attempt).toHaveBeenCalledTimes(1);
    c.attempt.mockResolvedValue(true); await c.authenticate(); expect(c.authenticated).toBe(true);
  });

  it('clears derived headers on permitted reinitialization', async () => {
    const c = new LifecycleConnector(); await c.initialize(config); await c.authenticate();
    expect(c.authorization).toBe('Bearer 1');
    await c.initialize({ ...config });
    expect(c.authenticated).toBe(false); expect(c.authorization).toBeUndefined();
  });

  it.each([false, true])('rejects an old-config transient retry without reauthenticating (sensitive=%s)', async sensitive => {
    const c = new LifecycleConnector(); c.maxRetries = 2;
    await c.initialize(config); await c.authenticate();
    const entered = barrier(), release = barrier(); let calls = 0;
    c.setAdapter(async request => {
      calls++; entered.release(); await release.promise;
      throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', request, undefined, { ...success(request), status: 503 });
    });
    const result = settle(c.request('/business', sensitive)); await entered.promise;
    await c.initialize({ ...config }); release.release();
    expect((await result).status).toBe('rejected'); expect(calls).toBe(1); expect(c.attempt).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('refreshes credentials that expire during transient backoff (sensitive=%s)', async sensitive => {
    const c = new LifecycleConnector(); c.maxRetries = 2;
    await c.initialize({ ...config, expiresAt: new Date(Date.now() + 600_000) }); await c.authenticate();
    const headers: unknown[] = [];
    c.attempt.mockImplementation(async () => { c.authConfig.expiresAt = new Date(Date.now() + 600_000); return true; });
    c.setAdapter(async request => {
      headers.push(request.headers.Authorization);
      if (headers.length === 1) {
        c.authConfig.expiresAt = new Date(Date.now() - 1);
        throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', request, undefined, { ...success(request), status: 503 });
      }
      return success(request);
    });
    await c.request('/business', sensitive);
    expect(headers).toEqual(['Bearer 1', 'Bearer 2']); expect(c.attempt).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('does not invalidate a newer credential after a delayed second 401 (sensitive=%s)', async sensitive => {
    const c = new LifecycleConnector(); await c.initialize(config); await c.authenticate();
    const entered = barrier(), release = barrier(); let calls = 0;
    c.setAdapter(async request => {
      calls++;
      if (calls === 2) { entered.release(); await release.promise; }
      throw unauthorized(request);
    });
    const result = settle(c.request('/business', sensitive)); await entered.promise;
    await c.authenticate(); expect(c.authorization).toBe('Bearer 3');
    release.release(); expect((await result).status).toBe('rejected');
    expect(c.authenticated).toBe(true); expect(c.authorization).toBe('Bearer 3'); expect(calls).toBe(2);
  });

  it('captures refreshed credentials on transient retries before processing a 401', async () => {
    const c = new LifecycleConnector(); c.maxRetries = 2;
    await c.initialize(config); await c.authenticate();
    const entered = barrier(), release = barrier(); const headers: unknown[] = [];
    c.setAdapter(async request => {
      headers.push(request.headers.Authorization);
      if (headers.length === 1) {
        entered.release(); await release.promise;
        throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', request, undefined, { ...success(request), status: 503 });
      }
      if (headers.length === 2) throw unauthorized(request);
      return success(request);
    });
    const result = c.request(); await entered.promise; await c.authenticate(); release.release(); await result;
    expect(headers).toEqual(['Bearer 1', 'Bearer 2', 'Bearer 3']); expect(c.attempt).toHaveBeenCalledTimes(3);
  });

  it('keeps sensitive response canaries out of errors and logs', async () => {
    const c = new LifecycleConnector(); await c.initialize(config);
    const canary = 'AUTH_PRIVATE_CANARY';
    c.setAdapter(async request => { throw new AxiosError(canary, 'ERR_BAD_RESPONSE', request, undefined, { ...success(request), status: 403, data: { canary } }); });
    const result = await settle(c.request('/'+canary, true));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Expected a rejection');
    expect(String(result.reason)).not.toContain(canary); expect(JSON.stringify(result.reason)).not.toContain(canary);
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(canary);
  });

  it.each(['false', 'throw'] as const)('coalesces callers and propagates %s before business dispatch', async failure => {
    const c = new LifecycleConnector(); await c.initialize(config);
    const entered = barrier(), release = barrier();
    c.attempt.mockImplementation(async () => { entered.release(); await release.promise; if (failure === 'throw') throw new Error('fixture refused'); return false; });
    const calls: string[] = []; c.setAdapter(async request => { calls.push(request.url ?? ''); return success(request); });
    const first = settle(c.authenticate()); await entered.promise;
    const rest = [settle(c.authenticate()), settle(c.ensure()), settle(c.request()), settle(c.request('/sensitive', true))];
    await checkpoint(); const callsBeforeRelease = calls.length;
    release.release(); const results = await Promise.all([first, ...rest]);
    expect(callsBeforeRelease).toBe(0);
    expect(c.attempt).toHaveBeenCalledTimes(1);
    expect(results.slice(2).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(c.authenticated).toBe(false);
    c.attempt.mockResolvedValue(true);
    await expect(c.authenticate()).resolves.toBe(true);
    expect(c.authenticated).toBe(true);
  });

  it('checks expiry on ensure and retains valid cached authentication', async () => {
    const c = new LifecycleConnector(); await c.initialize({ ...config, expiresAt: new Date(Date.now() + 600_000) });
    await c.authenticate(); await c.ensure(); expect(c.attempt).toHaveBeenCalledTimes(1);
    c.authConfig.expiresAt = new Date(Date.now() - 1);
    await c.ensure(); expect(c.attempt).toHaveBeenCalledTimes(2);
  });

  it('reports disconnected when authentication returns false', async () => {
    const c = new LifecycleConnector(); c.attempt.mockResolvedValue(false); c.getSystemInfo.mockResolvedValue({});
    expect((await c.testConnection()).isConnected).toBe(false);
    expect(c.getSystemInfo).not.toHaveBeenCalled();
  });

  it.each([false, true])('late 401 reuses a newer credential without another refresh (sensitive=%s)', async sensitive => {
    const c = new LifecycleConnector(); await c.initialize(config); await c.authenticate();
    const firstEntered = barrier(), secondEntered = barrier(), releaseFirst = barrier(), releaseSecond = barrier();
    const seen = new Map<string, number>();
    c.setAdapter(async request => {
      const url = request.url ?? ''; const count = (seen.get(url) ?? 0) + 1; seen.set(url, count);
      if (count === 1) {
        (url === '/first' ? firstEntered : secondEntered).release();
        await (url === '/first' ? releaseFirst : releaseSecond).promise;
        throw unauthorized(request);
      }
      return success(request);
    });
    const first = c.request('/first', sensitive), second = c.request('/second', sensitive);
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    releaseFirst.release(); await first;
    expect(c.attempt).toHaveBeenCalledTimes(2);
    releaseSecond.release(); await second;
    expect(c.attempt).toHaveBeenCalledTimes(2);
    expect(c.authenticated).toBe(true);
  });

  it('rejects reinitialization during a pending attempt before replacing configuration', async () => {
    const c = new LifecycleConnector(); await c.initialize(config);
    const entered = barrier(), release = barrier();
    c.attempt.mockImplementation(async () => { entered.release(); await release.promise; return true; });
    const auth = c.authenticate(); await entered.promise;
    const replacement = await settle(c.initialize({ type: 'api_key', credentials: { apiKey: 'replacement' } }));
    release.release(); await auth;
    expect(replacement.status).toBe('rejected'); expect(c.authConfig).toBe(config);
  });

  it('does not replay a pending old-config request after reinitialization', async () => {
    const c = new LifecycleConnector(); await c.initialize(config); await c.authenticate();
    const entered = barrier(), release = barrier(); const requests: string[] = [];
    c.setAdapter(async request => { requests.push(request.url ?? ''); entered.release(); await release.promise; throw unauthorized(request); });
    const request = settle(c.request()); await entered.promise;
    await c.initialize({ type: 'api_key', credentials: { apiKey: 'replacement' } });
    release.release(); expect((await request).status).toBe('rejected');
    expect(requests).toHaveLength(1); expect(c.attempt).toHaveBeenCalledTimes(1);
  });
});
