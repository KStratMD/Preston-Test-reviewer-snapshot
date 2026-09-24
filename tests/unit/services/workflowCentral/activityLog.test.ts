import 'reflect-metadata';
import { safeActivityLog } from '../../../../src/services/workflowCentral/activityLog';
import { workflowCentralActivityLogDeliveryFailures } from '../../../../src/services/workflowCentral/metrics';
import type { Logger } from '../../../../src/utils/Logger';
import type { WorkflowCentralRepository } from '../../../../src/services/workflowCentral/WorkflowCentralRepository';

function makeRow(overrides: Partial<{ id: string; action: string }> = {}) {
  return {
    id: overrides.id ?? 'A-1',
    tenantId: 'tnt_A',
    instanceId: 'INST-1',
    workflowName: 'Test WF',
    action: overrides.action ?? 'instance_cancelled',
    userId: 'user-1',
    userName: 'Alice',
    stepName: 'Step 1',
    details: null,
    timestamp: new Date().toISOString(),
  };
}

describe('safeActivityLog', () => {
  it('returns normally and writes when insertActivityLog succeeds', async () => {
    const repo = { insertActivityLog: jest.fn().mockResolvedValue(undefined) } as unknown as WorkflowCentralRepository;
    const logger = {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;
    await expect(safeActivityLog({ repo, logger, row: makeRow() })).resolves.toBeUndefined();
    expect(repo.insertActivityLog).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not throw when insertActivityLog rejects; emits warn + counter', async () => {
    const repo = {
      insertActivityLog: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as WorkflowCentralRepository;
    const warn = jest.fn();
    const logger = { warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const baseCount = await readCounterValue();
    await expect(safeActivityLog({ repo, logger, row: makeRow() })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const after = await readCounterValue();
    expect(after).toBeGreaterThan(baseCount);
  });

  // Codex R1 P2 BLOCKING: the catch block was unguarded — a logger that
  // throws (closed transport) or a counter that throws (unregistered) would
  // bubble back into the verb's response path. The guard wraps both calls
  // in their own try/catch.
  it('swallows logger.warn exceptions inside the catch block', async () => {
    const repo = {
      insertActivityLog: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as WorkflowCentralRepository;
    const logger = {
      warn: jest.fn(() => {
        throw new Error('logger transport closed');
      }),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as Logger;
    await expect(safeActivityLog({ repo, logger, row: makeRow() })).resolves.toBeUndefined();
  });

  it('swallows counter.inc exceptions inside the catch block', async () => {
    const repo = {
      insertActivityLog: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as WorkflowCentralRepository;
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const spy = jest
      .spyOn(workflowCentralActivityLogDeliveryFailures, 'inc')
      .mockImplementation(() => {
        throw new Error('counter unregistered');
      });
    try {
      await expect(safeActivityLog({ repo, logger, row: makeRow() })).resolves.toBeUndefined();
      // Logger still ran successfully despite counter throw.
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

async function readCounterValue(): Promise<number> {
  const snap = await workflowCentralActivityLogDeliveryFailures.get();
  return snap.values.reduce((sum, v) => sum + (v.value ?? 0), 0);
}
