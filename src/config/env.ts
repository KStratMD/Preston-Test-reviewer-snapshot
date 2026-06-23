import { z } from 'zod';
import * as dotenv from 'dotenv';
import { LoggingService } from '../observability/logging';
import { INTEGRATION_CONSTANTS, AUTH_CONSTANTS } from '../constants/systemConstants';
import { hasDbUrlCredentials, pgSslConfig } from '../utils/dbUrlHelper';

// Load environment variables from .env file
dotenv.config();

const logger = new LoggingService({
  level: process.env.LOG_LEVEL ?? 'info',
  environment: process.env.NODE_ENV ?? 'development',
  enableConsole: true,
});

const DEFAULT_JWT_SECRET = 'development-secret-change-me-please-1234567890';
const DISALLOWED_PRODUCTION_JWT_SECRET_PATTERN = /placeholder|change[-_]?me|local[-_]?only/i;
const parseBooleanEnvFlag = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
  return false;
};

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Core connection URLs
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().default(DEFAULT_JWT_SECRET),

  // Database Configuration (PostgreSQL)
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().default('integration_hub'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('password'),
  PGPOOL_MAX: z.coerce.number().int().positive().default(20),
  PGPOOL_MIN: z.coerce.number().int().positive().default(5),
  PGPOOL_IDLE_TIMEOUT: z.coerce.number().int().positive().default(10000),
  PGSSLMODE: z.enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']).default('prefer'),
  DB_SSL: z.boolean().default(false),
  DB_CONNECTION_TIMEOUT: z.coerce.number().int().min(1000).default(2000),

  // Redis Configuration
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.coerce.boolean().default(false),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_KEY_PREFIX: z.string().default('integration-hub'),
  REDIS_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  REDIS_RETRY_DELAY: z.coerce.number().int().min(100).default(1000),
  // Operational toggle to disable Redis usage entirely (queues + cache fall back to in-memory mocks)
  DISABLE_REDIS: z.coerce.boolean().default(false),
  // Allows controlled demo-only exceptions while keeping NODE_ENV=production guards active
  HOSTED_DEMO: z.preprocess(parseBooleanEnvFlag, z.boolean().default(false)),

  // Security
  API_KEY_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // Server Configuration
  ENABLE_HTTPS: z.coerce.boolean().default(false),
  SSL_CERT_PATH: z.string().optional(),
  SSL_KEY_PATH: z.string().optional(),
  RATE_LIMIT: z.coerce.number().int().min(1).default(100),
  REQUEST_TIMEOUT: z.coerce.number().int().min(1000).default(30000),
  OAUTH2_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(AUTH_CONSTANTS.OAUTH2_REQUEST_TIMEOUT_MS),

  // Application Configuration
  CONFIG_DIR: z.string().default('integrations'),

  // NetSuite Configuration
  NETSUITE_ACCOUNT_ID: z.string().optional(),
  NETSUITE_CONSUMER_KEY: z.string().optional(),
  NETSUITE_CONSUMER_SECRET: z.string().optional(),
  NETSUITE_TOKEN_ID: z.string().optional(),
  NETSUITE_TOKEN_SECRET: z.string().optional(),
  NETSUITE_BASE_URL: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),
  NETSUITE_MCP_ENDPOINT: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),
  NETSUITE_MCP_CLIENT_ID: z.string().optional(),
  NETSUITE_MCP_CLIENT_SECRET: z.string().optional(),
  NETSUITE_MCP_ACCESS_TOKEN: z.string().optional(),

  // Dynamics 365 Configuration
  DYNAMICS_TENANT_ID: z.string().optional(),
  DYNAMICS_CLIENT_ID: z.string().optional(),
  DYNAMICS_CLIENT_SECRET: z.string().optional(),
  DYNAMICS_RESOURCE_URL: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),
  DYNAMICS_BASE_URL: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),
  BC_MCP_ENDPOINT: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),
  BC_MCP_TENANT_ID: z.string().optional(),
  BC_MCP_CLIENT_ID: z.string().optional(),
  BC_MCP_CLIENT_SECRET: z.string().optional(),
  BC_MCP_ACCESS_TOKEN: z.string().optional(),

  // Salesforce Configuration
  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_USERNAME: z.string().email().optional(),
  SALESFORCE_PASSWORD: z.string().optional(),
  SALESFORCE_SECURITY_TOKEN: z.string().optional(),
  SALESFORCE_LOGIN_URL: z.string().url().default('https://login.salesforce.com'),

  // SuiteCentral Configuration
  SUITECENTRAL_API_KEY: z.string().optional(),
  SUITECENTRAL_BASE_URL: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),

  // Squire Configuration
  SQUIRE_API_KEY: z.string().optional(),
  SQUIRE_BASE_URL: z.string().url().optional().or(z.literal('')).transform(val => val || undefined),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  LOG_FILE: z.string().default('logs/integration-hub.log'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  TEST_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10 * 1000),
  TEST_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10000),

  // Integration Settings
  MAX_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
  MAX_CONCURRENT_INTEGRATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .default(INTEGRATION_CONSTANTS.MAX_CONCURRENT_INTEGRATIONS),

  // Token cleanup configuration
  TOKEN_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000), // 5 minutes

  // Queue Configuration
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  QUEUE_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  QUEUE_RETRY_DELAY: z.coerce.number().int().min(1000).default(2000),

  // Secret Management Configuration
  SECRET_MANAGER_PROVIDER: z.enum(['aws', 'azure', 'hashicorp', 'env']).default('env'),
  AWS_REGION: z.string().optional(),
  VAULT_URL: z.string().url().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_ROLE_NAME: z.string().optional(),
  AZURE_KEY_VAULT_NAME: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  ENABLE_CREDENTIAL_ENCRYPTION: z.coerce.boolean().default(false),
  CREDENTIAL_ROTATION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  ENABLE_CREDENTIAL_AUDIT_LOGGING: z.coerce.boolean().default(true),

  // Feature Flags for Gradual Rollout
  FEATURE_NEW_INTEGRATION_STRATEGY: z.coerce.boolean().default(false),
  MCP_GATEWAY_ENABLED: z.preprocess(parseBooleanEnvFlag, z.boolean().default(false)),
  MCP_TOOL_ALLOWLIST: z.string().optional(),
  MCP_TOOL_DENYLIST: z.string().optional(),
  MCP_DISABLED_TENANTS: z.string().optional(),
});

export type Environment = z.infer<typeof environmentSchema>;

declare global {
  var env: Environment;
}

// Default values used when running in development without a .env file
const devFallbacks: Partial<Record<keyof Environment, string>> = {
  DATABASE_URL: 'postgresql://localhost:5432/integration_hub',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: DEFAULT_JWT_SECRET,
};

const envInput = process.env.NODE_ENV === 'production' ? process.env : { ...devFallbacks, ...process.env };

try {
  const parsedEnv = environmentSchema.parse(envInput);
  const isHostedDemoProduction = process.env.NODE_ENV === 'production' && parsedEnv.HOSTED_DEMO;
  if (isHostedDemoProduction) {
    logger.warn('HOSTED_DEMO=1 enabled in production. Applying hosted-demo guard exceptions for JWT/DB checks.');
  }
  if (process.env.NODE_ENV === 'production' && !parsedEnv.HOSTED_DEMO) {
    const jwtSecretLooksLikePlaceholder =
      parsedEnv.JWT_SECRET === DEFAULT_JWT_SECRET ||
      DISALLOWED_PRODUCTION_JWT_SECRET_PATTERN.test(parsedEnv.JWT_SECRET);
    if (jwtSecretLooksLikePlaceholder) {
      logger.error('JWT_SECRET is using a default or placeholder value in production. Set a unique, secure value.');
      process.exit(1);
    }
  }
  // SECURITY: Reject default database password in production (check env var directly
  // to avoid false positives when Zod schema default fills in during test re-evaluation).
  // Skip if DATABASE_URL has embedded credentials (alternative config path).
  if (
    process.env.NODE_ENV === 'production' &&
    !parsedEnv.HOSTED_DEMO &&
    !hasDbUrlCredentials(process.env.DATABASE_URL) &&
    (!process.env.DB_PASSWORD || process.env.DB_PASSWORD === 'password')
  ) {
    logger.error('DB_PASSWORD is missing or insecure in production. Set DB_PASSWORD or use DATABASE_URL with embedded credentials.');
    process.exit(1);
  }
  // SECURITY: Require rate limiting in production to prevent DoS attacks
  if (process.env.NODE_ENV === 'production' && !parsedEnv.RATE_LIMIT_ENABLED) {
    logger.error('RATE_LIMIT_ENABLED must be true in production. Set RATE_LIMIT_ENABLED=true');
    process.exit(1);
  }
  if (process.env.NODE_ENV !== 'production') {
    logger.info('Environment variables validated successfully');
    const usedFallbacks = Object.keys(devFallbacks).filter(key => !process.env[key]);
    if (usedFallbacks.length) {
      logger.warn(`Using fallback environment variables: ${usedFallbacks.join(', ')}`);
    }
  }
  // Create a new object for the validated environment variables
  const validatedEnv: Environment = parsedEnv;

  // Export the validated and strongly-typed environment variables
  const env = new Proxy(validatedEnv, {
    get(target, prop) {
      return target[prop as keyof typeof target];
    },
  });

  // Make the validated environment available globally
  globalThis.env = env;
} catch (error) {
  if (error instanceof z.ZodError) {
    logger.error({ errors: error.flatten().fieldErrors }, 'Invalid environment variables');
    process.exit(1);
  }
  throw error;
}

export const env: Environment = globalThis.env;

/**
 * Configuration object for the database connection pool
 */
export const dbConfig = {
  connectionString: env.DATABASE_URL,
  ssl: pgSslConfig(env.PGSSLMODE, env.NODE_ENV),
  max: env.PGPOOL_MAX,
  min: env.PGPOOL_MIN,
  idleTimeoutMillis: env.PGPOOL_IDLE_TIMEOUT,
};

/**
 * Configuration object for Redis connection
 */
export const redisConfig = {
  url: env.REDIS_URL,
  password: env.REDIS_PASSWORD,
  socket: {
    tls: env.REDIS_TLS,
    rejectUnauthorized: env.NODE_ENV === 'production',
  },
  retry_strategy: (options: { attempt: number; error: Error }) => {
    if (options.attempt > env.REDIS_MAX_RETRIES) {
      // End reconnecting on a specific error and flush all commands with a individual error
      return new Error('Retry time exhausted');
    }
    // Reconnect after
    return Math.min(options.attempt * env.REDIS_RETRY_DELAY, 3000);
  },
};

/**
 * Configuration for NetSuite connector
 */
export const netsuiteConfig = {
  accountId: env.NETSUITE_ACCOUNT_ID,
  consumerKey: env.NETSUITE_CONSUMER_KEY,
  consumerSecret: env.NETSUITE_CONSUMER_SECRET,
  tokenId: env.NETSUITE_TOKEN_ID,
  tokenSecret: env.NETSUITE_TOKEN_SECRET,
  baseUrl: env.NETSUITE_BASE_URL,
};

/**
 * Configuration for Dynamics 365 connector
 */
export const dynamicsConfig = {
  tenantId: env.DYNAMICS_TENANT_ID,
  clientId: env.DYNAMICS_CLIENT_ID,
  clientSecret: env.DYNAMICS_CLIENT_SECRET,
  resourceUrl: env.DYNAMICS_RESOURCE_URL,
  baseUrl: env.DYNAMICS_BASE_URL,
};

/**
 * MCP gateway/adapters configuration
 */
export const mcpGatewayConfig = {
  gatewayEnabled: env.MCP_GATEWAY_ENABLED,
  netsuite: {
    endpoint: env.NETSUITE_MCP_ENDPOINT,
    clientId: env.NETSUITE_MCP_CLIENT_ID,
    clientSecret: env.NETSUITE_MCP_CLIENT_SECRET,
    accessToken: env.NETSUITE_MCP_ACCESS_TOKEN,
  },
  businessCentral: {
    endpoint: env.BC_MCP_ENDPOINT,
    tenantId: env.BC_MCP_TENANT_ID,
    clientId: env.BC_MCP_CLIENT_ID,
    clientSecret: env.BC_MCP_CLIENT_SECRET,
    accessToken: env.BC_MCP_ACCESS_TOKEN,
  },
  policy: {
    allowlist: env.MCP_TOOL_ALLOWLIST,
    denylist: env.MCP_TOOL_DENYLIST,
    disabledTenants: env.MCP_DISABLED_TENANTS,
  },
};

/**
 * Configuration for Salesforce connector
 */
export const salesforceConfig = {
  clientId: env.SALESFORCE_CLIENT_ID,
  clientSecret: env.SALESFORCE_CLIENT_SECRET,
  username: env.SALESFORCE_USERNAME,
  password: env.SALESFORCE_PASSWORD,
  securityToken: env.SALESFORCE_SECURITY_TOKEN,
  loginUrl: env.SALESFORCE_LOGIN_URL,
};

/**
 * Configuration for SuiteCentral connector
 */
export const suiteCentralConfig = {
  apiKey: env.SUITECENTRAL_API_KEY,
  baseUrl: env.SUITECENTRAL_BASE_URL,
};

/**
 * Configuration for Squire connector
 */
export const squireConfig = {
  apiKey: env.SQUIRE_API_KEY,
  baseUrl: env.SQUIRE_BASE_URL,
};

/**
 * Configuration for server settings
 */
export const serverConfig = {
  port: env.PORT,
  env: env.NODE_ENV,
  rateLimit: env.RATE_LIMIT,
  timeout: env.REQUEST_TIMEOUT,
  enableHttps: env.ENABLE_HTTPS,
  sslCertPath: env.SSL_CERT_PATH,
  sslKeyPath: env.SSL_KEY_PATH,
};

/**
 * Configuration for security settings
 */
export const securityConfig = {
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
};

/**
 * Configuration for logging
 */
export const loggingConfig = {
  level: env.LOG_LEVEL,
  logFile: env.LOG_FILE,
};

/**
 * Configuration for integration settings
 */
export const integrationConfig = {
  maxRetryAttempts: env.MAX_RETRY_ATTEMPTS,
  batchSize: env.BATCH_SIZE,
  syncIntervalMinutes: env.SYNC_INTERVAL_MINUTES,
  maxConcurrentIntegrations: env.MAX_CONCURRENT_INTEGRATIONS,
  tokenCleanupIntervalMs: env.TOKEN_CLEANUP_INTERVAL_MS,
};

/**
 * A simple check to determine if any integration is configured
 */
export const isAnyIntegrationConfigured =
  !!netsuiteConfig.accountId ||
  !!dynamicsConfig.clientId ||
  !!salesforceConfig.clientId ||
  !!suiteCentralConfig.apiKey ||
  !!squireConfig.apiKey;
