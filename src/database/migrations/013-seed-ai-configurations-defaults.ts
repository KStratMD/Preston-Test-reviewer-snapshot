import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'seed_ai_configurations_defaults',
  async run(db, dbType) {
    const defaultUserId = 1;
    const providerType = 'rule-based';
    const providerName = 'Rule-Based Engine';
    const seededAt = new Date().toISOString();

    const providerConfiguration = {
      description: 'Deterministic fallback provider with zero token cost.',
      capabilities: [
        'field_mapping',
        'quality_assessment',
        'data_validation',
        'transformation_suggestion'
      ],
      routing: {
        strategy: 'rule-based',
        confidenceThreshold: 0.7
      },
      metadata: {
        seededAt
      }
    };

    if (dbType === 'sqlite') {
      await sql`
        INSERT INTO ai_provider_configs (
          user_id,
          organization_id,
          provider_type,
          provider_name,
          encrypted_api_key,
          endpoint_url,
          is_active,
          is_default,
          configuration
        )
        SELECT
          ${defaultUserId},
          NULL,
          ${providerType},
          ${providerName},
          NULL,
          NULL,
          1,
          1,
          ${JSON.stringify(providerConfiguration)}
        WHERE NOT EXISTS (
          SELECT 1 FROM ai_provider_configs
          WHERE user_id = ${defaultUserId}
            AND provider_type = ${providerType}
        )
      `.execute(db);
    } else {
      await sql`
        INSERT INTO ai_provider_configs (
          user_id,
          organization_id,
          provider_type,
          provider_name,
          encrypted_api_key,
          endpoint_url,
          is_active,
          is_default,
          configuration
        )
        SELECT
          ${defaultUserId},
          NULL,
          ${providerType},
          ${providerName},
          NULL,
          NULL,
          true,
          true,
          CAST(${JSON.stringify(providerConfiguration)} AS JSONB)
        WHERE NOT EXISTS (
          SELECT 1 FROM ai_provider_configs
          WHERE user_id = ${defaultUserId}
            AND provider_type = ${providerType}
        )
      `.execute(db);
    }

    const providerResult = await sql`
      SELECT id FROM ai_provider_configs
      WHERE user_id = ${defaultUserId}
        AND provider_type = ${providerType}
      ORDER BY id ASC
      LIMIT 1
    `.execute(db);

    const providerRow = providerResult.rows[0] as { id?: number } | undefined;
    const providerId = providerRow?.id;

    if (!providerId) {
      return;
    }

    const taskSeeds = [
      {
        taskType: 'field_mapping',
        modelVersion: 'rule-based-v1',
        description: 'Deterministic semantic field mapping defaults.'
      },
      {
        taskType: 'quality_assessment',
        modelVersion: 'rule-based-v1',
        description: 'Baseline data quality scoring heuristics.'
      },
      {
        taskType: 'data_validation',
        modelVersion: 'rule-based-v1',
        description: 'Schema validation and transformation guardrails.'
      },
      {
        taskType: 'transformation_suggestion',
        modelVersion: 'rule-based-v1',
        description: 'Rule-based transformation recommendations.'
      }
    ] as const;

    for (const task of taskSeeds) {
      const modelParameters = {
        routingStrategy: 'deterministic',
        confidenceThreshold: 0.7,
        notes: task.description,
        seededAt
      };

      if (dbType === 'sqlite') {
        await sql`
          INSERT INTO ai_task_model_configs (
            user_id,
            organization_id,
            task_type,
            provider_config_id,
            model_version,
            model_parameters,
            is_active,
            priority
          )
          SELECT
            ${defaultUserId},
            NULL,
            ${task.taskType},
            ${providerId},
            ${task.modelVersion},
            ${JSON.stringify(modelParameters)},
            1,
            1
          WHERE NOT EXISTS (
            SELECT 1 FROM ai_task_model_configs
            WHERE user_id = ${defaultUserId}
              AND task_type = ${task.taskType}
          )
        `.execute(db);
      } else {
        await sql`
          INSERT INTO ai_task_model_configs (
            user_id,
            organization_id,
            task_type,
            provider_config_id,
            model_version,
            model_parameters,
            is_active,
            priority
          )
          SELECT
            ${defaultUserId},
            NULL,
            ${task.taskType},
            ${providerId},
            ${task.modelVersion},
            CAST(${JSON.stringify(modelParameters)} AS JSONB),
            true,
            1
          WHERE NOT EXISTS (
            SELECT 1 FROM ai_task_model_configs
            WHERE user_id = ${defaultUserId}
              AND task_type = ${task.taskType}
          )
        `.execute(db);
      }
    }
  },
};
