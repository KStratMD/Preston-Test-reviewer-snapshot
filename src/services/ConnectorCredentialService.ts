import { injectable, inject } from 'inversify';
import { Kysely } from 'kysely';
import type {
  Database,
  ConnectorCredentials,
  NewConnectorCredentials,
  ConnectorCredentialsUpdate,
  NewConnectorCredentialAuditLog,
  ConnectorMetadata
} from '../database/types';
import { CredentialEncryption } from '../utils/CredentialEncryption';
import type { Logger } from '../utils/Logger';
import { DatabaseService } from '../database/DatabaseService';
import { TYPES } from '../inversify/types';

export interface CredentialTestResult {
  success: boolean;
  message: string;
  timestamp: Date;
}

export interface ConnectorCredentialWithDecrypted extends Omit<ConnectorCredentials, 'encrypted_credentials'> {
  credentials: Record<string, unknown>;
}

/**
 * ConnectorCredentialService
 *
 * Manages secure storage and retrieval of connector credentials with:
 * - AES-256-GCM encryption at rest
 * - Complete audit trail for all operations
 * - Multi-tenant isolation (user and organization level)
 * - Environment support (production, sandbox, dev, test)
 * - Connection testing and validation
 *
 * Security Features:
 * - Credentials encrypted before database storage
 * - Automatic audit logging for all access
 * - Sanitized logging (no sensitive data in logs)
 * - Authentication tag verification prevents tampering
 */
@injectable()
export class ConnectorCredentialService {
  private db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) private dbService: DatabaseService,
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.db = this.dbService.getDatabase();
  }

  /**
   * Store connector credentials (encrypted)
   *
   * @param userId - User ID (for multi-tenant isolation)
   * @param connectorId - Connector identifier (e.g., 'netsuite', 'salesforce')
   * @param connectorName - Display name
   * @param credentials - Credential object to encrypt and store
   * @param credentialType - Authentication type (oauth1, oauth2, api_key, etc.)
   * @param environment - Environment (production, sandbox, dev, test)
   * @param organizationId - Optional organization ID
   * @returns Stored credential record (without decrypted credentials)
   */
  async storeCredentials(
    userId: number,
    connectorId: string,
    connectorName: string,
    credentials: Record<string, unknown>,
    credentialType: string,
    environment = 'production',
    organizationId?: number
  ): Promise<ConnectorCredentials> {
    try {
      // Validate encryption key is configured
      if (!CredentialEncryption.isKeyConfigured()) {
        throw new Error(
          'ENCRYPTION_KEY not configured. Set ENCRYPTION_KEY environment variable before storing credentials.'
        );
      }

      // Encrypt credentials
      const encryptedCredentials = CredentialEncryption.encrypt(credentials);

      // Check if credentials already exist for this user/connector/environment
      const existing = await this.db
        .selectFrom('connector_credentials')
        .selectAll()
        .where('user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('environment', '=', environment)
        .executeTakeFirst();

      let result: ConnectorCredentials;

      if (existing) {
        // Update existing credentials
        const oldValuesSanitized = {
          connector_name: existing.connector_name,
          credential_type: existing.credential_type,
          is_active: existing.is_active,
          credentials: '[REDACTED]'
        };

        const newValuesSanitized = {
          connector_name: connectorName,
          credential_type: credentialType,
          is_active: true,
          credentials: '[REDACTED]'
        };

        result = await this.db
          .updateTable('connector_credentials')
          .set({
            connector_name: connectorName,
            encrypted_credentials: encryptedCredentials,
            credential_type: credentialType,
            is_active: true,
            updated_by: userId,
          })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Log update to audit trail
        await this.logAudit({
          credential_id: result.id,
          user_id: userId,
          organization_id: organizationId || null,
          action: 'update',
          action_status: 'success',
          old_values: oldValuesSanitized,
          new_values: newValuesSanitized,
          change_reason: 'Credentials updated via API',
          access_granted: true,
          denial_reason: null,
        });

        this.logger.info(`Updated credentials for connector ${connectorId} (user: ${userId}, env: ${environment})`);
      } else {
        // Insert new credentials
        const newRecord: NewConnectorCredentials = {
          user_id: userId,
          organization_id: organizationId || null,
          connector_id: connectorId,
          connector_name: connectorName,
          environment,
          encrypted_credentials: encryptedCredentials,
          credential_type: credentialType,
          encryption_version: 'v1',
          is_active: true,
          last_tested_at: null,
          last_test_status: null,
          last_test_error: null,
          last_used_at: null,
          expires_at: null,
          created_by: userId,
          updated_by: userId,
        };

        result = await this.db
          .insertInto('connector_credentials')
          .values(newRecord)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Log creation to audit trail
        await this.logAudit({
          credential_id: result.id,
          user_id: userId,
          organization_id: organizationId || null,
          action: 'create',
          action_status: 'success',
          old_values: null,
          new_values: {
            connector_id: connectorId,
            connector_name: connectorName,
            credential_type: credentialType,
            environment,
            credentials: '[REDACTED]'
          },
          change_reason: 'Credentials created via API',
          access_granted: true,
          denial_reason: null,
        });

        this.logger.info(`Stored credentials for connector ${connectorId} (user: ${userId}, env: ${environment})`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to store credentials for ${connectorId}: ${errorMessage}`);

      // Log failed attempt to audit trail
      await this.logAudit({
        credential_id: null,
        user_id: userId,
        organization_id: organizationId || null,
        action: 'create',
        action_status: 'failed',
        old_values: null,
        new_values: {
          connector_id: connectorId,
          credential_type: credentialType,
          environment,
          credentials: '[REDACTED]'
        },
        change_reason: `Failed: ${errorMessage}`,
        access_granted: false,
        denial_reason: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Retrieve connector credentials (decrypted)
   *
   * @param userId - User ID
   * @param connectorId - Connector identifier
   * @param environment - Environment (default: production)
   * @returns Decrypted credentials or null if not found
   */
  async getCredentials(
    userId: number,
    connectorId: string,
    environment = 'production'
  ): Promise<ConnectorCredentialWithDecrypted | null> {
    try {
      const record = await this.db
        .selectFrom('connector_credentials')
        .selectAll()
        .where('user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('environment', '=', environment)
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (!record) {
        this.logger.debug(`No credentials found for ${connectorId} (user: ${userId}, env: ${environment})`);
        return null;
      }

      // Decrypt credentials
      const decryptedCredentials = CredentialEncryption.decrypt(record.encrypted_credentials);

      // Update last_used_at
      await this.db
        .updateTable('connector_credentials')
        .set({ last_used_at: new Date() })
        .where('id', '=', record.id)
        .execute();

      // Log access to audit trail
      await this.logAudit({
        credential_id: record.id,
        user_id: userId,
        organization_id: record.organization_id,
        action: 'access',
        action_status: 'success',
        old_values: null,
        new_values: null,
        change_reason: 'Credentials accessed via API',
        access_granted: true,
        denial_reason: null,
      });

      this.logger.debug(`Retrieved credentials for ${connectorId} (user: ${userId}, env: ${environment})`);

      const { encrypted_credentials, ...rest } = record;
      return {
        ...rest,
        credentials: decryptedCredentials
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to retrieve credentials for ${connectorId}: ${errorMessage}`);

      // Log failed access to audit trail
      await this.logAudit({
        credential_id: null,
        user_id: userId,
        organization_id: null,
        action: 'access',
        action_status: 'failed',
        old_values: null,
        new_values: null,
        change_reason: `Failed: ${errorMessage}`,
        access_granted: false,
        denial_reason: errorMessage,
      });

      throw error;
    }
  }

  /**
   * List all connector credentials for a user (without decrypted credentials)
   *
   * @param userId - User ID
   * @param activeOnly - Only return active credentials (default: true)
   * @returns Array of credential records (encrypted credentials excluded)
   */
  async listCredentials(
    userId: number,
    activeOnly = true
  ): Promise<Omit<ConnectorCredentials, 'encrypted_credentials'>[]> {
    try {
      let query = this.db
        .selectFrom('connector_credentials')
        .select([
          'id', 'user_id', 'organization_id', 'connector_id', 'connector_name',
          'environment', 'credential_type', 'encryption_version', 'is_active',
          'last_tested_at', 'last_test_status', 'last_test_error',
          'last_used_at', 'expires_at', 'created_at', 'updated_at',
          'created_by', 'updated_by'
        ])
        .where('user_id', '=', userId);

      if (activeOnly) {
        query = query.where('is_active', '=', true);
      }

      const credentials = await query
        .orderBy('connector_id', 'asc')
        .orderBy('environment', 'asc')
        .execute();

      this.logger.debug(`Listed ${credentials.length} credentials for user ${userId}`);

      return credentials;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to list credentials for user ${userId}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Delete connector credentials
   *
   * @param userId - User ID (for authorization)
   * @param connectorId - Connector identifier
   * @param environment - Environment
   * @returns True if deleted, false if not found
   */
  async deleteCredentials(
    userId: number,
    connectorId: string,
    environment = 'production'
  ): Promise<boolean> {
    try {
      // Get existing record for audit log
      const existing = await this.db
        .selectFrom('connector_credentials')
        .selectAll()
        .where('user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('environment', '=', environment)
        .executeTakeFirst();

      if (!existing) {
        this.logger.debug(`No credentials to delete for ${connectorId} (user: ${userId}, env: ${environment})`);
        return false;
      }

      // Delete the record (cascade will delete audit logs)
      await this.db
        .deleteFrom('connector_credentials')
        .where('id', '=', existing.id)
        .execute();

      // Log deletion to audit trail (before cascade deletes it)
      await this.logAudit({
        credential_id: existing.id,
        user_id: userId,
        organization_id: existing.organization_id,
        action: 'delete',
        action_status: 'success',
        old_values: {
          connector_id: connectorId,
          connector_name: existing.connector_name,
          credential_type: existing.credential_type,
          environment,
          credentials: '[REDACTED]'
        },
        new_values: null,
        change_reason: 'Credentials deleted via API',
        access_granted: true,
        denial_reason: null,
      });

      this.logger.info(`Deleted credentials for ${connectorId} (user: ${userId}, env: ${environment})`);

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to delete credentials for ${connectorId}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Test connector credentials by attempting to decrypt and validate
   *
   * @param userId - User ID
   * @param connectorId - Connector identifier
   * @param environment - Environment
   * @returns Test result with success status and message
   */
  async testCredentials(
    userId: number,
    connectorId: string,
    environment = 'production'
  ): Promise<CredentialTestResult> {
    const timestamp = new Date();

    try {
      const record = await this.db
        .selectFrom('connector_credentials')
        .selectAll()
        .where('user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('environment', '=', environment)
        .executeTakeFirst();

      if (!record) {
        return {
          success: false,
          message: `No credentials found for ${connectorId} in ${environment} environment`,
          timestamp
        };
      }

      // Try to decrypt credentials
      try {
        const decryptedCredentials = CredentialEncryption.decrypt(record.encrypted_credentials);

        // Validate that required fields exist (basic validation)
        if (!decryptedCredentials || Object.keys(decryptedCredentials).length === 0) {
          throw new Error('Decrypted credentials are empty');
        }

        // Update test status
        await this.db
          .updateTable('connector_credentials')
          .set({
            last_tested_at: timestamp,
            last_test_status: 'success',
            last_test_error: null
          })
          .where('id', '=', record.id)
          .execute();

        // Log test to audit trail
        await this.logAudit({
          credential_id: record.id,
          user_id: userId,
          organization_id: record.organization_id,
          action: 'test',
          action_status: 'success',
          old_values: null,
          new_values: null,
          change_reason: 'Credentials tested successfully',
          access_granted: true,
          denial_reason: null,
        });

        this.logger.info(`Credentials test successful for ${connectorId} (user: ${userId}, env: ${environment})`);

        return {
          success: true,
          message: 'Credentials are valid and can be decrypted',
          timestamp
        };
      } catch (decryptError) {
        const errorMessage = decryptError instanceof Error ? decryptError.message : String(decryptError);

        // Update test status with error
        await this.db
          .updateTable('connector_credentials')
          .set({
            last_tested_at: timestamp,
            last_test_status: 'failed',
            last_test_error: errorMessage
          })
          .where('id', '=', record.id)
          .execute();

        // Log failed test to audit trail
        await this.logAudit({
          credential_id: record.id,
          user_id: userId,
          organization_id: record.organization_id,
          action: 'test',
          action_status: 'failed',
          old_values: null,
          new_values: null,
          change_reason: `Credentials test failed: ${errorMessage}`,
          access_granted: false,
          denial_reason: errorMessage,
        });

        this.logger.warn(`Credentials test failed for ${connectorId}: ${errorMessage}`);

        return {
          success: false,
          message: `Credential decryption failed: ${errorMessage}`,
          timestamp
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Credentials test error for ${connectorId}: ${errorMessage}`);

      return {
        success: false,
        message: `Test failed: ${errorMessage}`,
        timestamp
      };
    }
  }

  /**
   * Get connector metadata
   *
   * @param connectorId - Connector identifier
   * @returns Connector metadata or null if not found
   */
  async getConnectorMetadata(connectorId: string): Promise<ConnectorMetadata | null> {
    try {
      const metadata = await this.db
        .selectFrom('connector_metadata')
        .selectAll()
        .where('connector_id', '=', connectorId)
        .where('is_active', '=', true)
        .executeTakeFirst();

      return metadata || null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get metadata for ${connectorId}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * List all available connectors (from metadata)
   *
   * @param activeOnly - Only return active connectors (default: true)
   * @returns Array of connector metadata
   */
  async listConnectors(activeOnly = true): Promise<ConnectorMetadata[]> {
    try {
      let query = this.db
        .selectFrom('connector_metadata')
        .selectAll();

      if (activeOnly) {
        query = query.where('is_active', '=', true);
      }

      const connectors = await query
        .orderBy('connector_name', 'asc')
        .execute();

      return connectors;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to list connectors: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Log an audit event
   *
   * @param auditData - Audit log entry data
   * @private
   */
  private async logAudit(auditData: Omit<NewConnectorCredentialAuditLog, 'ip_address' | 'user_agent' | 'request_id' | 'session_id'>): Promise<void> {
    try {
      await this.db
        .insertInto('connector_credential_audit_log')
        .values({
          ...auditData,
          ip_address: null,
          user_agent: null,
          request_id: null,
          session_id: null,
        })
        .execute();
    } catch (error) {
      // Don't throw on audit log failures - just log the error
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to write audit log: ${errorMessage}`);
    }
  }
}
