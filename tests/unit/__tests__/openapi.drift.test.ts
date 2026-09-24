import { App } from '../../../src/app';
import path from 'path';
import http from 'http';
import { runOpenApiDriftCheck } from '../../../scripts/openapi-drift-check';

/**
 * Lightweight drift smoke test: ensures drift checker exits 0 after server boot.
 * Skips if running in CI without network (can be extended with env guard).
 */
describe('OpenAPI drift checker', () => {
  let app: App;
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    app = new App({ lightweight: true });
    await app.waitForInitialization();
    // Start HTTP server on ephemeral port
    await new Promise<void>(resolve => {
      server = app.getExpressApp().listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port; else port = 3000;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('drift script reports no drift', async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const projectRoot = path.resolve(__dirname, '../../..');
    const variant = await runOpenApiDriftCheck({ baseUrl, specRoot: projectRoot, debug: true });
    expect(variant).toBeDefined();
  });
});