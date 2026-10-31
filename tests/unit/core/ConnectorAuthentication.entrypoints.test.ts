import { AxiosError, type AxiosAdapter } from 'axios';
import { HubSpotConnector } from '../../../src/connectors/HubSpotConnector';
import { ShipStationConnector } from '../../../src/connectors/ShipStationConnector';
import { Logger } from '../../../src/utils/Logger';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

jest.useRealTimers();

class HubSpotHarness extends HubSpotConnector {
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  ensure(): Promise<void> { return this.ensureAuthenticated(); }
  request(sensitive = false): Promise<unknown> {
    const config = { method: 'GET', url: '/business-fixture' };
    return sensitive ? this.makeSensitiveRequest(config, '/redacted-fixture') : this.makeRequest(config);
  }
  get authenticated(): boolean { return this.isAuthenticated; }
  failures(): number { return this.circuitBreaker.getFailureCount(); }
}

class ShipStationHarness extends ShipStationConnector {
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  ensure(): Promise<void> { return this.ensureAuthenticated(); }
  request(sensitive = false): Promise<unknown> {
    const config = { method: 'GET', url: '/business-fixture' };
    return sensitive ? this.makeSensitiveRequest(config, '/redacted-fixture') : this.makeRequest(config);
  }
  get authenticated(): boolean { return this.isAuthenticated; }
}

function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

const logger = new Logger('AuthenticationEntryTests');
beforeEach(() => {
  for (const method of ['debug', 'info', 'warn', 'error'] as const) jest.spyOn(logger, method).mockImplementation(() => {});
});

async function create(name: 'HubSpot' | 'ShipStation') {
  const governance = createMockOutboundGovernanceService();
  if (name === 'HubSpot') {
    const connector = new HubSpotHarness(logger, governance);
    await connector.initialize({ type: 'api_key', credentials: { accessToken: 'fixture-token' } });
    return { connector, probe: '/objects/contacts' };
  }
  const connector = new ShipStationHarness(logger, governance);
  await connector.initialize({ type: 'api_key', credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret' } });
  return { connector, probe: '/carriers' };
}

describe.each(['HubSpot', 'ShipStation'] as const)('%s authentication entry contract', name => {
  it.each(['direct', 'ensure', 'ordinary', 'sensitive'] as const)('%s performs exactly one credential probe', async entry => {
    const { connector, probe } = await create(name);
    const calls: string[] = [];
    connector.setAdapter(async config => {
      calls.push(config.url ?? '');
      return { status: 200, statusText: 'OK', data: [], headers: {}, config };
    });
    if (entry === 'direct') await expect(connector.authenticate()).resolves.toBe(true);
    else if (entry === 'ensure') await connector.ensure();
    else await connector.request(entry === 'sensitive');
    expect(calls.filter(url => url === probe)).toHaveLength(1);
    expect(calls.filter(url => url === '/business-fixture')).toHaveLength(entry === 'direct' || entry === 'ensure' ? 0 : 1);
    expect(connector.authenticated).toBe(true);
  });

  describe.each([false, true])('sensitive=%s', sensitive => {
    it.each([false, true])('waits for a pending credential probe (refused=%s)', async refused => {
      const { connector, probe } = await create(name);
      const entered = barrier(), release = barrier();
      const calls: string[] = [];
      connector.setAdapter(async config => {
        calls.push(config.url ?? '');
        if (config.url === probe) {
          entered.release();
          await release.promise;
          if (refused) {
            throw new AxiosError('fixture unauthorized', 'ERR_BAD_REQUEST', config, undefined,
              { status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config });
          }
        }
        return { status: 200, statusText: 'OK', data: [], headers: {}, config };
      });
      const auth = settle(connector.authenticate());
      await entered.promise;
      const request = settle(connector.request(sensitive));
      await new Promise<void>(resolve => setImmediate(resolve));
      const businessCallsBeforeRelease = calls.filter(url => url === '/business-fixture').length;
      release.release();
      const [authResult, requestResult] = await Promise.all([auth, request]);
      expect(businessCallsBeforeRelease).toBe(0);
      expect(authResult.status).toBe(refused ? 'rejected' : 'fulfilled');
      expect(requestResult.status).toBe(refused ? 'rejected' : 'fulfilled');
      expect(calls.filter(url => url === probe)).toHaveLength(1);
      expect(calls.filter(url => url === '/business-fixture')).toHaveLength(refused ? 0 : 1);
      expect(connector.authenticated).toBe(!refused);
    });
  });
});

it('does not mistake a normal system-info request for the credential probe by URL', async () => {
  const { connector } = await create('ShipStation');
  const calls: string[] = [];
  connector.setAdapter(async config => {
    calls.push(config.url ?? '');
    return { status: 200, statusText: 'OK', data: [], headers: {}, config };
  });
  await connector.getSystemInfo();
  expect(calls).toEqual(['/carriers', '/carriers']);
  expect(connector.authenticated).toBe(true);
});

it('does not dispatch with missing HubSpot credentials', async () => {
  const connector = new HubSpotHarness(logger, createMockOutboundGovernanceService());
  await connector.initialize({ type: 'api_key', credentials: {} });
  const adapter = jest.fn(); connector.setAdapter(adapter);
  await expect(connector.authenticate()).rejects.toThrow('No access token or API key');
  await expect(connector.request()).rejects.toThrow();
  expect(adapter).not.toHaveBeenCalled(); expect(connector.authenticated).toBe(false);
});

it.each([[500, 2], [503, 0]])('preserves nested breaker accounting for probe status %s', async (status, failures) => {
  const connector = new HubSpotHarness(logger, createMockOutboundGovernanceService());
  await connector.initialize({ type: 'api_key', credentials: { apiKey: 'fixture' } });
  connector.maxRetries = 1;
  let calls = 0;
  connector.setAdapter(async config => {
    calls++;
    throw new AxiosError('upstream refused', 'ERR_BAD_RESPONSE', config, undefined,
      { status, statusText: '', headers: {}, data: {}, config });
  });
  await expect(connector.request()).rejects.toThrow();
  expect(calls).toBe(1); expect(connector.failures()).toBe(failures);
});
