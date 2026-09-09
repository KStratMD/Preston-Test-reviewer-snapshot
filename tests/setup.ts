import { jest } from '@jest/globals';
import { createServer, AddressInfo } from 'net';

// Helper function to log skipped test information
const logSkippedTest = (testName: string, reason: string) => {
  console.info(`\n🚫 SKIPPED TEST: ${testName}`);
  console.info(`   Reason: ${reason}\n`);
};

// Global test setup
const getAvailablePort = async (): Promise<number> => {
  return await new Promise<number>(resolve => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
};

beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only-minimum-32-chars';
  process.env.LOG_LEVEL = 'error'; // Reduce noise during tests
  // Use an available port per test file to avoid EADDRINUSE errors when tests run in parallel
  const port = await getAvailablePort();
  process.env.PORT = String(port);
  
  // Mock console methods to reduce test output noise but keep info for skip messages
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  // Make logSkippedTest available globally
  global.logSkippedTest = logSkippedTest;
});

afterAll(() => {
  // Restore console methods
  jest.restoreAllMocks();
});

// Global test timeout
jest.setTimeout(30000);

declare global {
  var logSkippedTest: (testName: string, reason: string) => void;
}
