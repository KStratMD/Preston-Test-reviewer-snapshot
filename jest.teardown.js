// Jest teardown to close all handles properly
const cleanup = async () => {
  // Close Pino worker threads  
  if (global.gc) {
    global.gc();
  }
  
  // Close any remaining handles
  const handles = process._getActiveHandles();
  const requests = process._getActiveRequests();
  
  handles.forEach(handle => {
    if (handle && typeof handle.close === 'function') {
      try {
        handle.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
  
  requests.forEach(request => {
    if (request && typeof request.abort === 'function') {
      try {
        request.abort();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
  
  // Don't force-exit from this teardown. The previous unconditional
  // `setTimeout(() => process.exit(0), 500)` was harmless in practice
  // (jest's `forceExit: true` from jest.base.config.cjs reliably wins
  // the race), but its presence implies an exit-code override that
  // didn't actually exist — confusing future readers. The real CI
  // silent-failure fix is the test-summary.json verification guard
  // wired into ci-minimal.yml's "Run tests with coverage" step in
  // PR #713, not anything in this file.
};

module.exports = cleanup;