#!/usr/bin/env node

import { Command } from 'commander';
import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import {
  validateIntegrationConfig,
  validateSystemAuthentication,
  IntegrationConfigSchema,
} from '../schemas/configurationSchemas.js';
import { createLogger } from '../utils/Logger.js';
import type { FieldMapping, TransformationRule } from '../types/index.js';

const program = new Command();
const logger = createLogger('ConfigValidatorCLI');

interface ValidationSummary {
  totalConfigs: number;
  validConfigs: number;
  invalidConfigs: number;
  warnings: number;
  errors: string[];
}

/**
 * Validates a single configuration file
 */
async function validateConfigFile(
  filePath: string,
): Promise<{ isValid: boolean; errors: string[]; warnings: string[] }> {
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(fileContent);

    const result = validateIntegrationConfig(config);

    // Additional system-specific validation if config is structurally valid
    if (result.isValid && config.sourceAuthentication) {
      const sourceAuthResult = validateSystemAuthentication(config.sourceSystem, config.sourceAuthentication);
      if (!sourceAuthResult.isValid) {
        result.errors.push(...sourceAuthResult.errors.map(e => `Source authentication: ${e}`));
        result.isValid = false;
      }
    }

    if (result.isValid && config.targetAuthentication) {
      const targetAuthResult = validateSystemAuthentication(config.targetSystem, config.targetAuthentication);
      if (!targetAuthResult.isValid) {
        result.errors.push(...targetAuthResult.errors.map(e => `Target authentication: ${e}`));
        result.isValid = false;
      }
    }

    return result;
  } catch (error) {
    return {
      isValid: false,
      errors: [`Failed to parse configuration file: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
}

/**
 * Validates all configuration files in a directory
 */
async function validateConfigDirectory(dirPath: string): Promise<ValidationSummary> {
  const summary: ValidationSummary = {
    totalConfigs: 0,
    validConfigs: 0,
    invalidConfigs: 0,
    warnings: 0,
    errors: [],
  };

  try {
    const files = await fs.readdir(dirPath);
    const configFiles = files.filter(file => file.endsWith('.json'));

    logger.info(chalk.blue(`\n📁 Validating ${configFiles.length} configuration files in ${dirPath}\n`));

    for (const file of configFiles) {
      const filePath = path.join(dirPath, file);
      summary.totalConfigs++;

      logger.info(chalk.gray(`Validating ${file}...`));

      const result = await validateConfigFile(filePath);

      if (result.isValid) {
        summary.validConfigs++;
        logger.info(chalk.green(`  ✅ ${file} - Valid`));

        if (result.warnings.length > 0) {
          summary.warnings += result.warnings.length;
          result.warnings.forEach(warning => {
            logger.info(chalk.yellow(`  ⚠️  ${warning}`));
          });
        }
      } else {
        summary.invalidConfigs++;
        logger.info(chalk.red(`  ❌ ${file} - Invalid`));

        result.errors.forEach(error => {
          logger.info(chalk.red(`    • ${error}`));
          summary.errors.push(`${file}: ${error}`);
        });
      }
    }

    return summary;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    summary.errors.push(`Failed to read directory ${dirPath}: ${msg}`);
    return summary;
  }
}

/**
 * Generates a sample configuration file
 */
async function generateSampleConfig(outputPath: string): Promise<void> {
  const sampleConfig = {
    id: 'sample_sf_to_ns_customers',
    tenantId: 'sample-tenant',
    name: 'Sample Salesforce to NetSuite Customer Sync',
    description: 'Sample integration configuration for syncing customers from Salesforce to NetSuite',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [
      {
        sourceField: 'Name',
        targetField: 'companyName',
        transformationType: 'direct',
        isRequired: true,
      },
      {
        sourceField: 'BillingStreet',
        targetField: 'address1',
        transformationType: 'direct',
        isRequired: false,
      },
      {
        sourceField: 'Phone',
        targetField: 'phone',
        transformationType: 'direct',
        isRequired: false,
      },
    ],
    transformationRules: [
      {
        id: 'set_customer_type',
        name: 'Set Default Customer Type',
        type: 'business_logic',
        action: 'set_field_value',
        parameters: {
          targetField: 'customerType',
          defaultValue: 'Standard',
        },
      },
    ],
    sourceAuthentication: {
      type: 'oauth2',
      credentials: {
        clientId: 'your_salesforce_client_id',
        clientSecret: 'your_salesforce_client_secret',
        username: 'your_salesforce_username',
        password: 'your_salesforce_password',
      },
    },
    targetAuthentication: {
      type: 'oauth1',
      credentials: {
        consumerKey: 'your_netsuite_consumer_key',
        consumerSecret: 'your_netsuite_consumer_secret',
        tokenId: 'your_netsuite_token_id',
        tokenSecret: 'your_netsuite_token_secret',
        accountId: 'your_netsuite_account_id',
      },
    },
    batchSize: 100,
    retryConfig: {
      maxRetries: 3,
      retryDelay: 1000,
      backoffStrategy: 'exponential',
    },
  };

  await fs.writeFile(outputPath, JSON.stringify(sampleConfig, null, 2));
  logger.info(chalk.green(`✅ Sample configuration generated: ${outputPath}`));
}

/**
 * Fixes common configuration issues automatically
 */
async function autoFixConfig(filePath: string): Promise<void> {
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(fileContent);

    let fixed = false;

    // Auto-fix common issues
    if (!config.batchSize || config.batchSize <= 0) {
      config.batchSize = 100;
      fixed = true;
    }

    if (config.fieldMappings) {
      config.fieldMappings.forEach((mapping: FieldMapping) => {
        if (!mapping.isRequired) {
          mapping.isRequired = false;
          fixed = true;
        }
      });
    }

    if (config.transformationRules) {
      config.transformationRules.forEach((rule: TransformationRule, index: number) => {
        if (!rule.id) {
          rule.id = `rule_${index + 1}`;
          fixed = true;
        }
      });
    }

    if (fixed) {
      const backupPath = `${filePath}.backup`;
      await fs.writeFile(backupPath, fileContent);
      await fs.writeFile(filePath, JSON.stringify(config, null, 2));

      logger.info(chalk.green(`✅ Configuration auto-fixed: ${filePath}`));
      logger.info(chalk.blue(`📄 Backup created: ${backupPath}`));
    } else {
      logger.info(chalk.yellow(`ℹ️  No automatic fixes available for: ${path.basename(filePath)}`));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.info(chalk.red(`❌ Failed to auto-fix ${filePath}: ${msg}`));
  }
}

// CLI Commands
program
  .name('config-validator')
  .description('Integration Hub Configuration Validator')
  .version('1.0.0');

program
  .command('validate')
  .description('Validate configuration file(s)')
  .argument('<path>', 'Path to configuration file or directory')
  .option('-v, --verbose', 'Verbose output')
  .option('-f, --format <type>', 'Output format (text|json)', 'text')
  .action(async (configPath: string, options: { verbose?: boolean; format?: 'text' | 'json' }) => {
    try {
      const stats = await fs.stat(configPath);

      if (stats.isDirectory()) {
        const summary = await validateConfigDirectory(configPath);

        // Print summary
        logger.info(chalk.blue('\n📊 Validation Summary:'));
        logger.info(`Total configurations: ${summary.totalConfigs}`);
        logger.info(chalk.green(`Valid configurations: ${summary.validConfigs}`));
        logger.info(chalk.red(`Invalid configurations: ${summary.invalidConfigs}`));
        logger.info(chalk.yellow(`Total warnings: ${summary.warnings}`));

        if (options.format === 'json') {
          logger.info(`\n${JSON.stringify(summary, null, 2)}`);
        }

        process.exit(summary.invalidConfigs > 0 ? 1 : 0);
      } else {
        const result = await validateConfigFile(configPath);
        const fileName = path.basename(configPath);

        if (result.isValid) {
          logger.info(chalk.green(`✅ ${fileName} - Valid configuration`));
          if (result.warnings.length > 0) {
            logger.info(chalk.yellow('\nWarnings:'));
            result.warnings.forEach(warning => logger.info(chalk.yellow(`  ⚠️  ${warning}`)));
          }
        } else {
          logger.info(chalk.red(`❌ ${fileName} - Invalid configuration`));
          logger.info(chalk.red('\nErrors:'));
          result.errors.forEach(error => logger.info(chalk.red(`  • ${error}`)));
        }

        if (options.format === 'json') {
          logger.info(`\n${JSON.stringify(result, null, 2)}`);
        }

        process.exit(result.isValid ? 0 : 1);
      }
    } catch (error) {
      logger.error(chalk.red(`❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Generate a sample configuration file')
  .argument('<output>', 'Output file path')
  .action(async (outputPath: string) => {
    try {
      await generateSampleConfig(outputPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(chalk.red(`❌ Error generating sample config: ${msg}`));
      process.exit(1);
    }
  });

program
  .command('fix')
  .description('Automatically fix common configuration issues')
  .argument('<path>', 'Path to configuration file')
  .action(async (configPath: string) => {
    try {
      await autoFixConfig(configPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(chalk.red(`❌ Error: ${msg}`));
      process.exit(1);
    }
  });

program
  .command('schema')
  .description('Display the configuration schema')
  .option('-f, --format <type>', 'Output format (json|yaml)', 'json')
  .action((_options) => {
    try {
      // Export the schema as JSON Schema
      const schema = IntegrationConfigSchema;
      logger.info(JSON.stringify(schema, null, 2));
    } catch (error) {
      logger.error(chalk.red(`❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error(chalk.red(`💥 Uncaught Exception: ${error.message}`));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(chalk.red(`💥 Unhandled Rejection: ${reason}`));
  process.exit(1);
});

// Parse command line arguments
program.parse();
