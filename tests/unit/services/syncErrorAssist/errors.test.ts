import { SyncErrorAssistTimeoutError, withTimeout } from '../../../../src/services/syncErrorAssist/errors';

describe('SyncErrorAssistTimeoutError', () => {
  it('is an instance of Error', () => {
    const err = new SyncErrorAssistTimeoutError('AI call', 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SyncErrorAssistTimeoutError);
    expect(err.name).toBe('SyncErrorAssistTimeoutError');
    expect(err.message).toContain('AI call');
    expect(err.message).toContain('5000');
  });
});

describe('withTimeout', () => {
  it('resolves with the inner promise value when it resolves before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test op');
    expect(result).toBe('ok');
  });

  it('throws SyncErrorAssistTimeoutError when inner promise exceeds timeout', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(slow, 50, 'slow op')).rejects.toThrow(SyncErrorAssistTimeoutError);
  });

  it('propagates inner rejection unchanged when inner rejects before timeout', async () => {
    const inner = Promise.reject(new Error('inner failure'));
    await expect(withTimeout(inner, 1000, 'op')).rejects.toThrow('inner failure');
  });
});
