import { readFileSync } from 'fs';
import path from 'path';

const ROUTE_SETUP_TS = path.resolve(__dirname, '../../../../src/middleware/setup/RouteSetup.ts');

describe('secure credential route composition', () => {
  const source = readFileSync(ROUTE_SETUP_TS, 'utf8');

  it('mounts credentials through the tenant-status helper', () => {
    expect(source).toContain('mountSecureCredentialRoutes(this.app, tenantSvc, secureCredentialsRouter)');
    expect(source).not.toContain("this.app.use('/api/credentials', secureCredentialsRouter)");
  });

  it('applies the shared mutating-write limiter at the mount boundary', () => {
    expect(source).toContain('authMiddleware, gate, erpWriteRateLimit, router');
  });

  it('resolves TenantLifecycleService before mounting the secure route', () => {
    const resolveLine = source.indexOf('TYPES.TenantLifecycleService');
    const mountLine = source.indexOf('mountSecureCredentialRoutes(this.app, tenantSvc, secureCredentialsRouter)');

    expect(resolveLine).toBeGreaterThanOrEqual(0);
    expect(mountLine).toBeGreaterThan(resolveLine);
  });
});
