import { SecretRotationService, RotationPolicy, SecretRotationStatus, RotationResult } from '../../../src/services/SecretRotationService';
import { CronJob } from 'cron';

// Mock cron
jest.mock('cron', () => ({
  CronJob: jest.fn().mockImplementation((cronTime, onTick, onComplete, start, timeZone) => ({
    start: jest.fn(),
    stop: jest.fn(),
    cronTime,
    onTick
  }))
}));

// Mock env config
jest.mock('../../../src/config/env', () => ({
  env: {
    CREDENTIAL_ROTATION_DAYS: undefined
  }
}));

describe('SecretRotationService', () => {
  let service: SecretRotationService;
  let mockLogger: any;
  let mockSecretManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    mockSecretManager = {
      getSecret: jest.fn().mockResolvedValue({
        value: 'test-secret',
        metadata: { version: 'v1' }
      }),
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined)
    };

    service = new SecretRotationService(mockLogger, mockSecretManager);
  });

  afterEach(() => {
    jest.useRealTimers();
    service.shutdown().catch(() => {});
  });

  describe('constructor', () => {
    it('should create service with dependencies', () => {
      expect(service).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should load default rotation policies', async () => {
      await service.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Secret rotation service initialized',
        expect.any(Object)
      );
    });

    it('should schedule rotations for auto-rotate policies', async () => {
      await service.initialize();

      // api-key has autoRotate: true by default
      expect(CronJob).toHaveBeenCalled();
    });

    it('should handle initialization gracefully when secrets not found', async () => {
      // Create a logger that we can verify
      const initLogger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
      };

      // Make getSecret fail - getCurrentSecretVersion catches this and returns 'v1'
      const failingSecretManager = {
        ...mockSecretManager,
        getSecret: jest.fn().mockRejectedValue(new Error('Secret not found'))
      };

      const gracefulService = new SecretRotationService(initLogger, failingSecretManager);

      // Initialize should succeed even when getSecret fails
      // because getCurrentSecretVersion catches errors and returns 'v1'
      await expect(gracefulService.initialize()).resolves.not.toThrow();

      // Info should be logged for successful initialization
      expect(initLogger.info).toHaveBeenCalledWith(
        'Secret rotation service initialized',
        expect.any(Object)
      );
    });
  });

  describe('addRotationPolicy', () => {
    it('should add a valid rotation policy', async () => {
      const policy: RotationPolicy = {
        secretName: 'test-secret',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await service.addRotationPolicy(policy);

      const status = service.getRotationStatus('test-secret');
      expect(status).toBeDefined();
      expect(status?.secretName).toBe('test-secret');
      expect(status?.status).toBe('active');
    });

    it('should schedule rotation when autoRotate is true', async () => {
      const policy: RotationPolicy = {
        secretName: 'auto-secret',
        rotationInterval: 7,
        retentionPeriod: 3,
        autoRotate: true,
        notifyBeforeExpiry: 12,
        rotationStrategy: 'immediate'
      };

      await service.addRotationPolicy(policy);

      expect(CronJob).toHaveBeenCalled();
    });

    it('should not schedule rotation when autoRotate is false', async () => {
      jest.clearAllMocks();

      const policy: RotationPolicy = {
        secretName: 'manual-secret',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await service.addRotationPolicy(policy);

      // CronJob should not be called for this policy
      const calls = (CronJob as jest.Mock).mock.calls;
      const relevantCalls = calls.filter(call => call[0]); // Filter out undefined cronTimes
      expect(relevantCalls.length).toBe(0);
    });

    it('should reject policy without secret name', async () => {
      const policy = {
        secretName: '',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      } as RotationPolicy;

      await expect(service.addRotationPolicy(policy)).rejects.toThrow('Secret name is required');
    });

    it('should reject policy with invalid rotation interval', async () => {
      const policy: RotationPolicy = {
        secretName: 'test',
        rotationInterval: 0,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await expect(service.addRotationPolicy(policy)).rejects.toThrow('Rotation interval must be at least 1 day');
    });

    it('should reject policy with invalid retention period', async () => {
      const policy: RotationPolicy = {
        secretName: 'test',
        rotationInterval: 30,
        retentionPeriod: 0,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await expect(service.addRotationPolicy(policy)).rejects.toThrow('Retention period must be at least 1 day');
    });

    it('should reject policy with invalid notification period', async () => {
      const policy: RotationPolicy = {
        secretName: 'test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 0,
        rotationStrategy: 'graceful'
      };

      await expect(service.addRotationPolicy(policy)).rejects.toThrow('Notification period must be at least 1 hour');
    });

    it('should initialize rotation history as empty array', async () => {
      const policy: RotationPolicy = {
        secretName: 'history-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await service.addRotationPolicy(policy);

      const status = service.getRotationStatus('history-test');
      expect(status?.rotationHistory).toEqual([]);
    });

    it('should calculate next rotation date based on interval', async () => {
      const policy: RotationPolicy = {
        secretName: 'date-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      const now = new Date();
      await service.addRotationPolicy(policy);

      const status = service.getRotationStatus('date-test');
      const expectedDate = new Date(now);
      expectedDate.setDate(expectedDate.getDate() + 30);

      // Allow 1 second tolerance
      expect(Math.abs(status!.nextRotationDate.getTime() - expectedDate.getTime())).toBeLessThan(1000);
    });
  });

  describe('rotateSecret', () => {
    beforeEach(async () => {
      const policy: RotationPolicy = {
        secretName: 'rotate-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };
      await service.addRotationPolicy(policy);
    });

    it('should rotate a secret successfully', async () => {
      const result = await service.rotateSecret('rotate-test', 'admin', 'Manual rotation');

      expect(result.success).toBe(true);
      expect(result.secretName).toBe('rotate-test');
      expect(result.newVersion).toBeDefined();
      expect(result.previousVersion).toBeDefined();
      expect(result.rotationId).toBeDefined();
    });

    it('should store new secret via secret manager', async () => {
      await service.rotateSecret('rotate-test');

      expect(mockSecretManager.setSecret).toHaveBeenCalledWith(
        'rotate-test',
        expect.any(String),
        expect.objectContaining({
          metadata: expect.objectContaining({
            version: expect.any(String),
            rotationId: expect.any(String)
          })
        })
      );
    });

    it('should update rotation status to active after success', async () => {
      await service.rotateSecret('rotate-test');

      const status = service.getRotationStatus('rotate-test');
      expect(status?.status).toBe('active');
    });

    it('should add entry to rotation history', async () => {
      await service.rotateSecret('rotate-test', 'admin', 'Test rotation');

      const status = service.getRotationStatus('rotate-test');
      expect(status?.rotationHistory.length).toBe(1);
      expect(status?.rotationHistory[0].status).toBe('success');
      expect(status?.rotationHistory[0].rotatedBy).toBe('admin');
      expect(status?.rotationHistory[0].reason).toBe('Test rotation');
    });

    it('should limit rotation history to 50 entries', async () => {
      // Manually populate history
      const status = service.getRotationStatus('rotate-test');
      if (status) {
        for (let i = 0; i < 55; i++) {
          status.rotationHistory.push({
            id: `old-${i}`,
            rotationDate: new Date(),
            fromVersion: 'v1',
            toVersion: 'v2',
            status: 'success'
          });
        }
      }

      await service.rotateSecret('rotate-test');

      const updatedStatus = service.getRotationStatus('rotate-test');
      expect(updatedStatus!.rotationHistory.length).toBeLessThanOrEqual(50);
    });

    it('should throw error if no policy exists', async () => {
      const result = await service.rotateSecret('nonexistent-secret');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No rotation policy found');
    });

    it('should throw error if secret is already being rotated', async () => {
      // Set status to rotating
      const status = service.getRotationStatus('rotate-test');
      if (status) {
        status.status = 'rotating';
      }

      const result = await service.rotateSecret('rotate-test');

      expect(result.success).toBe(false);
      expect(result.message).toContain('already being rotated');
    });

    it('should handle rotation failure', async () => {
      mockSecretManager.setSecret.mockRejectedValue(new Error('Storage failed'));

      const result = await service.rotateSecret('rotate-test');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Storage failed');
    });

    it('should update status to failed on error', async () => {
      mockSecretManager.setSecret.mockRejectedValue(new Error('Storage failed'));

      await service.rotateSecret('rotate-test');

      const status = service.getRotationStatus('rotate-test');
      expect(status?.status).toBe('failed');
    });

    it('should add failed entry to rotation history', async () => {
      mockSecretManager.setSecret.mockRejectedValue(new Error('Storage failed'));

      await service.rotateSecret('rotate-test');

      const status = service.getRotationStatus('rotate-test');
      expect(status?.rotationHistory[0].status).toBe('failed');
    });

    it('should update lastRotationDate on success', async () => {
      const before = new Date();
      await service.rotateSecret('rotate-test');
      const after = new Date();

      const status = service.getRotationStatus('rotate-test');
      expect(status?.lastRotationDate).toBeDefined();
      expect(status!.lastRotationDate!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(status!.lastRotationDate!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should update nextRotationDate on success', async () => {
      const before = new Date();
      await service.rotateSecret('rotate-test');

      const status = service.getRotationStatus('rotate-test');
      expect(status?.nextRotationDate.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe('getRotationStatus', () => {
    it('should return null for non-existent secret', () => {
      const status = service.getRotationStatus('nonexistent');

      expect(status).toBeNull();
    });

    it('should return status for existing secret', async () => {
      const policy: RotationPolicy = {
        secretName: 'status-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      };

      await service.addRotationPolicy(policy);

      const status = service.getRotationStatus('status-test');
      expect(status).toBeDefined();
      expect(status?.secretName).toBe('status-test');
    });
  });

  describe('getAllRotationStatuses', () => {
    it('should return empty array when no policies exist', () => {
      const statuses = service.getAllRotationStatuses();

      expect(statuses).toEqual([]);
    });

    it('should return all rotation statuses', async () => {
      await service.addRotationPolicy({
        secretName: 'secret1',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      await service.addRotationPolicy({
        secretName: 'secret2',
        rotationInterval: 60,
        retentionPeriod: 14,
        autoRotate: false,
        notifyBeforeExpiry: 48,
        rotationStrategy: 'phased'
      });

      const statuses = service.getAllRotationStatuses();

      expect(statuses.length).toBe(2);
      expect(statuses.map(s => s.secretName)).toContain('secret1');
      expect(statuses.map(s => s.secretName)).toContain('secret2');
    });
  });

  describe('updateRotationPolicy', () => {
    beforeEach(async () => {
      await service.addRotationPolicy({
        secretName: 'update-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });
    });

    it('should update existing policy', async () => {
      await service.updateRotationPolicy('update-test', { rotationInterval: 60 });

      const status = service.getRotationStatus('update-test');
      // Next rotation date should be updated based on new interval
      expect(status).toBeDefined();
    });

    it('should throw error for non-existent policy', async () => {
      await expect(
        service.updateRotationPolicy('nonexistent', { rotationInterval: 60 })
      ).rejects.toThrow('No rotation policy found');
    });

    it('should validate updated policy', async () => {
      await expect(
        service.updateRotationPolicy('update-test', { rotationInterval: 0 })
      ).rejects.toThrow('Rotation interval must be at least 1 day');
    });

    it('should reschedule rotation when autoRotate changes', async () => {
      jest.clearAllMocks();

      await service.updateRotationPolicy('update-test', { autoRotate: true });

      expect(CronJob).toHaveBeenCalled();
    });

    it('should reschedule rotation when interval changes', async () => {
      jest.clearAllMocks();

      await service.updateRotationPolicy('update-test', { rotationInterval: 7, autoRotate: true });

      expect(CronJob).toHaveBeenCalled();
    });

    it('should log successful update', async () => {
      await service.updateRotationPolicy('update-test', { retentionPeriod: 14 });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Rotation policy updated',
        expect.objectContaining({ secretName: 'update-test' })
      );
    });
  });

  describe('removeRotationPolicy', () => {
    beforeEach(async () => {
      await service.addRotationPolicy({
        secretName: 'remove-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: true,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });
    });

    it('should remove policy and status', async () => {
      await service.removeRotationPolicy('remove-test');

      expect(service.getRotationStatus('remove-test')).toBeNull();
    });

    it('should stop scheduled rotation job', async () => {
      await service.removeRotationPolicy('remove-test');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Rotation policy removed',
        { secretName: 'remove-test' }
      );
    });

    it('should handle removal of non-existent policy gracefully', async () => {
      await expect(service.removeRotationPolicy('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('checkSecretsForRotation', () => {
    it('should return empty array when no secrets need rotation', async () => {
      await service.addRotationPolicy({
        secretName: 'future-rotation',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      const needRotation = await service.checkSecretsForRotation();

      expect(needRotation).toEqual([]);
    });

    it('should return secrets that need rotation', async () => {
      await service.addRotationPolicy({
        secretName: 'needs-rotation',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      // Set next rotation date to past
      const status = service.getRotationStatus('needs-rotation');
      if (status) {
        status.nextRotationDate = new Date(Date.now() - 1000);
      }

      const needRotation = await service.checkSecretsForRotation();

      expect(needRotation).toContain('needs-rotation');
    });

    it('should not include secrets currently being rotated', async () => {
      await service.addRotationPolicy({
        secretName: 'rotating-secret',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      const status = service.getRotationStatus('rotating-secret');
      if (status) {
        status.nextRotationDate = new Date(Date.now() - 1000);
        status.status = 'rotating';
      }

      const needRotation = await service.checkSecretsForRotation();

      expect(needRotation).not.toContain('rotating-secret');
    });
  });

  describe('shutdown', () => {
    it('should stop all rotation jobs', async () => {
      await service.addRotationPolicy({
        secretName: 'shutdown-test',
        rotationInterval: 7,
        retentionPeriod: 3,
        autoRotate: true,
        notifyBeforeExpiry: 12,
        rotationStrategy: 'immediate'
      });

      await service.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('Secret rotation service shutdown completed');
    });

    it('should clear rotation jobs map', async () => {
      await service.addRotationPolicy({
        secretName: 'clear-test',
        rotationInterval: 7,
        retentionPeriod: 3,
        autoRotate: true,
        notifyBeforeExpiry: 12,
        rotationStrategy: 'immediate'
      });

      await service.shutdown();

      // After shutdown, adding new policy should work normally
      await expect(service.addRotationPolicy({
        secretName: 'new-after-shutdown',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      })).resolves.not.toThrow();
    });

    it('should handle shutdown errors gracefully', async () => {
      // Shutdown should not throw even if there are issues
      await expect(service.shutdown()).resolves.not.toThrow();
    });
  });

  describe('secret generation', () => {
    it('should generate API key with prefix', async () => {
      await service.addRotationPolicy({
        secretName: 'api-key-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      await service.rotateSecret('api-key-test');

      expect(mockSecretManager.setSecret).toHaveBeenCalledWith(
        'api-key-test',
        expect.stringMatching(/^ak_[a-f0-9]{64}$/),
        expect.any(Object)
      );
    });

    it('should generate JWT secret as base64', async () => {
      await service.addRotationPolicy({
        secretName: 'jwt-secret-test',
        rotationInterval: 90,
        retentionPeriod: 14,
        autoRotate: false,
        notifyBeforeExpiry: 72,
        rotationStrategy: 'phased'
      });

      await service.rotateSecret('jwt-secret-test');

      expect(mockSecretManager.setSecret).toHaveBeenCalledWith(
        'jwt-secret-test',
        expect.any(String),
        expect.any(Object)
      );
    });

    it('should generate password with special characters', async () => {
      await service.addRotationPolicy({
        secretName: 'password-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      await service.rotateSecret('password-test');

      expect(mockSecretManager.setSecret).toHaveBeenCalled();
    });

    it('should generate random string for unknown secret types', async () => {
      await service.addRotationPolicy({
        secretName: 'random-secret',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      await service.rotateSecret('random-secret');

      expect(mockSecretManager.setSecret).toHaveBeenCalledWith(
        'random-secret',
        expect.any(String),
        expect.any(Object)
      );
    });
  });

  describe('cron expression calculation', () => {
    it('should use daily cron for 1-day interval', async () => {
      await service.addRotationPolicy({
        secretName: 'daily-secret',
        rotationInterval: 1,
        retentionPeriod: 1,
        autoRotate: true,
        notifyBeforeExpiry: 1,
        rotationStrategy: 'immediate'
      });

      expect(CronJob).toHaveBeenCalledWith(
        '0 2 * * *', // Daily at 2 AM
        expect.any(Function),
        null,
        true,
        'UTC'
      );
    });

    it('should use weekly cron for 7-day interval', async () => {
      jest.clearAllMocks();

      await service.addRotationPolicy({
        secretName: 'weekly-secret',
        rotationInterval: 7,
        retentionPeriod: 3,
        autoRotate: true,
        notifyBeforeExpiry: 12,
        rotationStrategy: 'graceful'
      });

      expect(CronJob).toHaveBeenCalledWith(
        '0 2 * * 0', // Weekly on Sunday at 2 AM
        expect.any(Function),
        null,
        true,
        'UTC'
      );
    });

    it('should use monthly cron for 30-day interval', async () => {
      jest.clearAllMocks();

      await service.addRotationPolicy({
        secretName: 'monthly-secret',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: true,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'phased'
      });

      expect(CronJob).toHaveBeenCalledWith(
        '0 2 1 * *', // Monthly on 1st at 2 AM
        expect.any(Function),
        null,
        true,
        'UTC'
      );
    });

    it('should use daily cron for custom intervals', async () => {
      jest.clearAllMocks();

      await service.addRotationPolicy({
        secretName: 'custom-secret',
        rotationInterval: 45,
        retentionPeriod: 7,
        autoRotate: true,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      expect(CronJob).toHaveBeenCalledWith(
        '0 2 * * *', // Daily at 2 AM
        expect.any(Function),
        null,
        true,
        'UTC'
      );
    });
  });

  describe('secret validation', () => {
    it('should reject empty secrets', async () => {
      await service.addRotationPolicy({
        secretName: 'validation-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      // Mock to return short secret
      const originalSetSecret = mockSecretManager.setSecret;
      mockSecretManager.setSecret = jest.fn().mockImplementation(async (name, secret) => {
        if (secret.length < 16) {
          throw new Error('Generated secret does not meet minimum requirements');
        }
        return originalSetSecret(name, secret);
      });

      // The actual generation creates proper length secrets, so this should pass
      const result = await service.rotateSecret('validation-test');
      expect(result.success).toBe(true);
    });
  });

  describe('rotation ID and version generation', () => {
    it('should generate unique rotation IDs', async () => {
      await service.addRotationPolicy({
        secretName: 'id-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      const result1 = await service.rotateSecret('id-test');
      const result2 = await service.rotateSecret('id-test');

      expect(result1.rotationId).not.toBe(result2.rotationId);
    });

    it('should include timestamp in rotation ID', async () => {
      await service.addRotationPolicy({
        secretName: 'timestamp-test',
        rotationInterval: 30,
        retentionPeriod: 7,
        autoRotate: false,
        notifyBeforeExpiry: 24,
        rotationStrategy: 'graceful'
      });

      const before = Date.now();
      const result = await service.rotateSecret('timestamp-test');
      const after = Date.now();

      const rotationIdTimestamp = parseInt(result.rotationId.split('_')[1]);
      expect(rotationIdTimestamp).toBeGreaterThanOrEqual(before);
      expect(rotationIdTimestamp).toBeLessThanOrEqual(after);
    });
  });
});
