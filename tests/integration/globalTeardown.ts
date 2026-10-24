/**
 * Global teardown for integration tests
 * Ensures all resources are cleaned up before Jest exits
 */
export default async function globalTeardown(): Promise<void> {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  // Give any pending promises time to resolve
  await new Promise(resolve => setTimeout(resolve, 100));

  // Log successful teardown
  console.log('✓ Global teardown completed');
}