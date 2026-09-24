/**
 * Agent Registry - Centralized management of AI agents
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import { logger, type Logger } from '../../../utils/Logger';
import type { Agent, AgentSchema, AgentExecutionContext } from './interfaces';

export interface AgentRegistration {
  agent: Agent;
  registeredAt: Date;
  lastHealthCheck?: Date;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  executionCount: number;
  averageExecutionTime: number;
  successRate: number;
}

export interface AgentCapabilityQuery {
  capabilities: string[];
  requireAll?: boolean;
  excludeUnhealthy?: boolean;
}

export interface AgentHealthStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: Date;
  responseTime?: number;
  errorRate?: number;
  uptime?: number;
}

@injectable()
export class AgentRegistry {
  private agents = new Map<string, AgentRegistration>();
  private capabilityIndex = new Map<string, Set<string>>();
  private dependencyGraph = new Map<string, Set<string>>();

  constructor(@inject(TYPES.Logger) private logger: Logger) {
    this.initializeRegistry();
  }

  /**
   * Register an agent with the registry
   */
  registerAgent(name: string, agent: Agent): void {
    try {
      // Validate agent implementation
      this.validateAgent(agent);

      const registration: AgentRegistration = {
        agent,
        registeredAt: new Date(),
        healthStatus: 'unknown',
        executionCount: 0,
        averageExecutionTime: 0,
        successRate: 1.0
      };

      this.agents.set(name, registration);
      this.updateCapabilityIndex(name, agent);
      this.updateDependencyGraph(name, agent);

      this.logger.info('Agent registered successfully', {
        name,
        version: agent.version,
        capabilities: agent.capabilities,
        dependencies: agent.dependencies
      });

      // Perform initial health check
      this.performHealthCheck(name).catch(error => {
        this.logger.warn('Initial health check failed for agent', {
          name,
          error: String(error)
        });
      });

    } catch (error) {
      this.logger.error('Failed to register agent', {
        name,
        error: String(error)
      });
      throw new Error(`Agent registration failed: ${error}`, { cause: error });
    }
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(name: string): boolean {
    const registration = this.agents.get(name);
    if (!registration) {
      return false;
    }

    this.agents.delete(name);
    this.removeFromCapabilityIndex(name, registration.agent);
    this.removeFromDependencyGraph(name);

    this.logger.info('Agent unregistered', { name });
    return true;
  }

  /**
   * Get an agent by name
   */
  getAgent(name: string): Agent | null {
    const registration = this.agents.get(name);
    return registration?.agent || null;
  }

  /**
   * Get agent registration info
   */
  getAgentRegistration(name: string): AgentRegistration | null {
    return this.agents.get(name) || null;
  }

  /**
   * List all registered agents
   */
  listAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Find agents by capabilities
   */
  findAgentsByCapabilities(query: AgentCapabilityQuery): string[] {
    const { capabilities, requireAll = false, excludeUnhealthy = true } = query;

    const candidates = new Set<string>();

    // Find agents with required capabilities
    for (const capability of capabilities) {
      const agentsWithCapability = this.capabilityIndex.get(capability) || new Set();

      if (candidates.size === 0) {
        // First capability - add all agents that have it
        agentsWithCapability.forEach(agent => candidates.add(agent));
      } else if (requireAll) {
        // Intersection - keep only agents that have this capability too
        const intersection = new Set<string>();
        candidates.forEach(agent => {
          if (agentsWithCapability.has(agent)) {
            intersection.add(agent);
          }
        });
        candidates.clear();
        intersection.forEach(agent => candidates.add(agent));
      } else {
        // Union - add any agent that has this capability
        agentsWithCapability.forEach(agent => candidates.add(agent));
      }
    }

    // Filter by health status if requested
    if (excludeUnhealthy) {
      const healthyAgents = Array.from(candidates).filter(name => {
        const registration = this.agents.get(name);
        return registration?.healthStatus === 'healthy' || registration?.healthStatus === 'degraded';
      });
      return healthyAgents;
    }

    return Array.from(candidates);
  }

  /**
   * Get agents in dependency order
   */
  getDependencyOrder(agentNames: string[]): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const visit = (name: string) => {
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving agent: ${name}`);
      }
      if (visited.has(name)) {
        return;
      }

      visiting.add(name);

      const agent = this.getAgent(name);
      if (agent) {
        // Visit dependencies first
        for (const dep of agent.dependencies) {
          if (agentNames.includes(dep)) {
            visit(dep);
          }
        }
      }

      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    // Visit all requested agents
    for (const name of agentNames) {
      visit(name);
    }

    return result;
  }

  /**
   * Get agent health status
   */
  async getAgentHealth(name: string): Promise<AgentHealthStatus | null> {
    const registration = this.agents.get(name);
    if (!registration) {
      return null;
    }

    return {
      name,
      status: (registration.healthStatus === 'unknown' ? 'healthy' : registration.healthStatus) as 'healthy' | 'degraded' | 'unhealthy',
      lastCheck: registration.lastHealthCheck || registration.registeredAt,
      responseTime: registration.averageExecutionTime,
      errorRate: 1 - registration.successRate,
      uptime: Date.now() - registration.registeredAt.getTime()
    };
  }

  /**
   * Get all agent health statuses
   */
  async getAllAgentHealth(): Promise<AgentHealthStatus[]> {
    const healthStatuses: AgentHealthStatus[] = [];

    for (const name of this.agents.keys()) {
      const health = await this.getAgentHealth(name);
      if (health) {
        healthStatuses.push(health);
      }
    }

    return healthStatuses;
  }

  /**
   * Perform health check on specific agent
   */
  async performHealthCheck(name: string): Promise<boolean> {
    const registration = this.agents.get(name);
    if (!registration) {
      return false;
    }

    const startTime = Date.now();

    try {
      // Create a minimal context for health check
      const healthContext: AgentExecutionContext = {
        sessionId: `health-check-${Date.now()}`,
        sourceSystem: 'health-check',
        targetSystem: 'health-check',
        confidenceThreshold: 0.5,
        maxExecutionTime: 5000,
        enableReasoningTrace: false
      };

      // Validate with agent-specific sample input so health reflects capabilities
      const sampleInput = this.createHealthCheckInput(registration.agent.name);
      const isValid = await registration.agent.validateInput(sampleInput);
      const responseTime = Date.now() - startTime;

      registration.lastHealthCheck = new Date();
      registration.healthStatus = isValid ? 'healthy' : 'degraded';

      this.logger.debug('Agent health check completed', {
        name,
        status: registration.healthStatus,
        responseTime
      });

      return isValid;

    } catch (error) {
      registration.lastHealthCheck = new Date();
      registration.healthStatus = 'unhealthy';

      this.logger.warn('Agent health check failed', {
        name,
        error: String(error)
      });

      return false;
    }
  }

  /**
   * Perform health checks on all agents
   */
  async performAllHealthChecks(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    const healthCheckPromises = Array.from(this.agents.keys()).map(async name => {
      const result = await this.performHealthCheck(name);
      results.set(name, result);
      return { name, result };
    });

    await Promise.allSettled(healthCheckPromises);

    this.logger.info('All agent health checks completed', {
      totalAgents: this.agents.size,
      healthyCount: Array.from(results.values()).filter(Boolean).length
    });

    return results;
  }

  /**
   * Update agent execution statistics
   */
  updateAgentStats(name: string, executionTime: number, success: boolean): void {
    const registration = this.agents.get(name);
    if (!registration) {
      return;
    }

    registration.executionCount++;

    // Update rolling average execution time
    registration.averageExecutionTime =
      (registration.averageExecutionTime * (registration.executionCount - 1) + executionTime) /
      registration.executionCount;

    // Update rolling success rate (last 100 executions weighted)
    const weight = Math.min(registration.executionCount, 100);
    registration.successRate =
      (registration.successRate * (weight - 1) + (success ? 1 : 0)) / weight;

    this.logger.debug('Agent stats updated', {
      name,
      executionCount: registration.executionCount,
      averageExecutionTime: registration.averageExecutionTime,
      successRate: registration.successRate
    });
  }

  /**
   * Get registry statistics
   */
  getRegistryStats(): {
    totalAgents: number;
    healthyAgents: number;
    totalExecutions: number;
    averageSuccessRate: number;
    capabilityDistribution: Record<string, number>;
  } {
    const totalAgents = this.agents.size;
    const healthyAgents = Array.from(this.agents.values())
      .filter(reg => reg.healthStatus === 'healthy').length;

    const totalExecutions = Array.from(this.agents.values())
      .reduce((sum, reg) => sum + reg.executionCount, 0);

    const averageSuccessRate = Array.from(this.agents.values())
      .reduce((sum, reg) => sum + reg.successRate, 0) / totalAgents;

    const capabilityDistribution: Record<string, number> = {};
    this.capabilityIndex.forEach((agents, capability) => {
      capabilityDistribution[capability] = agents.size;
    });

    return {
      totalAgents,
      healthyAgents,
      totalExecutions,
      averageSuccessRate,
      capabilityDistribution
    };
  }

  // Private methods

  private initializeRegistry(): void {
    this.logger.info('Agent registry initialized');

    // Start periodic health checks
    setInterval(async () => {
      try {
        await this.performAllHealthChecks();
      } catch (error) {
        this.logger.error('Periodic health check failed', { error: String(error) });
      }
    }, 300000); // Every 5 minutes
  }

  private validateAgent(agent: Agent): void {
    if (!agent.name || typeof agent.name !== 'string') {
      throw new Error('Agent must have a valid name');
    }

    if (!agent.version || typeof agent.version !== 'string') {
      throw new Error('Agent must have a valid version');
    }

    if (!Array.isArray(agent.capabilities)) {
      throw new Error('Agent must have a capabilities array');
    }

    if (!Array.isArray(agent.dependencies)) {
      throw new Error('Agent must have a dependencies array');
    }

    if (typeof agent.execute !== 'function') {
      throw new Error('Agent must implement execute method');
    }

    if (typeof agent.validateInput !== 'function') {
      throw new Error('Agent must implement validateInput method');
    }

    if (typeof agent.getSchema !== 'function') {
      throw new Error('Agent must implement getSchema method');
    }
  }

  private updateCapabilityIndex(name: string, agent: Agent): void {
    for (const capability of agent.capabilities) {
      if (!this.capabilityIndex.has(capability)) {
        this.capabilityIndex.set(capability, new Set());
      }
      this.capabilityIndex.get(capability)!.add(name);
    }
  }

  private removeFromCapabilityIndex(name: string, agent: Agent): void {
    for (const capability of agent.capabilities) {
      const agentsWithCapability = this.capabilityIndex.get(capability);
      if (agentsWithCapability) {
        agentsWithCapability.delete(name);
        if (agentsWithCapability.size === 0) {
          this.capabilityIndex.delete(capability);
        }
      }
    }
  }

  private updateDependencyGraph(name: string, agent: Agent): void {
    this.dependencyGraph.set(name, new Set(agent.dependencies));
  }

  private removeFromDependencyGraph(name: string): void {
    this.dependencyGraph.delete(name);

    // Remove this agent as a dependency from others
    this.dependencyGraph.forEach(deps => {
      deps.delete(name);
    });
  }

  private createHealthCheckInput(agentName: string): unknown {
    switch (agentName) {
      case 'FieldMappingAgent':
        return {
          sourceFields: [
            { name: 'first_name', type: 'string', description: 'Source first name', required: true }
          ],
          targetFields: [
            { name: 'FirstName', type: 'string', description: 'Target first name', required: true }
          ],
          sampleData: [
            { first_name: 'Ada' }
          ]
        };
      case 'DataQualityAgent':
        return {
          data: [
            { first_name: 'Ada', revenue: 123.45 }
          ],
          schema: [
            { name: 'first_name', type: 'string' },
            { name: 'revenue', type: 'number' }
          ]
        };
      case 'ProcessOptimizationAgent':
        return {
          currentWorkflow: [
            {
              id: 'step-1',
              name: 'Review Request',
              type: 'manual',
              duration: 15,
              resources: ['analyst'],
              dependencies: []
            }
          ]
        };
      case 'IntegrationStrategyAgent':
        return {
          sourceSystemProfile: {
            name: 'Legacy CRM',
            type: 'crm',
            capabilities: ['rest-api'],
            limitations: ['rate-limits']
          },
          targetSystemProfile: {
            name: 'NetSuite',
            type: 'erp',
            capabilities: ['bulk-import'],
            limitations: ['batch-processing']
          },
          businessRequirements: [
            {
              id: 'req-1',
              description: 'Synchronize customer records nightly',
              priority: 'high',
              type: 'functional'
            }
          ]
        };
      case 'business-intelligence':
      case 'BusinessIntelligenceAgent':
        return {
          organizationProfile: {
            name: 'Acme Corp',
            industry: 'Manufacturing',
            annualRevenue: 1_000_000,
            employeeCount: 250
          },
          analysisType: 'business-impact'
        };
      default:
        return {};
    }
  }
}
