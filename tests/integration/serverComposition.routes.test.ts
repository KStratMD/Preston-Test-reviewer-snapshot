/**
 * `App` is not the production route surface, and a gate built on it would be
 * blind to the two families that matter most.
 *
 * `/api/integrations` is mounted by `Server.compose()` after the async
 * IntegrationService resolution — `RouteSetup` skips it during construction,
 * when the service is still undefined. `/api/help` is mounted later still, by
 * `initializeHelpChat()`. A route-coverage gate that enumerated `new App()`
 * would report both families as absent and quietly stop asking about them.
 *
 * This test pins the split that makes the gate possible: `compose()` builds the
 * whole surface without binding a port, and `stop()` tears down the background
 * workers composition starts.
 */
import { Server } from '../../src/index';
import {
  getRouteRegistrationSnapshot,
  isRouteRegistrationRecorderInstalled,
} from '../../src/middleware/setup/routeRegistrationRecorder';

jest.setTimeout(180_000);

describe('Server.compose() builds the production route surface without listening', () => {
  // Assigned in the test body; the afterEach guard reads it before assignment
  // on any path where compose() never runs.
  let server: Server | undefined;

  afterEach(async () => {
    // compose() starts background workers even though nothing is listening.
    if (server) await server.stop();
  });

  it('mounts /api/integrations and /api/help, and binds no port', async () => {
    server = new Server();
    await server.compose();

    const app = server.getExpressApp();
    expect(isRouteRegistrationRecorderInstalled(app)).toBe(true);

    const registrations = getRouteRegistrationSnapshot(app).registrations;
    const routeOps = registrations.filter((r) => r.source === 'route');

    // Both families must appear as *routes*, not merely as mount prefixes: the
    // gate compares operations, and a mount carries no methods.
    for (const family of ['/api/integrations', '/api/help']) {
      const hits = routeOps.filter((r) => r.path.startsWith(family));
      expect(hits.length).toBeGreaterThan(0);
      // Every route registration the gate will turn into an operation needs at
      // least one verb, or it contributes nothing and the family is invisible.
      expect(hits.some((r) => (r.methods ?? []).length > 0)).toBe(true);
    }

    // Nothing should be listening: compose() must not bind.
    expect(server.getPort()).toBeUndefined();
  });
});
