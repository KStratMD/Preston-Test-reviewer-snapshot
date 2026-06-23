import { isBusinessCentralMCPEnabled, isMCPGatewayEnabled } from '../../../../src/config/runtimeFlags';

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
