#!/usr/bin/env ts-node
// Test-specific server runner that starts cleanly and exits properly
// Set max listeners before any other imports to prevent warnings
process.setMaxListeners(30);

// In test subprocess, always disable OTEL to keep startup fast and deterministic
process.env.DEMO_NO_OTEL = '1';
// Speed up ts-node transpilation in test subprocesses
process.env.TS_NODE_TRANSPILE_ONLY = '1';

import 'reflect-metadata';
import './config/env';
import { setupGlobalErrorHandlers } from './middleware/errorBoundary';

// Set up global error handlers
setupGlobalErrorHandlers();
import type { AddressInfo } from 'net';
import { resolveAvailablePort } from './utils/portResolver';
import { App } from './app';
import { serverConfig } from './config';

async function startTestServer() {
  try {
    console.error('[TEST-SERVER] Starting test server...');
    
    // Create lightweight app for testing
    const app = new App({ lightweight: true });
    const expressApp = app.getExpressApp();
    
    // Determine CLI flags for auto-port behavior
    const args = process.argv.slice(2);
    const forceAutoPort = args.includes('--auto-port');
    const disableAutoPort = args.includes('--no-auto-port');
    
    console.error('[TEST-SERVER] Resolving port...');
    const selectedPort = await resolveAvailablePort(serverConfig.port, {
      forceAutoPort,
      disableAutoPort,
      userSpecifiedPort: !!process.env.PORT,
      logger: { 
        info: (m: string) => console.error(`[TEST-SERVER] INFO: ${m}`), 
        warn: (m: string) => console.error(`[TEST-SERVER] WARN: ${m}`) 
      },
    });

    console.error(`[TEST-SERVER] Starting server on port ${selectedPort}...`);
    
    const server = expressApp.listen(selectedPort, () => {
      const actualPort = (server.address() as AddressInfo)?.port || selectedPort;
      const message = `Server listening on port ${actualPort}${actualPort !== serverConfig.port ? ` (fallback from ${serverConfig.port})` : ''}`;
      
      // Output to both stderr (for debugging) and stdout (for test detection)
      console.error(`[TEST-SERVER] ${message}`);
      console.log(message); // This is what the test looks for
    });

    server.on('error', (error) => {
      console.error('[TEST-SERVER] Server error:', error);
      process.exit(1);
    });

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.error(`[TEST-SERVER] Received ${signal}, shutting down gracefully...`);
      
      server.close((err) => {
        if (err) {
          console.error('[TEST-SERVER] Error closing server:', err);
          process.exit(1);
        } else {
          console.error('[TEST-SERVER] Server closed successfully');
          process.exit(0);
        }
      });

      // Force exit after 3 seconds if graceful shutdown fails
      setTimeout(() => {
        console.error('[TEST-SERVER] Force exiting after timeout');
        process.exit(1);
      }, 3000);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGHUP', () => void shutdown('SIGHUP'));

  } catch (error) {
    console.error('[TEST-SERVER] Failed to start:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  void startTestServer();
}
