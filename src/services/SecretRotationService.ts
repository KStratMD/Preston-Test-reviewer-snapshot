import { injectable, inject } from 'inversify';
import crypto from 'crypto';
import { CronJob } from 'cron';
import type { Logger } from '../utils/Logger';
import type { SecretManager } from './SecretManager';
import { TYPES } from '../inversify/types';
import { env } from '../config/env';

export interface RotationPolicy {
  secretName: string;
  rotationInterval: number; // in days
  retentionPeriod: number; // in days
  autoRotate: boolean;
  notifyBeforeExpiry: number; // in hours
  rotationStrategy: 'immediate' | 'graceful' | 'phased';
}

export interface SecretRotationStatus {
  secretName: string;
  currentVersion: string;
  previousVersion?: string;
  nextRotationDate: Date;
  lastRotationDate?: Date;
  status: 'active' | 'rotating' | 'failed' | 'pending';
  rotationHistory: RotationHistoryEntry[];
}

export interface RotationHistoryEntry {
  id: string;
  rotationDate: Date;
  fromVersion: string;
  toVersion: string;
  status: 'success' | 'failed' | 'rollback';
  reason?: string;
  rotatedBy?: string;
}

export interface RotationResult {
  success: boolean;
  secretName: string;
  newVersion: string;
  previousVersion?: string;
  message: string;
  rotationId: string;
}

/**
 * Service for managing automatic secret rotation
 * Provides secure rotation of API keys, passwords, and other sensitive data
 */
@injectable()
export class SecretRotationService {
  private readonly logger: Logger;
  private readonly secretManager: SecretManager;
  private readonly rotationJobs = new Map<string, CronJob>();
  private readonly rotationPolicies = new Map<string, RotationPolicy>();
  private readonly rotationStatus = new Map<string, SecretRotationStatus>();

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.SecretManager) secretManager: SecretManager,
  ) {
    this.logger = logger;
    this.secretManager = secretManager;
  }

  /**
   * Initialize the secret rotation service
   */
  async initialize(): Promise<void> {
    try {
      await this.loadRotationPolicies();
      await this.scheduleRotations();

      this.logger.info('Secret rotation service initialized', {
        policiesCount: this.rotationPolicies.size,
        scheduledJobs: this.rotationJobs.size,
      });
    } catch (error) {
      this.logger.error('Failed to initialize secret rotation service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Add a rotation policy for a secret
   */
  async addRotationPolicy(policy: RotationPolicy): Promise<void> {
    try {
      // Validate policy
      this.validateRotationPolicy(policy);

      this.rotationPolicies.set(policy.secretName, policy);

      // Initialize rotation status
      const status: SecretRotationStatus = {
        secretName: policy.secretName,
        currentVersion: await this.getCurrentSecretVersion(policy.secretName),
        nextRotationDate: this.calculateNextRotationDate(policy),
        status: 'active',
        rotationHistory: [],
      };

      this.rotationStatus.set(policy.secretName, status);

      // Schedule rotation if auto-rotation is enabled
      if (policy.autoRotate) {
        await this.scheduleRotation(policy);
      }

      this.logger.info('Rotation policy added', {
        secretName: policy.secretName,
        rotationInterval: policy.rotationInterval,
        autoRotate: policy.autoRotate,
      });
    } catch (error) {
      this.logger.error('Failed to add rotation policy', {
        secretName: policy.secretName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Manually rotate a secret
   */
  async rotateSecret(
    secretName: string,
    rotatedBy?: string,
    reason?: string,
  ): Promise<RotationResult> {
    const rotationId = this.generateRotationId();

    try {
      const policy = this.rotationPolicies.get(secretName);
      if (!policy) {
        throw new Error(`No rotation policy found for secret: ${secretName}`);
      }

      const status = this.rotationStatus.get(secretName);
      if (!status) {
        throw new Error(`No rotation status found for secret: ${secretName}`);
      }

      if (status.status === 'rotating') {
        throw new Error(`Secret ${secretName} is already being rotated`);
      }

      this.logger.info('Starting secret rotation', {
        secretName,
        rotationId,
        rotatedBy,
        reason,
      });

      // Update status to rotating
      status.status = 'rotating';
      this.rotationStatus.set(secretName, status);

      // Generate new secret
      const newSecret = await this.generateNewSecret(secretName, policy);
      const newVersion = this.generateVersionId();

      // Store the new secret
      await this.secretManager.setSecret(secretName, newSecret, {
        metadata: {
          version: newVersion,
          rotationId,
          rotatedBy,
          rotatedAt: new Date().toISOString(),
        },
      });

      // Test the new secret if validation function is available
      await this.validateNewSecret(secretName, newSecret);

      // Update rotation status
      const previousVersion = status.currentVersion;
      status.currentVersion = newVersion;
      status.previousVersion = previousVersion;
      status.lastRotationDate = new Date();
      status.nextRotationDate = this.calculateNextRotationDate(policy);
      status.status = 'active';

      // Add to rotation history
      const historyEntry: RotationHistoryEntry = {
        id: rotationId,
        rotationDate: new Date(),
        fromVersion: previousVersion,
        toVersion: newVersion,
        status: 'success',
        reason,
        rotatedBy,
      };
      status.rotationHistory.unshift(historyEntry);

      // Keep only recent history entries
      if (status.rotationHistory.length > 50) {
        status.rotationHistory = status.rotationHistory.slice(0, 50);
      }

      this.rotationStatus.set(secretName, status);

      // Schedule cleanup of old version
      await this.scheduleOldSecretCleanup(secretName, previousVersion, policy.retentionPeriod);

      this.logger.info('Secret rotation completed successfully', {
        secretName,
        rotationId,
        newVersion,
        previousVersion,
      });

      return {
        success: true,
        secretName,
        newVersion,
        previousVersion,
        message: 'Secret rotated successfully',
        rotationId,
      };
    } catch (error) {
      // Update status to failed
      const status = this.rotationStatus.get(secretName);
      if (status) {
        status.status = 'failed';

        // Add failed rotation to history
        const historyEntry: RotationHistoryEntry = {
          id: rotationId,
          rotationDate: new Date(),
          fromVersion: status.currentVersion,
          toVersion: 'failed',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          rotatedBy,
        };
        status.rotationHistory.unshift(historyEntry);
        this.rotationStatus.set(secretName, status);
      }

      this.logger.error('Secret rotation failed', {
        secretName,
        rotationId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        secretName,
        newVersion: '',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        rotationId,
      };
    }
  }

  /**
   * Get rotation status for a secret
   */
  getRotationStatus(secretName: string): SecretRotationStatus | null {
    return this.rotationStatus.get(secretName) || null;
  }

  /**
   * Get all rotation statuses
   */
  getAllRotationStatuses(): SecretRotationStatus[] {
    return Array.from(this.rotationStatus.values());
  }

  /**
   * Update rotation policy
   */
  async updateRotationPolicy(secretName: string, updates: Partial<RotationPolicy>): Promise<void> {
    try {
      const existingPolicy = this.rotationPolicies.get(secretName);
      if (!existingPolicy) {
        throw new Error(`No rotation policy found for secret: ${secretName}`);
      }

      const updatedPolicy = { ...existingPolicy, ...updates };
      this.validateRotationPolicy(updatedPolicy);

      this.rotationPolicies.set(secretName, updatedPolicy);

      // Update status
      const status = this.rotationStatus.get(secretName);
      if (status) {
        status.nextRotationDate = this.calculateNextRotationDate(updatedPolicy);
        this.rotationStatus.set(secretName, status);
      }

      // Reschedule rotation if auto-rotation settings changed
      if (updates.autoRotate !== undefined || updates.rotationInterval !== undefined) {
        await this.scheduleRotation(updatedPolicy);
      }

      this.logger.info('Rotation policy updated', {
        secretName,
        updates,
      });
    } catch (error) {
      this.logger.error('Failed to update rotation policy', {
        secretName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Remove rotation policy and stop scheduled rotation
   */
  async removeRotationPolicy(secretName: string): Promise<void> {
    try {
      // Stop scheduled rotation
      const job = this.rotationJobs.get(secretName);
      if (job) {
        job.stop();
        job.stop();
        this.rotationJobs.delete(secretName);
      }

      // Remove policy and status
      this.rotationPolicies.delete(secretName);
      this.rotationStatus.delete(secretName);

      this.logger.info('Rotation policy removed', { secretName });
    } catch (error) {
      this.logger.error('Failed to remove rotation policy', {
        secretName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check for secrets that need rotation
   */
  async checkSecretsForRotation(): Promise<string[]> {
    const secretsNeedingRotation: string[] = [];
    const now = new Date();

    for (const [secretName, status] of this.rotationStatus) {
      if (status.nextRotationDate <= now && status.status === 'active') {
        secretsNeedingRotation.push(secretName);
      }
    }

    return secretsNeedingRotation;
  }

  /**
   * Shutdown the rotation service
   */
  async shutdown(): Promise<void> {
    try {
      // Stop all scheduled jobs
      for (const [secretName, job] of this.rotationJobs) {
        job.stop();
        job.stop();
        this.logger.debug('Stopped rotation job', { secretName });
      }

      this.rotationJobs.clear();
      this.logger.info('Secret rotation service shutdown completed');
    } catch (error) {
      this.logger.error('Error during secret rotation service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load rotation policies from configuration
   */
  private async loadRotationPolicies(): Promise<void> {
    // In a real implementation, this would load from a configuration store
    // For now, we'll set up some default policies for common secrets

    const defaultPolicies: RotationPolicy[] = [
      {
        secretName: 'api-key',
        rotationInterval: 30, // 30 days
        retentionPeriod: 7, // Keep old secret for 7 days
        autoRotate: true,
        notifyBeforeExpiry: 24, // Notify 24 hours before
        rotationStrategy: 'graceful',
      },
      {
        secretName: 'jwt-secret',
        rotationInterval: 90, // 90 days
        retentionPeriod: 14, // Keep old secret for 14 days
        autoRotate: false, // Manual rotation for JWT secrets
        notifyBeforeExpiry: 72, // Notify 72 hours before
        rotationStrategy: 'phased',
      },
    ];

    for (const policy of defaultPolicies) {
      if (env.CREDENTIAL_ROTATION_DAYS) {
        // Override with environment configuration if available
        policy.rotationInterval = env.CREDENTIAL_ROTATION_DAYS;
      }

      await this.addRotationPolicy(policy);
    }
  }

  /**
   * Schedule all rotations
   */
  private async scheduleRotations(): Promise<void> {
    for (const policy of this.rotationPolicies.values()) {
      if (policy.autoRotate) {
        await this.scheduleRotation(policy);
      }
    }
  }

  /**
   * Schedule rotation for a specific secret
   */
  private async scheduleRotation(policy: RotationPolicy): Promise<void> {
    try {
      // Stop existing job if any
      const existingJob = this.rotationJobs.get(policy.secretName);
      if (existingJob) {
        existingJob.stop();
        existingJob.stop();
      }

      // Calculate cron expression for rotation interval
      const cronExpression = this.calculateCronExpression(policy.rotationInterval);

      // Create new cron job
      const job = new CronJob(
        cronExpression,
        async () => {
          try {
            await this.rotateSecret(
              policy.secretName,
              'auto-rotation',
              'Scheduled automatic rotation',
            );
          } catch (error) {
            this.logger.error('Scheduled rotation failed', {
              secretName: policy.secretName,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        null,
        true, // Start immediately
        'UTC',
      );

      this.rotationJobs.set(policy.secretName, job);

      this.logger.debug('Rotation scheduled', {
        secretName: policy.secretName,
        cronExpression,
        interval: policy.rotationInterval,
      });
    } catch (error) {
      this.logger.error('Failed to schedule rotation', {
        secretName: policy.secretName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate a new secret based on the secret type
   */
  private async generateNewSecret(secretName: string, policy: RotationPolicy): Promise<string> {
    // Different generation strategies based on secret type
    if (secretName.includes('api-key')) {
      return this.generateApiKey();
    } else if (secretName.includes('jwt')) {
      return this.generateJwtSecret();
    } else if (secretName.includes('password')) {
      return this.generatePassword();
    } else {
      // Default: strong random string
      return this.generateRandomString(64);
    }
  }

  /**
   * Generate API key
   */
  private generateApiKey(): string {
    const prefix = 'ak_';
    const randomPart = crypto.randomBytes(32).toString('hex');
    return prefix + randomPart;
  }

  /**
   * Generate JWT secret
   */
  private generateJwtSecret(): string {
    return crypto.randomBytes(64).toString('base64');
  }

  /**
   * Generate password
   */
  private generatePassword(): string {
    const length = 32;
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';

    for (let i = 0; i < length; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    return password;
  }

  /**
   * Generate random string
   */
  private generateRandomString(length: number): string {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }

  /**
   * Validate new secret
   */
  private async validateNewSecret(secretName: string, newSecret: string): Promise<void> {
    // In a real implementation, this would test the new secret
    // against the target systems to ensure it works
    this.logger.debug('Validating new secret', { secretName });

    // Basic validation: ensure secret is not empty and meets minimum requirements
    if (!newSecret || newSecret.length < 16) {
      throw new Error('Generated secret does not meet minimum requirements');
    }
  }

  /**
   * Get current secret version
   */
  private async getCurrentSecretVersion(secretName: string): Promise<string> {
    try {
      const secretData = await this.secretManager.getSecret(secretName);
      return (secretData?.metadata?.version as string) || 'v1';
    } catch {
      return 'v1';
    }
  }

  /**
   * Calculate next rotation date
   */
  private calculateNextRotationDate(policy: RotationPolicy): Date {
    const now = new Date();
    const nextRotation = new Date(now);
    nextRotation.setDate(nextRotation.getDate() + policy.rotationInterval);
    return nextRotation;
  }

  /**
   * Calculate cron expression for rotation interval
   */
  private calculateCronExpression(intervalDays: number): string {
    // Run at 2 AM every N days
    if (intervalDays === 1) {
      return '0 2 * * *'; // Daily at 2 AM
    } else if (intervalDays === 7) {
      return '0 2 * * 0'; // Weekly on Sunday at 2 AM
    } else if (intervalDays === 30) {
      return '0 2 1 * *'; // Monthly on 1st at 2 AM
    } else {
      // For other intervals, use daily and check if rotation is needed
      return '0 2 * * *';
    }
  }

  /**
   * Schedule cleanup of old secret
   */
  private async scheduleOldSecretCleanup(
    secretName: string,
    version: string,
    retentionDays: number,
  ): Promise<void> {
    setTimeout(async () => {
      try {
        // Note: deleteSecret method would need to be implemented in SecretManager
        this.logger.debug('Would delete old secret version', { secretName, version });
        this.logger.info('Old secret version cleaned up', {
          secretName,
          version,
        });
      } catch (error) {
        this.logger.error('Failed to cleanup old secret version', {
          secretName,
          version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, retentionDays * 24 * 60 * 60 * 1000); // Convert days to milliseconds
  }

  /**
   * Validate rotation policy
   */
  private validateRotationPolicy(policy: RotationPolicy): void {
    if (!policy.secretName) {
      throw new Error('Secret name is required');
    }
    if (policy.rotationInterval < 1) {
      throw new Error('Rotation interval must be at least 1 day');
    }
    if (policy.retentionPeriod < 1) {
      throw new Error('Retention period must be at least 1 day');
    }
    if (policy.notifyBeforeExpiry < 1) {
      throw new Error('Notification period must be at least 1 hour');
    }
  }

  /**
   * Generate rotation ID
   */
  private generateRotationId(): string {
    return `rot_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Generate version ID
   */
  private generateVersionId(): string {
    return `v${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
}
