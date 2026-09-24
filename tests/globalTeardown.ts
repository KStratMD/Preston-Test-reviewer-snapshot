import type { Shutdownable } from './globals';

export default async () => {
  // Gracefully stop the server created in globalSetup
  const instance = global.__APP_INSTANCE__ as Shutdownable | undefined;
  if (instance && typeof instance.shutdown === 'function') {
    await instance.shutdown();
  }

  // Close Pino worker threads
  if (global.gc) {
    global.gc();
  }
  
  // Close any remaining handles - use type assertion for internal APIs
  const processAny = process as any;
  const handles = processAny._getActiveHandles?.() || [];
  const requests = processAny._getActiveRequests?.() || [];
  
  handles.forEach((handle: any) => {
    if (handle && typeof handle.close === 'function') {
      try {
        handle.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
  
  requests.forEach((request: any) => {
    if (request && typeof request.abort === 'function') {
      try {
        request.abort();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
  
  // Force exit after cleanup
  setTimeout(() => {
    process.exit(0);
  }, 500);
};