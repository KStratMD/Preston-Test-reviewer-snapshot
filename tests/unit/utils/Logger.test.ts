/**
 * Logger.error 2nd-arg leniency regression suite.
 *
 * Background: Logger.error(message, error?, metadata?) historically attached
 * its 2nd arg to the structured log context ONLY when it was an Error
 * instance — any other value (most commonly a `{ error }` object literal)
 * was silently dropped. PRs #891/#892/#896 fixed individual callsites by
 * wrapping, but an AST sweep found 497 such sites across 137 files, so the
 * durable fix is Logger-side: plain-object 2nd args merge into the log
 * context, and any other non-Error value attaches as `context.error`.
 */
import { Logger } from '../../../src/utils/Logger';
import type { LoggingService } from '../../../src/observability/logging';

type LoggedContext = Record<string, unknown>;

function makeLogger(): { logger: Logger; errorSpy: jest.Mock } {
  const errorSpy = jest.fn();
  const service = {
    info: jest.fn(),
    warn: jest.fn(),
    error: errorSpy,
    debug: jest.fn(),
    getLogger: jest.fn(),
  } as unknown as LoggingService;
  return { logger: new Logger('LoggerTest', service), errorSpy };
}

function loggedContext(errorSpy: jest.Mock): LoggedContext {
  expect(errorSpy).toHaveBeenCalledTimes(1);
  return errorSpy.mock.calls[0][0] as LoggedContext;
}

describe('Logger.error second-arg handling', () => {
  it('attaches an Error instance as context.error (existing behavior)', () => {
    const { logger, errorSpy } = makeLogger();
    const err = new Error('boom');

    logger.error('failed', err);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe(err);
    expect(errorSpy.mock.calls[0][1]).toBe('failed');
  });

  it('merges a plain-object 2nd arg into the log context instead of dropping it', () => {
    const { logger, errorSpy } = makeLogger();
    const err = new Error('boom');

    logger.error('failed', { error: err, vendorId: 'v-1' });

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe(err);
    expect(ctx.vendorId).toBe('v-1');
  });

  it('merges plain objects without an error key (e.g. { errors })', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('mapping failed', { errors: ['a', 'b'] });

    const ctx = loggedContext(errorSpy);
    expect(ctx.errors).toEqual(['a', 'b']);
  });

  it('attaches non-Error, non-object values as context.error (e.g. string throws)', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed', 'string failure');

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe('string failure');
  });

  it('attaches arrays as context.error rather than merging index keys', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed', ['e1', 'e2']);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toEqual(['e1', 'e2']);
    expect(ctx['0']).toBeUndefined();
  });

  it('attaches non-plain class instances as context.error instead of merging', () => {
    class NotAnError {
      code = 'X';
    }
    const { logger, errorSpy } = makeLogger();
    const value = new NotAnError();

    logger.error('failed', value);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe(value);
    expect(ctx.code).toBeUndefined();
  });

  it('omits context.error entirely when the 2nd arg is undefined', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed');

    const ctx = loggedContext(errorSpy);
    expect('error' in ctx).toBe(false);
  });

  it('attaches null as context.error (explicit null is a value, not an omission)', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed', null);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBeNull();
  });

  it('still merges explicit 3rd-arg metadata alongside an Error 2nd arg', () => {
    const { logger, errorSpy } = makeLogger();
    const err = new Error('boom');

    logger.error('failed', err, { requestId: 'r-1' });

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe(err);
    expect(ctx.requestId).toBe('r-1');
  });

  it('explicit 3rd-arg metadata wins over merged 2nd-arg object keys', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed', { requestId: 'from-second' }, { requestId: 'from-metadata' });

    const ctx = loggedContext(errorSpy);
    expect(ctx.requestId).toBe('from-metadata');
  });

  it('a merged 2nd-arg object cannot clobber the correlationId', () => {
    const { logger, errorSpy } = makeLogger();
    const child = logger.withCorrelationId('corr-1');
    errorSpy.mockClear();

    child.error('failed', { correlationId: 'spoofed', error: 'x' });

    const ctx = loggedContext(errorSpy);
    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.error).toBe('x');
  });

  it('a merged 2nd-arg object cannot clobber the base context (logger name)', () => {
    const { logger, errorSpy } = makeLogger();

    logger.error('failed', { context: 'spoofed-logger', error: 'x' });

    const ctx = loggedContext(errorSpy);
    expect(ctx.context).toBe('LoggerTest');
    expect(ctx.error).toBe('x');
  });

  it('skips __proto__/constructor/prototype keys instead of mutating the context prototype', () => {
    const { logger, errorSpy } = makeLogger();
    // JSON.parse produces an OWN __proto__ key — the shape a deserialized
    // attacker-controlled payload would carry.
    const payload = JSON.parse(
      '{"error":"x","__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2}}',
    ) as Record<string, unknown>;

    logger.error('failed', payload);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe('x');
    expect(Object.getPrototypeOf(ctx)).toBe(Object.prototype);
    expect((ctx as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ctx, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'prototype')).toBe(false);
  });

  it('Error subclasses with extra props attach as context.error (instanceof wins over merge)', () => {
    class HttpError extends Error {
      status = 502;
    }
    const { logger, errorSpy } = makeLogger();
    const err = new HttpError('bad gateway');

    logger.error('failed', err);

    const ctx = loggedContext(errorSpy);
    expect(ctx.error).toBe(err);
    expect(ctx.status).toBeUndefined();
  });
});
