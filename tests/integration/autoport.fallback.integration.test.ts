import { spawn } from 'child_process';
import path from 'path';

// Integration style test by spawning a child process to avoid DI/container side-effects in-process.
describe('Auto port fallback (subprocess)', () => {
  test('starts server with auto-port behavior', async () => {
    const script = path.join(__dirname, '../../src/test-server-runner.ts');
    const env = { ...process.env };
    delete env.PORT; // Don't set PORT so userSpecifiedPort is false
    env.NODE_ENV = 'test';
    env.JWT_SECRET = 'test-secret-123456789012345678901234567890';
    env.DISABLE_REDIS = '1';
    env.DASHBOARD_DISABLE_INTERVALS = '1';
    // Keep child startup fast and avoid typecheck-only failures in integration subprocess boot.
    env.TS_NODE_TRANSPILE_ONLY = 'true';
    // Force auto-port behavior
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', script, '--auto-port'], { env });

    let output = '';
    let resolved = false;
    let childKilled = false;
    
    const killChild = () => {
      if (!childKilled) {
        childKilled = true;
        if (!child.killed) {
          child.kill('SIGTERM');
          // Force kill after 2 seconds
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 2000);
        }
      }
    };

    const portPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          killChild();
          reject(new Error('Timeout waiting for server output. Collected output:\n' + output));
        }
      }, 25000); // Allow more time for ts-node cold start

      const handleChunk = (buf: Buffer) => {
        const chunk = buf.toString();
        output += chunk;
        const match = /Server listening on port (\d+)/.exec(chunk);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Give the server a moment to fully start before resolving
          setTimeout(() => resolve(Number(match[1])), 100);
        }
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', handleChunk);
      
      child.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Child exited early (code=${code}, signal=${signal}). Output:\n${output}`));
        }
      });

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Child process error: ${error.message}. Output:\n${output}`));
        }
      });
    });

    try {
      const boundPort = await portPromise;
      // Just verify that we got a valid port number (could be 3000 or higher)
      expect(boundPort).toBeGreaterThanOrEqual(3000);
      expect(boundPort).toBeLessThan(65536);
    } finally {
      killChild();
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }, 40000);
});
