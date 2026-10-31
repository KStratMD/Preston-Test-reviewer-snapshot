/** Real application tracing composition, run in a fresh process by the Redis profile. */
/* eslint-disable no-console -- standalone verification command reports its outcome */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import type Redis from 'ioredis';
import type { Logger as PinoLogger } from 'pino';
import type { Logger } from '../src/utils/Logger';

interface ExportedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status?: { code?: number };
}
interface TracePayload {
  resourceSpans?: {
    scopeSpans?: { scope?: { name?: string }; spans?: ExportedSpan[] }[];
  }[];
}

async function main(): Promise<void> {
  const composition = process.argv[2];
  assert.ok(composition === 'tracing' || composition === 'distributed', 'unknown composition');
  assert.ok(process.env.REDIS_URL, 'REDIS_URL is required');
  const errors: unknown[] = [];
  const logger = {
    info: (): void => undefined,
    debug: (): void => undefined,
    warn: (...args: unknown[]): void => { errors.push(args); },
    error: (...args: unknown[]): void => { errors.push(args); },
  };
  const received: TracePayload[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('error', error => errors.push(error));
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/traces');
        assert.match(req.headers['content-type'] ?? '', /application\/json/);
        received.push(JSON.parse(Buffer.concat(chunks).toString()) as TracePayload);
        res.writeHead(200).end('{}');
      } catch (error) {
        errors.push(error);
        res.writeHead(400).end();
      }
    });
  });
  // No success-path force exit: the parent also bounds the child's natural exit.
  const watchdog = setTimeout(() => {
    console.error('Redis tracing smoke timed out');
    process.exit(1);
  }, 20000);
  watchdog.unref();
  let service: { shutdown(): Promise<void> } | undefined;
  let redis: Redis | undefined;
  const key = `redis-tracing-${randomUUID()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const otlpEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
    if (composition === 'distributed') {
      const { DistributedTracingService } = await import('../src/observability/DistributedTracing');
      const tracing = new DistributedTracingService(logger as unknown as Logger);
      service = tracing;
      await tracing.initialize({ otlpEndpoint, enableAutoInstrumentation: true, enableConsoleExporter: false });
    } else {
      const { TracingService } = await import('../src/observability/tracing');
      const tracing = new TracingService({
        serviceName: 'redis-tracing-smoke', serviceVersion: 'test', environment: 'test', otlpEndpoint,
      }, logger as unknown as PinoLogger);
      service = tracing;
      await tracing.initialize();
    }
    // Instrumentation hooks must be installed before the first runtime Redis import.
    const { default: RedisClient } = await import('ioredis');
    redis = new RedisClient(process.env.REDIS_URL, {
      lazyConnect: true, retryStrategy: () => null, connectTimeout: 2000, commandTimeout: 3000,
    });
    redis.on('error', error => errors.push(error));
    const client = redis;
    // requireParentSpan defaults to true. Without this parent, even supported clients emit no spans.
    await trace.getTracer('redis-compatibility').startActiveSpan('redis-tracing-parent', async parent => {
      try {
        await client.connect();
        await client.set(key, 'synthetic');
        assert.equal(await client.get(key), 'synthetic');
        await client.del(key);
        await client.hset(key, 'field', 'synthetic');
        await assert.rejects(client.get(key), /WRONGTYPE/);
      } finally {
        try {
          if (client.status === 'ready') await client.del(key);
        } finally { parent.end(); }
      }
    });
    await client.quit();
    await service.shutdown();
    service = undefined;
    const spans = received.flatMap(payload => (payload.resourceSpans ?? []).flatMap(resource =>
      (resource.scopeSpans ?? []).flatMap(scope => (scope.spans ?? []).map(span => ({
        ...span, scope: scope.scope?.name,
      })))));
    const parent = spans.find(span => span.name === 'redis-tracing-parent');
    assert.ok(parent, 'missing manual parent span');
    const gets = spans.filter(span => span.scope === '@opentelemetry/instrumentation-ioredis' && span.name === 'get');
    // The broken 0.69 + ioredis 6 cell emits the manual parent, but no Redis spans.
    assert.equal(gets.length, 2, 'manual parent exported but automatic Redis GET spans missing');
    assert.equal(gets.filter(span => span.status?.code === 2).length, 1, 'WRONGTYPE must emit an error span');
    assert.equal(gets.filter(span => (span.status?.code ?? 0) !== 2).length, 1, 'successful GET must not be an error');
    for (const span of gets) {
      assert.equal(span.traceId, parent.traceId, 'Redis span must share the parent trace');
      assert.equal(span.parentSpanId, parent.spanId, 'Redis span must be a child of the active parent');
    }
    assert.deepEqual(errors, [], 'tracing or transport logged errors');
    console.log(`Redis tracing smoke passed: ${composition}; manual parent, successful GET and error GET exported`);
  } finally {
    redis?.disconnect();
    try { if (service) await service.shutdown(); }
    finally {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      });
    }
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
