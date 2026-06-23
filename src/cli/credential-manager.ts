#!/usr/bin/env node

import { Command } from 'commander';
import 'reflect-metadata';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SecureCredentialManager } from '../services/SecureCredentialManager';
import type { SecureConfigurationService } from '../services/SecureConfigurationService';
import { createLogger } from '../utils/Logger';
import * as readline from 'readline';

interface ListCommandOptions {
  format?: string;
}

interface StoreCommandOptions {
  type: string;
  id: string;
  file?: string;
  interactive?: boolean;
}

interface GetCommandOptions {
  type: string;
  id: string;
}

interface RotateCommandOptions {
  type: string;
  id: string;
  file?: string;
  interactive?: boolean;
}

interface DeleteCommandOptions {
  type: string;
  id: string;
  yes?: boolean;
}

interface HealthCommandOptions {
  format?: string;
}

interface ValidateCommandOptions {
  format?: string;
}

interface MigrateCommandOptions {
  yes?: boolean;
}

interface ExportTemplateCommandOptions {
  type: string;
  output?: string;
}

const program = new Command();
const credentialManager = container.get<SecureCredentialManager>(TYPES.SecureCredentialManager);
const secureConfigService = container.get<SecureConfigurationService>(TYPES.ConfigurationService);
const logger = createLogger('CredentialManagerCLI');

// Lazy readline interface so non-interactive commands don't keep the
// event loop alive after the action completes.
let _rl: readline.Interface | null = null;
function getRl(): readline.Interface {
  if (!_rl) {
    _rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return _rl;
}
function closeRl(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

const question = (prompt: string): Promise<string> => {
  return new Promise((resolve) => {
    getRl().question(prompt, (answer) => {
      resolve(answer);
    });
  });
};

// Helper function for secure password input
async function secureInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    stdin.on('data', (char) => {
      const c = char.toString();

      if (c === '\u0003') { // Ctrl+C
        process.exit();
      } else if (c === '\r' || c === '\n') { // Enter
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        resolve(input);
      } else if (c === '\u0008' || c === '\u007f') { // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        input += c;
        stdout.write('*');
      }
    });
  });
}

program
  .name('credential-manager')
  .description('CLI tool for managing secure credentials')
  .version('1.0.0');

// List credentials command
program
  .command('list')
  .description('List all stored credentials (metadata only)')
  .option('-f, --format <format>', 'Output format (table|json)', 'table')
  .action(async (options: ListCommandOptions) => {
    try {
      const credentials = await credentialManager.listCredentials();

      if (options.format === 'json') {
        logger.info(JSON.stringify(credentials, null, 2));
      } else {
        logger.info('\n📋 Stored Credentials:');
        logger.info('─'.repeat(80));
        logger.info(
          [
            'System Type'.padEnd(15),
            'System ID'.padEnd(15),
            'Credential Type'.padEnd(15),
            'Last Rotated'.padEnd(20),
            'Status',
          ].join(' '),
        );
        logger.info('─'.repeat(80));

        for (const cred of credentials) {
          const lastRotated = (cred.lastRotated ? cred.lastRotated.toISOString().split('T')[0] : 'Never') as string;
          const status = cred.rotationRequired ? '⚠️  Needs Rotation' : '✅ Healthy';

          logger.info(
            [
              cred.systemType.padEnd(15),
              cred.systemId.padEnd(15),
              cred.credentialType.padEnd(15),
              lastRotated.padEnd(20),
              status,
            ].join(' '),
          );
        }
        logger.info('─'.repeat(80));
        logger.info(`\nTotal credentials: ${credentials.length}`);
      }
    } catch (error) {
      logger.error('❌ Failed to list credentials', error);
      process.exit(1);
    }
  });

// Store credentials command
program
  .command('store')
  .description('Store new system credentials')
  .requiredOption('-t, --type <type>', 'System type (NetSuite, Salesforce, etc.)')
  .requiredOption('-i, --id <id>', 'System ID')
  .option('-f, --file <file>', 'Read credentials from JSON file')
  .option('--interactive', 'Interactive credential input')
  .action(async (options: StoreCommandOptions) => {
    try {
      let credentials: Record<string, unknown> = {};

      if (options.file) {
        const fs = await import('fs/promises');
        const credentialsData = await fs.readFile(options.file, 'utf8');
        credentials = JSON.parse(credentialsData);
      } else if (options.interactive) {
        logger.info(`\n🔐 Interactive credential setup for ${options.type}:${options.id}`);

        // Common credential types
        const credentialTypes = {
          'NetSuite': ['accountId', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret', 'baseUrl'],
          'Salesforce': ['clientId', 'clientSecret', 'username', 'password', 'securityToken', 'loginUrl'],
          'Dynamics365': ['tenantId', 'clientId', 'clientSecret', 'resourceUrl'],
          'SAP': ['username', 'password', 'host', 'port', 'client', 'systemId'],
          'Oracle': ['username', 'password', 'host', 'port', 'serviceName'],
          'BusinessCentral': ['clientId', 'clientSecret', 'tenantId', 'environment', 'companyId'],
        };

        const fields = credentialTypes[options.type as keyof typeof credentialTypes] || ['username', 'password'];

        for (const field of fields) {
          const isSecret = field.toLowerCase().includes('secret') ||
                          field.toLowerCase().includes('password') ||
                          field.toLowerCase().includes('token');

          if (isSecret) {
            credentials[field] = await secureInput(`${field}: `);
          } else {
            credentials[field] = await question(`${field}: `);
          }
        }
      } else {
        logger.error('❌ Either --file or --interactive option is required');
        process.exit(1);
      }

      await credentialManager.storeCredentials(options.type, options.id, credentials as any);
      logger.info(`✅ Credentials stored successfully for ${options.type}:${options.id}`);
    } catch (error) {
      logger.error('❌ Failed to store credentials', error);
      process.exit(1);
    } finally {
      closeRl();
    }
  });

// Get credential metadata
program
  .command('get')
  .description('Get credential metadata')
  .requiredOption('-t, --type <type>', 'System type')
  .requiredOption('-i, --id <id>', 'System ID')
  .action(async (options: GetCommandOptions) => {
    try {
      const metadata = await credentialManager.getCredentialMetadata(options.type, options.id);

      if (!metadata) {
        logger.info(`❌ No credentials found for ${options.type}:${options.id}`);
        process.exit(1);
      }

      logger.info(`\n📄 Credential Metadata for ${options.type}:${options.id}:`);
      logger.info('─'.repeat(50));
      logger.info(`System Type: ${metadata.systemType}`);
      logger.info(`System ID: ${metadata.systemId}`);
      logger.info(`Credential Type: ${metadata.credentialType}`);
      logger.info(`Last Rotated: ${metadata.lastRotated ? metadata.lastRotated.toISOString() : 'Never'}`);
      logger.info(`Last Accessed: ${metadata.lastAccessed ? metadata.lastAccessed.toISOString() : 'Never'}`);
      logger.info(`Access Count: ${metadata.accessCount}`);
      logger.info(`Rotation Required: ${metadata.rotationRequired ? 'Yes' : 'No'}`);
    } catch (error) {
      logger.error('❌ Failed to get credential metadata', error);
      process.exit(1);
    }
  });

// Rotate credentials command
program
  .command('rotate')
  .description('Rotate system credentials')
  .requiredOption('-t, --type <type>', 'System type')
  .requiredOption('-i, --id <id>', 'System ID')
  .option('-f, --file <file>', 'Read new credentials from JSON file')
  .option('--interactive', 'Interactive credential input')
  .action(async (options: RotateCommandOptions) => {
    try {
      let newCredentials: Record<string, unknown> = {};

      if (options.file) {
        const fs = await import('fs/promises');
        const credentialsData = await fs.readFile(options.file, 'utf8');
        newCredentials = JSON.parse(credentialsData);
      } else if (options.interactive) {
        logger.info(`\n🔄 Rotating credentials for ${options.type}:${options.id}`);
        logger.info('Enter new credentials:');

        // Get current metadata to know what fields to ask for
        const metadata = await credentialManager.getCredentialMetadata(options.type, options.id);
        if (!metadata) {
          logger.error(`❌ No existing credentials found for ${options.type}:${options.id}`);
          process.exit(1);
        }

        // Use predefined fields based on system type
        const credentialTypes = {
          'NetSuite': ['accountId', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret', 'baseUrl'],
          'Salesforce': ['clientId', 'clientSecret', 'username', 'password', 'securityToken', 'loginUrl'],
          'Dynamics365': ['tenantId', 'clientId', 'clientSecret', 'resourceUrl'],
          'SAP': ['username', 'password', 'host', 'port', 'client', 'systemId'],
          'Oracle': ['username', 'password', 'host', 'port', 'serviceName'],
          'BusinessCentral': ['clientId', 'clientSecret', 'tenantId', 'environment', 'companyId'],
        };

        const fields = credentialTypes[options.type as keyof typeof credentialTypes] || ['username', 'password'];

        for (const field of fields) {
          const isSecret = field.toLowerCase().includes('secret') ||
                          field.toLowerCase().includes('password') ||
                          field.toLowerCase().includes('token');

          if (isSecret) {
            newCredentials[field] = await secureInput(`New ${field}: `);
          } else {
            newCredentials[field] = await question(`New ${field}: `);
          }
        }
      } else {
        logger.error('❌ Either --file or --interactive option is required');
        process.exit(1);
      }

      await credentialManager.rotateCredentials(options.type, options.id, newCredentials as any);
      logger.info(`✅ Credentials rotated successfully for ${options.type}:${options.id}`);
    } catch (error) {
      logger.error('❌ Failed to rotate credentials', error);
      process.exit(1);
    } finally {
      closeRl();
    }
  });

// Delete credentials command
program
  .command('delete')
  .description('Delete system credentials')
  .requiredOption('-t, --type <type>', 'System type')
  .requiredOption('-i, --id <id>', 'System ID')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: DeleteCommandOptions) => {
    try {
      if (!options.yes) {
        const promptMsg =
          `⚠️  Are you sure you want to delete credentials for ${options.type}:${options.id}? ` +
          '(y/N): ';
        const confirmation = await question(promptMsg);
        if (confirmation && confirmation.toLowerCase() !== 'y' && confirmation.toLowerCase() !== 'yes') {
          logger.info('❌ Operation cancelled');
          process.exit(0);
        }
      }

      await credentialManager.deleteCredentials(options.type, options.id);
      logger.info(`✅ Credentials deleted successfully for ${options.type}:${options.id}`);
    } catch (error) {
      logger.error('❌ Failed to delete credentials', error);
      process.exit(1);
    } finally {
      closeRl();
    }
  });

// Health check command
program
  .command('health')
  .description('Check credential health status')
  .option('-f, --format <format>', 'Output format (table|json)', 'table')
  .action(async (options: HealthCommandOptions) => {
    try {
      const healthStatus = await secureConfigService.getCredentialHealthStatus();

      if (options.format === 'json') {
        logger.info(JSON.stringify(healthStatus, null, 2));
      } else {
        logger.info('\n🏥 Credential Health Status:');
        logger.info('─'.repeat(60));
        logger.info(`Total Integrations: ${healthStatus.totalIntegrations}`);
        logger.info(`✅ Healthy Credentials: ${healthStatus.healthyCredentials}`);
        logger.info(`⚠️  Need Rotation: ${healthStatus.credentialsNeedingRotation}`);
        logger.info(`❌ Expired Credentials: ${healthStatus.expiredCredentials}`);

        if (healthStatus.details.length > 0) {
          logger.info('\n📊 Details:');
          logger.info('─'.repeat(80));
          logger.info(
            [
              'Integration ID'.padEnd(20),
              'System Type'.padEnd(15),
              'System ID'.padEnd(15),
              'Status'.padEnd(20),
              'Days Since Rotation',
            ].join(' '),
          );
          logger.info('─'.repeat(80));

          for (const detail of healthStatus.details) {
            const statusIcon = detail.status === 'healthy' ? '✅' : detail.status === 'needs_rotation' ? '⚠️ ' : '❌';
            const statusText = `${statusIcon} ${detail.status}`;
            const daysSince = detail.daysSinceRotation ? detail.daysSinceRotation.toString() : 'N/A';

            logger.info(
              [
                detail.integrationId.padEnd(20),
                detail.systemType.padEnd(15),
                detail.systemId.padEnd(15),
                statusText.padEnd(20),
                daysSince,
              ].join(' '),
            );
          }
        }
        logger.info('─'.repeat(80));
      }
    } catch (error) {
      logger.error('❌ Failed to get health status', error);
      process.exit(1);
    }
  });

// Security validation command
program
  .command('validate')
  .description('Validate credential security')
  .option('-f, --format <format>', 'Output format (table|json)', 'table')
  .action(async (options: ValidateCommandOptions) => {
    try {
      const validation = await secureConfigService.validateCredentialSecurity();

      if (options.format === 'json') {
        logger.info(JSON.stringify(validation, null, 2));
      } else {
        logger.info('\n🔒 Credential Security Validation:');
        logger.info('─'.repeat(60));
        logger.info(`Total Integrations: ${validation.totalIntegrations}`);
        logger.info(`✅ Secure Integrations: ${validation.secureIntegrations}`);
        logger.info(`❌ Insecure Integrations: ${validation.insecureIntegrations}`);

        if (validation.issues.length > 0) {
          logger.info('\n⚠️  Security Issues:');
          logger.info('─'.repeat(100));

          for (const issue of validation.issues) {
            const severityIcon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
            logger.info(`${severityIcon} ${issue.severity.toUpperCase()}: ${issue.integrationId}`);
            logger.info(`   Issue: ${issue.issue}`);
            logger.info(`   Recommendation: ${issue.recommendation}\n`);
          }
        }
        logger.info('─'.repeat(100));
      }
    } catch (error) {
      logger.error('❌ Failed to validate security', error);
      process.exit(1);
    }
  });

// Migration command
program
  .command('migrate')
  .description('Migrate credentials from environment variables to secure storage')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: MigrateCommandOptions) => {
    try {
      if (!options.yes) {
        logger.info('⚠️  This will migrate credentials from environment variables to secure storage.');
        logger.info('   This process will:');
        logger.info('   1. Extract credentials from environment variables');
        logger.info('   2. Store them securely in the configured secret manager');
        logger.info('   3. Update integration configurations to reference secure storage');

        const confirmation = await question('\nProceed with migration? (y/N): ');
        if (confirmation && confirmation.toLowerCase() !== 'y' && confirmation.toLowerCase() !== 'yes') {
          logger.info('❌ Migration cancelled');
          process.exit(0);
        }
      }

      logger.info('🚀 Starting credential migration...');

      const results = await secureConfigService.migrateToSecureCredentials();

      logger.info('\n✅ Migration completed!');
      logger.info('─'.repeat(40));
      logger.info(`Migrated Integrations: ${results.migratedIntegrations}`);
      logger.info(`Migrated Credentials: ${results.migratedCredentials}`);

      if (results.errors.length > 0) {
        logger.info('\n❌ Errors encountered:');
        for (const error of results.errors) {
          logger.info(`   • ${error}`);
        }
      }
    } catch (error) {
      logger.error('❌ Migration failed', error);
      process.exit(1);
    } finally {
      closeRl();
    }
  });

// Export template command
program
  .command('export-template')
  .description('Export credential template for a system type')
  .requiredOption('-t, --type <type>', 'System type')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options: ExportTemplateCommandOptions) => {
    try {
      const templates = {
        'NetSuite': {
          accountId: 'your_account_id',
          consumerKey: 'your_consumer_key',
          consumerSecret: 'your_consumer_secret',
          tokenId: 'your_token_id',
          tokenSecret: 'your_token_secret',
          baseUrl: 'https://your_account.suitetalk.api.netsuite.com',
        },
        'Salesforce': {
          clientId: 'your_client_id',
          clientSecret: 'your_client_secret',
          username: 'your_username',
          password: 'your_password',
          securityToken: 'your_security_token',
          loginUrl: 'https://login.salesforce.com',
        },
        'Dynamics365': {
          tenantId: 'your_tenant_id',
          clientId: 'your_client_id',
          clientSecret: 'your_client_secret',
          resourceUrl: 'https://your_org.crm.dynamics.com',
        },
        'SAP': {
          username: 'your_username',
          password: 'your_password',
          host: 'sap-server.company.com',
          port: '8000',
          client: '100',
          systemId: 'DEV',
        },
        'Oracle': {
          username: 'your_username',
          password: 'your_password',
          host: 'oracle-db.company.com',
          port: '8080',
          serviceName: 'XEPDB1',
        },
        'BusinessCentral': {
          clientId: 'your_client_id',
          clientSecret: 'your_client_secret',
          tenantId: 'your_tenant_id',
          environment: 'sandbox',
          companyId: 'your_company_id',
        },
      };

      const template = templates[options.type as keyof typeof templates];
      if (!template) {
        logger.error(`❌ Unknown system type: ${options.type}`);
        logger.info(`Available types: ${Object.keys(templates).join(', ')}`);
        process.exit(1);
      }

      const templateJson = JSON.stringify(template, null, 2);

      if (options.output) {
        const fs = await import('fs/promises');
        await fs.writeFile(options.output, templateJson);
        logger.info(`✅ Template exported to ${options.output}`);
      } else {
        logger.info(templateJson);
      }
    } catch (error) {
      logger.error('❌ Failed to export template', error);
      process.exit(1);
    }
  });

// Parse command line arguments
if (require.main === module) {
  program.parse();
}
