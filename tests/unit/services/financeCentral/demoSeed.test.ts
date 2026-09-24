/**
 * FinanceCentral demo-seed gate (PR-F5b-3).
 *
 * These cases prove the self-gate delegates to the shared shouldSeedDemoData
 * predicate rather than a hand-rolled NODE_ENV check — the drift F5b-3 exists
 * to prevent, since three call sites share the decision.
 *
 * No DB needed: a recording repo stub is the discriminator. The return value
 * alone is NOT one — the seed swallows per-row failures and would report
 * {inserted: 0, skipped: 0} for a repo that rejected all 12 rows, exactly like
 * a closed gate. Call count separates the two cases unambiguously.
 *
 * env pinning happens BEFORE the src/ imports because src/config/env.ts
 * zod-snapshots HOSTED_DEMO at first module evaluation; changing
 * process.env.HOSTED_DEMO afterwards would not move env.HOSTED_DEMO. That is
 * also why the HOSTED_DEMO=1 arm of the predicate is covered in
 * tests/unit/services/governance/demoTenant.test.ts (pure function, no
 * snapshot) rather than re-imported here.
 */
const ENV_KEYS = ['NODE_ENV', 'HOSTED_DEMO'] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
process.env.HOSTED_DEMO = '0';

// eslint-disable-next-line import/first
import { seedFinanceCentralDemoData } from '../../../../src/services/financeCentral/demoSeed';
// eslint-disable-next-line import/first
import type { FinanceCentralRepository } from '../../../../src/services/financeCentral/FinanceCentralRepository';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../../src/services/governance/demoTenant';

/** Records writes so a gate leak is visible as a non-zero call count. */
function recordingRepo(): { repo: FinanceCentralRepository; insertIfMissing: jest.Mock } {
  const insertIfMissing = jest.fn().mockResolvedValue(true);
  return { repo: { insertIfMissing } as unknown as FinanceCentralRepository, insertIfMissing };
}

describe('seedFinanceCentralDemoData gate (F5b-3)', () => {
  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function withNodeEnv<T>(nodeEnv: string | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.NODE_ENV;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }

  it.each(['production', 'test', undefined, ''])(
    'writes nothing when NODE_ENV=%s without the hosted flag',
    async (nodeEnv) => {
      const { repo, insertIfMissing } = recordingRepo();
      const result = await withNodeEnv(nodeEnv, () =>
        seedFinanceCentralDemoData(repo, { tenantId: CENTRAL_DEMO_TENANT_ID }),
      );
      expect(result).toEqual({ inserted: 0, skipped: 0 });
      expect(insertIfMissing).not.toHaveBeenCalled();
    },
  );

  it('seeds all 12 approvals under the demo tenant in development (gate open)', async () => {
    const { repo, insertIfMissing } = recordingRepo();
    const result = await withNodeEnv('development', () =>
      seedFinanceCentralDemoData(repo, { tenantId: CENTRAL_DEMO_TENANT_ID }),
    );
    expect(result).toEqual({ inserted: 12, skipped: 0 });
    expect(insertIfMissing).toHaveBeenCalledTimes(12);
    for (const [row] of insertIfMissing.mock.calls) {
      expect(row.tenantId).toBe(CENTRAL_DEMO_TENANT_ID);
    }
  });
});
