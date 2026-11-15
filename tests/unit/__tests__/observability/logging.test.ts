import { Logged, LoggingService } from 'src/observability/logging';
import { CardinalityViolationError } from 'src/errors/CardinalityViolationError';
import { makeFinding, makePreflightRunResult, makeReport } from '../../../helpers/cardinalityTestDoubles';

describe('Logged decorator', () => {
  const makeLogger = () => {
    const info = jest.fn();
    const error = jest.fn();
    const logger = { info, error } as any;
    const service = new LoggingService({ level: 'silent', environment: 'test', enableConsole: false } as any);
    // Monkey patch underlying pino logger methods to capture context+message tuple
    (service as any).logger = {
      info: (ctx: any, msg?: string) => info(ctx, msg),
      error: (ctx: any, msg?: string) => error(ctx, msg),
      flush: (cb: Function) => cb(),
    } as any;
    return { service, info, error };
  };

  class TestClass {
    constructor(public loggingService: LoggingService) {}

    @Logged('test_op', true)
    async ok(a: number, b: string): Promise<number> { return a + b.length; }

    @Logged('test_fail')
    async boom(): Promise<void> { throw new Error('boom'); }
  }

  it('logs start and success with context, including args when requested', async () => {
    const { service, info } = makeLogger();
    const obj = new TestClass(service);
    await obj.ok(2, 'x');

    const start = info.mock.calls.find(c => String(c[1]).includes('Starting operation test_op'));
    const done = info.mock.calls.find(c => String(c[1]).includes('Completed operation test_op'));

    expect(start).toBeTruthy();
    expect(done).toBeTruthy();
    expect(start[0]).toEqual(expect.objectContaining({ operation: 'test_op', methodName: 'ok' }));
    expect(start[0].arguments).toBeDefined();
  });

  it('logs error on failure and rethrows', async () => {
    const { service, error } = makeLogger();
    const obj = new TestClass(service);
    await expect(obj.boom()).rejects.toThrow('boom');

    const failed = error.mock.calls.find(c => String(c[1]).includes('Failed operation test_fail'));
    expect(failed).toBeTruthy();
    expect(failed[0]).toEqual(expect.objectContaining({ operation: 'test_fail', status: 'error' }));
  });

  it('preserves bounded cardinality diagnostics without exposing arbitrary error strings', () => {
    const service = new LoggingService({ level: 'error', environment: 'production', enableConsole: true });
    const error = new CardinalityViolationError(
      makePreflightRunResult({
        reports: [makeReport({
          unavailableChecks: ['relationship_evidence'],
          findings: [makeFinding({
            type: 'relationship_evidence_unavailable',
            key: 'relationship_evidence_unavailable|source_to_target|source|',
            message: 'This message must never be logged',
          })],
        })],
        blocking: true,
      }),
      [makeFinding({
        type: 'relationship_evidence_unavailable',
        key: 'relationship_evidence_unavailable|source_to_target|source|',
        message: 'SYNTHETIC_A10_SECRET_MARKER',
      })],
    );
    const logged = jest.fn();
    (service as unknown as { logger: { error: typeof logged } }).logger = { error: logged };

    service.error(
      { configurationId: 'sf_to_ns_customers', error },
      'Failed to save configuration',
    );

    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationId: 'sf_to_ns_customers',
        error: expect.objectContaining({
          name: 'CardinalityViolationError',
          errorCode: 'CARDINALITY_VIOLATION',
          findings: [expect.objectContaining({
            type: 'relationship_evidence_unavailable',
            key: 'relationship_evidence_unavailable|source_to_target|source|',
          })],
          unavailableChecks: ['relationship_evidence'],
        }),
      }),
      'Failed to save configuration',
    );
    expect(JSON.stringify(logged.mock.calls[0][0])).not.toContain('SYNTHETIC_A10_SECRET_MARKER');
    expect(JSON.stringify(logged.mock.calls[0][0])).not.toContain('stack');
  });

  it('drops an explicitly supplied stack from generic error context', () => {
    const service = new LoggingService({ level: 'error', environment: 'production', enableConsole: true });
    const logged = jest.fn();
    (service as unknown as { logger: { error: typeof logged } }).logger = { error: logged };

    service.error(
      { error: new Error('SYNTHETIC_STACK_SECRET'), stack: 'SYNTHETIC_STACK_SECRET' },
      'startup failed',
    );

    expect(JSON.stringify(logged.mock.calls[0][0])).not.toContain('SYNTHETIC_STACK_SECRET');
    expect(logged.mock.calls[0][0]).not.toHaveProperty('stack');
  });

  it('removes stack text embedded in an error log message', () => {
    const service = new LoggingService({ level: 'error', environment: 'production', enableConsole: true });
    const logged = jest.fn();
    (service as unknown as { logger: { error: typeof logged } }).logger = { error: logged };

    service.error({}, 'startup failed\n    at setup (file.ts:1:1) SYNTHETIC_MESSAGE_STACK_SECRET');

    expect(logged.mock.calls[0][1]).toBe('startup failed');
    expect(JSON.stringify(logged.mock.calls[0])).not.toContain('SYNTHETIC_MESSAGE_STACK_SECRET');
  });

  it('redacts raw error strings, cycles, and child logger stack context', () => {
    const service = new LoggingService({ level: 'error', environment: 'production', enableConsole: true });
    const logged = jest.fn();
    const child = jest.fn();
    (service as unknown as { logger: { error: typeof logged; child: typeof child } }).logger = { error: logged, child };

    const cyclic: Record<string, unknown> = { error: 'PRIMITIVE_ERROR_SECRET' };
    cyclic.self = cyclic;
    service.error(cyclic, 'failed');
    service.createChildLogger({ stack: 'CHILD_STACK_SECRET' });

    expect(JSON.stringify(logged.mock.calls[0][0])).not.toContain('PRIMITIVE_ERROR_SECRET');
    expect(JSON.stringify(logged.mock.calls[0][0])).toContain('[redacted]');
    expect(child).toHaveBeenCalledWith(expect.not.objectContaining({ stack: expect.anything() }));
  });

  it('redacts camel-case credential keys after case normalization', () => {
    const service = new LoggingService({ level: 'error', environment: 'production', enableConsole: true });
    const logged = jest.fn();
    (service as unknown as { logger: { error: typeof logged } }).logger = { error: logged };

    service.error({
      apiKey: 'SYNTHETIC_API_KEY',
      accessToken: 'SYNTHETIC_ACCESS_TOKEN',
      api_key: 'SYNTHETIC_SNAKE_API_KEY',
      client_secret: 'SYNTHETIC_CLIENT_SECRET',
      consumerSecret: 'SYNTHETIC_CONSUMER_SECRET',
      tokenSecret: 'SYNTHETIC_TOKEN_SECRET',
      securityToken: 'SYNTHETIC_SECURITY_TOKEN',
      private_key: 'SYNTHETIC_PRIVATE_KEY',
    }, 'failed');

    const serialized = JSON.stringify(logged.mock.calls[0][0]);
    expect(serialized).not.toContain('SYNTHETIC_API_KEY');
    expect(serialized).not.toContain('SYNTHETIC_ACCESS_TOKEN');
    expect(serialized).not.toContain('SYNTHETIC_SNAKE_API_KEY');
    expect(serialized).not.toContain('SYNTHETIC_CLIENT_SECRET');
    expect(serialized).not.toContain('SYNTHETIC_CONSUMER_SECRET');
    expect(serialized).not.toContain('SYNTHETIC_TOKEN_SECRET');
    expect(serialized).not.toContain('SYNTHETIC_SECURITY_TOKEN');
    expect(serialized).not.toContain('SYNTHETIC_PRIVATE_KEY');
  });
});
