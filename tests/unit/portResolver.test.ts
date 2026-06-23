import http from 'http';
import { resolveAvailablePort } from './utils/portResolver';

describe('resolveAvailablePort', () => {
  

  test('returns same port if free (no fallback needed)', async () => {
    // Pick a high random port to reduce collision chance
    const base = 45000 + Math.floor(Math.random()*1000);
    const port = await resolveAvailablePort(base, { userSpecifiedPort: true });
    expect(port).toBe(base);
  });

  test('falls back when base port is busy and not user specified', async () => {
    // Create a server on a specific port to make it busy
    const testPort = 45123; // Use a high port to avoid conflicts
    const server = http.createServer();
    
    await new Promise<void>((resolve) => {
      server.listen(testPort, resolve);
    });
    
    try {
      const port = await resolveAvailablePort(testPort, { userSpecifiedPort: false, forceAutoPort: true, maxAttempts: 5 });
      expect(port).toBeGreaterThan(testPort);
    } finally {
      server.close();
    }
  });
});