/**
 * DemoConnectorDecorator.count() Tests
 *
 * Verifies that count() returns accurate unsliced totals in demo mode
 * and -1 (unknown) in non-demo mode, with optional filter/operator support.
 */

import { DemoConnectorDecorator } from '../../../../src/connectors/DemoConnectorDecorator';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { Logger } from '../../../../src/utils/Logger';
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

describe('DemoConnectorDecorator.count()', () => {
  let decorator: DemoConnectorDecorator;
  let mockInner: jest.Mocked<IConnector>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    setDemoModeOverride(true);

    mockInner = {
      systemType: 'TestSystem',
      systemId: 'test-system-1',
      initialize: jest.fn(),
      authenticate: jest.fn(),
      testConnection: jest.fn(),
      getSystemInfo: jest.fn(),
      create: jest.fn(),
      read: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      search: jest.fn(),
      bulkCreate: jest.fn(),
      bulkUpdate: jest.fn(),
      bulkDelete: jest.fn(),
      setupWebhook: jest.fn(),
      removeWebhook: jest.fn(),
      getChanges: jest.fn(),
      validateSchema: jest.fn(),
    } as unknown as jest.Mocked<IConnector>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    decorator = new DemoConnectorDecorator(mockInner, mockLogger);
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  it('should return 0 for an empty entity store', () => {
    expect(decorator.count('orders')).toBe(0);
  });

  it('should return the total unsliced count of records', async () => {
    // Create 5 records
    for (let i = 0; i < 5; i++) {
      await decorator.create('orders', { id: `ord-${i}`, fields: { name: `Order ${i}` } });
    }

    expect(decorator.count('orders')).toBe(5);
  });

  it('should return count independent of list pagination', async () => {
    // Create 5 records, but list only returns 2 when paginated
    for (let i = 0; i < 5; i++) {
      await decorator.create('orders', { id: `ord-${i}`, fields: { status: 'open' } });
    }

    const paginated = await decorator.list('orders', { limit: 2 });
    expect(paginated).toHaveLength(2);

    // count() should still return the full total
    expect(decorator.count('orders')).toBe(5);
  });

  it('should return -1 when not in demo mode', async () => {
    await decorator.create('orders', { id: 'ord-1', fields: {} });

    setDemoModeOverride(false);
    expect(decorator.count('orders')).toBe(-1);
  });

  it('should apply filters and return filtered count', async () => {
    await decorator.create('orders', { id: 'ord-1', fields: { status: 'open' } });
    await decorator.create('orders', { id: 'ord-2', fields: { status: 'shipped' } });
    await decorator.create('orders', { id: 'ord-3', fields: { status: 'open' } });

    expect(decorator.count('orders', { status: 'open' })).toBe(2);
    expect(decorator.count('orders', { status: 'shipped' })).toBe(1);
  });

  it('should support OR operator for filter matching', async () => {
    await decorator.create('items', { id: 'i1', fields: { color: 'red' } });
    await decorator.create('items', { id: 'i2', fields: { color: 'blue' } });
    await decorator.create('items', { id: 'i3', fields: { color: 'green' } });

    // OR: matches red OR blue — but with single filter, OR/AND are equivalent
    // Use multiple filter keys to demonstrate OR
    await decorator.create('items', { id: 'i4', fields: { color: 'red', size: 'large' } });

    // AND: both color=red AND size=large must match
    expect(decorator.count('items', { color: 'red', size: 'large' }, 'AND')).toBe(1);

    // OR: color=red OR size=large must match
    expect(decorator.count('items', { color: 'red', size: 'large' }, 'OR')).toBe(2);
  });

  it('should return count without filters (no filters param)', async () => {
    await decorator.create('contacts', { id: 'c1', fields: {} });
    await decorator.create('contacts', { id: 'c2', fields: {} });

    expect(decorator.count('contacts')).toBe(2);
    expect(decorator.count('contacts', undefined)).toBe(2);
  });

  it('should be accessible through the Proxy wrapper', () => {
    const { wrapWithDecorator } = require('../../../../src/connectors/wrapWithDecorator');
    const wrapped = wrapWithDecorator(mockInner, mockLogger);

    // count should be accessible via 'in' check
    expect('count' in wrapped).toBe(true);

    // count should be callable
    const countFn = (wrapped as Record<string, unknown>).count;
    expect(typeof countFn).toBe('function');
  });

  it('should return -1 through Proxy in non-demo mode', async () => {
    const { wrapWithDecorator } = require('../../../../src/connectors/wrapWithDecorator');
    const wrapped = wrapWithDecorator(mockInner, mockLogger);

    setDemoModeOverride(false);
    const countFn = (wrapped as Record<string, unknown> & { count: (e: string) => number }).count;
    expect(countFn('orders')).toBe(-1);
  });
});
