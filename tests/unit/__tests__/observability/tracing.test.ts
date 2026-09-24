import { Traced } from '../../observability/tracing';

describe('Traced decorator', () => {
  class TestClass {
    constructor(public tracingService: { traceOperation: jest.Mock }) {}

    @Traced('op_name')
    async work(a: number) { return a * 2; }
  }

  it('delegates to tracingService.traceOperation', async () => {
    const traceOperation = jest.fn((_name, op) => op());
    const obj = new TestClass({ traceOperation } as any);
    const result = await obj.work(3);
    expect(result).toBe(6);
    expect(traceOperation).toHaveBeenCalledWith(
      'op_name',
      expect.any(Function),
      expect.objectContaining({ 'method.name': 'work', 'class.name': 'TestClass' }),
    );
  });
});

