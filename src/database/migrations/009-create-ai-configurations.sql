-- Migration: Create AI Provider Configuration Tables
-- Version: 009
-- Date: 2025-09-22
-- Description: Secure backend storage for AI provider configurations with task-specific model selection

-- AI Provider Configurations
-- Stores encrypted API keys and provider settings
CREATE TABLE IF NOT EXISTS ai_provider_configs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    organization_id INTEGER,
    provider_type VARCHAR(50) NOT NULL, -- 'openai', 'claude', 'gemini', 'lmstudio', 'rule-based'
    provider_name VARCHAR(100) NOT NULL,
    encrypted_api_key TEXT, -- AES-256 encrypted (null for rule-based/local)
    endpoint_url VARCHAR(500), -- For LMStudio and custom endpoints
    is_active BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,
    configuration JSONB DEFAULT '{}', -- Provider-specific settings
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by INTEGER,

    CONSTRAINT unique_user_provider UNIQUE(user_id, provider_type),
    CONSTRAINT unique_default_provider UNIQUE(user_id, is_default) WHERE is_default = true
);

-- Task-Specific AI Model Configurations
-- Allows different models for different AI tasks
CREATE TABLE IF NOT EXISTS ai_task_model_configs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    organization_id INTEGER,
    task_type VARCHAR(100) NOT NULL, -- 'field_mapping', 'quality_assessment', 'data_validation', 'transformation_suggestion'
    provider_config_id INTEGER REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
    model_version VARCHAR(100) NOT NULL, -- 'gpt-4o', 'claude-3-5-sonnet-20241022', etc.
    model_parameters JSONB DEFAULT '{}', -- temperature, max_tokens, etc.
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 1, -- For fallback ordering
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT unique_user_task_priority UNIQUE(user_id, task_type, priority)
);

-- AI Usage Tracking
-- Track token consumption and costs per task
CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    organization_id INTEGER,
    provider_config_id INTEGER REFERENCES ai_provider_configs(id),
    task_model_config_id INTEGER REFERENCES ai_task_model_configs(id),
    task_type VARCHAR(100) NOT NULL,
    provider_type VARCHAR(50) NOT NULL,
    model_version VARCHAR(100) NOT NULL,

    -- Usage metrics
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    estimated_cost DECIMAL(10,6) DEFAULT 0,

    -- Request details
    request_type VARCHAR(100), -- 'suggest', 'assess_quality', 'validate'
    session_id VARCHAR(100),
    execution_time_ms INTEGER,
    success BOOLEAN DEFAULT true,
    error_message TEXT,

    -- Data volume
    records_processed INTEGER DEFAULT 0,
    fields_analyzed INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT NOW()
);

-- AI Configuration Audit Log
-- Track all configuration changes for compliance
CREATE TABLE IF NOT EXISTS ai_config_audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    organization_id INTEGER,
    config_type VARCHAR(50) NOT NULL, -- 'provider', 'task_model'
    config_id INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL, -- 'create', 'update', 'delete', 'activate', 'deactivate'
    old_values JSONB,
    new_values JSONB,
    change_reason TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_user_active ON ai_provider_configs(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_provider_configs_org_active ON ai_provider_configs(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_task_model_configs_user_task ON ai_task_model_configs(user_id, task_type, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_date ON ai_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_org_date ON ai_usage_logs(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_session ON ai_usage_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_config_audit_user_date ON ai_config_audit_log(user_id, created_at);

-- Functions for automatic timestamping
CREATE OR REPLACE FUNCTION update_ai_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic timestamping
CREATE TRIGGER ai_provider_configs_update_timestamp
    BEFORE UPDATE ON ai_provider_configs
    FOR EACH ROW EXECUTE FUNCTION update_ai_config_timestamp();

CREATE TRIGGER ai_task_model_configs_update_timestamp
    BEFORE UPDATE ON ai_task_model_configs
    FOR EACH ROW EXECUTE FUNCTION update_ai_config_timestamp();

-- Insert default rule-based provider for all existing users (if any)
INSERT INTO ai_provider_configs (user_id, provider_type, provider_name, is_active, is_default, configuration)
SELECT
    1 as user_id,
    'rule-based' as provider_type,
    'Rule-Based Engine' as provider_name,
    true as is_active,
    true as is_default,
    '{"description": "Deterministic field mapping using semantic analysis"}' as configuration
WHERE NOT EXISTS (SELECT 1 FROM ai_provider_configs WHERE provider_type = 'rule-based');

-- Insert default task model configurations for rule-based provider
INSERT INTO ai_task_model_configs (user_id, task_type, provider_config_id, model_version, model_parameters, priority)
SELECT
    1 as user_id,
    task_type,
    (SELECT id FROM ai_provider_configs WHERE provider_type = 'rule-based' LIMIT 1) as provider_config_id,
    'rule-based-v1' as model_version,
    '{"algorithm": "semantic_similarity", "confidence_threshold": 0.7}' as model_parameters,
    1 as priority
FROM (VALUES
    ('field_mapping'),
    ('quality_assessment'),
    ('data_validation'),
    ('transformation_suggestion')
) AS tasks(task_type)
WHERE NOT EXISTS (
    SELECT 1 FROM ai_task_model_configs
    WHERE task_type = tasks.task_type AND user_id = 1
);

-- Comments for documentation
COMMENT ON TABLE ai_provider_configs IS 'Stores AI provider configurations with encrypted API keys';
COMMENT ON TABLE ai_task_model_configs IS 'Maps specific AI models to different task types for intelligent routing';
COMMENT ON TABLE ai_usage_logs IS 'Tracks AI usage for cost monitoring and analytics';
COMMENT ON TABLE ai_config_audit_log IS 'Audit trail for all AI configuration changes';

COMMENT ON COLUMN ai_provider_configs.encrypted_api_key IS 'AES-256 encrypted API key, null for local/rule-based providers';
COMMENT ON COLUMN ai_task_model_configs.task_type IS 'Type of AI task: field_mapping, quality_assessment, data_validation, transformation_suggestion';
COMMENT ON COLUMN ai_task_model_configs.priority IS 'Priority for fallback ordering, 1 = highest priority';
COMMENT ON COLUMN ai_usage_logs.estimated_cost IS 'Estimated cost in USD based on provider pricing';