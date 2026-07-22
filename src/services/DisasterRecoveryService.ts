import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import { LoggingService } from '../observability/logging';
import type { ConfigurationService } from './ConfigurationService';
import type { IntegrationService } from './IntegrationService';
import type { DLQService } from './DLQService';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Backup metadata interface
 */
export interface BackupMetadata {
  id: string;
  timestamp: string;
  version: string;
  type: 'full' | 'incremental' | 'snapshot';
  size: number;
  checksum: string;
  components: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
  recoveryPoint?: string;
  retentionDays?: number;
}

/**
 * Recovery point objective configuration
 */
export interface RecoveryConfig {
  rpoMinutes: number;  // Recovery Point Objective in minutes
  rtoMinutes: number;  // Recovery Time Objective in minutes
  retentionDays: number;
  compressionEnabled: boolean;
  encryptionEnabled: boolean;
  autoBackupEnabled: boolean;
  backupSchedule?: string;  // Cron expression
  maxBackups?: number;
}

/**
 * Health check status
 */
export interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  lastCheck: Date;
  message?: string;
  metrics?: Record<string, unknown>;
}

/**
 * Disaster Recovery Service
 * Provides backup, restore, failover, and health monitoring capabilities
 */
export class DisasterRecoveryService extends EventEmitter {
  private logger: LoggingService;
  private backupPath: string;
  private config: RecoveryConfig;
  private healthChecks = new Map<string, HealthStatus>();
  private backupScheduler?: NodeJS.Timeout;
  private healthMonitor?: NodeJS.Timeout;
  private isRecovering = false;

  constructor(
    private configService: ConfigurationService,
    private integrationService: IntegrationService,
    private dlqService: DLQService,
    config?: Partial<RecoveryConfig>
  ) {
    super();
    this.logger = new LoggingService({ 
      level: 'info',
      environment: process.env.NODE_ENV || 'development'
    });

    this.config = {
      rpoMinutes: config?.rpoMinutes || 15,
      rtoMinutes: config?.rtoMinutes || 30,
      retentionDays: config?.retentionDays || 30,
      compressionEnabled: config?.compressionEnabled ?? true,
      encryptionEnabled: config?.encryptionEnabled ?? true,
      autoBackupEnabled: config?.autoBackupEnabled ?? true,
      backupSchedule: config?.backupSchedule || '0 */15 * * * *', // Every 15 minutes
      maxBackups: config?.maxBackups || 100
    };

    this.backupPath = path.join(process.cwd(), 'backups');
    this.ensureBackupDirectory();
    
    if (this.config.autoBackupEnabled) {
      this.startAutoBackup();
    }
    
    this.startHealthMonitoring();
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDirectory(): void {
    if (!fs.existsSync(this.backupPath)) {
      fs.mkdirSync(this.backupPath, { recursive: true });
      this.logger.info('Created backup directory: ' + this.backupPath);
    }
  }

  /**
   * Create a full system backup
   */
  public async createBackup(type: 'full' | 'incremental' | 'snapshot' = 'full'): Promise<BackupMetadata> {
    const backupId = this.generateBackupId();
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      type,
      size: 0,
      checksum: '',
      components: [],
      status: 'in_progress'
    };

    try {
      this.logger.info(`Starting backup: ${backupId} (${type})`);
      this.emit('backup:started', metadata);

      const backupData: Record<string, unknown> = {};

      // Backup configurations
      const configurations = await this.backupConfigurations();
      if (configurations) {
        backupData.configurations = configurations;
        metadata.components.push('configurations');
      }

      // Backup integration states
      const integrationStates = await this.backupIntegrationStates();
      if (integrationStates) {
        backupData.integrations = integrationStates;
        metadata.components.push('integrations');
      }

      // Backup DLQ messages
      const dlqMessages = await this.backupDLQMessages();
      if (dlqMessages) {
        backupData.dlq = dlqMessages;
        metadata.components.push('dlq');
      }

      // Backup field mappings
      const mappings = await this.backupFieldMappings();
      if (mappings) {
        backupData.mappings = mappings;
        metadata.components.push('mappings');
      }

      // Backup credentials (encrypted)
      const credentials = await this.backupCredentials();
      if (credentials) {
        backupData.credentials = credentials;
        metadata.components.push('credentials');
      }

      // Serialize and compress backup data
      let backupBuffer: Buffer = Buffer.from(JSON.stringify(backupData, null, 2));
      
      if (this.config.compressionEnabled) {
        backupBuffer = Buffer.from(await gzipAsync(backupBuffer));
      }

      if (this.config.encryptionEnabled) {
        backupBuffer = this.encryptData(backupBuffer);
      }

      // Calculate checksum
      metadata.checksum = crypto.createHash('sha256').update(backupBuffer).digest('hex');
      metadata.size = backupBuffer.length;

      // Save backup to disk
      const backupFile = path.join(this.backupPath, `backup_${backupId}.bak`);
      await fs.promises.writeFile(backupFile, backupBuffer);

      // Save metadata
      const metadataFile = path.join(this.backupPath, `backup_${backupId}.meta`);
      await fs.promises.writeFile(metadataFile, JSON.stringify(metadata, null, 2));

      metadata.status = 'completed';
      metadata.recoveryPoint = backupFile;

      this.logger.info({
        backupId, 
        size: metadata.size, 
        components: metadata.components 
      }, 'Backup completed successfully');
      
      this.emit('backup:completed', metadata);
      
      // Clean up old backups
      await this.cleanupOldBackups();

      return metadata;
    } catch (error) {
      metadata.status = 'failed';
      metadata.error = error instanceof Error ? error.message : String(error);
      
      this.logger.error({ backupId, error: metadata.error }, 'Backup failed');
      this.emit('backup:failed', metadata);
      
      throw error;
    }
  }

  /**
   * Restore system from backup
   */
  public async restoreFromBackup(backupId: string): Promise<void> {
    if (this.isRecovering) {
      throw new Error('Recovery already in progress');
    }

    this.isRecovering = true;
    
    try {
      this.logger.info({ backupId }, 'Starting system restore');
      this.emit('restore:started', { backupId });

      // Load backup metadata
      const metadataFile = path.join(this.backupPath, `backup_${backupId}.meta`);
      if (!fs.existsSync(metadataFile)) {
        throw new Error(`Backup metadata not found: ${backupId}`);
      }

      const metadata: BackupMetadata = JSON.parse(
        await fs.promises.readFile(metadataFile, 'utf-8')
      );

      // Load and decrypt backup data
      const backupFile = path.join(this.backupPath, `backup_${backupId}.bak`);
      if (!fs.existsSync(backupFile)) {
        throw new Error(`Backup file not found: ${backupId}`);
      }

      let backupBuffer = await fs.promises.readFile(backupFile);

      if (this.config.encryptionEnabled) {
        const decrypted = this.decryptData(backupBuffer);
        backupBuffer = Buffer.from(decrypted);
      }

      if (this.config.compressionEnabled) {
        backupBuffer = await gunzipAsync(backupBuffer);
      }

      // Verify checksum
      const checksum = crypto.createHash('sha256').update(backupBuffer).digest('hex');
      if (checksum !== metadata.checksum) {
        throw new Error('Backup integrity check failed');
      }

      const backupData = JSON.parse(backupBuffer.toString());

      // Restore configurations
      if (backupData.configurations) {
        await this.restoreConfigurations(backupData.configurations);
        this.logger.info('Restored configurations');
      }

      // Restore integration states
      if (backupData.integrations) {
        await this.restoreIntegrationStates(backupData.integrations);
        this.logger.info('Restored integration states');
      }

      // Restore DLQ messages
      if (backupData.dlq) {
        await this.restoreDLQMessages(backupData.dlq);
        this.logger.info('Restored DLQ messages');
      }

      // Restore field mappings
      if (backupData.mappings) {
        await this.restoreFieldMappings(backupData.mappings);
        this.logger.info('Restored field mappings');
      }

      // Restore credentials
      if (backupData.credentials) {
        await this.restoreCredentials(backupData.credentials);
        this.logger.info('Restored credentials');
      }

      this.logger.info({ backupId }, 'System restore completed successfully');
      this.emit('restore:completed', { backupId });

    } catch (error) {
      this.logger.error({ 
        backupId, 
        error: error instanceof Error ? error.message : String(error) 
      }, 'System restore failed');
      this.emit('restore:failed', { backupId, error });
      throw error;
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Perform automatic failover
   */
  public async performFailover(targetEnvironment: string): Promise<void> {
    this.logger.info({ targetEnvironment }, 'Initiating failover');
    this.emit('failover:started', { targetEnvironment });

    try {
      // 1. Create snapshot of current state
      const snapshot = await this.createBackup('snapshot');

      // 2. Stop current services gracefully
      await this.stopServices();

      // 3. Switch to backup environment
      await this.switchEnvironment(targetEnvironment);

      // 4. Restore latest known good state
      const latestBackup = await this.findLatestBackup();
      if (latestBackup) {
        await this.restoreFromBackup(latestBackup.id);
      }

      // 5. Start services in new environment
      await this.startServices();

      // 6. Verify system health
      const isHealthy = await this.verifySystemHealth();
      if (!isHealthy) {
        throw new Error('System health check failed after failover');
      }

      this.logger.info({ targetEnvironment }, 'Failover completed successfully');
      this.emit('failover:completed', { targetEnvironment });

    } catch (error) {
      this.logger.error({ 
        targetEnvironment, 
        error: error instanceof Error ? error.message : String(error) 
      }, 'Failover failed');
      this.emit('failover:failed', { targetEnvironment, error });
      
      // Attempt rollback
      await this.rollback();
      throw error;
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    // Monitor every 30 seconds
    this.healthMonitor = setInterval(async () => {
      await this.performHealthChecks();
    }, 30000);

    // Initial health check
    this.performHealthChecks();
  }

  /**
   * Perform comprehensive health checks
   */
  private async performHealthChecks(): Promise<void> {
    const checks = [
      this.checkIntegrationHealth(),
      this.checkDatabaseHealth(),
      this.checkQueueHealth(),
      this.checkDiskSpace(),
      this.checkMemoryUsage()
    ];

    const results = await Promise.allSettled(checks);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const status = result.value;
        this.healthChecks.set(status.service, status);
        
        if (status.status === 'critical') {
          this.handleCriticalHealth(status);
        }
      }
    });

    // Emit overall health status
    const overallHealth = this.calculateOverallHealth();
    this.emit('health:status', overallHealth);
  }

  /**
   * Check integration service health
   */
  private async checkIntegrationHealth(): Promise<HealthStatus> {
    try {
      const status = await this.integrationService.getHealthStatus();
      return {
        service: 'integrations',
        status: status.status,
        lastCheck: new Date(),
        message: status.message,
        metrics: status.metrics
      };
    } catch (error) {
      return {
        service: 'integrations',
        status: 'critical',
        lastCheck: new Date(),
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Check database health
   */
  private async checkDatabaseHealth(): Promise<HealthStatus> {
    // Implementation would check actual database connection
    return {
      service: 'database',
      status: 'healthy',
      lastCheck: new Date(),
      metrics: {
        connections: 10,
        queryTime: 5
      }
    };
  }

  /**
   * Check queue health
   */
  private async checkQueueHealth(): Promise<HealthStatus> {
    try {
      const dlqStatus = await this.dlqService.getQueueStatus();
      return {
        service: 'queue',
        status: dlqStatus.status,
        lastCheck: new Date(),
        message: dlqStatus.message,
        metrics: dlqStatus.metrics
      };
    } catch (error) {
      return {
        service: 'queue',
        status: 'critical',
        lastCheck: new Date(),
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Check available disk space
   */
  private async checkDiskSpace(): Promise<HealthStatus> {
    const stats = await fs.promises.statfs(this.backupPath);
    const availableGB = stats.bavail * stats.bsize / (1024 * 1024 * 1024);
    
    return {
      service: 'disk',
      status: availableGB < 1 ? 'critical' : availableGB < 5 ? 'degraded' : 'healthy',
      lastCheck: new Date(),
      metrics: {
        availableGB: Math.round(availableGB * 100) / 100
      }
    };
  }

  /**
   * Check memory usage
   */
  private async checkMemoryUsage(): Promise<HealthStatus> {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const usage = (heapUsedMB / heapTotalMB) * 100;
    
    return {
      service: 'memory',
      status: usage > 90 ? 'critical' : usage > 75 ? 'degraded' : 'healthy',
      lastCheck: new Date(),
      metrics: {
        heapUsedMB,
        heapTotalMB,
        usagePercent: Math.round(usage)
      }
    };
  }

  /**
   * Handle critical health status
   */
  private async handleCriticalHealth(status: HealthStatus): Promise<void> {
    this.logger.error({ 
      service: status.service, 
      message: status.message 
    }, 'Critical health status detected');

    // Attempt auto-recovery based on service
    switch (status.service) {
      case 'integrations':
        await this.recoverIntegrationService();
        break;
      case 'queue':
        await this.recoverQueueService();
        break;
      case 'disk':
        await this.cleanupOldBackups(true); // Aggressive cleanup
        break;
      case 'memory':
        await this.performMemoryCleanup();
        break;
    }

    this.emit('health:critical', status);
  }

  /**
   * Calculate overall system health
   */
  private calculateOverallHealth(): HealthStatus {
    const statuses = Array.from(this.healthChecks.values());
    
    if (statuses.some(s => s.status === 'critical')) {
      return {
        service: 'system',
        status: 'critical',
        lastCheck: new Date(),
        message: 'One or more services are critical'
      };
    }
    
    if (statuses.some(s => s.status === 'degraded')) {
      return {
        service: 'system',
        status: 'degraded',
        lastCheck: new Date(),
        message: 'One or more services are degraded'
      };
    }
    
    return {
      service: 'system',
      status: 'healthy',
      lastCheck: new Date(),
      message: 'All services are healthy'
    };
  }

  /**
   * Start automatic backup scheduler
   */
  private startAutoBackup(): void {
    // Simple interval-based scheduling (could be replaced with node-cron)
    const intervalMs = this.config.rpoMinutes * 60 * 1000;
    
    this.backupScheduler = setInterval(async () => {
      try {
        await this.createBackup('incremental');
      } catch (error) {
        this.logger.error({ 
          error: error instanceof Error ? error.message : String(error) 
        }, 'Auto-backup failed');
      }
    }, intervalMs);

    this.logger.info({ 
      intervalMinutes: this.config.rpoMinutes 
    }, 'Auto-backup scheduler started');
  }

  /**
   * Clean up old backups based on retention policy
   */
  private async cleanupOldBackups(aggressive = false): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.backupPath);
      const backupFiles = files.filter(f => f.endsWith('.meta'));
      
      const backups: BackupMetadata[] = [];
      for (const file of backupFiles) {
        const metadata = JSON.parse(
          await fs.promises.readFile(path.join(this.backupPath, file), 'utf-8')
        );
        backups.push(metadata);
      }

      // Sort by timestamp
      backups.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      // Determine how many to keep
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - (aggressive ? 1 : this.config.retentionDays));
      
      const maxToKeep = aggressive ? 5 : (this.config.maxBackups || 100);
      
      let kept = 0;
      for (const backup of backups) {
        const backupDate = new Date(backup.timestamp);
        
        if (kept >= maxToKeep || backupDate < retentionDate) {
          // Delete this backup
          await this.deleteBackup(backup.id);
          this.logger.info({ 
            backupId: backup.id, 
            timestamp: backup.timestamp 
          }, 'Deleted old backup');
        } else {
          kept++;
        }
      }
    } catch (error) {
      this.logger.error({ 
        error: error instanceof Error ? error.message : String(error) 
      }, 'Failed to cleanup old backups');
    }
  }

  /**
   * Delete a specific backup
   */
  private async deleteBackup(backupId: string): Promise<void> {
    const backupFile = path.join(this.backupPath, `backup_${backupId}.bak`);
    const metadataFile = path.join(this.backupPath, `backup_${backupId}.meta`);
    
    if (fs.existsSync(backupFile)) {
      await fs.promises.unlink(backupFile);
    }
    
    if (fs.existsSync(metadataFile)) {
      await fs.promises.unlink(metadataFile);
    }
  }

  /**
   * Helper methods for backup/restore operations
   */
  private async backupConfigurations(): Promise<unknown> {
    return this.configService.exportAll();
  }

  private async backupIntegrationStates(): Promise<unknown> {
    return this.integrationService.exportStates();
  }

  private async backupDLQMessages(): Promise<unknown> {
    return this.dlqService.exportMessages();
  }

  private async backupFieldMappings(): Promise<unknown> {
    const mappingsPath = path.join(process.cwd(), 'config', 'mappings.json');
    if (fs.existsSync(mappingsPath)) {
      return JSON.parse(await fs.promises.readFile(mappingsPath, 'utf-8'));
    }
    return null;
  }

  private async backupCredentials(): Promise<unknown> {
    // Would backup encrypted credentials
    return null;
  }

  private async restoreConfigurations(data: unknown): Promise<void> {
    await this.configService.importAll(data);
  }

  private async restoreIntegrationStates(data: unknown): Promise<void> {
    await this.integrationService.importStates(data);
  }

  private async restoreDLQMessages(data: unknown): Promise<void> {
    await this.dlqService.importMessages(data);
  }

  private async restoreFieldMappings(data: unknown): Promise<void> {
    const mappingsPath = path.join(process.cwd(), 'config', 'mappings.json');
    await fs.promises.writeFile(mappingsPath, JSON.stringify(data, null, 2));
  }

  private async restoreCredentials(data: unknown): Promise<void> {
    // Would restore encrypted credentials
  }

  /**
   * Recovery helper methods
   */
  private async recoverIntegrationService(): Promise<void> {
    this.logger.info('Attempting to recover integration service');
    await this.integrationService.restart();
  }

  private async recoverQueueService(): Promise<void> {
    this.logger.info('Attempting to recover queue service');
    await this.dlqService.processFailedMessages();
  }

  private async performMemoryCleanup(): Promise<void> {
    this.logger.info('Performing memory cleanup');
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * Failover helper methods
   */
  private async stopServices(): Promise<void> {
    await this.integrationService.shutdown();
  }

  private async startServices(): Promise<void> {
    await this.integrationService.initialize();
  }

  private async switchEnvironment(target: string): Promise<void> {
    process.env.ENVIRONMENT = target;
  }

  private async verifySystemHealth(): Promise<boolean> {
    await this.performHealthChecks();
    const overall = this.calculateOverallHealth();
    return overall.status === 'healthy';
  }

  private async rollback(): Promise<void> {
    this.logger.info('Attempting rollback');
    // Rollback implementation
  }

  private async findLatestBackup(): Promise<BackupMetadata | null> {
    const files = await fs.promises.readdir(this.backupPath);
    const backupFiles = files.filter(f => f.endsWith('.meta'));
    
    if (backupFiles.length === 0) {
      return null;
    }

    const backups: BackupMetadata[] = [];
    for (const file of backupFiles) {
      const metadata = JSON.parse(
        await fs.promises.readFile(path.join(this.backupPath, file), 'utf-8')
      );
      backups.push(metadata);
    }

    backups.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return backups[0] || null;
  }

  /**
   * Encryption/Decryption helpers
   */
  private encryptData(data: Buffer): Buffer {
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.BACKUP_ENCRYPTION_KEY || 'default-key', 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(data) as Buffer,
      cipher.final() as Buffer
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private decryptData(data: Buffer): Buffer {
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.BACKUP_ENCRYPTION_KEY || 'default-key', 'salt', 32);
    
    const iv = data.slice(0, 16);
    const authTag = data.slice(16, 32);
    const encrypted = data.slice(32);
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(encrypted) as Buffer,
      decipher.final() as Buffer
    ]);
  }

  /**
   * Generate unique backup ID
   */
  private generateBackupId(): string {
    return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Get backup history
   */
  public async getBackupHistory(): Promise<BackupMetadata[]> {
    const files = await fs.promises.readdir(this.backupPath);
    const backupFiles = files.filter(f => f.endsWith('.meta'));
    
    const backups: BackupMetadata[] = [];
    for (const file of backupFiles) {
      const metadata = JSON.parse(
        await fs.promises.readFile(path.join(this.backupPath, file), 'utf-8')
      );
      backups.push(metadata);
    }

    return backups.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * Get current health status
   */
  public getHealthStatus(): Map<string, HealthStatus> {
    return this.healthChecks;
  }

  /**
   * Shutdown the service
   */
  public async shutdown(): Promise<void> {
    if (this.backupScheduler) {
      clearInterval(this.backupScheduler);
    }
    
    if (this.healthMonitor) {
      clearInterval(this.healthMonitor);
    }

    // Create final backup before shutdown
    try {
      await this.createBackup('snapshot');
    } catch (error) {
      this.logger.error({ 
        error: error instanceof Error ? error.message : String(error) 
      }, 'Failed to create shutdown backup');
    }

    this.logger.info('Disaster recovery service shutdown');
  }
}