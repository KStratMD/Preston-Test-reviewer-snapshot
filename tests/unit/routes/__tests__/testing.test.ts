import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';
import { spawn } from 'child_process';

// Record gate invocations so wiring order is assertable without real JWTs.
// The real authMiddleware/requirePlatformAdmin chain is proven with signed
// tokens in tests/integration/testingRouteAuthorization.routes.test.ts; here
// they are pass-throughs so handler behavior stays hermetic (same split as
// tests/unit/routes/adminSettings.test.ts).
const mockGateCalls: string[] = [];
jest.mock('../../../../src/middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mockGateCalls.push('auth');
    (req as express.Request & { user?: { id: string } }).user = { id: 'admin-1' };
    next();
  },
}));
jest.mock('../../../../src/middleware/verifiedAdmin', () => ({
  requirePlatformAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    mockGateCalls.push('platformAdmin');
    next();
  },
}));

// Controls the mocked NetSuite-MCP feature flag per test (jest.mock factories
// may only close over `mock`-prefixed variables).
let mockMcpFlagEnabled = false;
let mockMcpFlagThrows = false;
jest.mock('../../../../src/config/runtimeFlags', () => ({
  isNetSuiteMCPSchemaEnabled: () => {
    if (mockMcpFlagThrows) throw new Error('boom-secret-internal-detail');
    return mockMcpFlagEnabled;
  },
}));

// The route resolves the real MCP adapter from DI only for authenticated
// callers; stub the container so the gate is observable without booting DI.
const mockContainerGet = jest.fn(() => {
  throw new Error('adapter unavailable in unit test');
});
jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: { get: (...args: unknown[]) => mockContainerGet(...args) },
}));

import { createTestingRouter } from '../../../../src/routes/testing';
import { logger } from '../../../../src/utils/Logger';

jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

const mockedSpawn = spawn as unknown as jest.Mock;

function createApp(deps?: Parameters<typeof createTestingRouter>[0]): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createTestingRouter(deps));
  return app;
}

function mockSuccessfulSpawn(): void {
  mockedSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: jest.Mock;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = jest.fn();

    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
      child.emit('close', 0);
    });

    return child;
  });
}

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: jest.Mock;
};

function buildMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = jest.fn();
  return child;
}

/** Spawn mock whose child never exits on its own; returns each created child. */
function mockHangingSpawn(): MockChild[] {
  const children: MockChild[] = [];
  mockedSpawn.mockImplementation(() => {
    const child = buildMockChild();
    children.push(child);
    return child;
  });
  return children;
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('Testing route', () => {
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedSpawn.mockReset();
    mockGateCalls.length = 0;
    mockContainerGet.mockClear();
    mockMcpFlagEnabled = false;
    mockMcpFlagThrows = false;
    loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerInfoSpy.mockRestore();
  });

  it('uses testNamePattern semantics for the single suite and keeps shell disabled', async () => {
    mockSuccessfulSpawn();
    const app = createApp();

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: 'invoice total matches' })
      .expect(200);

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['jest', '--testNamePattern=invoice total matches'],
      expect.objectContaining({ shell: false })
    );
  });

  it('keeps testFile as a backward-compatible alias for testNamePattern', async () => {
    mockSuccessfulSpawn();
    const app = createApp();

    await request(app)
      .post('/run')
      .send({ suite: 'single', testFile: 'legacy alias' })
      .expect(200);

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['jest', '--testNamePattern=legacy alias'],
      expect.objectContaining({ shell: false })
    );
  });

  it('rejects conflicting test pattern aliases', async () => {
    const app = createApp();

    await request(app)
      .post('/run')
      .send({ suite: 'single', testFile: 'legacy', testNamePattern: 'new-name' })
      .expect(400);

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized test name patterns', async () => {
    const app = createApp();

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: '(' })
      .expect(400);

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: 'a'.repeat(257) })
      .expect(400);

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('does not log raw testNamePattern content before validation', async () => {
    mockSuccessfulSpawn();
    const app = createApp();
    const unsafePattern = 'valid\r\nforged-log-entry';

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: unsafePattern })
      .expect(400);

    const logMessages = loggerInfoSpy.mock.calls.map(([message]) => String(message));
    expect(logMessages).not.toEqual(expect.arrayContaining([expect.stringContaining(unsafePattern)]));
    expect(logMessages).not.toEqual(expect.arrayContaining([expect.stringContaining('forged-log-entry')]));
    expect(logMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('test name pattern provided: true, length: 23')
    ]));
  });

  it('does not create a dangling timeout timer on early validation returns', async () => {
    jest.useFakeTimers();
    const app = createApp();

    // All three validation-failure paths should return 400 without leaving a
    // timer running.  We advance time by 11 minutes after each request;
    // if the timeout callback fired it would attempt a 408 on a closed response
    // and throw "Cannot set headers after they are sent" — Jest fake timers
    // would surface this as an unhandled exception.
    await request(app)
      .post('/run')
      .send({ suite: 'single', testFile: 'a', testNamePattern: 'b' })
      .expect(400);
    jest.advanceTimersByTime(11 * 60 * 1000);

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: 'a'.repeat(257) })
      .expect(400);
    jest.advanceTimersByTime(11 * 60 * 1000);

    await request(app)
      .post('/run')
      .send({ suite: 'single', testNamePattern: '(' })
      .expect(400);
    jest.advanceTimersByTime(11 * 60 * 1000);

    expect(mockedSpawn).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  describe('authorization wiring (PR-C)', () => {
    it('runs authMiddleware then requirePlatformAdmin before spawning on /run', async () => {
      mockSuccessfulSpawn();
      const app = createApp();

      await request(app).post('/run').send({ suite: 'fast' }).expect(200);

      expect(mockGateCalls).toEqual(['auth', 'platformAdmin']);
      expect(mockedSpawn).toHaveBeenCalled();
    });

    it('keeps /mcp-schema anonymous — no auth gates invoked', async () => {
      const app = createApp();

      const res = await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(200);

      expect(res.body.success).toBe(true);
      expect(mockGateCalls).toEqual([]);
    });
  });

  describe('concurrency guard (PR-C)', () => {
    it('rejects a second concurrent run with 429 while a run is active', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const first = request(app).post('/run').send({ suite: 'fast' });
      const firstStarted = first.then(
        (res) => res,
        (err) => err,
      );
      try {
        // Let the first request reach the handler and spawn before the second arrives.
        await flushAsync();
        expect(children).toHaveLength(1);

        await request(app).post('/run').send({ suite: 'fast' }).expect(429);
        expect(mockedSpawn).toHaveBeenCalledTimes(1);
      } finally {
        // Finish the first run so the suite does not leak a pending request
        // even when an expectation above fails.
        children[0]?.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
        children[0]?.emit('close', 0);
        await firstStarted;
      }
    });

    it('releases the concurrency slot after a run completes', async () => {
      mockSuccessfulSpawn();
      const app = createApp();

      await request(app).post('/run').send({ suite: 'fast' }).expect(200);
      await request(app).post('/run').send({ suite: 'fast' }).expect(200);

      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('dedicated rate limiter (PR-C)', () => {
    it('applies the injected run rate limiter', async () => {
      mockSuccessfulSpawn();
      let hits = 0;
      const runRateLimit: express.RequestHandler = (_req, res, next) => {
        hits += 1;
        if (hits > 2) {
          res.status(429).json({ error: 'Too Many Requests' });
          return;
        }
        next();
      };
      const app = createApp({ runRateLimit });

      await request(app).post('/run').send({ suite: 'fast' }).expect(200);
      await request(app).post('/run').send({ suite: 'fast' }).expect(200);
      await request(app).post('/run').send({ suite: 'fast' }).expect(429);

      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });

    it('does not rate-limit /mcp-schema through the run limiter', async () => {
      const runRateLimit: express.RequestHandler = (_req, res) => {
        res.status(429).json({ error: 'Too Many Requests' });
      };
      const app = createApp({ runRateLimit });

      await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(200);
    });
  });

  describe('child process lifecycle (PR-C)', () => {
    it('does not kill the child when the run completes normally', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const pending = request(app).post('/run').send({ suite: 'fast' });
      const resolved = pending.then((res) => res);
      await flushAsync();
      expect(children).toHaveLength(1);

      children[0]!.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
      children[0]!.emit('close', 0);
      const res = await resolved;
      expect(res.status).toBe(200);

      // Give the request/response 'close' events time to fire — under the old
      // req.on('close') cleanup they would SIGTERM the already-exited child.
      await flushAsync();
      expect(children[0]!.kill).not.toHaveBeenCalled();
    });

    it('kills the child when the client aborts before completion', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const pending = request(app).post('/run').send({ suite: 'fast' });
      const settled = pending.then(
        () => undefined,
        () => undefined,
      );
      await flushAsync();
      expect(children).toHaveLength(1);

      pending.abort();
      await settled;
      await flushAsync();

      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('child process lifecycle (RVW-001)', () => {
    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      const children = mockHangingSpawn();
      const app = createApp({ killEscalationMs: 30 });

      const pending = request(app).post('/run').send({ suite: 'fast' });
      const settled = pending.then(() => undefined, () => undefined);
      await flushAsync();
      expect(children).toHaveLength(1);

      pending.abort();
      await settled;
      await flushAsync();
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');

      // The child never emits 'close' (SIGTERM ignored) — the escalation
      // timer must fire. Under the old !child.killed gate it never did,
      // because killed flips true the moment the SIGTERM is *sent*.
      children[0]!.killed = true; // what Node does after a successful kill()
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');

      children[0]!.emit('close', 1);
    });

    it('holds the concurrency slot after a client abort until the child exits', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const first = request(app).post('/run').send({ suite: 'fast' });
      const firstSettled = first.then(() => undefined, () => undefined);
      await flushAsync();
      expect(children).toHaveLength(1);

      first.abort();
      await firstSettled;
      await flushAsync();

      // The aborted request's child is still alive — the slot must still be
      // held, so an immediate second run is rejected instead of spawning a
      // concurrent process.
      await request(app).post('/run').send({ suite: 'fast' }).expect(429);
      expect(mockedSpawn).toHaveBeenCalledTimes(1);

      // Once the child actually exits, the slot frees and a new run spawns.
      children[0]!.emit('close', 1);
      await flushAsync();

      const third = request(app).post('/run').send({ suite: 'fast' });
      const thirdSettled = third.then((res) => res);
      await flushAsync();
      expect(mockedSpawn).toHaveBeenCalledTimes(2);

      children[1]!.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
      children[1]!.emit('close', 0);
      await thirdSettled;
    });

    it('holds the slot when a kill attempt fails while the child is still alive', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const first = request(app).post('/run').send({ suite: 'fast' });
      const firstSettled = first.then(() => undefined, () => undefined);
      await flushAsync();
      expect(children).toHaveLength(1);

      first.abort();
      await firstSettled;
      await flushAsync();
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');

      // Node emits 'error' on the child when a kill attempt fails — the
      // process is STILL ALIVE. Treating that as an exit released the slot
      // and let a second concurrent child spawn (Codex review, post-#1032).
      children[0]!.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
      await flushAsync();

      await request(app).post('/run').send({ suite: 'fast' }).expect(429);
      expect(mockedSpawn).toHaveBeenCalledTimes(1);

      // Only the child's real exit frees the slot.
      children[0]!.emit('close', 1);
      await flushAsync();

      const third = request(app).post('/run').send({ suite: 'fast' });
      const thirdSettled = third.then((res) => res);
      await flushAsync();
      expect(mockedSpawn).toHaveBeenCalledTimes(2);

      children[1]!.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
      children[1]!.emit('close', 0);
      await thirdSettled;
    });

    it('keeps the SIGKILL escalation armed after a failed kill attempt', async () => {
      const children = mockHangingSpawn();
      const app = createApp({ killEscalationMs: 30 });

      const pending = request(app).post('/run').send({ suite: 'fast' });
      const settled = pending.then(() => undefined, () => undefined);
      await flushAsync();
      expect(children).toHaveLength(1);

      pending.abort();
      await settled;
      await flushAsync();
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');

      // The failed-kill 'error' must not mark the child exited — that would
      // disarm the escalation exactly when SIGTERM is known to have failed.
      children[0]!.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');

      children[0]!.emit('close', 1);
    });

    it('releases the slot after a spawn failure (error followed by close)', async () => {
      // Real Node emits 'error' then 'close' when the binary cannot be
      // spawned (verified on Node 22) — the close is what frees the slot.
      mockedSpawn.mockImplementationOnce(() => {
        const child = buildMockChild();
        process.nextTick(() => {
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
          child.emit('close', -4058);
        });
        return child;
      });
      const app = createApp();

      const res = await request(app).post('/run').send({ suite: 'fast' });
      expect(res.status).toBe(500);

      // The slot is free again: a healthy second run spawns.
      mockSuccessfulSpawn();
      await request(app).post('/run').send({ suite: 'fast' }).expect(200);
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });

    it('keeps the jest summary parseable when output exceeds the capture cap', async () => {
      const children = mockHangingSpawn();
      const app = createApp();

      const pending = request(app).post('/run').send({ suite: 'fast' });
      const resolved = pending.then((res) => res);
      await flushAsync();

      // 2 MiB of noise, then the summary: the tail-keeping cap must preserve
      // the summary Jest prints last.
      children[0]!.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 'x'));
      children[0]!.stdout.emit('data', Buffer.from('\nTests: 3 passed, 3 total\n'));
      children[0]!.emit('close', 0);

      const res = await resolved;
      expect(res.status).toBe(200);
      expect(res.body.results.passed).toBe(3);
      expect(res.body.results.total).toBe(3);
    });
  });

  describe('mcp-schema hardening (RVW-002)', () => {
    it('applies the injected mcp-schema rate limiter', async () => {
      const mcpSchemaRateLimit: express.RequestHandler = (_req, res) => {
        res.status(429).json({ error: 'Too Many Requests' });
      };
      const app = createApp({ mcpSchemaRateLimit });

      await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(429);
      // The schema limiter must not gate /run.
      mockSuccessfulSpawn();
      await request(app).post('/run').send({ suite: 'fast' }).expect(200);
    });

    it('serves anonymous callers the mock response without touching DI even when real MCP is enabled', async () => {
      mockMcpFlagEnabled = true;
      const app = createApp();

      const res = await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(200);

      expect(res.body.source).toBe('mock');
      expect(mockContainerGet).not.toHaveBeenCalled();
    });

    it('resolves the real MCP adapter only for authenticated callers', async () => {
      mockMcpFlagEnabled = true;
      const app = express();
      app.use(express.json());
      // Simulate the global optional auth having validated a Bearer JWT.
      app.use((req, _res, next) => {
        (req as express.Request & { user?: { id: string } }).user = { id: 'user-1' };
        next();
      });
      app.use(createTestingRouter());

      const res = await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(200);

      // Adapter resolution was attempted (our stub throws, so the route falls
      // back to mock) — the point is the DI gate opens for authenticated users.
      expect(mockContainerGet).toHaveBeenCalled();
      expect(res.body.source).toBe('mock');
    });

    it('treats a throwing feature flag as disabled and never leaks internals', async () => {
      mockMcpFlagThrows = true;
      const app = createApp();

      const res = await request(app).post('/mcp-schema').send({ entityType: 'customer' }).expect(200);

      // Anonymous behavior stays stable: a broken flag reads as disabled, so
      // the caller gets the mock — and nothing internal reaches the response.
      expect(res.body.success).toBe(true);
      expect(res.body.source).toBe('mock');
      expect(res.body.details).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('boom-secret-internal-detail');
    });
  });
});
