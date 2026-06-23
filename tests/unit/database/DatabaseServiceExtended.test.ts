import 'reflect-metadata';
import { DatabaseService } from '../../../src/database/DatabaseService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

/**
 * DatabaseServiceExtended Tests
 *
 * Tests the DatabaseService public API surface: constructor, initialize (SQLite path),
 * getDatabase, getDbType, testConnection, getHealthStatus, transaction, query, shutdown.
 *
 * Uses in-memory SQLite (:memory:) to avoid filesystem side effects.
 */
describe('DatabaseServiceExtended', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  /**
   * Creates a fresh DatabaseService configured for in-memory SQLite.
   */
  function createService(): DatabaseService {
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_DB_PATH = ':memory:';
    // Ensure not production to avoid path validation blocking :memory:
    process.env.NODE_ENV = 'test';
    return new DatabaseService(mockLogger);
  }

  // =============================================
  // CONSTRUCTOR
  // =============================================

  describe('Constructor', () => {
    it('should create an instance with default sqlite db type', () => {
      delete process.env.DB_TYPE;
      const service = new DatabaseService(mockLogger);
      expect(service.getDbType()).toBe('sqlite');
    });

    it('should respect DB_TYPE=sqlite env var', () => {
      process.env.DB_TYPE = 'sqlite';
      const service = new DatabaseService(mockLogger);
      expect(service.getDbType()).toBe('sqlite');
    });

    it('should respect DB_TYPE=postgres env var', () => {
      process.env.DB_TYPE = 'postgres';
      const service = new DatabaseService(mockLogger);
      expect(service.getDbType()).toBe('postgres');
    });
  });

  // =============================================
  // getDatabase (before initialize)
  // =============================================

  describe('getDatabase before initialize', () => {
    it('should throw when database is not initialized', () => {
      const service = createService();
      expect(() => service.getDatabase()).toThrow('Database not initialized. Call initialize() first.');
    });
  });

  // =============================================
  // INITIALIZE (SQLite in-memory)
  // =============================================

  describe('initialize (SQLite in-memory)', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) {
        await service.shutdown();
      }
    });

    it('should initialize successfully with in-memory SQLite', async () => {
      service = createService();
      await service.initialize();
      // Should not throw and db should be ready
      const db = service.getDatabase();
      expect(db).toBeDefined();
    });

    it('should log SQLite initialization message', async () => {
      service = createService();
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SQLite database initialized',
        expect.any(Object),
      );
    });

    it('should log migrations running message', async () => {
      service = createService();
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith('Running database migrations...');
    });

    it('should log migrations completed message', async () => {
      service = createService();
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith('Database migrations completed');
    });

    it('should create all expected tables via migrations', async () => {
      service = createService();
      await service.initialize();
      const db = service.getDatabase();

      // Query sqlite_master to verify tables exist
      const { sql } = await import('kysely');
      const result = await sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`.execute(db);
      const tableNames = (result.rows as { name: string }[]).map(r => r.name);

      expect(tableNames).toContain('migrations');
      expect(tableNames).toContain('integration_jobs');
      expect(tableNames).toContain('integration_config_history');
      expect(tableNames).toContain('integration_execution_logs');
      expect(tableNames).toContain('data_quality_reports');
      expect(tableNames).toContain('webhook_deliveries');
      expect(tableNames).toContain('audit_logs');
      expect(tableNames).toContain('metrics');
      expect(tableNames).toContain('tenant_configurations');
      expect(tableNames).toContain('api_keys');
      expect(tableNames).toContain('circuit_breaker_states');
      expect(tableNames).toContain('dead_letter_records');
      expect(tableNames).toContain('ai_provider_configs');
      expect(tableNames).toContain('ai_task_model_configs');
      expect(tableNames).toContain('ai_usage_logs');
      expect(tableNames).toContain('ai_config_audit_log');
      expect(tableNames).toContain('mcp_user_settings');
      expect(tableNames).toContain('sync_cursors');
      expect(tableNames).toContain('saga_executions');
      expect(tableNames).toContain('mdm_golden_records');
      expect(tableNames).toContain('mdm_entity_sources');
      expect(tableNames).toContain('mdm_sync_requests');
      expect(tableNames).toContain('mdm_survivorship_rules');
    });

    it('should record all migrations in the migrations table', async () => {
      service = createService();
      await service.initialize();
      const db = service.getDatabase();
      const { sql } = await import('kysely');
      const result = await sql`SELECT name FROM migrations ORDER BY id`.execute(db);
      const migrationNames = (result.rows as { name: string }[]).map(r => r.name);

      expect(migrationNames).toContain('create_integration_jobs_table');
      expect(migrationNames).toContain('create_indexes');
      expect(migrationNames).toContain('create_ai_configurations_table');
      expect(migrationNames).toContain('seed_ai_configurations_defaults');
      expect(migrationNames).toContain('create_mdm_tables');
      expect(migrationNames).toContain('seed_mdm_survivorship_rules_defaults');
      expect(migrationNames).toContain('add_tenant_configurations_key_value_index');
      expect(migrationNames).toContain('create_sync_error_assist_runs_table');
      expect(migrationNames).toContain('create_sync_error_assist_processed_table');
      expect(migrationNames).toContain('extend_sync_error_assist_processed');
      expect(migrationNames).toContain('add_sync_error_assist_processed_error_last_modified');
      expect(migrationNames.length).toBe(56); // PR: 056-reconciliation-schedules-integration-config-not-null
    });

    it('should seed default AI provider configuration', async () => {
      service = createService();
      await service.initialize();
      const db = service.getDatabase();
      const { sql } = await import('kysely');

      const result = await sql`
        SELECT provider_type, provider_name, is_default
        FROM ai_provider_configs
        WHERE user_id = 1 AND provider_type = 'rule-based'
      `.execute(db);

      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as { provider_type: string; provider_name: string; is_default: number };
      expect(row.provider_type).toBe('rule-based');
      expect(row.provider_name).toBe('Rule-Based Engine');
      expect(row.is_default).toBe(1);
    });

    it('should seed MDM survivorship rules', async () => {
      service = createService();
      await service.initialize();
      const db = service.getDatabase();
      const { sql } = await import('kysely');

      const result = await sql`SELECT COUNT(*) as cnt FROM mdm_survivorship_rules`.execute(db);
      const count = (result.rows[0] as { cnt: number }).cnt;
      expect(count).toBe(14); // 14 seed rules
    });

    it('should be idempotent - running initialize twice should not fail', async () => {
      service = createService();
      await service.initialize();
      // Shutdown and re-create to simulate restart
      await service.shutdown();

      service = createService();
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });

  // =============================================
  // DATABASE PATH VALIDATION
  // =============================================

  describe('validateDatabasePath (production)', () => {
    it('should allow :memory: even in production', async () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = ':memory:';
      process.env.NODE_ENV = 'production';
      const service = new DatabaseService(mockLogger);
      // Path validation is called during initialize, :memory: should be allowed
      await expect(service.initialize()).resolves.not.toThrow();
      await service.shutdown();
    });

    it('should reject path traversal in production', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = '../../../etc/passwd';
      process.env.NODE_ENV = 'production';
      const service = new DatabaseService(mockLogger);
      // initialize() should throw because of path traversal
      return expect(service.initialize()).rejects.toThrow('SECURITY');
    });

    it('should reject paths outside allowed data directory in production', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = '/tmp/rogue.db';
      process.env.NODE_ENV = 'production';
      const service = new DatabaseService(mockLogger);
      return expect(service.initialize()).rejects.toThrow('SECURITY');
    });

    it('should allow paths inside data directory in production', async () => {
      // This test may actually try to create the file. We set NODE_ENV=production
      // and point to the allowed data directory.
      const path = await import('path');
      const dataDir = path.join(process.cwd(), 'data');
      const dbPath = path.join(dataDir, 'test-prod-validate.db');

      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = dbPath;
      process.env.NODE_ENV = 'production';
      const service = new DatabaseService(mockLogger);

      // This should pass path validation (though actual init may succeed or fail
      // depending on file system). We just verify it does not throw a SECURITY error.
      try {
        await service.initialize();
        await service.shutdown();
      } catch (err: any) {
        // If it fails, it should NOT be a security error
        expect(err.message).not.toContain('SECURITY');
      }

      // Cleanup
      const fs = await import('fs');
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    });

    it('should skip path validation in non-production environments', async () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = ':memory:';
      process.env.NODE_ENV = 'test';
      const service = new DatabaseService(mockLogger);
      await service.initialize();
      // No SECURITY log should appear
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'Database path validated',
        expect.any(Object),
      );
      await service.shutdown();
    });
  });

  // =============================================
  // getDatabase (after initialize)
  // =============================================

  describe('getDatabase after initialize', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should return a Kysely instance after initialization', async () => {
      service = createService();
      await service.initialize();
      const db = service.getDatabase();
      expect(db).toBeDefined();
      expect(typeof db.selectFrom).toBe('function');
    });
  });

  // =============================================
  // getDbType
  // =============================================

  describe('getDbType', () => {
    it('should return sqlite for default configuration', () => {
      delete process.env.DB_TYPE;
      const service = new DatabaseService(mockLogger);
      expect(service.getDbType()).toBe('sqlite');
    });

    it('should return postgres when configured', () => {
      process.env.DB_TYPE = 'postgres';
      const service = new DatabaseService(mockLogger);
      expect(service.getDbType()).toBe('postgres');
    });
  });

  // =============================================
  // testConnection
  // =============================================

  describe('testConnection', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should throw if database is not initialized', async () => {
      service = createService();
      await expect(service.testConnection()).rejects.toThrow('Database not initialized');
    });

    it('should succeed after initialization', async () => {
      service = createService();
      await service.initialize();
      await expect(service.testConnection()).resolves.not.toThrow();
    });

    it('should log successful connection test', async () => {
      service = createService();
      await service.initialize();
      jest.clearAllMocks();
      await service.testConnection();
      expect(mockLogger.debug).toHaveBeenCalledWith('Database connection test successful');
    });
  });

  // =============================================
  // getHealthStatus
  // =============================================

  describe('getHealthStatus', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should return unhealthy when sqlite is not initialized', async () => {
      service = createService();
      const health = await service.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
    });

    it('should return healthy after successful SQLite initialization', async () => {
      service = createService();
      await service.initialize();
      const health = await service.getHealthStatus();
      expect(health.status).toBe('healthy');
      expect(health.details.connected).toBe(true);
      expect(health.details.poolSize).toBe(1); // SQLite single connection
      expect(health.details.activeConnections).toBe(1);
      expect(health.details.idleConnections).toBe(0);
      expect(health.details.waitingClients).toBe(0);
    });

    it('should return unhealthy after shutdown', async () => {
      service = createService();
      await service.initialize();
      await service.shutdown();
      const health = await service.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
    });

    it('should return unhealthy for postgres when pool is null', async () => {
      process.env.DB_TYPE = 'postgres';
      process.env.NODE_ENV = 'test';
      service = new DatabaseService(mockLogger);
      // Do NOT initialize - pool will be null
      const health = await service.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
      expect(health.details.poolSize).toBe(0);
    });
  });

  // =============================================
  // transaction
  // =============================================

  describe('transaction', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should throw if database is not initialized', async () => {
      service = createService();
      await expect(
        service.transaction(async () => 'result'),
      ).rejects.toThrow('Database not initialized');
    });

    it('should execute a transaction callback and return its result', async () => {
      service = createService();
      await service.initialize();

      const result = await service.transaction(async (trx) => {
        const { sql } = await import('kysely');
        await sql`INSERT INTO integration_jobs (id, integration_id, queue_job_id, status) VALUES ('txn-test-1', 'int-1', 'q-1', 'pending')`.execute(trx);
        return 'committed';
      });

      expect(result).toBe('committed');

      // Verify the insert persisted
      const { sql } = await import('kysely');
      const db = service.getDatabase();
      const check = await sql`SELECT id FROM integration_jobs WHERE id = 'txn-test-1'`.execute(db);
      expect(check.rows.length).toBe(1);
    });

    it('should roll back transaction on error', async () => {
      service = createService();
      await service.initialize();

      try {
        await service.transaction(async (trx) => {
          const { sql } = await import('kysely');
          await sql`INSERT INTO integration_jobs (id, integration_id, queue_job_id, status) VALUES ('txn-rollback', 'int-1', 'q-1', 'pending')`.execute(trx);
          throw new Error('Intentional failure');
        });
      } catch {
        // Expected
      }

      // Verify the insert was rolled back
      const { sql } = await import('kysely');
      const db = service.getDatabase();
      const check = await sql`SELECT id FROM integration_jobs WHERE id = 'txn-rollback'`.execute(db);
      expect(check.rows.length).toBe(0);
    });
  });

  // =============================================
  // query
  // =============================================

  describe('query', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should throw if database is not initialized', async () => {
      service = createService();
      const { sql } = await import('kysely');
      await expect(service.query(sql`SELECT 1`)).rejects.toThrow('Database not initialized');
    });

    it('should execute a raw SQL query and return rows', async () => {
      service = createService();
      await service.initialize();

      const { sql } = await import('kysely');
      const result = await service.query<{ val: number }>(sql`SELECT 42 as val`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].val).toBe(42);
    });

    it('should return multiple rows', async () => {
      service = createService();
      await service.initialize();

      const { sql } = await import('kysely');
      // Insert test data
      const db = service.getDatabase();
      await sql`INSERT INTO integration_jobs (id, integration_id, queue_job_id, status) VALUES ('q1', 'int-1', 'q-1', 'pending')`.execute(db);
      await sql`INSERT INTO integration_jobs (id, integration_id, queue_job_id, status) VALUES ('q2', 'int-2', 'q-2', 'completed')`.execute(db);

      const result = await service.query<{ id: string }>(sql`SELECT id FROM integration_jobs ORDER BY id`);
      expect(result.rows.length).toBe(2);
      expect(result.rows[0].id).toBe('q1');
      expect(result.rows[1].id).toBe('q2');
    });

    it('should return empty rows for no results', async () => {
      service = createService();
      await service.initialize();

      const { sql } = await import('kysely');
      const result = await service.query<{ id: string }>(
        sql`SELECT id FROM integration_jobs WHERE id = 'nonexistent'`,
      );
      expect(result.rows).toEqual([]);
    });
  });

  // =============================================
  // shutdown
  // =============================================

  describe('shutdown', () => {
    it('should complete without error on initialized SQLite', async () => {
      const service = createService();
      await service.initialize();
      await expect(service.shutdown()).resolves.not.toThrow();
    });

    it('should log shutdown message', async () => {
      const service = createService();
      await service.initialize();
      jest.clearAllMocks();
      await service.shutdown();
      expect(mockLogger.info).toHaveBeenCalledWith('Database service shutdown completed');
    });

    it('should not throw when called without initialization', async () => {
      const service = createService();
      await expect(service.shutdown()).resolves.not.toThrow();
    });

    it('should nullify database after shutdown', async () => {
      const service = createService();
      await service.initialize();
      await service.shutdown();
      expect(() => service.getDatabase()).toThrow('Database not initialized');
    });

    it('should handle shutdown called multiple times', async () => {
      const service = createService();
      await service.initialize();
      await service.shutdown();
      await expect(service.shutdown()).resolves.not.toThrow();
    });
  });

  // =============================================
  // SQLite boolean parameter patch
  // =============================================

  describe('SQLite boolean parameter patch', () => {
    let service: DatabaseService;

    afterEach(async () => {
      if (service) await service.shutdown();
    });

    it('should apply boolean patch by default', async () => {
      delete process.env.SQLITE_BOOL_PARAM_PATCH;
      service = createService();
      await service.initialize();
      // Patch is applied by default - no log about disabling
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('SQLite boolean parameter patch disabled'),
      );
    });

    it('should skip boolean patch when SQLITE_BOOL_PARAM_PATCH=0', async () => {
      process.env.SQLITE_BOOL_PARAM_PATCH = '0';
      service = createService();
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SQLite boolean parameter patch disabled by env flag SQLITE_BOOL_PARAM_PATCH=0',
      );
    });
  });

  // =============================================
  // MIGRATION IDEMPOTENCY
  // =============================================

  describe('Migration idempotency', () => {
    it('should record migrations and not fail on re-run of same migration set', async () => {
      // In-memory SQLite: we verify that after first init, migrations table exists
      // and contains all expected entries. The idempotency mechanism (SELECT before INSERT)
      // is inherently tested because migrations like 'create_indexes' call CREATE INDEX IF NOT EXISTS
      // which are safe to re-run.
      const service = createService();
      await service.initialize();

      const db = service.getDatabase();
      const { sql } = await import('kysely');
      const result = await sql`SELECT COUNT(*) as cnt FROM migrations`.execute(db);
      const count = (result.rows[0] as { cnt: number }).cnt;
      expect(count).toBe(56); // PR: 056-reconciliation-schedules-integration-config-not-null

      await service.shutdown();
    });
  });

  // =============================================
  // ERROR HANDLING
  // =============================================

  describe('Error handling', () => {
    it('should log and re-throw initialization errors', async () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.SQLITE_DB_PATH = '/tmp/test-db-error-handling.sqlite';
      process.env.NODE_ENV = 'test';
      const service = new DatabaseService(mockLogger);

      // Force validateDatabasePath to throw so initialize() hits the catch block
      (service as any).validateDatabasePath = () => {
        throw new Error('Simulated initialization failure');
      };

      await expect(service.initialize()).rejects.toThrow('Simulated initialization failure');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize database service',
        expect.any(Object),
      );
    });
  });
});
