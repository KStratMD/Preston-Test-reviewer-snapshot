import { DemoModeService } from '../../../src/services/DemoModeService';

// Mock the in-tree uuid wrapper (the npm `uuid` package was removed; src/utils/uuid.ts
// now wraps node:crypto.randomUUID — see PR #714).
jest.mock('../../../src/utils/uuid', () => ({
  uuidv4: jest.fn(() => 'mock-uuid-1234')
}));

// Mock runtime flags
jest.mock('../../../src/config/runtimeFlags', () => ({
  isDemoMode: jest.fn(() => false),
  setDemoModeOverride: jest.fn()
}));

import { isDemoMode, setDemoModeOverride } from '../../../src/config/runtimeFlags';

describe('DemoModeService', () => {
  let service: DemoModeService;
  let mockLogger: any;
  let mockDbService: any;
  let mockDb: any;
  let mockQueryBuilder: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env.DEMO_MODE;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    // Create mock query builder
    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      selectAll: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(null)
    };

    mockDb = {
      selectFrom: jest.fn(() => mockQueryBuilder),
      updateTable: jest.fn(() => mockQueryBuilder),
      insertInto: jest.fn(() => mockQueryBuilder)
    };

    mockDbService = {
      getDatabase: jest.fn(() => mockDb)
    };

    // Reset isDemoMode mock
    (isDemoMode as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should initialize service with dependencies', () => {
      service = new DemoModeService(mockLogger, mockDbService);
      expect(service).toBeDefined();
    });

    it('should load initial state from environment if DEMO_MODE is set', async () => {
      process.env.DEMO_MODE = '1';
      (isDemoMode as jest.Mock).mockReturnValue(true);

      service = new DemoModeService(mockLogger, mockDbService);

      // Wait for bootstrap to complete
      const result = await service.getDemoMode();

      expect(result).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Demo mode initialized from environment',
        expect.any(Object)
      );
    });

    it('should load initial state from database if DEMO_MODE not set', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue({
        setting_value: 'true'
      });

      service = new DemoModeService(mockLogger, mockDbService);

      // Wait for bootstrap
      const result = await service.getDemoMode();

      expect(result).toBe(true);
    });

    it('should fallback to env flag if database load fails', async () => {
      mockQueryBuilder.executeTakeFirst.mockRejectedValue(new Error('DB error'));
      (isDemoMode as jest.Mock).mockReturnValue(false);

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Unable to load persisted demo mode, falling back to env flag',
        expect.any(Object)
      );
    });
  });

  describe('getDemoMode', () => {
    beforeEach(() => {
      service = new DemoModeService(mockLogger, mockDbService);
    });

    it('should return cached value if available', async () => {
      // First call initializes
      await service.getDemoMode();

      // Second call should use cache
      const result = await service.getDemoMode();

      expect(result).toBe(false);
    });

    it('should return env value if cache is undefined', async () => {
      (isDemoMode as jest.Mock).mockReturnValue(true);

      const result = await service.getDemoMode();

      expect(typeof result).toBe('boolean');
    });
  });

  describe('setDemoMode', () => {
    beforeEach(() => {
      service = new DemoModeService(mockLogger, mockDbService);
    });

    it('should update existing setting in database', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue({ id: 'existing-id' });

      await service.setDemoMode(true, { userId: 1 });

      expect(mockDb.updateTable).toHaveBeenCalledWith('tenant_configurations');
      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          setting_value: 'true'
        })
      );
    });

    it('should insert new setting if not exists', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      expect(mockDb.insertInto).toHaveBeenCalledWith('tenant_configurations');
      expect(mockQueryBuilder.values).toHaveBeenCalledWith(
        expect.objectContaining({
          setting_key: 'demo_mode',
          setting_value: 'true',
          tenant_id: 'global'
        })
      );
    });

    it('should update cached value', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      const result = await service.getDemoMode();
      expect(result).toBe(true);
    });

    it('should call setDemoModeOverride', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      expect(setDemoModeOverride).toHaveBeenCalledWith(true);
    });

    it('should update process.env.DEMO_MODE', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      expect(process.env.DEMO_MODE).toBe('1');
    });

    it('should set DEMO_MODE to 0 when disabled', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(false);

      expect(process.env.DEMO_MODE).toBe('0');
    });

    it('should log with userId context', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true, { userId: 42 });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Demo mode updated',
        expect.objectContaining({
          enabled: true,
          userId: '42'
        })
      );
    });

    it('should log with system userId if not provided', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(false);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Demo mode updated',
        expect.objectContaining({
          userId: 'system'
        })
      );
    });

    it('should throw error if database operation fails', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      mockQueryBuilder.execute.mockRejectedValue(new Error('DB write error'));

      await expect(service.setDemoMode(true)).rejects.toThrow('DB write error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to persist demo mode setting',
        expect.any(Object)
      );
    });
  });

  describe('persistence behavior', () => {
    it('should use global tenant ID', async () => {
      service = new DemoModeService(mockLogger, mockDbService);
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('tenant_id', '=', 'global');
    });

    it('should use demo_mode setting key', async () => {
      service = new DemoModeService(mockLogger, mockDbService);
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      await service.setDemoMode(true);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('setting_key', '=', 'demo_mode');
    });
  });

  describe('environment variable priority', () => {
    it('should prioritize env variable over database value', async () => {
      process.env.DEMO_MODE = '1';
      (isDemoMode as jest.Mock).mockReturnValue(true);

      // Database would return false
      mockQueryBuilder.executeTakeFirst.mockResolvedValue({
        setting_value: 'false'
      });

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      // Env should take priority
      expect(result).toBe(true);
    });

    it('should sync env value to database', async () => {
      process.env.DEMO_MODE = '1';
      (isDemoMode as jest.Mock).mockReturnValue(true);

      service = new DemoModeService(mockLogger, mockDbService);

      // Wait for initialization
      await service.getDemoMode();

      // Give async sync time to run
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have tried to sync to database
      expect(mockDb.selectFrom).toHaveBeenCalled();
    });
  });

  describe('database value parsing', () => {
    it('should parse "true" string as boolean true', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue({
        setting_value: 'true'
      });

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      expect(result).toBe(true);
    });

    it('should parse "false" string as boolean false', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue({
        setting_value: 'false'
      });

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      expect(result).toBe(false);
    });

    it('should return null if no record exists', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);
      (isDemoMode as jest.Mock).mockReturnValue(false);

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      expect(result).toBe(false); // Falls back to env
    });
  });

  describe('bootstrap promise', () => {
    it('should wait for bootstrap before getDemoMode', async () => {
      // Simulate slow database
      mockQueryBuilder.executeTakeFirst.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ setting_value: 'true' }), 50))
      );

      service = new DemoModeService(mockLogger, mockDbService);

      const result = await service.getDemoMode();

      expect(result).toBe(true);
    });

    it('should wait for bootstrap before setDemoMode', async () => {
      mockQueryBuilder.executeTakeFirst.mockResolvedValue(null);

      service = new DemoModeService(mockLogger, mockDbService);

      await service.setDemoMode(true);

      // Should complete without error
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });
});
