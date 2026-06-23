import isPortFree from "is-port-free";

export interface PortResolutionOptions {
  forceAutoPort?: boolean;
  disableAutoPort?: boolean;
  userSpecifiedPort?: boolean; // true if PORT env explicitly set
  maxAttempts?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export async function resolveAvailablePort(basePort: number, opts: PortResolutionOptions = {}): Promise<number> {
  const {
    forceAutoPort = false,
    disableAutoPort = false,
    userSpecifiedPort = false,
    maxAttempts = 10,
    logger = console,
  } = opts;

  if (disableAutoPort) {
    return basePort;
  }

  // If PORT is explicitly set and not forcing auto port, use it
  if (userSpecifiedPort && !forceAutoPort) {
    return basePort;
  }

  // Check if basePort is free
  try {
    if (await isPortFree(basePort)) {
      return basePort;
    }
  } catch (err) {
    logger.warn(`Error checking port ${basePort}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try to find an available port
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = basePort + attempt;
    try {
      if (await isPortFree(port)) {
        logger.info(`Using port ${port} (base port ${basePort} was busy)`);
        return port;
      }
    } catch (err) {
      logger.warn(`Error checking port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unable to find available port after ${maxAttempts} attempts starting from ${basePort}`);
}
