import {
  ApprovalQueueUnreachableError,
  assertApprovalQueueReachableIfNeeded,
} from '../../../../src/services/governance/approvalModeStartupGuard';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { Logger } from '../../../../src/utils/Logger';

// PR-G (C2): dedicated unit coverage for the boot guard — it was the one
// core-surface file with no dedicated test, which would otherwise stamp a
// near-zero per-file floor into the coverage ratchet.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

function fakeDb(executeTakeFirst: jest.Mock): DatabaseService {
  const chain = {
    selectFrom: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    executeTakeFirst,
  };
  return { getDatabase: () => chain } as unknown as DatabaseService;
}

describe('assertApprovalQueueReachableIfNeeded', () => {
  beforeEach(() => jest.clearAllMocks());

  it('skips the probe entirely in block mode', async () => {
    const probe = jest.fn();
    await assertApprovalQueueReachableIfNeeded({ approvalMode: 'block' }, fakeDb(probe), logger);
    expect(probe).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('skipped'),
      expect.objectContaining({ approvalMode: 'block' }),
    );
  });

  it('continues boot when the table is reachable (even empty)', async () => {
    // executeTakeFirst resolving undefined = reachable-but-empty, a valid state.
    const probe = jest.fn().mockResolvedValue(undefined);
    await expect(
      assertApprovalQueueReachableIfNeeded({ approvalMode: 'queue' }, fakeDb(probe), logger),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('throws ApprovalQueueUnreachableError when the probe fails in queue mode', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('relation "governance_approvals" does not exist'));
    const promise = assertApprovalQueueReachableIfNeeded({ approvalMode: 'queue' }, fakeDb(probe), logger);
    await expect(promise).rejects.toBeInstanceOf(ApprovalQueueUnreachableError);
    await expect(promise).rejects.toMatchObject({
      code: 'approval_queue_unreachable',
      message: expect.stringContaining('Refusing to boot'),
      cause: expect.objectContaining({ message: expect.stringContaining('does not exist') }),
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
