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
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '../../src/index';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { sampleConfigurations } from '../../src/examples/sample-integrations';
import { ConfigurationService } from '../../src/services/ConfigurationService';
import { makeAuditDouble, makePreflightRunResult, makeFinding, makeReport, makeGateDouble } from '../helpers/cardinalityTestDoubles';

describe('Server.loadSampleDataIfNeeded (Task 8, startup_migration)', () => {
  it('attributes each startup sample-config save to SYSTEM_IDENTITY with a concrete startup_migration operation, the config\'s own tenant, and a correlation id', async () => {
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

  it('persists all hosted sample configurations when the empty directory triggers startup seeding', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalHostedDemo = process.env.HOSTED_DEMO;
    process.env.NODE_ENV = 'production';
    process.env.HOSTED_DEMO = '1';
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-seed-'));
    const blockedPreflight = makePreflightRunResult({
      blocking: true,
      reports: [makeReport({
        findings: [makeFinding({
          type: 'relationship_evidence_unavailable',
          key: 'relationship_evidence_unavailable|source_to_target|source|',
          mappingIndexes: [],
          message: 'Required relationship evidence is unavailable',
        })],
      })],
    });
    const gate = makeGateDouble(
      { runForConfig: jest.fn(async () => blockedPreflight), runForPlan: jest.fn() },
      makeAuditDouble(),
    );
    const service = new ConfigurationService(
      { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
      configDirectory,
      gate,
    );

    try {
      await (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
        .loadSampleDataIfNeeded.call({
          configService: service,
          logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });

      const persisted = (await fs.readdir(configDirectory)).filter(name => name.endsWith('.json')).sort();
      expect(persisted).toEqual(sampleConfigurations.map(config => `${config.id}.json`).sort());
      expect(service.getAllConfigurations()).toEqual(
        expect.arrayContaining(sampleConfigurations.map(config => expect.objectContaining({
          id: config.id,
          isActive: false,
        }))),
      );
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalHostedDemo === undefined) delete process.env.HOSTED_DEMO;
      else process.env.HOSTED_DEMO = originalHostedDemo;
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it('fails hosted startup when a partial seed cannot be repaired in the current boot', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalHostedDemo = process.env.HOSTED_DEMO;
    process.env.NODE_ENV = 'production';
    process.env.HOSTED_DEMO = '1';
    const persisted = new Map<string, unknown>();
    const saveConfiguration = jest.fn(async (config: { id: string }) => {
      if (config.id === sampleConfigurations[0].id) throw new Error('disk full');
      persisted.set(config.id, config);
    });
    const fakeThis = {
      configService: {
        getAllConfigurations: jest.fn(() => Array.from(persisted.values())),
        saveConfiguration,
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };

    try {
      await expect(
        (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
          .loadSampleDataIfNeeded.call(fakeThis),
      ).rejects.toThrow('did not persist the expected configuration set');
      expect(saveConfiguration).toHaveBeenCalledTimes(sampleConfigurations.length);
      expect(persisted.size).toBe(sampleConfigurations.length - 1);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalHostedDemo === undefined) delete process.env.HOSTED_DEMO;
      else process.env.HOSTED_DEMO = originalHostedDemo;
    }
  });

  it('repairs missing hosted samples even when an unrelated operator draft already exists', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalHostedDemo = process.env.HOSTED_DEMO;
    const originalHealthKeys = process.env.HOSTED_CONFIG_EXPECTED_KEYS;
    process.env.NODE_ENV = 'production';
    process.env.HOSTED_DEMO = '1';
    const persisted = new Map<string, { id: string; tenantId: string; isActive: boolean }>([
      ['tenant-a:operator-draft', { id: 'operator-draft', tenantId: 'tenant-a', isActive: false }],
    ]);
    const saveConfiguration = jest.fn(async (config: { id: string; tenantId: string; isActive?: boolean }) => {
      persisted.set(`${config.tenantId}:${config.id}`, { ...config, isActive: config.isActive ?? false });
    });
    const fakeThis = {
      configService: {
        getAllConfigurations: jest.fn(() => Array.from(persisted.values())),
        saveConfiguration,
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };

    try {
      await (Server.prototype as unknown as { loadSampleDataIfNeeded: () => Promise<void> })
        .loadSampleDataIfNeeded.call(fakeThis);
      expect(saveConfiguration).toHaveBeenCalledTimes(sampleConfigurations.length);
      expect(process.env.HOSTED_CONFIG_PERSISTED_COUNT).toBe(String(sampleConfigurations.length));
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalHostedDemo === undefined) delete process.env.HOSTED_DEMO;
      else process.env.HOSTED_DEMO = originalHostedDemo;
      if (originalHealthKeys === undefined) delete process.env.HOSTED_CONFIG_EXPECTED_KEYS;
      else process.env.HOSTED_CONFIG_EXPECTED_KEYS = originalHealthKeys;
      delete process.env.HOSTED_CONFIG_EXPECTED_COUNT;
      delete process.env.HOSTED_CONFIG_PERSISTED_COUNT;
      delete process.env.HOSTED_CONFIG_ACTIVE_COUNT;
      delete process.env.HOSTED_CONFIG_INACTIVE_DRAFT_COUNT;
    }
  });
});
