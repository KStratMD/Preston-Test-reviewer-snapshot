import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';
import { spawn } from 'child_process';
import { createTestingRouter } from '../../../../src/routes/testing';
import { logger } from '../../../../src/utils/Logger';

jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

const mockedSpawn = spawn as unknown as jest.Mock;

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createTestingRouter());
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

describe('Testing route', () => {
  let loggerInfoSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedSpawn.mockReset();
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
});
