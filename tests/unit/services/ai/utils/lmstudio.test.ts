const mockReadFileSync = jest.fn();
const mockOsRelease = jest.fn();

jest.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

jest.mock('node:os', () => ({
  release: () => mockOsRelease(),
}));

import { canonicalizeLMStudioBaseUrl, resolveLMStudioBaseUrl } from 'src/services/ai/utils/lmstudio';

// Each test deletes the WSL markers for a deterministic baseline; restore the
// full original env afterward so mutations never leak to other suites in the
// same Jest worker (repo pattern, e.g. SecureAIServiceExtended.test.ts).
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('resolveLMStudioBaseUrl', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockOsRelease.mockReset();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  it('normalizes an explicit base URL', () => {
    expect(resolveLMStudioBaseUrl(' http://127.0.0.1:1234/ ')).toBe('http://127.0.0.1:1234');
  });

  it('uses the WSL default gateway when running under WSL', () => {
    mockOsRelease.mockReturnValue('5.15.153.1-microsoft-standard-WSL2');
    mockReadFileSync.mockReturnValue(
      [
        'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
        'eth0 00000000 0101A8C0 0003 0 0 0 00000000 0 0 0',
      ].join('\n'),
    );

    expect(resolveLMStudioBaseUrl()).toBe('http://192.168.1.1:1234');
  });

  it('treats a whitespace-only base URL as unset', () => {
    mockOsRelease.mockReturnValue('6.8.0-100-generic');

    expect(resolveLMStudioBaseUrl('   ')).toBe('http://127.0.0.1:1234');
  });

  it('falls back to localhost outside WSL', () => {
    mockOsRelease.mockReturnValue('6.8.0-100-generic');

    expect(resolveLMStudioBaseUrl()).toBe('http://127.0.0.1:1234');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});

describe('canonicalizeLMStudioBaseUrl', () => {
  const WSL_ROUTE_TABLE = [
    'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
    'eth0 00000000 0101A8C0 0003 0 0 0 00000000 0 0 0',
  ].join('\n');

  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockOsRelease.mockReset();
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  it('repairs a saved loopback endpoint under WSL, preserving the port', () => {
    mockOsRelease.mockReturnValue('5.15.153.1-microsoft-standard-WSL2');
    mockReadFileSync.mockReturnValue(WSL_ROUTE_TABLE);

    expect(canonicalizeLMStudioBaseUrl('http://127.0.0.1:8000')).toBe('http://192.168.1.1:8000');
    expect(canonicalizeLMStudioBaseUrl('http://localhost:1234/')).toBe('http://192.168.1.1:1234');
  });

  it('defaults to the LM Studio port when the saved loopback URL has none', () => {
    mockOsRelease.mockReturnValue('5.15.153.1-microsoft-standard-WSL2');
    mockReadFileSync.mockReturnValue(WSL_ROUTE_TABLE);

    expect(canonicalizeLMStudioBaseUrl('http://127.0.0.1')).toBe('http://192.168.1.1:1234');
    expect(canonicalizeLMStudioBaseUrl('http://localhost/')).toBe('http://192.168.1.1:1234');
  });

  it('preserves a saved non-loopback endpoint under WSL', () => {
    mockOsRelease.mockReturnValue('5.15.153.1-microsoft-standard-WSL2');
    mockReadFileSync.mockReturnValue(WSL_ROUTE_TABLE);

    expect(canonicalizeLMStudioBaseUrl('http://10.0.0.5:1234')).toBe('http://10.0.0.5:1234');
  });

  it('preserves loopback outside WSL', () => {
    mockOsRelease.mockReturnValue('6.8.0-100-generic');

    expect(canonicalizeLMStudioBaseUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('falls back to the resolver defaults when no value is saved', () => {
    mockOsRelease.mockReturnValue('5.15.153.1-microsoft-standard-WSL2');
    mockReadFileSync.mockReturnValue(WSL_ROUTE_TABLE);

    expect(canonicalizeLMStudioBaseUrl(undefined)).toBe('http://192.168.1.1:1234');
    expect(canonicalizeLMStudioBaseUrl('   ')).toBe('http://192.168.1.1:1234');
  });
});
