import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_ai_configurations_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      // SQLite-compatible schema - Execute each statement separately for better-sqlite3

      // AI Provider Configurations Table
      await sql`
        CREATE TABLE IF NOT EXISTS ai_provider_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          provider_type TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          encrypted_api_key TEXT,
          endpoint_url TEXT,
          is_active INTEGER DEFAULT 1,
          is_default INTEGER DEFAULT 0,
          configuration TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, provider_type)
        )
      `.execute(db);

      // AI Task Model Configurations Table
      await sql`
        CREATE TABLE IF NOT EXISTS ai_task_model_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          task_type TEXT NOT NULL,
          provider_config_id INTEGER NOT NULL REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
          model_version TEXT NOT NULL,
          model_parameters TEXT DEFAULT '{}',
          is_active INTEGER DEFAULT 1,
          priority INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, task_type, priority)
        )
      `.execute(db);

      // AI Usage Logs Table
      await sql`
        CREATE TABLE IF NOT EXISTS ai_usage_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          provider_config_id INTEGER REFERENCES ai_provider_configs(id),
          task_model_config_id INTEGER REFERENCES ai_task_model_configs(id),
          task_type TEXT NOT NULL,
          provider_type TEXT NOT NULL,
          model_version TEXT NOT NULL,
          prompt_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          estimated_cost REAL DEFAULT 0.00,
          request_type TEXT NOT NULL,
          session_id TEXT,
          execution_time_ms INTEGER DEFAULT 0,
          success INTEGER DEFAULT 1,
          error_message TEXT,
          records_processed INTEGER DEFAULT 0,
          fields_analyzed INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);

      // AI Configuration Audit Log Table
      await sql`
        CREATE TABLE IF NOT EXISTS ai_config_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          config_type TEXT NOT NULL,
          config_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          old_values TEXT,
          new_values TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);

      // Create indexes for AI tables - Execute separately for SQLite
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_user_id ON ai_provider_configs(user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_type ON ai_provider_configs(provider_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_active ON ai_provider_configs(is_active)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_ai_task_configs_user_id ON ai_task_model_configs(user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_task_configs_task_type ON ai_task_model_configs(task_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_task_configs_provider ON ai_task_model_configs(provider_config_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_task_configs_priority ON ai_task_model_configs(task_type, priority)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id ON ai_usage_logs(user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_task_type ON ai_usage_logs(task_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_provider ON ai_usage_logs(provider_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_session_id ON ai_usage_logs(session_id)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_ai_audit_log_user_id ON ai_config_audit_log(user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_ai_audit_log_config ON ai_config_audit_log(config_type, config_id)`.execute(db);
    } else {
      // PostgreSQL schema
      await sql`
        -- AI Provider Configurations Table
        CREATE TABLE IF NOT EXISTS ai_provider_configs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          provider_type VARCHAR(50) NOT NULL,
          provider_name VARCHAR(255) NOT NULL,
          encrypted_api_key TEXT,
          endpoint_url VARCHAR(500),
          is_active BOOLEAN DEFAULT true,
          is_default BOOLEAN DEFAULT false,
          configuration JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, provider_type)
        );

        -- AI Task Model Configurations Table
        CREATE TABLE IF NOT EXISTS ai_task_model_configs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          task_type VARCHAR(50) NOT NULL,
          provider_config_id INTEGER NOT NULL REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
          model_version VARCHAR(255) NOT NULL,
          model_parameters JSONB DEFAULT '{}',
          is_active BOOLEAN DEFAULT true,
          priority INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, task_type, priority)
        );

        -- AI Usage Logs Table
        CREATE TABLE IF NOT EXISTS ai_usage_logs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          organization_id INTEGER,
          provider_config_id INTEGER REFERENCES ai_provider_configs(id),
          task_model_config_id INTEGER REFERENCES ai_task_model_configs(id),
          task_type VARCHAR(50) NOT NULL,
          provider_type VARCHAR(50) NOT NULL,
          model_version VARCHAR(255) NOT NULL,
          prompt_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          estimated_cost DECIMAL(10,6) DEFAULT 0.00,
          request_type VARCHAR(100) NOT NULL,
          session_id VARCHAR(255),
          execution_time_ms INTEGER DEFAULT 0,
          success BOOLEAN DEFAULT true,
          error_message TEXT,
          records_processed INTEGER DEFAULT 0,
          fields_analyzed INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );

        -- AI Configuration Audit Log Table
        CREATE TABLE IF NOT EXISTS ai_config_audit_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          config_type VARCHAR(50) NOT NULL,
          config_id INTEGER NOT NULL,
          action VARCHAR(50) NOT NULL,
          old_values JSONB,
          new_values JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );

        -- Create indexes for AI tables
        CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_user_id ON ai_provider_configs(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_type ON ai_provider_configs(provider_type);
        CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_active ON ai_provider_configs(is_active);

        CREATE INDEX IF NOT EXISTS idx_ai_task_configs_user_id ON ai_task_model_configs(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_task_configs_task_type ON ai_task_model_configs(task_type);
        CREATE INDEX IF NOT EXISTS idx_ai_task_configs_provider ON ai_task_model_configs(provider_config_id);
        CREATE INDEX IF NOT EXISTS idx_ai_task_configs_priority ON ai_task_model_configs(task_type, priority);

        CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id ON ai_usage_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_task_type ON ai_usage_logs(task_type);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_provider ON ai_usage_logs(provider_type);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_session_id ON ai_usage_logs(session_id);

        CREATE INDEX IF NOT EXISTS idx_ai_audit_log_user_id ON ai_config_audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_log_config ON ai_config_audit_log(config_type, config_id);
      `.execute(db);
    }
  },
};
