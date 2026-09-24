// This test uses real timers because EventBus uses setTimeout for event processing
jest.useRealTimers();

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventBus } from '../../src/utils/EventBus';

describe('EventBus queue limits and persistence', () => {
  const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eventbus-'));

  afterEach(async () => {
    const instance = (EventBus as any).instance as EventBus | undefined;
    if (instance) {
      await instance.shutdown();
      (EventBus as any).instance = undefined;
    }
  });

  it('persists events when queue limit exceeded and recovers on restart', async () => {
    const dir = createTempDir();
    (EventBus as any).instance = undefined;
    const bus = EventBus.getInstance({ maxQueueSize: 1, storageDir: dir });
    const received: string[] = [];
    bus.subscribe('test', {
      handle: event => {
        received.push(event.data as string);
      },
    });

    await bus.publish('test', 'e1');
    await bus.publish('test', 'e2');
    await bus.publish('test', 'e3');
    await new Promise(r => setTimeout(r, 50));

    const overflowPath = path.join(dir, 'overflow-events.json');
    const persisted = JSON.parse(fs.readFileSync(overflowPath, 'utf-8'));
    expect(persisted.length).toBe(2);

    await bus.shutdown();
    (EventBus as any).instance = undefined;

    const bus2 = EventBus.getInstance({ maxQueueSize: 5, storageDir: dir });
    const recovered: string[] = [];
    bus2.subscribe('test', {
      handle: event => {
        recovered.push(event.data as string);
      },
    });
    await bus2.processRecoveredEvents();
    await new Promise(r => setTimeout(r, 50));

    expect(recovered).toEqual(['e2', 'e3']);
  });

  it('limits dead-letter queue and persists overflow', async () => {
    const dir = createTempDir();
    (EventBus as any).instance = undefined;
    const bus = EventBus.getInstance({ maxDeadLetterQueueSize: 1, storageDir: dir });

    bus.subscribe('dead', {
      handle: () => {
        throw new Error('fail');
      },
    }, {
      retryConfig: { maxRetries: 0, retryDelay: 0, retryMultiplier: 1, maxRetryDelay: 0 },
    });

    await bus.publish('dead', 'a');
    await bus.publish('dead', 'b');
    await bus.publish('dead', 'c');
    await new Promise(r => setTimeout(r, 50));

    expect(bus.getDeadLetterQueue().length).toBe(1);
    const dlPath = path.join(dir, 'dead-letter-events.json');
    const dlPersisted = JSON.parse(fs.readFileSync(dlPath, 'utf-8'));
    expect(dlPersisted.length).toBe(3);
  });

  it('rejects events when overflow behavior is set to reject', async () => {
    const dir = createTempDir();
    (EventBus as any).instance = undefined;
    const bus = EventBus.getInstance({ maxQueueSize: 1, storageDir: dir, overflowBehavior: 'reject' });
    const saturationEvents: any[] = [];
    bus.on('queue:saturation', (data) => saturationEvents.push(data));
    bus.subscribe('test', { handle: () => {} });

    await bus.publish('test', 'e1');
    await expect(bus.publish('test', 'e2')).rejects.toThrow('Event queue is full');
    expect(saturationEvents.length).toBeGreaterThan(0);
    const metrics = bus.getMetrics();
    expect(metrics.maxQueueSize).toBe(1);
    expect(metrics.queueSaturation).toBe(1);
  });
});
