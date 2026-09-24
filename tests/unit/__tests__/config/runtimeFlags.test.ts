import {
  isBusinessCentralMCPEnabled,
  isMCPGatewayEnabled,
  isNetSuiteSerializedAssetSyncGloballyEnabled,
  NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY,
} from '../../../../src/config/runtimeFlags';

describe('runtimeFlags MCP gateway helpers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns false for MCP gateway when unset', () => {
    delete process.env.MCP_GATEWAY_ENABLED;
    expect(isMCPGatewayEnabled()).toBe(false);
  });

  it('returns true for MCP gateway when enabled', () => {
    process.env.MCP_GATEWAY_ENABLED = '1';
    expect(isMCPGatewayEnabled()).toBe(true);
  });

  it('requires gateway + BC endpoint for Business Central MCP enablement', () => {
    process.env.BC_MCP_ENDPOINT = 'https://bc.example.com/mcp';
    process.env.MCP_GATEWAY_ENABLED = '0';
    expect(isBusinessCentralMCPEnabled()).toBe(false);

    process.env.MCP_GATEWAY_ENABLED = '1';
    expect(isBusinessCentralMCPEnabled()).toBe(true);
  });

  it('returns false for Business Central MCP when endpoint is missing', () => {
    process.env.MCP_GATEWAY_ENABLED = '1';
    delete process.env.BC_MCP_ENDPOINT;
    expect(isBusinessCentralMCPEnabled()).toBe(false);
  });
});

describe('runtimeFlags NetSuite serialized-asset sync global flag (Task 1, 2026-07-27 plan)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('pins the tenant-setting key string', () => {
    expect(NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY).toBe('integration.netsuite_serialized_asset.enabled');
  });

  it('defaults closed when unset', () => {
    delete process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;
    expect(isNetSuiteSerializedAssetSyncGloballyEnabled()).toBe(false);
  });

  it('is enabled by the shared truthy parser', () => {
    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = '1';
    expect(isNetSuiteSerializedAssetSyncGloballyEnabled()).toBe(true);

    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = 'true';
    expect(isNetSuiteSerializedAssetSyncGloballyEnabled()).toBe(true);
  });

  it('stays closed for falsy/garbage values', () => {
    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = '0';
    expect(isNetSuiteSerializedAssetSyncGloballyEnabled()).toBe(false);

    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = 'nope';
    expect(isNetSuiteSerializedAssetSyncGloballyEnabled()).toBe(false);
  });
});
