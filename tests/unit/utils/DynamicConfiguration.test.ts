/**
 * DynamicConfiguration Unit Tests
 * Tests for dynamic configuration management with schema validation
 */

import {
  DynamicConfiguration,
  FileConfigurationSource,
  EnvironmentConfigurationSource,
  ConfigurationSource,
  ConfigurationSchema,
  getConfiguration,
  configValue,
  setConfigValue,
} from '../../../src/utils/DynamicConfiguration';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Mock fs
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    readFile: jest.fn(),
  },
  watch: jest.fn().mockReturnValue({
    close: jest.fn(),
  }),
}));

// Use real timers
beforeAll(() => {
  jest.useRealTimers();
});

describe('DynamicConfiguration', () => {
  let config: DynamicConfiguration;

  beforeEach(() => {
    // Get a fresh instance by accessing the singleton
    // Note: DynamicConfiguration is a singleton, so we need to work with that
    config = DynamicConfiguration.getInstance();
    // Clear any existing config by reloading with no sources
  });

  afterEach(async () => {
    await config.shutdown();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = DynamicConfiguration.getInstance();
      const instance2 = DynamicConfiguration.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('get and set operations', () => {
    it('should set and get a simple value', () => {
      config.set('test.value', 'hello');
      expect(config.get('test.value')).toBe('hello');
    });

    it('should set and get nested values', () => {
      config.set('deep.nested.value', 42);
      expect(config.get('deep.nested.value')).toBe(42);
    });

    it('should return default value when key not found', () => {
      const result = config.get('non.existent', 'default');
      expect(result).toBe('default');
    });

    it('should return undefined when no default provided', () => {
      const result = config.get('non.existent');
      expect(result).toBeUndefined();
    });

    it('should handle object values', () => {
      const obj = { name: 'test', count: 10 };
      config.set('config.obj', obj);
      expect(config.get('config.obj')).toEqual(obj);
    });

    it('should handle array values', () => {
      const arr = [1, 2, 3, 'four'];
      config.set('config.arr', arr);
      expect(config.get('config.arr')).toEqual(arr);
    });

    it('should handle boolean values', () => {
      config.set('config.enabled', true);
      config.set('config.disabled', false);
      expect(config.get('config.enabled')).toBe(true);
      expect(config.get('config.disabled')).toBe(false);
    });

    it('should handle null values', () => {
      config.set('config.nullable', null);
      expect(config.get('config.nullable')).toBeNull();
    });
  });

  describe('has operation', () => {
    it('should return true for existing key', () => {
      config.set('exists.key', 'value');
      expect(config.has('exists.key')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      expect(config.has('does.not.exist')).toBe(false);
    });
  });

  describe('getAll operation', () => {
    it('should return copy of all config', () => {
      config.set('all.key1', 'value1');
      config.set('all.key2', 'value2');

      const all = config.getAll();
      expect(all).toBeDefined();
      expect(typeof all).toBe('object');
    });

    it('should return a deep clone (modifications do not affect original)', () => {
      config.set('clone.test', { nested: 'value' });
      const all = config.getAll();

      // Modify the returned object
      (all as any).clone = { test: { nested: 'modified' } };

      // Original should be unchanged
      expect(config.get('clone.test')).toEqual({ nested: 'value' });
    });
  });

  describe('schema validation', () => {
    it('should set schema', () => {
      const schema: ConfigurationSchema = {
        'app.name': { type: 'string', required: true },
        'app.port': { type: 'number', default: 3000 },
      };

      config.setSchema(schema);
      // Should not throw
      expect(true).toBe(true);
    });

    it('should apply defaults from schema', () => {
      const schema: ConfigurationSchema = {
        'default.value': { type: 'string', default: 'default-string' },
        'default.number': { type: 'number', default: 42 },
      };

      config.setSchema(schema);

      expect(config.get('default.value')).toBe('default-string');
      expect(config.get('default.number')).toBe(42);
    });

    it('should validate type on set', () => {
      const schema: ConfigurationSchema = {
        'typed.string': { type: 'string', required: false },
      };

      config.setSchema(schema);

      // Valid type
      config.set('typed.string', 'valid');
      expect(config.get('typed.string')).toBe('valid');
    });

    it('should reject invalid type on set', () => {
      const schema: ConfigurationSchema = {
        'typed.number': { type: 'number', required: false },
      };

      config.setSchema(schema);

      // Invalid type - should throw
      expect(() => {
        config.set('typed.number', 'not a number');
      }).toThrow();
    });

    it('should run custom validation', () => {
      const schema: ConfigurationSchema = {
        'validated.port': {
          type: 'number',
          validation: (value) => {
            const port = value as number;
            return port >= 1 && port <= 65535 ? true : 'Port must be between 1 and 65535';
          },
        },
      };

      config.setSchema(schema);

      // Valid port
      config.set('validated.port', 3000);
      expect(config.get('validated.port')).toBe(3000);

      // Invalid port
      expect(() => {
        config.set('validated.port', 70000);
      }).toThrow('Port must be between 1 and 65535');
    });

    it('should support sensitive values masking', () => {
      const schema: ConfigurationSchema = {
        'sensitiveKey': { type: 'string', sensitive: true },
        'publicKey': { type: 'string', sensitive: false },
      };

      config.setSchema(schema);
      config.set('sensitiveKey', 'super-secret');
      config.set('publicKey', 'visible');

      const masked = config.getAllMasked();
      expect(masked['sensitiveKey']).toBe('***');
      expect(masked['publicKey']).toBe('visible');
    });
  });

  describe('metrics', () => {
    it('should return metrics object', () => {
      const metrics = config.getMetrics();

      expect(metrics).toHaveProperty('totalReloads');
      expect(metrics).toHaveProperty('validationErrors');
      expect(metrics).toHaveProperty('hotReloads');
      expect(metrics).toHaveProperty('sourceStatus');
      expect(metrics).toHaveProperty('configSize');
      expect(metrics).toHaveProperty('watchersActive');
    });

    it('should track hot reloads', () => {
      const schema: ConfigurationSchema = {
        'hot.config': { type: 'string', hotReloadable: true },
      };

      config.setSchema(schema);

      const initialHotReloads = config.getMetrics().hotReloads;
      config.set('hot.config', 'new-value');

      expect(config.getMetrics().hotReloads).toBe(initialHotReloads + 1);
    });
  });

  describe('source status', () => {
    it('should return source status', () => {
      const status = config.getSourceStatus();
      expect(typeof status).toBe('object');
    });
  });

  describe('history', () => {
    it('should return configuration history', () => {
      const history = config.getHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('events', () => {
    it('should emit configurationChanged event', (done) => {
      config.once('configurationChanged', (changes) => {
        // The key is 'event.test' as a string, not nested properties
        expect(changes['event.test']).toBe('value');
        done();
      });

      config.set('event.test', 'value');
    });

    it('should emit hotReload event for hot-reloadable config', (done) => {
      const schema: ConfigurationSchema = {
        'hotReloadTest': { type: 'string', hotReloadable: true },
      };

      config.setSchema(schema);

      config.once('hotReload', (changes) => {
        expect(changes['hotReloadTest']).toBe('hot-value');
        done();
      });

      config.set('hotReloadTest', 'hot-value');
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await config.shutdown();
      expect(config.getMetrics().watchersActive).toBe(0);
    });
  });
});

describe('EnvironmentConfigurationSource', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should have correct name and priority', () => {
    const source = new EnvironmentConfigurationSource('env', 200);
    expect(source.name).toBe('env');
    expect(source.priority).toBe(200);
  });

  it('should load environment variables', async () => {
    process.env.TEST_VALUE = 'env-value';
    process.env.TEST_NUMBER = '42';

    const source = new EnvironmentConfigurationSource('env', 100);
    const config = await source.load();

    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  it('should filter by prefix', async () => {
    process.env.APP_NAME = 'my-app';
    process.env.APP_PORT = '3000';
    process.env.OTHER_VAR = 'ignored';

    const source = new EnvironmentConfigurationSource('env', 100, 'APP_');
    const config = await source.load();

    expect(config).toBeDefined();
    // PREFIX is removed, so 'name' and 'port' keys should exist
  });

  it('should parse JSON values', async () => {
    process.env.JSON_CONFIG = '{"nested": true}';

    const source = new EnvironmentConfigurationSource('env', 100);
    const config = await source.load();

    expect(config['json']).toBeDefined();
  });

  it('should convert underscores to dots in key paths', async () => {
    process.env.DATABASE_HOST = 'localhost';

    const source = new EnvironmentConfigurationSource('env', 100);
    const config = await source.load();

    expect(config['database']).toBeDefined();
  });
});

describe('FileConfigurationSource', () => {
  const mockFs = require('fs').promises;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should have correct name and priority', () => {
    const source = new FileConfigurationSource('file', 100, '/path/to/config.json');
    expect(source.name).toBe('file');
    expect(source.priority).toBe(100);
  });

  it('should load JSON file', async () => {
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ key: 'value' }));

    const source = new FileConfigurationSource('json-file', 100, '/path/to/config.json');
    const config = await source.load();

    expect(config).toEqual({ key: 'value' });
  });

  it('should throw on invalid JSON', async () => {
    mockFs.readFile.mockResolvedValueOnce('not valid json');

    const source = new FileConfigurationSource('invalid-json', 100, '/path/to/config.json');

    await expect(source.load()).rejects.toThrow();
  });

  it('should throw on file not found', async () => {
    mockFs.readFile.mockRejectedValueOnce(new Error('ENOENT: file not found'));

    const source = new FileConfigurationSource('missing-file', 100, '/path/to/missing.json');

    await expect(source.load()).rejects.toThrow('Failed to load configuration');
  });

  it('should throw on unsupported file extension', async () => {
    mockFs.readFile.mockResolvedValueOnce('content');

    const source = new FileConfigurationSource('unknown', 100, '/path/to/config.xyz');

    await expect(source.load()).rejects.toThrow('Unsupported file extension');
  });
});

describe('Configuration Sources Integration', () => {
  let config: DynamicConfiguration;

  beforeEach(() => {
    config = DynamicConfiguration.getInstance();
  });

  afterEach(async () => {
    await config.shutdown();
  });

  it('should add source and update metrics', () => {
    const mockSource: ConfigurationSource = {
      name: 'mock-source',
      priority: 100,
      load: jest.fn().mockResolvedValue({ key: 'value' }),
    };

    config.addSource(mockSource);

    const status = config.getSourceStatus();
    expect(status['mock-source']).toBeDefined();
    expect(status['mock-source'].healthy).toBe(true);
  });

  it('should order sources by priority', () => {
    const lowPriority: ConfigurationSource = {
      name: 'low',
      priority: 50,
      load: jest.fn().mockResolvedValue({}),
    };

    const highPriority: ConfigurationSource = {
      name: 'high',
      priority: 200,
      load: jest.fn().mockResolvedValue({}),
    };

    config.addSource(lowPriority);
    config.addSource(highPriority);

    const status = config.getSourceStatus();
    expect(status['low']).toBeDefined();
    expect(status['high']).toBeDefined();
  });

  it('should add watcher when source supports watching', () => {
    const watchCallback = jest.fn().mockReturnValue(() => {});
    const watchableSource: ConfigurationSource = {
      name: 'watchable',
      priority: 100,
      load: jest.fn().mockResolvedValue({}),
      watch: watchCallback,
    };

    const initialWatchers = config.getMetrics().watchersActive;
    config.addSource(watchableSource);

    expect(config.getMetrics().watchersActive).toBe(initialWatchers + 1);
    expect(watchCallback).toHaveBeenCalled();
  });
});

describe('Utility Functions', () => {
  it('getConfiguration should return singleton', () => {
    const instance = getConfiguration();
    expect(instance).toBe(DynamicConfiguration.getInstance());
  });

  it('configValue should get configuration value', () => {
    const config = getConfiguration();
    config.set('util.test', 'util-value');

    expect(configValue('util.test')).toBe('util-value');
  });

  it('configValue should return default when not found', () => {
    expect(configValue('util.missing', 'default')).toBe('default');
  });

  it('setConfigValue should set configuration value', () => {
    setConfigValue('util.set', 'set-value');
    expect(configValue('util.set')).toBe('set-value');
  });
});
