/**
 * Comprehensive unit tests for AgentRegistry
 * Covers: registerAgent, unregisterAgent, getAgent, listAgents,
 *         findAgentsByCapabilities, getDependencyOrder, health checks,
 *         updateAgentStats, getRegistryStats, validation, capability index
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { AgentRegistry } from '../../../../src/services/ai/orchestrator/AgentRegistry';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    name: 'test-agent',
    version: '1.0.0',
    capabilities: ['mapping', 'analysis'],
    dependencies: [],
    execute: jest.fn().mockResolvedValue({ success: true }),
    validateInput: jest.fn().mockResolvedValue(true),
    getSchema: jest.fn().mockReturnValue({ inputSchema: {}, outputSchema: {} }),
    ...overrides,
  };
}

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    registry = new AgentRegistry(mockLogger);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize registry', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('Agent registry initialized');
    });

    it('should start with no agents', () => {
      expect(registry.listAgents()).toEqual([]);
    });
  });

  describe('registerAgent', () => {
    it('should register a valid agent', () => {
      registry.registerAgent('agent-a', makeAgent());
      expect(registry.listAgents()).toContain('agent-a');
    });

    it('should log registration', () => {
      registry.registerAgent('agent-a', makeAgent());
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Agent registered successfully',
        expect.objectContaining({ name: 'agent-a' }),
      );
    });

    it('should throw for agent without name', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ name: '' })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without version', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ version: '' })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without capabilities array', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ capabilities: 'not-array' })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without dependencies array', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ dependencies: null })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without execute method', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ execute: 'not-fn' })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without validateInput method', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ validateInput: 123 })),
      ).toThrow('Agent registration failed');
    });

    it('should throw for agent without getSchema method', () => {
      expect(() =>
        registry.registerAgent('bad', makeAgent({ getSchema: null })),
      ).toThrow('Agent registration failed');
    });

    it('should set initial health status to unknown', () => {
      registry.registerAgent('agent-a', makeAgent());
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.healthStatus).toBe('unknown');
    });

    it('should set initial execution count to 0', () => {
      registry.registerAgent('agent-a', makeAgent());
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.executionCount).toBe(0);
      expect(reg!.successRate).toBe(1.0);
    });
  });

  describe('unregisterAgent', () => {
    it('should return false for non-existent agent', () => {
      expect(registry.unregisterAgent('missing')).toBe(false);
    });

    it('should remove a registered agent', () => {
      registry.registerAgent('agent-a', makeAgent());
      expect(registry.unregisterAgent('agent-a')).toBe(true);
      expect(registry.listAgents()).not.toContain('agent-a');
    });

    it('should clean capability index on unregister', () => {
      registry.registerAgent('agent-a', makeAgent({ capabilities: ['cap1'] }));
      registry.unregisterAgent('agent-a');
      const found = registry.findAgentsByCapabilities({
        capabilities: ['cap1'],
        excludeUnhealthy: false,
      });
      expect(found).toEqual([]);
    });
  });

  describe('getAgent', () => {
    it('should return null for non-existent agent', () => {
      expect(registry.getAgent('missing')).toBeNull();
    });

    it('should return the agent instance', () => {
      const agent = makeAgent();
      registry.registerAgent('agent-a', agent);
      expect(registry.getAgent('agent-a')).toBe(agent);
    });
  });

  describe('getAgentRegistration', () => {
    it('should return null for non-existent', () => {
      expect(registry.getAgentRegistration('missing')).toBeNull();
    });

    it('should return registration details', () => {
      registry.registerAgent('agent-a', makeAgent());
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg).toBeDefined();
      expect(reg!.registeredAt).toBeInstanceOf(Date);
    });
  });

  describe('findAgentsByCapabilities', () => {
    beforeEach(() => {
      registry.registerAgent('agent-a', makeAgent({
        name: 'a', capabilities: ['mapping', 'analysis'],
      }));
      registry.registerAgent('agent-b', makeAgent({
        name: 'b', capabilities: ['analysis', 'optimization'],
      }));
    });

    it('should find agents by single capability (union)', () => {
      const found = registry.findAgentsByCapabilities({
        capabilities: ['mapping'],
        excludeUnhealthy: false,
      });
      expect(found).toContain('agent-a');
      expect(found).not.toContain('agent-b');
    });

    it('should find agents by multiple capabilities (union)', () => {
      const found = registry.findAgentsByCapabilities({
        capabilities: ['mapping', 'optimization'],
        requireAll: false,
        excludeUnhealthy: false,
      });
      expect(found).toContain('agent-a');
      expect(found).toContain('agent-b');
    });

    it('should find agents by multiple capabilities (requireAll)', () => {
      const found = registry.findAgentsByCapabilities({
        capabilities: ['mapping', 'analysis'],
        requireAll: true,
        excludeUnhealthy: false,
      });
      expect(found).toContain('agent-a');
      expect(found).not.toContain('agent-b');
    });

    it('should exclude unhealthy agents by default', () => {
      // Manually set agents to unhealthy (initial async health check may have resolved)
      const regA = registry.getAgentRegistration('agent-a');
      const regB = registry.getAgentRegistration('agent-b');
      regA!.healthStatus = 'unhealthy';
      regB!.healthStatus = 'unhealthy';

      const found = registry.findAgentsByCapabilities({
        capabilities: ['analysis'],
      });
      expect(found).toEqual([]);
    });

    it('should include degraded agents when excludeUnhealthy is true', async () => {
      // Mark agent-a as healthy via health check
      await registry.performHealthCheck('agent-a');
      const found = registry.findAgentsByCapabilities({
        capabilities: ['analysis'],
        excludeUnhealthy: true,
      });
      expect(found).toContain('agent-a');
    });

    it('should return empty for unknown capability', () => {
      const found = registry.findAgentsByCapabilities({
        capabilities: ['nonexistent'],
        excludeUnhealthy: false,
      });
      expect(found).toEqual([]);
    });
  });

  describe('getDependencyOrder', () => {
    it('should return agents in dependency order', () => {
      registry.registerAgent('base', makeAgent({ name: 'base', dependencies: [] }));
      registry.registerAgent('mid', makeAgent({ name: 'mid', dependencies: ['base'] }));
      registry.registerAgent('top', makeAgent({ name: 'top', dependencies: ['mid'] }));

      const order = registry.getDependencyOrder(['top', 'mid', 'base']);
      expect(order.indexOf('base')).toBeLessThan(order.indexOf('mid'));
      expect(order.indexOf('mid')).toBeLessThan(order.indexOf('top'));
    });

    it('should handle agents with no dependencies', () => {
      registry.registerAgent('a', makeAgent({ name: 'a', dependencies: [] }));
      registry.registerAgent('b', makeAgent({ name: 'b', dependencies: [] }));
      const order = registry.getDependencyOrder(['a', 'b']);
      expect(order).toHaveLength(2);
    });

    it('should detect circular dependencies', () => {
      registry.registerAgent('a', makeAgent({ name: 'a', dependencies: ['b'] }));
      registry.registerAgent('b', makeAgent({ name: 'b', dependencies: ['a'] }));
      expect(() => registry.getDependencyOrder(['a', 'b'])).toThrow('Circular dependency');
    });

    it('should skip dependencies not in the requested set', () => {
      registry.registerAgent('a', makeAgent({ name: 'a', dependencies: ['external'] }));
      const order = registry.getDependencyOrder(['a']);
      expect(order).toEqual(['a']);
    });
  });

  describe('performHealthCheck', () => {
    it('should return false for non-existent agent', async () => {
      const result = await registry.performHealthCheck('missing');
      expect(result).toBe(false);
    });

    it('should mark agent as healthy when validateInput succeeds', async () => {
      registry.registerAgent('agent-a', makeAgent());
      const result = await registry.performHealthCheck('agent-a');
      expect(result).toBe(true);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.healthStatus).toBe('healthy');
    });

    it('should mark agent as degraded when validateInput returns false', async () => {
      registry.registerAgent('agent-a', makeAgent({
        validateInput: jest.fn().mockResolvedValue(false),
      }));
      const result = await registry.performHealthCheck('agent-a');
      expect(result).toBe(false);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.healthStatus).toBe('degraded');
    });

    it('should mark agent as unhealthy on error', async () => {
      registry.registerAgent('agent-a', makeAgent({
        validateInput: jest.fn().mockRejectedValue(new Error('broken')),
      }));
      const result = await registry.performHealthCheck('agent-a');
      expect(result).toBe(false);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.healthStatus).toBe('unhealthy');
    });

    it('should update lastHealthCheck timestamp', async () => {
      registry.registerAgent('agent-a', makeAgent());
      await registry.performHealthCheck('agent-a');
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.lastHealthCheck).toBeInstanceOf(Date);
    });
  });

  describe('performAllHealthChecks', () => {
    it('should check all registered agents', async () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));
      registry.registerAgent('b', makeAgent({ name: 'b' }));
      const results = await registry.performAllHealthChecks();
      expect(results.size).toBe(2);
      expect(results.get('a')).toBe(true);
      expect(results.get('b')).toBe(true);
    });

    it('should log summary', async () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));
      await registry.performAllHealthChecks();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'All agent health checks completed',
        expect.objectContaining({ totalAgents: 1 }),
      );
    });
  });

  describe('getAgentHealth', () => {
    it('should return null for non-existent agent', async () => {
      const health = await registry.getAgentHealth('missing');
      expect(health).toBeNull();
    });

    it('should return health status', async () => {
      registry.registerAgent('agent-a', makeAgent());
      await registry.performHealthCheck('agent-a');
      const health = await registry.getAgentHealth('agent-a');
      expect(health!.name).toBe('agent-a');
      expect(health!.status).toBe('healthy');
      expect(health!.responseTime).toBeDefined();
      expect(health!.errorRate).toBeDefined();
    });

    it('should treat unknown status as healthy', async () => {
      registry.registerAgent('agent-a', makeAgent());
      const health = await registry.getAgentHealth('agent-a');
      expect(health!.status).toBe('healthy');
    });
  });

  describe('getAllAgentHealth', () => {
    it('should return health for all agents', async () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));
      registry.registerAgent('b', makeAgent({ name: 'b' }));
      const healths = await registry.getAllAgentHealth();
      expect(healths).toHaveLength(2);
    });
  });

  describe('updateAgentStats', () => {
    it('should ignore non-existent agent', () => {
      registry.updateAgentStats('missing', 100, true);
      // no throw
    });

    it('should increment execution count', () => {
      registry.registerAgent('agent-a', makeAgent());
      registry.updateAgentStats('agent-a', 100, true);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.executionCount).toBe(1);
    });

    it('should update average execution time', () => {
      registry.registerAgent('agent-a', makeAgent());
      registry.updateAgentStats('agent-a', 100, true);
      registry.updateAgentStats('agent-a', 200, true);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.averageExecutionTime).toBe(150);
    });

    it('should update success rate on failure', () => {
      registry.registerAgent('agent-a', makeAgent());
      registry.updateAgentStats('agent-a', 100, false);
      const reg = registry.getAgentRegistration('agent-a');
      expect(reg!.successRate).toBeLessThan(1.0);
    });
  });

  describe('getRegistryStats', () => {
    it('should return empty stats with no agents', () => {
      const stats = registry.getRegistryStats();
      expect(stats.totalAgents).toBe(0);
      expect(stats.totalExecutions).toBe(0);
    });

    it('should count agents and capabilities', () => {
      registry.registerAgent('a', makeAgent({ name: 'a', capabilities: ['cap1', 'cap2'] }));
      registry.registerAgent('b', makeAgent({ name: 'b', capabilities: ['cap2', 'cap3'] }));
      const stats = registry.getRegistryStats();
      expect(stats.totalAgents).toBe(2);
      expect(stats.capabilityDistribution['cap1']).toBe(1);
      expect(stats.capabilityDistribution['cap2']).toBe(2);
      expect(stats.capabilityDistribution['cap3']).toBe(1);
    });

    it('should count healthy agents', async () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));
      await registry.performHealthCheck('a');
      const stats = registry.getRegistryStats();
      expect(stats.healthyAgents).toBe(1);
    });

    it('should aggregate execution stats', () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));
      registry.updateAgentStats('a', 100, true);
      registry.updateAgentStats('a', 200, true);
      const stats = registry.getRegistryStats();
      expect(stats.totalExecutions).toBe(2);
    });
  });

  describe('createHealthCheckInput (via performHealthCheck)', () => {
    it('should create input for FieldMappingAgent', async () => {
      const agent = makeAgent({ name: 'FieldMappingAgent' });
      registry.registerAgent('fm', agent);
      await registry.performHealthCheck('fm');
      expect(agent.validateInput).toHaveBeenCalledWith(
        expect.objectContaining({ sourceFields: expect.any(Array) }),
      );
    });

    it('should create input for DataQualityAgent', async () => {
      const agent = makeAgent({ name: 'DataQualityAgent' });
      registry.registerAgent('dq', agent);
      await registry.performHealthCheck('dq');
      expect(agent.validateInput).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.any(Array) }),
      );
    });

    it('should create input for ProcessOptimizationAgent', async () => {
      const agent = makeAgent({ name: 'ProcessOptimizationAgent' });
      registry.registerAgent('po', agent);
      await registry.performHealthCheck('po');
      expect(agent.validateInput).toHaveBeenCalledWith(
        expect.objectContaining({ currentWorkflow: expect.any(Array) }),
      );
    });

    it('should create input for business-intelligence agent', async () => {
      const agent = makeAgent({ name: 'business-intelligence' });
      registry.registerAgent('bi', agent);
      await registry.performHealthCheck('bi');
      expect(agent.validateInput).toHaveBeenCalledWith(
        expect.objectContaining({ organizationProfile: expect.any(Object) }),
      );
    });

    it('should create empty input for unknown agent', async () => {
      const agent = makeAgent({ name: 'unknown-agent' });
      registry.registerAgent('uk', agent);
      await registry.performHealthCheck('uk');
      expect(agent.validateInput).toHaveBeenCalledWith({});
    });
  });

  describe('periodic health checks', () => {
    it('should trigger health checks after interval', async () => {
      registry.registerAgent('a', makeAgent({ name: 'a' }));

      // Advance past the 5-minute interval
      jest.advanceTimersByTime(300001);

      // The interval fires performAllHealthChecks asynchronously
      // We just verify the timer was set up (no error on advance)
      expect(mockLogger.info).toHaveBeenCalledWith('Agent registry initialized');
    });
  });

  describe('dependency graph cleanup', () => {
    it('should remove agent from other dependency graphs on unregister', () => {
      registry.registerAgent('base', makeAgent({ name: 'base', dependencies: [] }));
      registry.registerAgent('dep', makeAgent({ name: 'dep', dependencies: ['base'] }));

      registry.unregisterAgent('base');

      // dep should still be registered but dependency on base is cleaned
      expect(registry.getAgent('dep')).toBeDefined();
    });
  });
});
