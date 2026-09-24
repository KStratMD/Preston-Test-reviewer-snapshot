import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

async function bounded<T>(operation: Promise<T>, label = 'unnamed'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis operation ${label} exceeded 10 seconds`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function client(name: string): Redis {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectionName: name,
    maxRetriesPerRequest: null, // BullMQ requires this on shared blocking clients.
    connectTimeout: 2000,
  });
  // Connection refusal is asserted through connect/commands; never leave an
  // EventEmitter error unhandled while finally disconnects the owned client.
  redis.on('error', () => undefined);
  return redis;
}

describe('ioredis shared peer against real Redis', () => {
  it('negotiates RESP3 by default (observed by the server)', async () => {
    const redis = client(`protocol-${randomUUID()}`);
    try {
      await bounded(redis.connect());
      expect(await bounded(redis.call('CLIENT', 'INFO'))).toMatch(/\bresp=3\b/);
    } finally {
      redis.disconnect();
    }
  });

  it('preserves string, hash, scan and pipeline replies and reconnects after its socket is killed', async () => {
    const prefix = `compat-${randomUUID()}`;
    const redis = client(prefix);
    const observer = client(`${prefix}-observer`);
    try {
      await bounded(Promise.all([redis.connect(), observer.connect()]));
      expect(await bounded(redis.set(`${prefix}:string`, 'value'))).toBe('OK');
      expect(await bounded(redis.get(`${prefix}:string`))).toBe('value');
      await bounded(redis.hset(`${prefix}:hash`, 'field', 'value'));
      expect(await bounded(redis.hgetall(`${prefix}:hash`))).toEqual({ field: 'value' });
      const found: string[] = [];
      let cursor = '0';
      do {
        const reply = await bounded(redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100));
        expect(Array.isArray(reply)).toBe(true);
        expect(typeof reply[0]).toBe('string');
        expect(Array.isArray(reply[1])).toBe(true);
        [cursor] = reply;
        found.push(...reply[1]);
      } while (cursor !== '0');
      expect(found).toEqual(expect.arrayContaining([`${prefix}:string`, `${prefix}:hash`]));
      const replies = await bounded(redis.pipeline().get(`${prefix}:string`).hgetall(`${prefix}:hash`)
        .get(`${prefix}:hash`).exec());
      expect(replies).toEqual([
        [null, 'value'], [null, { field: 'value' }], [expect.any(Error)],
      ]);
      expect(replies?.[2][0]?.message).toMatch(/WRONGTYPE/);

      const oldId = await bounded(redis.call('CLIENT', 'ID'));
      expect(await bounded(observer.call('CLIENT', 'KILL', 'ID', String(oldId)))).toBe(1);
      expect(await bounded(redis.get(`${prefix}:string`))).toBe('value');
      expect(await bounded(redis.call('CLIENT', 'ID'))).not.toBe(oldId);
    } finally {
      try {
        if (observer.status === 'ready') {
          await bounded(observer.del(`${prefix}:string`, `${prefix}:hash`));
        }
      } finally {
        redis.disconnect();
        observer.disconnect();
      }
    }
  });

  it('runs jobs and completion events through a shared direct client and reconnects its blocking duplicate', async () => {
    const name = `compat-${randomUUID()}`;
    const redis = client(name);
    const observer = client(`${name}-observer`);
    const errors: Error[] = [];
    let queue: Queue | undefined;
    let events: QueueEvents | undefined;
    let worker: Worker | undefined;
    try {
      queue = new Queue(name, { connection: redis });
      queue.on('error', error => errors.push(error));
      events = new QueueEvents(name, { connection: redis });
      events.on('error', error => errors.push(error));
      worker = new Worker(name, async job => ({ doubled: job.data.value * 2 }), { connection: redis });
      worker.on('error', error => errors.push(error));
      await bounded(Promise.all([
        observer.connect(), queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady(),
      ]), 'BullMQ startup');
      const first = await bounded(queue.add('double', { value: 7 }), 'first queue add');
      await expect(first.waitUntilFinished(events, 10000)).resolves.toEqual({ doubled: 14 });
      expect(errors).toEqual([]);

      // Kill only the blocking worker connection for this unique queue.
      const blockingName = `bull:${Buffer.from(name).toString('base64')}`;
      const clients = String(await bounded(observer.call('CLIENT', 'LIST'))).trim().split('\n');
      const blocking = clients.find(line => line.split(' ').includes(`name=${blockingName}`));
      expect(blocking).toBeDefined();
      const id = blocking?.match(/\bid=(\d+)\b/)?.[1];
      expect(id).toBeDefined();
      expect(await bounded(observer.call('CLIENT', 'KILL', 'ID', String(id)), 'blocking duplicate kill')).toBe(1);
      // A job can finish on the main connection while the killed blocking
      // connection is still reconnecting. Observe its replacement on the server
      // before claiming reconnect success or starting graceful shutdown.
      const reconnectDeadline = Date.now() + 10000;
      let replacement: string | undefined;
      while (Date.now() < reconnectDeadline) {
        const live = String(await bounded(observer.call('CLIENT', 'LIST'), 'replacement client list'));
        replacement = live.split('\n').find(line =>
          line.split(' ').includes(`name=${blockingName}`) &&
          !line.startsWith(`id=${id} `) && line.split(' ').includes('cmd=bzpopmin'));
        if (replacement) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(replacement).toBeDefined();
      const second = await bounded(queue.add('double', { value: 11 }), 'second queue add after duplicate kill');
      await expect(second.waitUntilFinished(events, 10000)).resolves.toEqual({ doubled: 22 });
      const after = String(await bounded(observer.call('CLIENT', 'LIST')));
      expect(after.split('\n').some(line => line.startsWith(`id=${id} `))).toBe(false);
      // A killed blocking read may emit this transport error; other errors
      // remain failures rather than being silently discarded.
      expect(errors.map(error => error.message).filter(message => !/^(Connection is closed\.?|read ECONNRESET)$/.test(message)))
        .toEqual([]);
    } finally {
      try {
        const closed = await Promise.allSettled([
          bounded(Promise.resolve(worker?.close()), 'worker close'), bounded(Promise.resolve(events?.close()), 'events close'),
        ]);
        // Cleanup is best-effort; a cleanup rejection may supersede the body's error.
        try {
          if (queue && redis.status === 'ready') await bounded(queue.obliterate({ force: true }), 'queue obliterate');
        } finally {
          if (queue) await bounded(queue.close(), 'queue close');
        }
        expect(closed.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        redis.disconnect();
        observer.disconnect();
        // Still release every duplicate if an assertion or one close failed.
        await bounded(Promise.all([worker?.disconnect(), events?.disconnect(), queue?.disconnect()]), 'fallback disconnect');
      }
    }
  });
});
