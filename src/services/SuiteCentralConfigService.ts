import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import { TYPES } from '../inversify/types';
import { CryptoUtils } from '../utils/crypto';
import * as crypto from 'crypto';

export interface SuiteCentralEnvironmentConfig {
  id: string;
  name: string;
  baseUrl: string;
  environment: 'sandbox' | 'production';
  apiVersion: string;
  timeout: number;
  retryAttempts: number;
  rateLimiting: {
    requestsPerSecond: number;
    burstAllowance: number;
    dailyQuota: number;
  };
  security: {
    enabledCiphers: string[];
    tlsVersion: string;
    certificatePinning: boolean;
    requestSigning: boolean;
  };
  monitoring: {
    enableHealthCheck: boolean;
    healthCheckInterval: number;
    enableMetrics: boolean;
    alertThresholds: {
      errorRate: number;
      responseTime: number;
      availabilityThreshold: number;
    };
  };
  features: {
    bulkOperations: boolean;
    webhooks: boolean;
    realTimeSync: boolean;
    advancedSearch: boolean;
    changeTracking: boolean;
  };
}

export interface SuiteCentralCredentialProfile {
  id: string;
  name: string;
  environmentId: string;
  clientId: string;
  clientSecret: string; // Encrypted
  companyId?: string;
  scopes: string[];
  createdAt: Date;
  lastUsed?: Date;
  isActive: boolean;
}

export interface SuiteCentralIntegrationTemplate {
  id: string;
  name: string;
  description: string;
  sourceSystem: string;
  targetEntities: string[];
  fieldMappings: {
    sourceField: string;
    targetField: string;
    transformation?: string;
    isRequired: boolean;
  }[];
  businessRules: {
    id: string;
    name: string;
    condition: string;
    action: string;
    priority: number;
  }[];
  syncSettings: {
    direction: 'inbound' | 'outbound' | 'bidirectional';
    frequency: 'realtime' | 'hourly' | 'daily' | 'weekly';
    batchSize: number;
    errorHandling: 'skip' | 'retry' | 'fail';
  };
}

export interface SuiteCentralPerformanceProfile {
  environmentId: string;
  averageResponseTime: number;
  successRate: number;
  dailyRequestVolume: number;
  peakHourThroughput: number;
  errorDistribution: Record<string, number>;
  lastUpdated: Date;
}

/**
 * SuiteCentralConfigService manages production configurations, credentials,
 * integration templates, and performance profiles for SuiteCentral connectors.
 * 
 * Features:
 * - Environment-specific configurations (sandbox/production)
 * - Encrypted credential management
 * - Integration templates for common patterns
 * - Performance monitoring and optimization
 * - Health check and alerting configuration
 */
@injectable()
export class SuiteCentralConfigService {
  private environments = new Map<string, SuiteCentralEnvironmentConfig>();
  private credentials = new Map<string, SuiteCentralCredentialProfile>();
  private templates = new Map<string, SuiteCentralIntegrationTemplate>();
  private performanceProfiles = new Map<string, SuiteCentralPerformanceProfile>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService
  ) {
    this.initializeDefaultConfigurations();
    this.logger.info('SuiteCentralConfigService initialized');
  }

  // Environment Configuration Management
  async createEnvironment(config: Omit<SuiteCentralEnvironmentConfig, 'id'>): Promise<string> {
    const environmentId = CryptoUtils.generateUUID();
    const environment: SuiteCentralEnvironmentConfig = {
      id: environmentId,
      ...config
    };

    this.environments.set(environmentId, environment);
    
    this.logger.info('SuiteCentral environment created', {
      environmentId,
      name: config.name,
      environment: config.environment
    });

    return environmentId;
  }

  getEnvironment(environmentId: string): SuiteCentralEnvironmentConfig | null {
    return this.environments.get(environmentId) || null;
  }

  getAllEnvironments(): SuiteCentralEnvironmentConfig[] {
    return Array.from(this.environments.values());
  }

  async updateEnvironment(environmentId: string, updates: Partial<SuiteCentralEnvironmentConfig>): Promise<boolean> {
    const environment = this.environments.get(environmentId);
    if (!environment) {
      return false;
    }

    const updatedEnvironment = { ...environment, ...updates, id: environmentId };
    this.environments.set(environmentId, updatedEnvironment);

    this.logger.info('SuiteCentral environment updated', { environmentId, updates });
    return true;
  }

  // Credential Management
  async createCredentialProfile(profile: Omit<SuiteCentralCredentialProfile, 'id' | 'createdAt'>): Promise<string> {
    const profileId = CryptoUtils.generateUUID();
    
    // Generate encryption key from a combination of profile data and system secret
    const keyMaterial = `suitecentral-${profileId}-${profile.environmentId}`;
    const encryptionKey = crypto.createHash('sha256').update(keyMaterial).digest();
    
    // Encrypt the client secret
    const encryptedSecret = CryptoUtils.encrypt(profile.clientSecret, encryptionKey);
    
    const credentialProfile: SuiteCentralCredentialProfile = {
      id: profileId,
      createdAt: new Date(),
      ...profile,
      clientSecret: JSON.stringify(encryptedSecret) // Store as JSON string
    };

    this.credentials.set(profileId, credentialProfile);

    this.logger.info('SuiteCentral credential profile created', {
      profileId,
      name: profile.name,
      environmentId: profile.environmentId
    });

    return profileId;
  }

  async getCredentialProfile(profileId: string, decrypt = false): Promise<SuiteCentralCredentialProfile | null> {
    const profile = this.credentials.get(profileId);
    if (!profile) {
      return null;
    }

    if (decrypt) {
      try {
        // Generate the same encryption key
        const keyMaterial = `suitecentral-${profileId}-${profile.environmentId}`;
        const encryptionKey = crypto.createHash('sha256').update(keyMaterial).digest();
        
        // Parse the encrypted data and decrypt
        const encryptedData = JSON.parse(profile.clientSecret);
        const decryptedSecret = CryptoUtils.decrypt(encryptedData, encryptionKey);
        
        return {
          ...profile,
          clientSecret: decryptedSecret
        };
      } catch (error) {
        this.logger.error('Failed to decrypt credential profile', { profileId, error });
        return profile;
      }
    }

    return profile;
  }

  getCredentialsByEnvironment(environmentId: string): SuiteCentralCredentialProfile[] {
    return Array.from(this.credentials.values())
      .filter(profile => profile.environmentId === environmentId);
  }

  async updateCredentialLastUsed(profileId: string): Promise<void> {
    const profile = this.credentials.get(profileId);
    if (profile) {
      profile.lastUsed = new Date();
      this.credentials.set(profileId, profile);
    }
  }

  // Integration Template Management
  async createIntegrationTemplate(template: Omit<SuiteCentralIntegrationTemplate, 'id'>): Promise<string> {
    const templateId = CryptoUtils.generateUUID();
    const integrationTemplate: SuiteCentralIntegrationTemplate = {
      id: templateId,
      ...template
    };

    this.templates.set(templateId, integrationTemplate);

    this.logger.info('SuiteCentral integration template created', {
      templateId,
      name: template.name,
      sourceSystem: template.sourceSystem
    });

    return templateId;
  }

  getIntegrationTemplate(templateId: string): SuiteCentralIntegrationTemplate | null {
    return this.templates.get(templateId) || null;
  }

  getTemplatesBySourceSystem(sourceSystem: string): SuiteCentralIntegrationTemplate[] {
    return Array.from(this.templates.values())
      .filter(template => template.sourceSystem === sourceSystem);
  }

  getAllTemplates(): SuiteCentralIntegrationTemplate[] {
    return Array.from(this.templates.values());
  }

  // Performance Profile Management
  async updatePerformanceProfile(environmentId: string, metrics: {
    responseTime: number;
    successRate: number;
    requestCount: number;
    errors: Record<string, number>;
  }): Promise<void> {
    const existing = this.performanceProfiles.get(environmentId);
    
    const profile: SuiteCentralPerformanceProfile = {
      environmentId,
      averageResponseTime: existing ? 
        (existing.averageResponseTime * 0.7 + metrics.responseTime * 0.3) : 
        metrics.responseTime,
      successRate: existing ?
        (existing.successRate * 0.7 + metrics.successRate * 0.3) :
        metrics.successRate,
      dailyRequestVolume: existing ?
        existing.dailyRequestVolume + metrics.requestCount :
        metrics.requestCount,
      peakHourThroughput: Math.max(existing?.peakHourThroughput || 0, metrics.requestCount),
      errorDistribution: {
        ...existing?.errorDistribution,
        ...metrics.errors
      },
      lastUpdated: new Date()
    };

    this.performanceProfiles.set(environmentId, profile);
  }

  getPerformanceProfile(environmentId: string): SuiteCentralPerformanceProfile | null {
    return this.performanceProfiles.get(environmentId) || null;
  }

  // Configuration Validation
  validateEnvironmentConfig(config: SuiteCentralEnvironmentConfig): string[] {
    const errors: string[] = [];

    if (!config.baseUrl || !config.baseUrl.startsWith('https://')) {
      errors.push('Base URL must be HTTPS');
    }

    if (config.rateLimiting.requestsPerSecond < 1 || config.rateLimiting.requestsPerSecond > 1000) {
      errors.push('Requests per second must be between 1 and 1000');
    }

    if (config.timeout < 1000 || config.timeout > 300000) {
      errors.push('Timeout must be between 1 and 300 seconds');
    }

    if (config.environment === 'production') {
      if (!config.security.certificatePinning) {
        errors.push('Certificate pinning must be enabled in production');
      }
      
      if (config.security.tlsVersion !== '1.3') {
        errors.push('TLS 1.3 is required for production environments');
      }
    }

    return errors;
  }

  // Health and Monitoring
  async generateHealthReport(): Promise<{
    environments: {
      id: string;
      name: string;
      status: 'healthy' | 'warning' | 'critical';
      issues: string[];
    }[];
    credentials: {
      total: number;
      active: number;
      expiringSoon: number;
    };
    templates: {
      total: number;
      bySourceSystem: Record<string, number>;
    };
    performance: {
      environmentId: string;
      averageResponseTime: number;
      successRate: number;
      status: 'good' | 'warning' | 'poor';
    }[];
  }> {
    const environments = Array.from(this.environments.values()).map(env => {
      const issues: string[] = [];
      const performance = this.performanceProfiles.get(env.id);
      
      if (performance) {
        if (performance.successRate < env.monitoring.alertThresholds.availabilityThreshold) {
          issues.push(`Success rate (${performance.successRate}%) below threshold`);
        }
        
        if (performance.averageResponseTime > env.monitoring.alertThresholds.responseTime) {
          issues.push(`Response time (${performance.averageResponseTime}ms) above threshold`);
        }
      }

      const status: 'healthy' | 'warning' | 'critical' = 
        issues.length === 0 ? 'healthy' :
        issues.length <= 2 ? 'warning' : 'critical';

      return {
        id: env.id,
        name: env.name,
        status,
        issues
      };
    });

    const credentials = Array.from(this.credentials.values());
    const templates = Array.from(this.templates.values());
    
    const templatesBySource = templates.reduce((acc, template) => {
      acc[template.sourceSystem] = (acc[template.sourceSystem] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const performance = Array.from(this.performanceProfiles.values()).map(profile => {
      let status: 'good' | 'warning' | 'poor' = 'good';
      
      if (profile.successRate < 95 || profile.averageResponseTime > 2000) {
        status = 'warning';
      }
      
      if (profile.successRate < 90 || profile.averageResponseTime > 5000) {
        status = 'poor';
      }

      return {
        environmentId: profile.environmentId,
        averageResponseTime: profile.averageResponseTime,
        successRate: profile.successRate,
        status
      };
    });

    return {
      environments,
      credentials: {
        total: credentials.length,
        active: credentials.filter(c => c.isActive).length,
        expiringSoon: 0 // Could implement expiration logic
      },
      templates: {
        total: templates.length,
        bySourceSystem: templatesBySource
      },
      performance
    };
  }

  // Initialize default configurations
  private initializeDefaultConfigurations(): void {
    // Sandbox environment
    const sandboxId = CryptoUtils.generateUUID();
    const sandboxEnv: SuiteCentralEnvironmentConfig = {
      id: sandboxId,
      name: 'SuiteCentral Sandbox',
      baseUrl: 'https://sandbox.suitecentral.com',
      environment: 'sandbox',
      apiVersion: 'v1',
      timeout: 30000,
      retryAttempts: 3,
      rateLimiting: {
        requestsPerSecond: 5,
        burstAllowance: 10,
        dailyQuota: 10000
      },
      security: {
        enabledCiphers: ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'],
        tlsVersion: '1.2',
        certificatePinning: false,
        requestSigning: false
      },
      monitoring: {
        enableHealthCheck: true,
        healthCheckInterval: 300000, // 5 minutes
        enableMetrics: true,
        alertThresholds: {
          errorRate: 5.0,
          responseTime: 3000,
          availabilityThreshold: 95.0
        }
      },
      features: {
        bulkOperations: true,
        webhooks: true,
        realTimeSync: false,
        advancedSearch: true,
        changeTracking: true
      }
    };

    // Production environment
    const prodId = CryptoUtils.generateUUID();
    const prodEnv: SuiteCentralEnvironmentConfig = {
      id: prodId,
      name: 'SuiteCentral Production',
      baseUrl: 'https://api.suitecentral.com',
      environment: 'production',
      apiVersion: 'v1',
      timeout: 15000,
      retryAttempts: 2,
      rateLimiting: {
        requestsPerSecond: 20,
        burstAllowance: 50,
        dailyQuota: 100000
      },
      security: {
        enabledCiphers: ['TLS_AES_256_GCM_SHA384'],
        tlsVersion: '1.3',
        certificatePinning: true,
        requestSigning: true
      },
      monitoring: {
        enableHealthCheck: true,
        healthCheckInterval: 60000, // 1 minute
        enableMetrics: true,
        alertThresholds: {
          errorRate: 2.0,
          responseTime: 1500,
          availabilityThreshold: 99.5
        }
      },
      features: {
        bulkOperations: true,
        webhooks: true,
        realTimeSync: true,
        advancedSearch: true,
        changeTracking: true
      }
    };

    this.environments.set(sandboxId, sandboxEnv);
    this.environments.set(prodId, prodEnv);

    // Default integration templates
    this.createDefaultTemplates();

    this.logger.info('Default SuiteCentral configurations initialized', {
      environments: 2,
      templates: this.templates.size
    });
  }

  private async createDefaultTemplates(): Promise<void> {
    // Squire → SuiteCentral Customer template
    const squireCustomerTemplate: Omit<SuiteCentralIntegrationTemplate, 'id'> = {
      name: 'Squire to SuiteCentral Customers',
      description: 'Sync customer data from Squire POS to SuiteCentral',
      sourceSystem: 'Squire',
      targetEntities: ['customers'],
      fieldMappings: [
        { sourceField: 'customer_id', targetField: 'customerId', isRequired: true },
        { sourceField: 'business_name', targetField: 'companyName', isRequired: true },
        { sourceField: 'contact_name', targetField: 'contactName', isRequired: false },
        { sourceField: 'email', targetField: 'email', isRequired: false },
        { sourceField: 'phone', targetField: 'phone', isRequired: false },
        { sourceField: 'address', targetField: 'address', isRequired: false },
        { sourceField: 'status', targetField: 'status', isRequired: true }
      ],
      businessRules: [
        {
          id: '1',
          name: 'Active Customer Filter',
          condition: 'status === "active"',
          action: 'sync',
          priority: 1
        },
        {
          id: '2',
          name: 'Email Validation',
          condition: 'email && email.includes("@")',
          action: 'validate',
          priority: 2
        }
      ],
      syncSettings: {
        direction: 'outbound',
        frequency: 'realtime',
        batchSize: 100,
        errorHandling: 'retry'
      }
    };

    await this.createIntegrationTemplate(squireCustomerTemplate);

    // NetSuite → SuiteCentral Orders template
    const netsuiteOrderTemplate: Omit<SuiteCentralIntegrationTemplate, 'id'> = {
      name: 'NetSuite to SuiteCentral Orders',
      description: 'Sync sales orders from NetSuite to SuiteCentral',
      sourceSystem: 'NetSuite',
      targetEntities: ['orders'],
      fieldMappings: [
        { sourceField: 'tranid', targetField: 'orderId', isRequired: true },
        { sourceField: 'entity', targetField: 'customerId', isRequired: true },
        { sourceField: 'trandate', targetField: 'orderDate', isRequired: true },
        { sourceField: 'total', targetField: 'totalAmount', isRequired: true },
        { sourceField: 'status', targetField: 'status', isRequired: true },
        { sourceField: 'item', targetField: 'items', transformation: 'arrayToObject', isRequired: false }
      ],
      businessRules: [
        {
          id: '1',
          name: 'Completed Orders Only',
          condition: 'status === "Billed" || status === "Fulfilled"',
          action: 'sync',
          priority: 1
        }
      ],
      syncSettings: {
        direction: 'outbound',
        frequency: 'hourly',
        batchSize: 50,
        errorHandling: 'skip'
      }
    };

    await this.createIntegrationTemplate(netsuiteOrderTemplate);
  }
}

export default SuiteCentralConfigService;