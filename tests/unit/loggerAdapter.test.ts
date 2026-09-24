import { adaptScopeLogger, safeCloseLogger } from '../../src/utils/loggerAdapter';

describe('loggerAdapter', () => {
  test('adaptScopeLogger wraps provided logger and supports child', () => {
    const calls: Record<string, any[][]> = { info: [], warn: [], error: [], debug: [], childInfo: [] };
    const fakeLogger = {
      info: (...args: any[]) => { calls.info.push(args); },
      warn: (...args: any[]) => { calls.warn.push(args); },
      error: (...args: any[]) => { calls.error.push(args); },
      debug: (...args: any[]) => { calls.debug.push(args); },
      child: (ctx: any) => ({ info: (...a:any[]) => { calls.childInfo.push([ctx, ...a]); } }),
    } as any;

    const adapted = adaptScopeLogger(fakeLogger);
    adapted.info('hello', { a: 1 });
    adapted.warn('warn');
    adapted.error('err');
  if (adapted.debug) adapted.debug('dbg');
  const child = adapted.child ? adapted.child({ ctx: 'x' }) : undefined;
  if (child) child.info('from child');

    expect(calls.info.length).toBe(1);
    expect(calls.warn.length).toBe(1);
    expect(calls.error.length).toBe(1);
    expect(calls.debug.length).toBe(1);
    expect(calls.childInfo.length).toBe(1);
    expect(calls.childInfo[0][0]).toEqual({ ctx: 'x' });
  });

  test('safeCloseLogger resolves even if close is missing', async () => {
    await expect(safeCloseLogger({} as any)).resolves.toBeUndefined();
  });

  test('safeCloseLogger calls close when available', async () => {
    const fake = { close: jest.fn(async () => {}) } as any;
    await safeCloseLogger(fake);
    expect(fake.close).toHaveBeenCalled();
  });
});
