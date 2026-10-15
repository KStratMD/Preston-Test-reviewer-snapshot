import { inject, injectable } from 'inversify';
import { uuidv4 } from '../utils/uuid';
import { TYPES } from '../inversify/types';
import { DatabaseService } from '../database/DatabaseService';
import type { Logger } from '../utils/Logger';
import { isDemoMode, setDemoModeOverride } from '../config/runtimeFlags';

interface DemoModeContext {
  userId?: string | number;
}

/**
 * Persisted demo-mode toggle backed by tenant_configurations table.
 * Provides a single source of truth for UI/connector runtime flags.
 */
@injectable()
export class DemoModeService {
  private readonly logger: Logger;
  private readonly databaseService: DatabaseService;
  private readonly tenantId = 'global';
  private readonly settingKey = 'demo_mode';
  private cachedValue: boolean | undefined;
  private readonly bootstrapPromise: Promise<void>;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.DatabaseService) databaseService: DatabaseService
  ) {
    this.logger = logger;
    this.databaseService = databaseService;
    this.bootstrapPromise = this.loadInitialState();
  }

  /**
   * Get the current demo mode status (cached + persisted fallback + env).
   */
  async getDemoMode(): Promise<boolean> {
    await this.bootstrapPromise;
    if (typeof this.cachedValue === 'boolean') {
      return this.cachedValue;
    }
    // Fallback to env-derived state if cache is still undefined
    const envValue = isDemoMode();
    this.cachedValue = envValue;
    return envValue;
  }

  /**
   * Update demo mode state and persist it.
   */
  async setDemoMode(enabled: boolean, context: DemoModeContext = {}): Promise<void> {
    await this.bootstrapPromise;
    const db = this.databaseService.getDatabase();
    const value = enabled ? 'true' : 'false';
    const now = new Date();

    try {
      const existing = await db
        .selectFrom('tenant_configurations')
        .select(['id'])
        .where('tenant_id', '=', this.tenantId)
        .where('setting_key', '=', this.settingKey)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable('tenant_configurations')
          .set({
            setting_value: value,
            updated_at: now
          })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('tenant_configurations')
          .values({
            id: uuidv4(),
            tenant_id: this.tenantId,
            setting_key: this.settingKey,
            setting_value: value,
            is_encrypted: false,
            created_at: now,
            updated_at: now
          })
          .execute();
      }

      this.cachedValue = enabled;
      setDemoModeOverride(enabled);
      process.env.DEMO_MODE = enabled ? '1' : '0';

      this.logger.info('Demo mode updated', {
        enabled,
        userId: String(context.userId ?? 'system')
      });
    } catch (error) {
      this.logger.error('Failed to persist demo mode setting', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async loadInitialState(): Promise<void> {
    try {
      // Prioritize environment variable first (source of truth for container config)
      const envDefined = process.env.DEMO_MODE !== undefined && process.env.DEMO_MODE !== '';
      const envValue = isDemoMode();

      // If env is explicitly set, we use it as the source of truth
      if (envDefined) {
        this.logger.info('Demo mode initialized from environment', {
          enabled: envValue,
          env: process.env.DEMO_MODE
        });

        // Sync to database asynchronously so it aligns for next time
        this.syncToDatabase(envValue).catch(err => {
          this.logger.warn('Failed to sync demo mode env to database', { error: String(err) });
        });

        this.cachedValue = envValue;
        setDemoModeOverride(envValue);
        return;
      }

      // Otherwise, fall back to stored DB preference
      const stored = await this.loadFromDatabase();
      const initial = stored ?? envValue;
      this.cachedValue = initial;
      setDemoModeOverride(initial);
      process.env.DEMO_MODE = initial ? '1' : '0';
      this.logger.debug('Demo mode initialized from storage', { enabled: initial, stored });
    } catch (error) {
      this.logger.warn('Unable to load persisted demo mode, falling back to env flag', {
        error: error instanceof Error ? error.message : String(error)
      });
      const fallback = isDemoMode();
      this.cachedValue = fallback;
      setDemoModeOverride(fallback);
    }
  }

  /**
   * Helper to sync environment state to DB without triggering full update logic
   */
  private async syncToDatabase(enabled: boolean): Promise<void> {
    const db = this.databaseService.getDatabase();
    const value = enabled ? 'true' : 'false';
    const now = new Date();

    const existing = await db
      .selectFrom('tenant_configurations')
      .select(['id'])
      .where('tenant_id', '=', this.tenantId)
      .where('setting_key', '=', this.settingKey)
      .executeTakeFirst();

    if (existing) {
      await db
        .updateTable('tenant_configurations')
        .set({ setting_value: value, updated_at: now })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await db
        .insertInto('tenant_configurations')
        .values({
          id: uuidv4(),
          tenant_id: this.tenantId,
          setting_key: this.settingKey,
          setting_value: value,
          is_encrypted: false,
          created_at: now,
          updated_at: now
        })
        .execute();
    }
  }

  private async loadFromDatabase(): Promise<boolean | null> {
    const db = this.databaseService.getDatabase();
    const record = await db
      .selectFrom('tenant_configurations')
      .select(['setting_value'])
      .where('tenant_id', '=', this.tenantId)
      .where('setting_key', '=', this.settingKey)
      .executeTakeFirst();

    if (!record) {
      return null;
    }
    return record.setting_value === 'true';
  }
}
