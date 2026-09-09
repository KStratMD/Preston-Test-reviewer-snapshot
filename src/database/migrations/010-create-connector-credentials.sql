-- Migration: Create Connector Credential Storage Tables
-- Version: 010
-- Date: 2025-11-04
-- Description: Secure encrypted storage for connector credentials with audit trail

-- Connector Credentials
-- Stores encrypted credentials for external system connectors
CREATE TABLE IF NOT EXISTS connector_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL DEFAULT 1,
    organization_id INTEGER,

    -- Connector identification
    connector_id VARCHAR(100) NOT NULL,  -- 'netsuite', 'salesforce', 'dynamics365', etc.
    connector_name VARCHAR(200) NOT NULL,
    environment VARCHAR(50) DEFAULT 'production',  -- 'production', 'sandbox', 'dev', 'test'

    -- Encrypted credentials (AES-256-GCM)
    encrypted_credentials TEXT NOT NULL,  -- JSON object encrypted with AES-256-GCM
    credential_type VARCHAR(50) NOT NULL,  -- 'oauth1', 'oauth2', 'api_key', 'basic', 'custom'
    encryption_version VARCHAR(20) DEFAULT 'v1',  -- For future encryption algorithm changes

    -- Metadata
    is_active BOOLEAN DEFAULT true,
    last_tested_at TIMESTAMP,
    last_test_status VARCHAR(50),  -- 'success', 'failed', 'pending'
    last_test_error TEXT,
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,  -- For credentials that expire

    -- Audit
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by INTEGER,
    updated_by INTEGER,

    -- Constraints
    CONSTRAINT unique_user_connector_env UNIQUE(user_id, connector_id, environment),
    CONSTRAINT valid_credential_type CHECK (credential_type IN ('oauth1', 'oauth2', 'api_key', 'basic', 'custom')),
    CONSTRAINT valid_environment CHECK (environment IN ('production', 'sandbox', 'dev', 'test', 'staging'))
);

-- Connector Credential Audit Log
-- Complete audit trail for all credential operations
CREATE TABLE IF NOT EXISTS connector_credential_audit_log (
    id SERIAL PRIMARY KEY,
    credential_id INTEGER REFERENCES connector_credentials(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    organization_id INTEGER,

    -- Action details
    action VARCHAR(50) NOT NULL,  -- 'create', 'update', 'delete', 'access', 'test', 'decrypt'
    action_status VARCHAR(50) DEFAULT 'success',  -- 'success', 'failed', 'denied'

    -- Change tracking
    old_values JSONB,  -- Snapshot before change (encrypted fields redacted)
    new_values JSONB,  -- Snapshot after change (encrypted fields redacted)
    change_reason TEXT,

    -- Request context
    ip_address INET,
    user_agent TEXT,
    request_id VARCHAR(100),
    session_id VARCHAR(100),

    -- Security
    access_granted BOOLEAN DEFAULT true,
    denial_reason TEXT,

    created_at TIMESTAMP DEFAULT NOW(),

    CONSTRAINT valid_action CHECK (action IN ('create', 'update', 'delete', 'access', 'test', 'decrypt', 'rotate'))
);

-- Connector Metadata
-- Store connector-specific metadata and capabilities
CREATE TABLE IF NOT EXISTS connector_metadata (
    id SERIAL PRIMARY KEY,
    connector_id VARCHAR(100) UNIQUE NOT NULL,
    connector_name VARCHAR(200) NOT NULL,
    connector_type VARCHAR(50) NOT NULL,  -- 'erp', 'crm', 'accounting', 'ecommerce', etc.

    -- Configuration
    supported_auth_types JSONB DEFAULT '[]',  -- ['oauth1', 'oauth2', 'api_key']
    required_credential_fields JSONB DEFAULT '[]',  -- ['accountId', 'consumerKey', ...]
    optional_credential_fields JSONB DEFAULT '[]',
    default_credential_type VARCHAR(50),

    -- Capabilities
    supports_sandbox BOOLEAN DEFAULT false,
    supports_multi_environment BOOLEAN DEFAULT false,
    connection_test_endpoint VARCHAR(500),
    documentation_url VARCHAR(500),

    -- Metadata
    vendor_name VARCHAR(200),
    vendor_website VARCHAR(500),
    logo_url VARCHAR(500),
    description TEXT,

    -- Status
    is_active BOOLEAN DEFAULT true,
    is_beta BOOLEAN DEFAULT false,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_connector_credentials_user_active
    ON connector_credentials(user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_connector_credentials_org_active
    ON connector_credentials(organization_id, is_active);

CREATE INDEX IF NOT EXISTS idx_connector_credentials_connector
    ON connector_credentials(connector_id, environment, is_active);

CREATE INDEX IF NOT EXISTS idx_connector_credentials_expires
    ON connector_credentials(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connector_credential_audit_credential
    ON connector_credential_audit_log(credential_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connector_credential_audit_user
    ON connector_credential_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connector_credential_audit_action
    ON connector_credential_audit_log(action, created_at DESC);

-- Functions for automatic timestamping
CREATE OR REPLACE FUNCTION update_connector_credential_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_connector_metadata_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic timestamping
CREATE TRIGGER connector_credentials_update_timestamp
    BEFORE UPDATE ON connector_credentials
    FOR EACH ROW EXECUTE FUNCTION update_connector_credential_timestamp();

CREATE TRIGGER connector_metadata_update_timestamp
    BEFORE UPDATE ON connector_metadata
    FOR EACH ROW EXECUTE FUNCTION update_connector_metadata_timestamp();

-- Insert default connector metadata for NetSuite
INSERT INTO connector_metadata (
    connector_id, connector_name, connector_type,
    supported_auth_types, required_credential_fields, default_credential_type,
    supports_sandbox, supports_multi_environment,
    vendor_name, description, is_active
) VALUES (
    'netsuite',
    'NetSuite ERP',
    'erp',
    '["oauth1"]'::jsonb,
    '["accountId", "consumerKey", "consumerSecret", "tokenId", "tokenSecret"]'::jsonb,
    'oauth1',
    true,
    true,
    'Oracle NetSuite',
    'NetSuite ERP and CRM system with OAuth 1.0 authentication',
    true
) ON CONFLICT (connector_id) DO NOTHING;

-- Insert default connector metadata for Salesforce
INSERT INTO connector_metadata (
    connector_id, connector_name, connector_type,
    supported_auth_types, required_credential_fields, default_credential_type,
    supports_sandbox, supports_multi_environment,
    vendor_name, description, is_active
) VALUES (
    'salesforce',
    'Salesforce CRM',
    'crm',
    '["oauth2"]'::jsonb,
    '["clientId", "clientSecret", "username", "password", "securityToken"]'::jsonb,
    'oauth2',
    true,
    true,
    'Salesforce',
    'Salesforce CRM with OAuth 2.0 authentication',
    true
) ON CONFLICT (connector_id) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE connector_credentials IS 'Stores encrypted credentials for external system connectors with AES-256-GCM encryption';
COMMENT ON TABLE connector_credential_audit_log IS 'Complete audit trail for all credential access and modifications';
COMMENT ON TABLE connector_metadata IS 'Connector capability metadata and configuration requirements';

COMMENT ON COLUMN connector_credentials.encrypted_credentials IS 'AES-256-GCM encrypted JSON containing all credential fields';
COMMENT ON COLUMN connector_credentials.credential_type IS 'Authentication type: oauth1, oauth2, api_key, basic, or custom';
COMMENT ON COLUMN connector_credentials.encryption_version IS 'Encryption algorithm version for future migration support';
COMMENT ON COLUMN connector_credential_audit_log.action IS 'Operation performed: create, update, delete, access, test, decrypt, rotate';
COMMENT ON COLUMN connector_metadata.required_credential_fields IS 'JSON array of required field names for this connector type';
