import { inject, injectable } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { DatabaseService } from '../database/DatabaseService';
import { uuidv4 } from '../utils/uuid';

@injectable()
export class UserSettingsService {
  private readonly logger: Logger;
  private readonly databaseService: DatabaseService;
  private readonly settingKey = 'ai_dataset_selection';

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.DatabaseService) databaseService: DatabaseService
  ) {
    this.logger = logger;
    this.databaseService = databaseService;
  }

  private tenantFor(userId?: string | number): string {
    if (userId === undefined || userId === null) return 'anonymous';
    return `user:${String(userId)}`;
  }

  async getDataset(userId?: string | number): Promise<string | null> {
    const db = this.databaseService.getDatabase();
    const tenantId = this.tenantFor(userId);

    try {
      const record = await db
        .selectFrom('tenant_configurations')
        .select(['setting_value'])
        .where('tenant_id', '=', tenantId)
        .where('setting_key', '=', this.settingKey)
        .executeTakeFirst();

      if (record?.setting_value) {
        return record.setting_value as string;
      }

      // Fallback to global default if present
      const globalRecord = await db
        .selectFrom('tenant_configurations')
        .select(['setting_value'])
        .where('tenant_id', '=', 'global')
        .where('setting_key', '=', this.settingKey)
        .executeTakeFirst();

      return (globalRecord?.setting_value as string) ?? null;
    } catch (error) {
      this.logger.warn('Failed to load dataset preference; default will be used', {
        error: error instanceof Error ? error.message : String(error),
        tenantId,
      });
      return null;
    }
  }

  async setDataset(datasetId: string, userId?: string | number): Promise<void> {
    const db = this.databaseService.getDatabase();
    const tenantId = this.tenantFor(userId);
    const now = new Date();

    try {
      const existing = await db
        .selectFrom('tenant_configurations')
        .select(['id'])
        .where('tenant_id', '=', tenantId)
        .where('setting_key', '=', this.settingKey)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable('tenant_configurations')
          .set({ setting_value: datasetId, updated_at: now })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await db
          .insertInto('tenant_configurations')
          .values({
            id: uuidv4(),
            tenant_id: tenantId,
            setting_key: this.settingKey,
            setting_value: datasetId,
            is_encrypted: false,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }

      this.logger.info('AI dataset preference updated', { tenantId, datasetId });
    } catch (error) {
      this.logger.error('Failed to persist AI dataset preference', {
        error: error instanceof Error ? error.message : String(error),
        tenantId,
        datasetId,
      });
      throw error;
    }
  }
}
