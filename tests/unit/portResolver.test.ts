import http from 'http';
import type { AddressInfo } from 'net';
import { resolveAvailablePort } from './utils/portResolver';

// Bind to port 0 so the OS hands out a free ephemeral port. A hard-coded port
// (formerly 45123) collides with whatever else holds it on a shared CI runner;
// listen() then emits 'error' instead of calling back, and a promise that only
// resolves on the callback hangs to Jest's 30s timeout (#1329 merge-SHA CI).
function listenOnFreePort(server: http.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('resolveAvailablePort', () => {
  test('returns same port if free (no fallback needed)', async () => {
    const probe = http.createServer();
    const base = await listenOnFreePort(probe);
    await close(probe);

    const port = await resolveAvailablePort(base, { userSpecifiedPort: true });
    expect(port).toBe(base);
  });

  test('falls back when base port is busy and not user specified', async () => {
    // The fallback probes busyPort+1..busyPort+maxAttempts, so leave headroom
    // below 65535: Windows assigns ephemeral ports up to 65535.
    let server = http.createServer();
    let busyPort = await listenOnFreePort(server);
    while (busyPort > 65_000) {
      await close(server);
      server = http.createServer();
      busyPort = await listenOnFreePort(server);
    }

    try {
      const port = await resolveAvailablePort(busyPort, { userSpecifiedPort: false, forceAutoPort: true, maxAttempts: 5 });
      expect(port).toBeGreaterThan(busyPort);
    } finally {
      await close(server);
    }
  });
});
