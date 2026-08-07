/**
 * Task 8 — the boot-owned startup migration (`Server.loadSampleDataIfNeeded`
 * in src/index.ts) is the ONE path allowed to attribute a
 * ConfigurationCommandContext to SYSTEM_IDENTITY: there is no authenticated
 * request behind server startup. Every other active-write path must derive
 * its context from verified caller identity instead (see the sibling route /
 * service suites for those).
 *
 * `loadSampleDataIfNeeded` is a private method on a heavy, DI-container-driven
 * class. Rather than constructing a full `Server` (which boots the whole app),
 * this suite invokes the method directly against a minimal fake `this` —
 * `sampleConfigurations` is read from the module-level import inside the
 * method body, not from `this`, so this is a faithful unit test of its logic.
 */
import 'reflect-metadata';
import { Server } from '../../src/index';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { sampleConfigurations } from '../../src/examples/sample-integrations';

describe('Server.loadSampleDataIfNeeded (Task 8, startup_migration)', () => {
  it('attributes each active sample-config save to SYSTEM_IDENTITY with a concrete startup_migration operation, the config\'s own tenant, and a correlation id', async () => {
    const saveConfiguration = jest.fn().mockResolvedValue(undefined);
    const fakeThis = {
      configService: {
        getAllConfigurations: jest.fn().mockReturnValue([]),
        saveConfiguration,
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    };

    await (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
      .loadSampleDataIfNeeded.call(fakeThis);

    expect(saveConfiguration).toHaveBeenCalledTimes(sampleConfigurations.length);
    for (const [config, context] of saveConfiguration.mock.calls) {
      expect(context).toEqual({
        tenantId: config.tenantId,
        actorUserId: SYSTEM_IDENTITY.userId,
        correlationId: expect.any(String),
        operation: 'startup_migration',
      });
      // Never the retired hardcoded literal read back as a bare string
      // comparison mistake — always the imported sentinel.
      expect(context.actorUserId).toBe('__system__');
    }

    // Each save gets its own correlation id (never reused across configs).
    const correlationIds = saveConfiguration.mock.calls.map(([, ctx]) => ctx.correlationId);
    expect(new Set(correlationIds).size).toBe(correlationIds.length);
  });

  it('does not save (or build any context) when configurations already exist', async () => {
    const saveConfiguration = jest.fn();
    const fakeThis = {
      configService: {
        getAllConfigurations: jest.fn().mockReturnValue([{ id: 'existing' }]),
        saveConfiguration,
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    };

    await (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
      .loadSampleDataIfNeeded.call(fakeThis);

    expect(saveConfiguration).not.toHaveBeenCalled();
  });

  it('logs a warning and continues past a single failed sample-config save (fault isolation)', async () => {
    const saveConfiguration = jest.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const warn = jest.fn();
    const fakeThis = {
      configService: {
        getAllConfigurations: jest.fn().mockReturnValue([]),
        saveConfiguration,
      },
      logger: { info: jest.fn(), warn },
    };

    await (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
      .loadSampleDataIfNeeded.call(fakeThis);

    expect(saveConfiguration).toHaveBeenCalledTimes(sampleConfigurations.length);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load sample configuration'),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
