import { buildQueueConnectionOptions, env } from '../../../src/config/env';

describe('queue connection option forwarding', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));

  beforeEach(() => {
    Object.assign(env, {
      REDIS_URL: undefined, REDIS_HOST: 'redis.internal', REDIS_PORT: 6381,
      REDIS_DB: 4, REDIS_PASSWORD: 'synthetic-secret', REDIS_TLS: false,
    });
  });

  it('forwards discrete address, database and password when there is no URL', () => {
    expect(buildQueueConnectionOptions()).toEqual({
      host: 'redis.internal', port: 6381, db: 4, password: 'synthetic-secret',
    });
  });

  it.each(['redis://redis.example:6382/5', 'rediss://redis.example:6382/5'])(
    'preserves URL %s without adding default host, port or database', url => {
      env.REDIS_URL = url;
      expect(buildQueueConnectionOptions()).toEqual({ url, password: 'synthetic-secret' });
    },
  );

  it('forwards explicit TLS with a plaintext URL', () => {
    env.REDIS_URL = 'redis://redis.example:6382/5';
    env.REDIS_TLS = true;
    expect(buildQueueConnectionOptions()).toEqual({
      url: env.REDIS_URL, password: 'synthetic-secret', tls: {},
    });
  });

  it('omits an absent password and adds TLS to discrete options', () => {
    env.REDIS_PASSWORD = undefined;
    env.REDIS_TLS = true;
    expect(buildQueueConnectionOptions()).toEqual({
      host: 'redis.internal', port: 6381, db: 4, tls: {},
    });
  });
});
