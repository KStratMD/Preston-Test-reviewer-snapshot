/**
 * UserSettingsService Tests
 * Tests for user settings persistence and tenant isolation
 */

// Mock the in-tree uuid wrapper at top-level (the npm `uuid` package was
// removed; src/utils/uuid.ts now wraps node:crypto.randomUUID — see PR #714).
// jest.mock is hoisted to the top of the file at compile time, so placing
// it before `import` keeps the source readable.
jest.mock('../../../src/utils/uuid', () => ({
  uuidv4: jest.fn(() => 'mock-uuid-1234'),
}));

import { UserSettingsService } from '../../../src/services/UserSettingsService';

describe('UserSettingsService', () => {
  let service: UserSettingsService;
  let mockLogger: any;
  let mockDatabaseService: any;
  let mockDb: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockDb = {
      selectFrom: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn(),
      updateTable: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      insertInto: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
    };

    mockDatabaseService = {
      getDatabase: jest.fn().mockReturnValue(mockDb),
    };

    service = new UserSettingsService(mockLogger, mockDatabaseService);
  });

  describe('getDataset', () => {
    describe('tenant resolution', () => {
      it('should use anonymous tenant for undefined userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.getDataset(undefined);

        expect(mockDb.where).toHaveBeenCalledWith('tenant_id', '=', 'anonymous');
      });

      it('should use anonymous tenant for null userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.getDataset(null as any);

        expect(mockDb.where).toHaveBeenCalledWith('tenant_id', '=', 'anonymous');
      });

      it('should format tenant ID for string userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ setting_value: 'dataset-1' });

        await service.getDataset('user-123');

        expect(mockDb.where).toHaveBeenCalledWith('tenant_id', '=', 'user:user-123');
      });

      it('should format tenant ID for numeric userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ setting_value: 'dataset-1' });

        await service.getDataset(456);

        expect(mockDb.where).toHaveBeenCalledWith('tenant_id', '=', 'user:456');
      });
    });

    describe('value retrieval', () => {
      it('should return user-specific setting if found', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ setting_value: 'user-dataset' });

        const result = await service.getDataset('user-1');

        expect(result).toBe('user-dataset');
      });

      it('should fallback to global setting if user setting not found', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.executeTakeFirst.mockResolvedValueOnce({ setting_value: 'global-dataset' });

        const result = await service.getDataset('user-1');

        expect(result).toBe('global-dataset');
        expect(mockDb.where).toHaveBeenCalledWith('tenant_id', '=', 'global');
      });

      it('should return null if no settings found', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        const result = await service.getDataset('user-1');

        expect(result).toBeNull();
      });

      it('should return null if record has no setting_value', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({});
        mockDb.executeTakeFirst.mockResolvedValueOnce({});

        const result = await service.getDataset('user-1');

        expect(result).toBeNull();
      });
    });

    describe('error handling', () => {
      it('should log warning and return null on database error', async () => {
        mockDb.executeTakeFirst.mockRejectedValue(new Error('DB connection failed'));

        const result = await service.getDataset('user-1');

        expect(result).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Failed to load dataset preference; default will be used',
          expect.objectContaining({
            error: 'DB connection failed',
            tenantId: 'user:user-1',
          })
        );
      });

      it('should handle non-Error objects in catch', async () => {
        mockDb.executeTakeFirst.mockRejectedValue('string error');

        const result = await service.getDataset('user-1');

        expect(result).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Failed to load dataset preference; default will be used',
          expect.objectContaining({
            error: 'string error',
          })
        );
      });
    });

    describe('setting key', () => {
      it('should query with correct setting key', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.getDataset('user-1');

        expect(mockDb.where).toHaveBeenCalledWith('setting_key', '=', 'ai_dataset_selection');
      });
    });
  });

  describe('setDataset', () => {
    describe('update existing setting', () => {
      it('should update existing record', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ id: 'existing-id' });

        await service.setDataset('new-dataset', 'user-1');

        expect(mockDb.updateTable).toHaveBeenCalledWith('tenant_configurations');
        expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({
          setting_value: 'new-dataset',
        }));
        expect(mockDb.where).toHaveBeenCalledWith('id', '=', 'existing-id');
      });

      it('should set updated_at timestamp', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ id: 'existing-id' });

        const beforeCall = new Date();
        await service.setDataset('new-dataset', 'user-1');
        const afterCall = new Date();

        expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({
          updated_at: expect.any(Date),
        }));

        const setCall = mockDb.set.mock.calls[0][0];
        expect(setCall.updated_at.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
        expect(setCall.updated_at.getTime()).toBeLessThanOrEqual(afterCall.getTime());
      });
    });

    describe('insert new setting', () => {
      it('should insert new record when none exists', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('new-dataset', 'user-1');

        expect(mockDb.insertInto).toHaveBeenCalledWith('tenant_configurations');
        expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({
          tenant_id: 'user:user-1',
          setting_key: 'ai_dataset_selection',
          setting_value: 'new-dataset',
          is_encrypted: false,
        }));
      });

      it('should generate UUID for new record', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('new-dataset', 'user-1');

        expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({
          id: expect.any(String),
        }));
      });

      it('should set created_at and updated_at for new record', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('new-dataset', 'user-1');

        const valuesCall = mockDb.values.mock.calls[0][0];
        expect(valuesCall.created_at).toEqual(valuesCall.updated_at);
      });
    });

    describe('tenant resolution', () => {
      it('should use anonymous tenant for undefined userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('dataset-1', undefined);

        expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({
          tenant_id: 'anonymous',
        }));
      });

      it('should format tenant ID for string userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('dataset-1', 'user-abc');

        expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({
          tenant_id: 'user:user-abc',
        }));
      });

      it('should format tenant ID for numeric userId', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('dataset-1', 789);

        expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({
          tenant_id: 'user:789',
        }));
      });
    });

    describe('logging', () => {
      it('should log successful update', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ id: 'existing-id' });

        await service.setDataset('new-dataset', 'user-1');

        expect(mockLogger.info).toHaveBeenCalledWith(
          'AI dataset preference updated',
          expect.objectContaining({
            tenantId: 'user:user-1',
            datasetId: 'new-dataset',
          })
        );
      });

      it('should log successful insert', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);

        await service.setDataset('new-dataset', 'user-1');

        expect(mockLogger.info).toHaveBeenCalledWith(
          'AI dataset preference updated',
          expect.objectContaining({
            tenantId: 'user:user-1',
            datasetId: 'new-dataset',
          })
        );
      });
    });

    describe('error handling', () => {
      it('should log error and rethrow on database failure', async () => {
        const dbError = new Error('Insert failed');
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.execute.mockRejectedValueOnce(dbError);

        await expect(service.setDataset('dataset-1', 'user-1')).rejects.toThrow('Insert failed');

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Failed to persist AI dataset preference',
          expect.objectContaining({
            error: 'Insert failed',
            tenantId: 'user:user-1',
            datasetId: 'dataset-1',
          })
        );
      });

      it('should handle non-Error objects in catch', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce(null);
        mockDb.execute.mockRejectedValueOnce('string error');

        await expect(service.setDataset('dataset-1', 'user-1')).rejects.toBe('string error');

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Failed to persist AI dataset preference',
          expect.objectContaining({
            error: 'string error',
          })
        );
      });

      it('should rethrow error for update failure', async () => {
        mockDb.executeTakeFirst.mockResolvedValueOnce({ id: 'existing-id' });
        mockDb.execute.mockRejectedValueOnce(new Error('Update failed'));

        await expect(service.setDataset('dataset-1', 'user-1')).rejects.toThrow('Update failed');
      });
    });
  });

  describe('database queries', () => {
    it('should select from tenant_configurations table', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      await service.getDataset('user-1');

      expect(mockDb.selectFrom).toHaveBeenCalledWith('tenant_configurations');
    });

    it('should select setting_value column', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      await service.getDataset('user-1');

      expect(mockDb.select).toHaveBeenCalledWith(['setting_value']);
    });

    it('should get database from database service', async () => {
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);
      mockDb.executeTakeFirst.mockResolvedValueOnce(null);

      await service.getDataset('user-1');

      expect(mockDatabaseService.getDatabase).toHaveBeenCalled();
    });
  });
});
