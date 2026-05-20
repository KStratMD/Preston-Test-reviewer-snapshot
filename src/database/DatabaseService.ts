import { injectable, inject } from 'inversify';
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
import { Pool } from 'pg';
import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { env } from '../config/env';
import { hasDbUrlCredentials, pgSslConfig } from '../utils/dbUrlHelper';
import type { Database } from './types';
import { MigrationRunner } from './MigrationRunner';
import { MIGRATIONS } from './migrations';

/**
 * Database service using Kysely for type-safe SQL queries
 * Provides connection pooling, transaction management, and migration support
 */
@injectable()
export class DatabaseService {
  private readonly logger: Logger;
  private db: Kysely<Database> | null = null;
  private pool: Pool | null = null;
  private sqlite: BetterSqlite3.Database | null = null;
  private dbType: 'sqlite' | 'postgres';

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    this.dbType = (process.env.DB_TYPE as 'sqlite' | 'postgres') || 'sqlite';
  }

  /**
   * SECURITY: Validate database path to prevent path traversal attacks
   * Ensures the path stays within the allowed data directory
   */
  private validateDatabasePath(dbPath: string): void {
    // Allow in-memory databases without validation
    if (dbPath === ':memory:') {
      return;
    }

    // SECURITY: In production, validate path stays within allowed directory
    // This prevents path traversal attacks via SQLITE_DB_PATH env var
    if (process.env.NODE_ENV === 'production') {
      const allowedDbDir = path.resolve(process.cwd(), 'data');
      const resolvedPath = path.resolve(dbPath);

      // Check for path traversal attempts (../)
      if (dbPath.includes('..')) {
        throw new Error(
          `SECURITY: Database path contains path traversal sequence '..': ${dbPath}`
        );
      }

      // Ensure resolved path is within allowed directory
      if (!resolvedPath.startsWith(allowedDbDir)) {
        throw new Error(
          `SECURITY: Database path must be within ${allowedDbDir}. Got: ${resolvedPath}`
        );
      }

      this.logger.info('Database path validated', { path: resolvedPath, allowedDir: allowedDbDir });
    }
  }

  /**
   * Initialize database connection and run migrations
   */
  async initialize(): Promise<void> {
    try {
      if (this.dbType === 'sqlite') {
        // Setup SQLite database
        const overridePath = process.env.SQLITE_DB_PATH;
        let dbPath: string;
        if (overridePath) {
          dbPath = overridePath;
          // SECURITY: Validate path before use (production only)
          this.validateDatabasePath(dbPath);
          // Only create directories for file-based databases (skip for ':memory:')
          if (dbPath !== ':memory:') {
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
          }
        } else {
          const dbDir = path.join(process.cwd(), 'data');
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }
          dbPath = path.join(dbDir, 'ai-config.db');
        }

        this.sqlite = new BetterSqlite3(dbPath);
        this.sqlite.pragma('journal_mode = WAL');
        this.sqlite.pragma('synchronous = NORMAL');
        this.sqlite.pragma('foreign_keys = ON');

        // Optionally patch better-sqlite3 to convert boolean parameters to integers (1/0) before binding
        // Enabled by default; can be disabled by setting SQLITE_BOOL_PARAM_PATCH=0
        try {
          const shouldPatch = process.env.SQLITE_BOOL_PARAM_PATCH !== '0';
          if (!shouldPatch) {
            this.logger.info('SQLite boolean parameter patch disabled by env flag SQLITE_BOOL_PARAM_PATCH=0');
          }
          if (shouldPatch) {
          const isPlainObject = (v: unknown) => Object.prototype.toString.call(v) === '[object Object]';
          const convertBooleansDeep = (value: unknown): unknown => {
            if (typeof value === 'boolean') return value ? 1 : 0;
            if (value == null) return value;
            if (Array.isArray(value)) return value.map(convertBooleansDeep);
            if (Buffer.isBuffer(value)) return value;
            if (value instanceof Date) return value.toISOString(); // SQLite expects strings/numbers/buffers
            // Only traverse plain JSON-like objects (avoid class instances)
            if (isPlainObject(value)) {
              const out: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(value)) {
                out[k] = convertBooleansDeep(v);
              }
              return out;
            }
            return value;
          };

          const wrapStatement = (stmt: Record<string, unknown>) => {
            const wrapMethod = (name: string) => {
              const method = stmt[name];
              if (typeof method !== 'function') return;
              const original = method.bind(stmt);
              stmt[name] = (...args: unknown[]) => {
                const converted = args.map(convertBooleansDeep);
                return original(...converted);
              };
            };
            // Common execution methods
            wrapMethod('run');
            wrapMethod('get');
            wrapMethod('all');
            wrapMethod('iterate');
            wrapMethod('bind');
            return stmt;
          };

            const originalPrepare = this.sqlite.prepare.bind(this.sqlite);
            (this.sqlite as any).prepare = (source: string) => {
              const stmt = originalPrepare(source);
              return wrapStatement(stmt);
            };
          }
        } catch (patchErr) {
          this.logger.warn('SQLite boolean parameter patch failed to apply; proceeding without it', {
            error: patchErr instanceof Error ? patchErr.message : String(patchErr),
          });
        }

        // Create Kysely instance with standard SQLite dialect
        this.db = new Kysely<Database>({
          dialect: new SqliteDialect({
            database: this.sqlite,
          }),
          log: (event) => {
            if (event.level === 'query') {
              this.logger.debug('Database query', {
                sql: event.query.sql,
                parameters: event.query.parameters,
                duration: event.queryDurationMillis,
              });
            } else if (event.level === 'error') {
              // Include query and parameter details (types) to diagnose binding issues
              const paramTypes = Array.isArray((event as any).query?.parameters)
                ? ((event as any).query.parameters as unknown[]).map((p) => (p === null ? 'null' : typeof p))
                : undefined;
              const errMsg = event.error && typeof event.error === 'object' && 'message' in event.error
                ? (event.error as Error).message
                : 'Unknown database error';
              this.logger.error('Database error', undefined, {
                error: errMsg,
                sql: (event as any).query?.sql,
                parameters: (event as any).query?.parameters,
                parameterTypes: paramTypes,
              });
            }
          },
        });

        this.logger.info('SQLite database initialized', {
          path: overridePath ? overridePath : dbPath,
        });
      } else {
        // Create PostgreSQL connection pool
        const sslConfig = pgSslConfig(env.PGSSLMODE, env.NODE_ENV);

        const useConnectionString = hasDbUrlCredentials(env.DATABASE_URL);
        this.pool = new Pool(
          useConnectionString
            ? {
                connectionString: env.DATABASE_URL,
                ssl: sslConfig,
                max: env.PGPOOL_MAX,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
              }
            : {
                host: env.DB_HOST,
                port: env.DB_PORT,
                database: env.DB_NAME,
                user: env.DB_USER,
                password: env.DB_PASSWORD,
                ssl: sslConfig,
                max: env.PGPOOL_MAX,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
              }
        );

        // Create Kysely instance with PostgreSQL dialect
        this.db = new Kysely<Database>({
          dialect: new PostgresDialect({
            pool: this.pool,
          }),
        log: (event) => {
          if (event.level === 'query') {
            this.logger.debug('Database query', {
              sql: event.query.sql,
              parameters: event.query.parameters,
              duration: event.queryDurationMillis,
            });
          } else if (event.level === 'error') {
            this.logger.error('Database error', {
              error: event.error && typeof event.error === 'object' && 'message' in event.error
                ? (event.error as Error).message
                : 'Unknown database error',
            });
          }
        },
      });
      }

      // Test connection
      await this.testConnection();

      // Run migrations
      await this.runMigrations();

      if (this.dbType === 'postgres') {
        this.logger.info('PostgreSQL database service initialized', {
          host: env.DB_HOST,
          database: env.DB_NAME,
          poolSize: env.PGPOOL_MAX,
        });
      }
    } catch (error) {
      this.logger.error('Failed to initialize database service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get database instance
   */
  getDatabase(): Kysely<Database> {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(
    callback: (trx: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db.transaction().execute(callback);
  }

  /**
   * Execute a raw SQL query using Kysely's sql template tag
   * Returns the query result with rows
   */
  async query<T = unknown>(
    sqlQuery: ReturnType<typeof sql>
  ): Promise<{ rows: T[] }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = await sqlQuery.execute(this.db);
    return { rows: result.rows as T[] };
  }

  /**
   * Get the database type (sqlite or postgres)
   */
  getDbType(): 'sqlite' | 'postgres' {
    return this.dbType;
  }

  /**
   * Test database connection
   */
  async testConnection(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      await sql`SELECT 1`.execute(this.db);
      this.logger.debug('Database connection test successful');
    } catch (error) {
      this.logger.error('Database connection test failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get database health status
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: {
      connected: boolean;
      poolSize: number;
      activeConnections: number;
      idleConnections: number;
      waitingClients: number;
    };
  }> {
    try {
      if (this.dbType === 'sqlite') {
        // SQLite health check
        if (!this.sqlite || !this.db) {
          return {
            status: 'unhealthy',
            details: {
              connected: false,
              poolSize: 0,
              activeConnections: 0,
              idleConnections: 0,
              waitingClients: 0,
            },
          };
        }

        // Try a simple query to verify connection
        await sql`SELECT 1`.execute(this.db);

        return {
          status: 'healthy',
          details: {
            connected: true,
            poolSize: 1, // SQLite is single connection
            activeConnections: 1,
            idleConnections: 0,
            waitingClients: 0,
          },
        };
      }

      // PostgreSQL health check
      if (!this.pool) {
        return {
          status: 'unhealthy',
          details: {
            connected: false,
            poolSize: 0,
            activeConnections: 0,
            idleConnections: 0,
            waitingClients: 0,
          },
        };
      }

      // Test connection
      await this.testConnection();

      return {
        status: 'healthy',
        details: {
          connected: true,
          poolSize: this.pool.totalCount,
          activeConnections: this.pool.totalCount - this.pool.idleCount,
          idleConnections: this.pool.idleCount,
          waitingClients: this.pool.waitingCount,
        },
      };
    } catch (_error) {
      return {
        status: 'unhealthy',
        details: {
          connected: false,
          poolSize: this.pool?.totalCount || 0,
          activeConnections: 0,
          idleConnections: 0,
          waitingClients: 0,
        },
      };
    }
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      this.logger.info('Running database migrations...');

      const runner = new MigrationRunner({
        db: this.db,
        dbType: this.dbType,
        modules: MIGRATIONS,
        logger: this.logger,
      });

      await runner.runAll();
      this.logger.info('Database migrations completed');
    } catch (error) {
      this.logger.error('Failed to run migrations', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Shutdown database connection
   */
  async shutdown(): Promise<void> {
    try {
      if (this.db) {
        await this.db.destroy();
        this.db = null;
      }

      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }

      this.logger.info('Database service shutdown completed');
    } catch (error) {
      this.logger.error('Error during database service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
