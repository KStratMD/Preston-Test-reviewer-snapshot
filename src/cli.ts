#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { SquireSupplierSyncFlow, SupplierSyncOptions } from './flows/runSquireSupplierSync';
import { SquireInstallerSyncFlow, InstallerSyncOptions } from './flows/runSquireInstallerSync';
import { SuiteCentralPayoutSyncFlow, PayoutSyncOptions } from './flows/runSuiteCentralPayoutSync';
import { Logger, logger } from './utils/Logger';
import { getSampleRecords } from './data/squireMockData';
import type { SyncResult } from './types';

// ASCII art logo
const LOGO = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ███████╗██╗   ██╗██╗████████╗███████╗ ██████╗███████╗███╗   ║
║   ██╔════╝██║   ██║██║╚══██╔══╝██╔════╝██╔════╝██╔════╝████╗  ║
║   ███████╗██║   ██║██║   ██║   █████╗  ██║     █████╗  ██╔██╗ ║
║   ╚════██║██║   ██║██║   ██║   ██╔══╝  ██║     ██╔══╝  ██║╚██║║
║   ███████║╚██████╔╝██║   ██║   ███████╗╚██████╗███████╗██║ ╚████
║   ╚══════╝ ╚═════╝ ╚═╝   ╚═╝   ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═══║
║                                                               ║
║            Integration Hub - SuiteCentral Demo CLI           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`;

class CLIRunner {
  private spinner?: Ora;

  constructor() {
  }

  private startSpinner(message: string): void {
    this.spinner = ora({
      text: chalk.cyan(message),
      spinner: 'dots12',
    }).start();
  }

  private updateSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.text = chalk.cyan(message);
    }
  }

  private stopSpinner(success: boolean, message: string): void {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(chalk.green(message));
      } else {
        this.spinner.fail(chalk.red(message));
      }
    }
  }

  public printHeader(): void {
    console.clear();
    console.log(chalk.blue(LOGO));
    console.log(chalk.gray('Demonstrating seamless integration between Squire and SuiteCentral modules'));
    console.log('');
  }

  private printSyncResult(result: SyncResult, module: string): void {
    console.log('');
    console.log(chalk.bold(`📊 ${module} Sync Results:`));
    console.log('══════════════════════════════════════════════');
    
    // Status indicator
    const statusIcon = result.success ? '✅' : result.recordsSuccessful > 0 ? '⚠️' : '❌';
    const statusColor = result.success ? 'green' : result.recordsSuccessful > 0 ? 'yellow' : 'red';
    console.log(`Status: ${statusIcon} ${chalk[statusColor](result.status.toUpperCase())}`);
    
    // Metrics
    console.log(`Records Processed: ${chalk.cyan(result.recordsProcessed)}`);
    console.log(`Records Successful: ${chalk.green(result.recordsSuccessful)}`);
    console.log(`Records Failed: ${chalk.red(result.recordsFailed)}`);
    
    // Duration
    const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
    console.log(`Duration: ${chalk.blue(duration.toFixed(2))}s`);
    
    // Financial info for payout sync
    if (result.metadata?.totalPayoutValue) {
      console.log(`Total Payout Value: ${chalk.green('$' + result.metadata.totalPayoutValue.toLocaleString())}`);
      console.log(`Average Payout: ${chalk.cyan('$' + result.metadata.averagePayoutAmount)}`);
    }
    
    // Warnings and errors
    if (result.warnings && result.warnings.length > 0) {
      console.log(`Warnings: ${chalk.yellow(result.warnings.length)}`);
      result.warnings.slice(0, 3).forEach(warning => {
        console.log(`  ⚠️  ${chalk.yellow(warning)}`);
      });
      if (result.warnings.length > 3) {
        console.log(`  ... and ${result.warnings.length - 3} more warnings`);
      }
    }
    
    if (result.errors && result.errors.length > 0) {
      console.log(`Errors: ${chalk.red(result.errors.length)}`);
      result.errors.slice(0, 3).forEach(error => {
        console.log(`  ❌  ${chalk.red(error)}`);
      });
      if (result.errors.length > 3) {
        console.log(`  ... and ${result.errors.length - 3} more errors`);
      }
    }
    
    console.log('══════════════════════════════════════════════');
  }

  async runSupplierSync(options: SupplierSyncOptions): Promise<void> {
    this.printHeader();
    console.log(chalk.bold.blue('🏢 Squire → SuiteCentral SupplierCentral Integration'));
    console.log('');
    
    const flow = new SquireSupplierSyncFlow();
    
    try {
      this.startSpinner('Connecting to Squire vendor system...');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      this.updateSpinner('Loading vendor records from Squire...');
      await new Promise(resolve => setTimeout(resolve, 300));
      
      this.updateSpinner('Applying field mappings and transformations...');
      const result = await flow.execute(options);
      
      this.stopSpinner(result.success, 'Supplier sync completed');
      this.printSyncResult(result, 'SupplierCentral');
      
      if (!options.dryRun && result.success) {
        console.log('');
        console.log(chalk.green('🎉 Vendors successfully synchronized to SuiteCentral SupplierCentral!'));
        console.log(chalk.gray('Data is now available in NetSuite through SuiteCentral\'s native integration.'));
      }
    } catch (error) {
      this.stopSpinner(false, 'Supplier sync failed');
      logger.error(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
    }
  }

  async runInstallerSync(options: InstallerSyncOptions): Promise<void> {
    this.printHeader();
    console.log(chalk.bold.blue('👷 Squire → SuiteCentral InstallerCentral Integration'));
    console.log('');
    
    const flow = new SquireInstallerSyncFlow();
    
    try {
      this.startSpinner('Connecting to Squire installer network...');
      await new Promise(resolve => setTimeout(resolve, 600));
      
      this.updateSpinner('Validating installer licenses and certifications...');
      await new Promise(resolve => setTimeout(resolve, 400));
      
      this.updateSpinner('Processing installer availability and capacity data...');
      const result = await flow.execute(options);
      
      this.stopSpinner(result.success, 'Installer sync completed');
      this.printSyncResult(result, 'InstallerCentral');
      
      if (!options.dryRun && result.success) {
        console.log('');
        console.log(chalk.green('🎉 Installers successfully synchronized to SuiteCentral InstallerCentral!'));
        console.log(chalk.gray('Installer capacity and scheduling data now available in NetSuite.'));
      }
      
      // Show availability report
      console.log('');
      this.startSpinner('Generating installer availability report...');
      const report = await flow.getAvailabilityReport();
      this.stopSpinner(true, 'Availability report generated');
      
      console.log('');
      console.log(chalk.bold('👥 Installer Availability Summary:'));
      console.log('────────────────────────────────────────────');
      console.log(`Total Installers: ${chalk.cyan(report.totalInstallers)}`);
      console.log(`Available: ${chalk.green(report.availableInstallers)}`);
      console.log(`Booked: ${chalk.yellow(report.bookedInstallers)}`);
      console.log(`Unavailable: ${chalk.red(report.unavailableInstallers)}`);
      console.log(`Average Capacity Score: ${chalk.blue(report.averageCapacity.toFixed(1))}/20`);
      
    } catch (error) {
      this.stopSpinner(false, 'Installer sync failed');
      logger.error(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
    }
  }

  async runPayoutSync(options: PayoutSyncOptions): Promise<void> {
    this.printHeader();
    console.log(chalk.bold.blue('💰 Squire → SuiteCentral PayoutCentral Integration'));
    console.log('');
    
    const flow = new SuiteCentralPayoutSyncFlow();
    
    try {
      this.startSpinner('Connecting to Squire project management system...');
      await new Promise(resolve => setTimeout(resolve, 700));
      
      this.updateSpinner('Calculating commission and bonus payouts...');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      this.updateSpinner('Performing financial validation and compliance checks...');
      const result = await flow.execute(options);
      
      this.stopSpinner(result.success, 'Payout sync completed');
      this.printSyncResult(result, 'PayoutCentral');
      
      if (!options.dryRun && result.success) {
        console.log('');
        console.log(chalk.green('🎉 Payouts successfully synchronized to SuiteCentral PayoutCentral!'));
        console.log(chalk.gray('Financial data and commission calculations now available in NetSuite.'));
      }
      
      // Show financial report
      console.log('');
      this.startSpinner('Generating financial summary report...');
      const report = await flow.generateFinancialReport();
      this.stopSpinner(true, 'Financial report generated');
      
      console.log('');
      console.log(chalk.bold('💼 Financial Summary:'));
      console.log('────────────────────────────────────────────');
      console.log(`Total Projects: ${chalk.cyan(report.totalProjects)}`);
      console.log(`Total Project Value: ${chalk.green('$' + report.totalProjectValue.toLocaleString())}`);
      console.log(`Total Commissions: ${chalk.blue('$' + report.totalCommissions.toLocaleString())}`);
      console.log(`Total Bonuses: ${chalk.yellow('$' + report.totalBonuses.toLocaleString())}`);
      console.log(`Average Commission Rate: ${chalk.magenta(report.averageCommissionRate + '%')}`);
      
    } catch (error) {
      this.stopSpinner(false, 'Payout sync failed');
      logger.error(chalk.red('❌ Error:'), error instanceof Error ? error.message : String(error));
    }
  }

  async runFullDemo(): Promise<void> {
    this.printHeader();
    console.log(chalk.bold.green('🚀 Complete SuiteCentral Integration Demo'));
    console.log(chalk.gray('Running all three integration flows sequentially...'));
    console.log('');
    
    const demoOptions = { dryRun: false, logLevel: 'info' as const };
    
    try {
      // Run each integration with a pause between
      await this.runSupplierSync(demoOptions);
      
      console.log('');
      console.log(chalk.gray('Pausing before next integration...'));
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.runInstallerSync(demoOptions);
      
      console.log('');
      console.log(chalk.gray('Pausing before final integration...'));
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.runPayoutSync(demoOptions);
      
      // Final summary
      console.log('');
      console.log(chalk.bold.green('🎊 Complete SuiteCentral Integration Demo Finished!'));
      console.log('');
      console.log(chalk.bold('📋 Demo Summary:'));
      console.log('══════════════════════════════════════════════════════════════');
      console.log('✅ Squire vendors synchronized to SuiteCentral SupplierCentral');
      console.log('✅ Squire installers synchronized to SuiteCentral InstallerCentral');
      console.log('✅ Squire projects synchronized to SuiteCentral PayoutCentral');
      console.log('══════════════════════════════════════════════════════════════');
      console.log('');
      console.log(chalk.green('All data is now flowing through SuiteCentral\'s native NetSuite integration!'));
      console.log(chalk.gray('This demonstrates how external systems like Squire can leverage'));
      console.log(chalk.gray('SuiteCentral\'s specialized modules for enhanced business workflows.'));
      
    } catch (error) {
      logger.error(chalk.red('❌ Demo failed:'), error instanceof Error ? error.message : String(error));
    }
  }

  async showDataSamples(): Promise<void> {
    this.printHeader();
    console.log(chalk.bold.blue('📊 Sample Data Preview'));
    console.log('');
    
    const vendors = getSampleRecords('vendors');
    const installers = getSampleRecords('installers');
    const projects = getSampleRecords('projects');
    
    console.log(chalk.bold('🏢 Sample Vendors:'));
    console.log('─'.repeat(50));
    vendors.slice(0, 2).forEach(vendor => {
      console.log(`• ${chalk.cyan(vendor.vendorName)} (${vendor.vendorCategory})`);
      console.log(`  Status: ${chalk.green(vendor.approvalStatus)} | Rating: ${chalk.yellow(vendor.qualityRating)}/5`);
      console.log(`  Contact: ${vendor.contactPerson} - ${vendor.vendorEmail}`);
    });
    
    console.log('');
    console.log(chalk.bold('👷 Sample Installers:'));
    console.log('─'.repeat(50));
    installers.slice(0, 2).forEach(installer => {
      console.log(`• ${chalk.cyan(installer.installerName)} (${installer.businessName})`);
      console.log(`  Status: ${chalk.green(installer.availabilityStatus)} | Rating: ${chalk.yellow(installer.averageRating)}/5`);
      console.log(`  Specializations: ${(installer as any).specializations.join(', ')}`);
    });
    
    console.log('');
    console.log(chalk.bold('💼 Sample Projects:'));
    console.log('─'.repeat(50));
    projects.slice(0, 2).forEach(project => {
      console.log(`• ${chalk.cyan(project.projectNumber)} - ${project.projectType}`);
      console.log(`  Customer: ${project.customerName} | Value: ${chalk.green('$' + (project as any).projectValue.toLocaleString())}`);
      console.log(`  Status: ${chalk.blue(project.projectStatus)} | Commission: ${chalk.magenta(((project as any).commissionRate * 100) + '%')}`);
    });
    
    console.log('');
    console.log(chalk.gray('This sample data demonstrates the rich integration possibilities'));
    console.log(chalk.gray('between Squire and SuiteCentral\'s specialized business modules.'));
  }
}

// CLI Program Definition
async function main(): Promise<void> {
  const cli = new CLIRunner();
  
  program
    .name('suitecentral-cli')
    .description('SuiteCentral Integration Hub Demo CLI')
    .version('1.0.0');

  // Supplier sync command
  program
    .command('supplier-sync')
    .description('Run Squire → SuiteCentral SupplierCentral integration')
    .option('--dry-run', 'Run in dry-run mode (no actual sync)', false)
    .option('--batch-size <number>', 'Batch size for processing', '10')
    .option('--include-inactive', 'Include inactive vendors', false)
    .option('--category <categories...>', 'Filter by vendor categories')
    .option('--log-level <level>', 'Set logging level', 'info')
    .action(async (options) => {
      const syncOptions: SupplierSyncOptions = {
        dryRun: options.dryRun,
        batchSize: parseInt(options.batchSize),
        includeInactive: options.includeInactive,
        filterByCategory: options.category,
        logLevel: options.logLevel,
      };
      await cli.runSupplierSync(syncOptions);
    });

  // Installer sync command
  program
    .command('installer-sync')
    .description('Run Squire → SuiteCentral InstallerCentral integration')
    .option('--dry-run', 'Run in dry-run mode (no actual sync)', false)
    .option('--batch-size <number>', 'Batch size for processing', '10')
    .option('--include-unavailable', 'Include unavailable installers', false)
    .option('--specialization <specializations...>', 'Filter by specializations')
    .option('--min-rating <number>', 'Minimum rating filter', '0')
    .option('--max-radius <number>', 'Maximum service radius filter')
    .option('--log-level <level>', 'Set logging level', 'info')
    .action(async (options) => {
      const syncOptions: InstallerSyncOptions = {
        dryRun: options.dryRun,
        batchSize: parseInt(options.batchSize),
        includeUnavailable: options.includeUnavailable,
        filterBySpecialization: options.specialization,
        minRating: parseFloat(options.minRating),
        maxRadius: options.maxRadius ? parseInt(options.maxRadius) : undefined,
        logLevel: options.logLevel,
      };
      await cli.runInstallerSync(syncOptions);
    });

  // Payout sync command
  program
    .command('payout-sync')
    .description('Run Squire → SuiteCentral PayoutCentral integration')
    .option('--dry-run', 'Run in dry-run mode (no actual sync)', false)
    .option('--batch-size <number>', 'Batch size for processing', '5')
    .option('--include-incomplete', 'Include incomplete projects', false)
    .option('--status <statuses...>', 'Filter by project status')
    .option('--min-value <number>', 'Minimum project value filter', '0')
    .option('--log-level <level>', 'Set logging level', 'info')
    .action(async (options) => {
      const syncOptions: PayoutSyncOptions = {
        dryRun: options.dryRun,
        batchSize: parseInt(options.batchSize),
        includeIncomplete: options.includeIncomplete,
        filterByStatus: options.status,
        minProjectValue: parseFloat(options.minValue),
        logLevel: options.logLevel,
      };
      await cli.runPayoutSync(syncOptions);
    });

  // Full demo command
  program
    .command('full-demo')
    .description('Run complete SuiteCentral integration demonstration')
    .action(async () => {
      await cli.runFullDemo();
    });

  // Data preview command
  program
    .command('show-data')
    .description('Display sample data used in integrations')
    .action(async () => {
      await cli.showDataSamples();
    });

  // Parse command line arguments
  await program.parseAsync(process.argv);
  
  // If no command specified, show help
  if (process.argv.length <= 2) {
    cli.printHeader();
    console.log(chalk.bold.yellow('Available Commands:'));
    console.log('');
    console.log(`${chalk.green('supplier-sync')}    - Sync vendors to SuiteCentral SupplierCentral`);
    console.log(`${chalk.green('installer-sync')}   - Sync installers to SuiteCentral InstallerCentral`);
    console.log(`${chalk.green('payout-sync')}      - Sync payouts to SuiteCentral PayoutCentral`);
    console.log(`${chalk.green('full-demo')}        - Run complete integration demonstration`);
    console.log(`${chalk.green('show-data')}        - Preview sample data`);
    console.log('');
    console.log(chalk.gray('Use --help with any command for detailed options'));
    console.log('');
    program.help();
  }
}

// Run the CLI
if (require.main === module) {
  main().catch(error => {
    logger.error(chalk.red('CLI Error:'), error);
    process.exit(1);
  });
}

export { CLIRunner };
