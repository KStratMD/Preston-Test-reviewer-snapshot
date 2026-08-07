import { Logged, LoggingService } from '../../observability/logging';

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
});

