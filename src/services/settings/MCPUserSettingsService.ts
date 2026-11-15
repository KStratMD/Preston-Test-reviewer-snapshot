/**
 * MCP User Settings Service
 *
 * Manages user-scoped NetSuite MCP feature flag preferences with database persistence.
 * Enables individual users to enable/disable MCP features for A/B testing and experimentation.
 *
 * Features:
 * - User-scoped MCP schema discovery toggle
 * - User-scoped MCP AI context enhancement toggle
 * - User-scoped MCP validation toggle (Phase 4)
 * - Database persistence (survives server restarts)
 * - Fast lookups via user_id index
 * - Fallback to environment variables when user settings not found
 *
 * Usage:
 * ```typescript
 * const settings = await mcpSettingsService.getUserSettings('user123');
 * if (settings.mcp_schema_enabled) {
 *   // Use MCP schema discovery
 * }
 * ```
 */

import { injectable, inject } from 'inversify';
import type { Kysely, RawBuilder } from 'kysely';
import { sql } from 'kysely';
import type { Logger } from '../../utils/Logger';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import { TYPES } from '../../inversify/types';
import {
  isNetSuiteMCPSchemaEnabled,
  isNetSuiteMCPAIContextEnabled,
  isNetSuiteMCPValidationEnabled,
  isMCPGatewayEnabled,
  isBusinessCentralMCPEnabled,
} from '../../config/runtimeFlags';

/**
 * MCP User Settings (Database Row)
 */
export interface MCPUserSettings {
  id: number;
  user_id: string;
  mcp_schema_enabled: boolean;
  mcp_ai_context_enabled: boolean;
  mcp_validation_enabled: boolean;
  mcp_gateway_enabled: boolean;
  mcp_bc_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  is_explicit: boolean; // true = user has DB row, false = using env defaults
}

/**
 * MCP Settings Update Request
 */
export interface MCPSettingsUpdate {
  mcp_schema_enabled?: boolean;
  mcp_ai_context_enabled?: boolean;
  mcp_validation_enabled?: boolean;
  mcp_gateway_enabled?: boolean;
  mcp_bc_enabled?: boolean;
}

type MCPUserSettingsRow = MCPUserSettings & {
  mcp_gateway_enabled?: unknown;
  mcp_bc_enabled?: unknown;
};

/**
 * MCP User Settings Service
 */
@injectable()
export class MCPUserSettingsService {
  private db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) private dbService: DatabaseService,
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.db = this.dbService.getDatabase();
  }

  private normalizeBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1';
    }
    return false;
  }

  /**
   * Get user's MCP settings
   * Returns user's saved settings or defaults from environment variables
   *
   * @param userId - User identifier
   * @returns User's MCP settings (database values or env defaults)
   */
  async getUserSettings(userId: string): Promise<MCPUserSettings> {
    try {
      // Check if user has custom settings
      const result = await sql`
        SELECT * FROM mcp_user_settings WHERE user_id = ${userId}
      `.execute(this.db);

      const row = result.rows[0] as MCPUserSettingsRow | undefined;

      if (row) {
        // Convert INTEGER to boolean for SQLite compatibility
        return {
          ...row,
          mcp_schema_enabled: Boolean(row.mcp_schema_enabled),
          mcp_ai_context_enabled: Boolean(row.mcp_ai_context_enabled),
          mcp_validation_enabled: Boolean(row.mcp_validation_enabled),
          mcp_gateway_enabled: this.normalizeBoolean(row.mcp_gateway_enabled),
          mcp_bc_enabled: this.normalizeBoolean(row.mcp_bc_enabled),
          is_explicit: true // User has explicit DB settings
        };
      }

      // No user settings found - return defaults from env
      const now = new Date();
      return {
        id: 0,
        user_id: userId,
        mcp_schema_enabled: isNetSuiteMCPSchemaEnabled(),
        mcp_ai_context_enabled: isNetSuiteMCPAIContextEnabled(),
        mcp_validation_enabled: isNetSuiteMCPValidationEnabled(),
        mcp_gateway_enabled: isMCPGatewayEnabled(),
        mcp_bc_enabled: isBusinessCentralMCPEnabled(),
        created_at: now,
        updated_at: now,
        is_explicit: false // Using environment defaults
      };
    } catch (error) {
      this.logger.error('Failed to get user MCP settings', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Update user's MCP settings
   * Creates new settings row if user doesn't have one yet
   *
   * @param userId - User identifier
   * @param settings - Settings to update (partial update supported)
   * @returns Updated settings
   */
  async updateUserSettings(
    userId: string,
    settings: MCPSettingsUpdate
  ): Promise<MCPUserSettings> {
    try {
      // Check if user already has settings
      const existing = await sql`
        SELECT id FROM mcp_user_settings WHERE user_id = ${userId}
      `.execute(this.db);

      if (existing.rows.length > 0) {
        // Update existing settings
        // Check if any settings need to be updated
        const hasUpdates =
          typeof settings.mcp_schema_enabled === 'boolean' ||
          typeof settings.mcp_ai_context_enabled === 'boolean' ||
          typeof settings.mcp_validation_enabled === 'boolean' ||
          typeof settings.mcp_gateway_enabled === 'boolean' ||
          typeof settings.mcp_bc_enabled === 'boolean';

        if (hasUpdates) {
          // Build SET clause with interpolated values using Kysely tagged templates
          const setClauses: RawBuilder<unknown>[] = [];

          if (typeof settings.mcp_schema_enabled === 'boolean') {
            setClauses.push(sql`mcp_schema_enabled = ${settings.mcp_schema_enabled ? 1 : 0}`);
          }

          if (typeof settings.mcp_ai_context_enabled === 'boolean') {
            setClauses.push(sql`mcp_ai_context_enabled = ${settings.mcp_ai_context_enabled ? 1 : 0}`);
          }

          if (typeof settings.mcp_validation_enabled === 'boolean') {
            setClauses.push(sql`mcp_validation_enabled = ${settings.mcp_validation_enabled ? 1 : 0}`);
          }

          if (typeof settings.mcp_gateway_enabled === 'boolean') {
            setClauses.push(sql`mcp_gateway_enabled = ${settings.mcp_gateway_enabled ? 1 : 0}`);
          }

          if (typeof settings.mcp_bc_enabled === 'boolean') {
            setClauses.push(sql`mcp_bc_enabled = ${settings.mcp_bc_enabled ? 1 : 0}`);
          }

          setClauses.push(sql`updated_at = ${new Date().toISOString()}`);

          // Combine clauses with commas
          let query = sql`UPDATE mcp_user_settings SET `;
          for (let i = 0; i < setClauses.length; i++) {
            if (i > 0) query = sql`${query}, `;
            query = sql`${query}${setClauses[i]}`;
          }
          query = sql`${query} WHERE user_id = ${userId}`;

          await query.execute(this.db);

          this.logger.info('Updated MCP user settings', { userId, settings });
        }
      } else {
        // Insert new settings
        const schemaEnabled = settings.mcp_schema_enabled ?? isNetSuiteMCPSchemaEnabled();
        const aiContextEnabled = settings.mcp_ai_context_enabled ?? isNetSuiteMCPAIContextEnabled();
        const validationEnabled = settings.mcp_validation_enabled ?? isNetSuiteMCPValidationEnabled();
        const gatewayEnabled = settings.mcp_gateway_enabled ?? isMCPGatewayEnabled();
        const bcEnabled = settings.mcp_bc_enabled ?? isBusinessCentralMCPEnabled();

        await sql`
          INSERT INTO mcp_user_settings (
            user_id,
            mcp_schema_enabled,
            mcp_ai_context_enabled,
            mcp_validation_enabled,
            mcp_gateway_enabled,
            mcp_bc_enabled
          ) VALUES (
            ${userId},
            ${schemaEnabled ? 1 : 0},
            ${aiContextEnabled ? 1 : 0},
            ${validationEnabled ? 1 : 0},
            ${gatewayEnabled ? 1 : 0},
            ${bcEnabled ? 1 : 0}
          )
        `.execute(this.db);

        this.logger.info('Created MCP user settings', { userId, settings });
      }

      // Return updated settings
      return await this.getUserSettings(userId);
    } catch (error) {
      this.logger.error('Failed to update user MCP settings', {
        userId,
        settings,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Reset user's MCP settings to environment defaults
   * Deletes user's custom settings row
   *
   * @param userId - User identifier
   */
  async resetToDefaults(userId: string): Promise<void> {
    try {
      await sql`
        DELETE FROM mcp_user_settings WHERE user_id = ${userId}
      `.execute(this.db);

      this.logger.info('Reset MCP settings to defaults', { userId });
    } catch (error) {
      this.logger.error('Failed to reset MCP settings', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Check if specific MCP feature is enabled for user
   * Convenience method for checking individual flags
   *
   * @param userId - User identifier
   * @param feature - Feature to check ('schema' | 'ai_context' | 'validation')
   * @returns True if feature is enabled for user
   */
  async isFeatureEnabled(
    userId: string,
    feature: 'schema' | 'ai_context' | 'validation' | 'gateway' | 'business_central'
  ): Promise<boolean> {
    try {
      const settings = await this.getUserSettings(userId);

      switch (feature) {
        case 'schema':
          return settings.mcp_schema_enabled;
        case 'ai_context':
          return settings.mcp_ai_context_enabled;
        case 'validation':
          return settings.mcp_validation_enabled;
        case 'gateway':
          return settings.mcp_gateway_enabled;
        case 'business_central':
          return settings.mcp_bc_enabled && settings.mcp_gateway_enabled;
        default:
          return false;
      }
    } catch (error) {
      this.logger.error('Failed to check MCP feature status', {
        userId,
        feature,
        error: error instanceof Error ? error.message : String(error)
      });
      // On error, fall back to environment variable
      switch (feature) {
        case 'schema':
          return isNetSuiteMCPSchemaEnabled();
        case 'ai_context':
          return isNetSuiteMCPAIContextEnabled();
        case 'validation':
          return isNetSuiteMCPValidationEnabled();
        case 'gateway':
          return isMCPGatewayEnabled();
        case 'business_central':
          return isBusinessCentralMCPEnabled();
        default:
          return false;
      }
    }
  }

  /**
   * Get MCP settings for all users (admin function)
   *
   * @returns Array of all user settings
   */
  async getAllUserSettings(): Promise<MCPUserSettings[]> {
    try {
      const result = await sql`
        SELECT * FROM mcp_user_settings ORDER BY created_at DESC
      `.execute(this.db);

      return (result.rows as MCPUserSettingsRow[]).map(row => ({
        ...row,
        mcp_schema_enabled: Boolean(row.mcp_schema_enabled),
        mcp_ai_context_enabled: Boolean(row.mcp_ai_context_enabled),
        mcp_validation_enabled: Boolean(row.mcp_validation_enabled),
        mcp_gateway_enabled: this.normalizeBoolean(row.mcp_gateway_enabled),
        mcp_bc_enabled: this.normalizeBoolean(row.mcp_bc_enabled),
        is_explicit: true // All rows from DB are explicit settings
      }));
    } catch (error) {
      this.logger.error('Failed to get all MCP user settings', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get count of users with MCP features enabled
   * Useful for monitoring A/B test rollout
   *
   * @returns Count statistics
   */
  async getEnabledCounts(): Promise<{
    schema: number;
    aiContext: number;
    validation: number;
    gateway: number;
    businessCentral: number;
    total: number;
  }> {
    try {
      const result = await sql`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN mcp_schema_enabled = 1 THEN 1 ELSE 0 END) as schema,
          SUM(CASE WHEN mcp_ai_context_enabled = 1 THEN 1 ELSE 0 END) as ai_context,
          SUM(CASE WHEN mcp_validation_enabled = 1 THEN 1 ELSE 0 END) as validation,
          SUM(CASE WHEN mcp_gateway_enabled = 1 THEN 1 ELSE 0 END) as gateway,
          SUM(CASE WHEN mcp_bc_enabled = 1 THEN 1 ELSE 0 END) as business_central
        FROM mcp_user_settings
      `.execute(this.db);

      const row = result.rows[0] as {
        total: number;
        schema: number;
        ai_context: number;
        validation: number;
        gateway: number;
        business_central: number;
      };

      return {
        schema: Number(row.schema || 0),
        aiContext: Number(row.ai_context || 0),
        validation: Number(row.validation || 0),
        gateway: Number(row.gateway || 0),
        businessCentral: Number(row.business_central || 0),
        total: Number(row.total || 0)
      };
    } catch (error) {
      this.logger.error('Failed to get MCP enabled counts', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get user-scoped MCP gateway enablement.
   * Falls back to process-level environment defaults when user settings are unavailable.
   */
  async isGatewayEnabled(userId: string): Promise<boolean> {
    return this.isFeatureEnabled(userId, 'gateway');
  }

  /**
   * Get user-scoped Business Central MCP adapter enablement.
   */
  async isBusinessCentralEnabled(userId: string): Promise<boolean> {
    return this.isFeatureEnabled(userId, 'business_central');
  }
}
