import 'reflect-metadata';

// Mock the Zod validator per existing test pattern (tests/unit/services/ConfigurationService.test.ts:33-42)
// so our fixture stays minimal and segment-safety / ambiguous-lookup logic is what gets exercised.
jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn().mockReturnValue({ isValid: true, errors: [], warnings: [] }),
}));

import { ConfigurationService } from '../../../src/services/ConfigurationService';
import { ConfigurationLookupAmbiguousError, ValidationError } from '../../../src/errors/ConfigurationErrors';
import type { Logger } from '../../../src/utils/Logger';
import type { IntegrationConfig } from '../../../src/types';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

const silentLogger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

function makeIntegrationConfig(overrides: Partial<{ id: string; tenantId: string; name: string }> = {}) {
  // Minimal valid fixture — validator is mocked above, so we only need the fields the
  // service body reads directly (id, tenantId, name, createdAt/updatedAt set by save).
  return {
    id: overrides.id ?? 'cfg-1',
    tenantId: overrides.tenantId ?? 'tenant-a',
    name: overrides.name ?? 'cfg',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [{ sourceField: 'Name', targetField: 'companyname', transformationType: 'direct', isRequired: true }],
  } as any;
}

describe('ConfigurationService segment-safe key', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects tenantId containing path-traversal sequences', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await expect(svc.saveConfiguration(makeIntegrationConfig({ tenantId: '../evil' }))).rejects.toThrow(ValidationError);
  });

  it('rejects id containing path separators', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await expect(svc.saveConfiguration(makeIntegrationConfig({ id: 'foo/bar' }))).rejects.toThrow(ValidationError);
  });
});

describe('ConfigurationService.getConfiguration deterministic-ambiguous', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('getConfiguration(id) throws a non-leaky ConfigurationLookupAmbiguousError on an ambiguous Map', async () => {
    // The same-id/different-tenant Map state can no longer arise from disk
    // (loadConfigurations enforces filename===${id}.json, so two same-id files
    // can't coexist) nor from save/import (both reject it). The getConfiguration(id)
    // guard is therefore defensive — stage the ambiguous Map directly to exercise it.
    const svc = new ConfigurationService(silentLogger, tmpDir);
    const map: Map<string, IntegrationConfig> = (svc as unknown as { configurations: Map<string, IntegrationConfig> }).configurations;
    map.set('tenant-a::shared', makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-a' }));
    map.set('tenant-b::shared', makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-b' }));
    expect(() => svc.getConfiguration('shared')).toThrow(ConfigurationLookupAmbiguousError);
    // The 409 body is the .message verbatim — it must NOT leak internal method
    // names (Copilot review).
    expect(() => svc.getConfiguration('shared')).toThrow(/ambiguous across tenants/);
    expect(() => svc.getConfiguration('shared')).not.toThrow(/getConfiguration\(/);
  });

  it('loadConfigurations fails closed on a non-canonical filename (filename != id)', async () => {
    // Codex + Copilot review: save/delete always operate on ${id}.json, so a config
    // loaded from a non-canonical filename would desync disk and memory. The loader
    // fails closed — this also makes same-id/different-tenant files impossible (both
    // would need to be ${id}.json in one flat dir).
    await fs.writeFile(path.join(tmpDir, 'legacy-name.json'), JSON.stringify(makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-a' })));
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await expect(svc.loadConfigurations()).rejects.toThrow(/does not match its internal id/);
  });

  it('returns undefined when no tenants have the id', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    expect(svc.getConfiguration('missing')).toBeUndefined();
  });

  it('returns the single match when exactly one tenant has the id', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'unique', tenantId: 'tenant-a' }));
    const result = svc.getConfiguration('unique');
    expect(result?.id).toBe('unique');
    expect(result?.tenantId).toBe('tenant-a');
  });
});

describe('ConfigurationService tenant-isolated reads', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  // The in-memory Map is keyed by `${tenantId}::${id}`, so distinct ids under
  // distinct tenants are isolated on read. (Same-id-two-tenants on flat disk is
  // rejected at the write boundary — see the file-layout block below.)
  it('isolates getConfigurationForTenant by tenant', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'cfg-a', tenantId: 'tenant-a', name: 'Config A' }));
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'cfg-b', tenantId: 'tenant-b', name: 'Config B' }));
    expect(svc.getConfigurationForTenant('tenant-a', 'cfg-a')?.name).toBe('Config A');
    expect(svc.getConfigurationForTenant('tenant-b', 'cfg-b')?.name).toBe('Config B');
    // Cross-tenant access (tenant-b asking for tenant-a's id) returns undefined.
    expect(svc.getConfigurationForTenant('tenant-b', 'cfg-a')).toBeUndefined();
    expect(svc.getAllConfigurationsForTenant('tenant-a')).toHaveLength(1);
    expect(svc.getAllConfigurationsForTenant('tenant-b')).toHaveLength(1);
  });

  it('cross-tenant lookup returns undefined', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'cfg', tenantId: 'tenant-a' }));
    expect(svc.getConfigurationForTenant('tenant-b', 'cfg')).toBeUndefined();
  });
});

describe('ConfigurationService file layout', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('writes to a flat ${id}.json (no tenant subdir)', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'cfg-1', tenantId: 'tenant-a' }));
    const flatExists = await fs.access(path.join(tmpDir, 'cfg-1.json')).then(() => true).catch(() => false);
    const subdirExists = await fs.access(path.join(tmpDir, 'tenant-a', 'cfg-1.json')).then(() => true).catch(() => false);
    expect(flatExists).toBe(true);
    expect(subdirExists).toBe(false);
  });

  it('delete removes the flat ${id}.json file', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'cfg-1', tenantId: 'tenant-a' }));
    await svc.deleteConfigurationForTenant('tenant-a', 'cfg-1');
    const fileExists = await fs.access(path.join(tmpDir, 'cfg-1.json')).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);
  });

  // Flat ${id}.json storage cannot durably hold the same id for two tenants — the
  // second writer would clobber the first on disk. The write boundary rejects the
  // cross-tenant collision rather than silently losing data. (Durable
  // same-id-across-tenants storage is deferred — see proof-card Known Gaps.)
  it('rejects saving the same id under a second tenant (flat-storage limitation)', async () => {
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-a' }));
    await expect(
      svc.saveConfiguration(makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-b' }))
    ).rejects.toThrow(ConfigurationLookupAmbiguousError);
  });

  it('cross-tenant save rejection does NOT leak the other tenant id in the error message', async () => {
    // ConfigurationLookupAmbiguousError → ConflictAppError → 409 body is the .message
    // verbatim. The owning tenant id must stay server-side only (Copilot review).
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.saveConfiguration(makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-a' }));
    let caught: Error | undefined;
    try {
      await svc.saveConfiguration(makeIntegrationConfig({ id: 'shared', tenantId: 'tenant-b' }));
    } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigurationLookupAmbiguousError);
    expect(caught?.message).not.toContain('tenant-a');
    expect(caught?.message).toContain('shared');
  });

  it('re-load drops configs removed on disk (atomic Map swap, not append)', async () => {
    // loadConfigurations builds a fresh Map and swaps it in on success, so a second
    // load after a file is deleted must NOT retain the stale entry (Copilot review).
    await fs.writeFile(path.join(tmpDir, 'keep.json'), JSON.stringify(makeIntegrationConfig({ id: 'keep', tenantId: 'tenant-a' })));
    await fs.writeFile(path.join(tmpDir, 'gone.json'), JSON.stringify(makeIntegrationConfig({ id: 'gone', tenantId: 'tenant-a' })));
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.loadConfigurations();
    expect(svc.getConfigurationForTenant('tenant-a', 'gone')?.id).toBe('gone');
    await fs.unlink(path.join(tmpDir, 'gone.json'));
    await svc.loadConfigurations();
    expect(svc.getConfigurationForTenant('tenant-a', 'gone')).toBeUndefined();
    expect(svc.getConfigurationForTenant('tenant-a', 'keep')?.id).toBe('keep');
  });

  it('two files declaring the same id fail boot closed (canonical-filename guard)', async () => {
    // Two files defining the same id must not silently shadow each other by readdir
    // order. With the canonical-filename invariant they can't both be ${id}.json, so
    // at least one is non-canonical and loadConfigurations fails closed — subsuming
    // the old duplicate-(tenantId,id) cross-file case (Codex + Copilot review).
    await fs.writeFile(path.join(tmpDir, 'dup.json'), JSON.stringify(makeIntegrationConfig({ id: 'dup', tenantId: 'tenant-a', name: 'A' })));
    await fs.writeFile(path.join(tmpDir, 'dup-copy.json'), JSON.stringify(makeIntegrationConfig({ id: 'dup', tenantId: 'tenant-a', name: 'B' })));
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await expect(svc.loadConfigurations()).rejects.toThrow(/does not match its internal id|[Dd]uplicate configuration/);
  });

  it('subdirectories under the config dir are ignored, not walked', async () => {
    // The runtime config dir is overloaded: top-level *.json configs PLUS subdirs
    // holding connector artifacts (e.g. integrations/business_central/*.al). The
    // loader must read only top-level *.json and ignore subdirs entirely — even
    // when a subdir contains a non-config file that would fail config validation.
    await fs.mkdir(path.join(tmpDir, 'business_central'));
    await fs.writeFile(path.join(tmpDir, 'business_central', 'app.json'), JSON.stringify({ not: 'a config' }));
    await fs.writeFile(path.join(tmpDir, 'cfg-1.json'), JSON.stringify(makeIntegrationConfig({ id: 'cfg-1', tenantId: 'tenant-a' })));
    const svc = new ConfigurationService(silentLogger, tmpDir);
    await svc.loadConfigurations();
    // Only the top-level config loaded; the subdir's app.json was ignored, not thrown on.
    expect(svc.getAllConfigurations()).toHaveLength(1);
    expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.id).toBe('cfg-1');
  });
});

describe('committed config dirs load clean under the canonical-filename invariant', () => {
  // Guard against the boot regression Codex caught on 52ae3bcb0: the canonical
  // filename check fails closed on any committed *.json whose name != ${id}.json.
  // Load the REAL committed dirs (runtime `integrations` + the constructor-default
  // `config/integrations`) so a future non-canonical commit fails here instead of
  // at boot. Uses the real Zod validator path via the mocked validator above, which
  // is fine — the canonical-filename check runs before validation.
  const repoRoot = path.resolve(__dirname, '../../..');
  for (const dir of ['integrations', 'config/integrations']) {
    it(`loadConfigurations() succeeds against ${dir}`, async () => {
      const svc = new ConfigurationService(silentLogger, path.join(repoRoot, dir));
      await expect(svc.loadConfigurations()).resolves.toBeUndefined();
    });
  }
});
