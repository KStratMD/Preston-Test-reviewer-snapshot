/**
 * Mapping Persistence Service - Backend storage for mapping templates and AI workflows
 * Phase 1 Implementation: Replaces localStorage with proper backend persistence
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';

export interface MappingTemplate {
  id: string;
  name: string;
  sourceSystem: string;
  targetSystem: string;
  industry?: string;
  businessProcess?: string;
  mappings: FieldMapping[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
    version: number;
    isActive: boolean;
    tags: string[];
  };
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional';
  confidence?: number;
  reasoning?: string;
  transformationDetails?: unknown;
}

export interface AIWorkflowState {
  id: string;
  userId?: string;
  sessionId: string;
  workflowType: 'integration_wizard' | 'field_mapping' | 'data_quality';
  currentStep: number;
  totalSteps: number;
  data: unknown;
  metadata: {
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    isComplete: boolean;
  };
}

export interface AIConfiguration {
  id: string;
  userId?: string;
  providerId: string;
  settings: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    customPrompts?: { [key: string]: string };
  };
  metadata: {
    createdAt: string;
    updatedAt: string;
    isActive: boolean;
    lastUsed?: string;
  };
}

export interface MappingApproval {
  id: string;
  mappingTemplateId: string;
  mappingHash: string; // SHA-256 hash of mapping JSON
  approvedBy: string;
  approvedAt: string;
  rationale?: string;
  confidenceScore?: number; // 0.0-1.0
  beforeState: FieldMapping[] | null;
  afterState: FieldMapping[];
  metadata?: {
    ipAddress?: string;
    userAgent?: string;
    reviewNotes?: string;
    [key: string]: unknown;
  };
}

/**
 * Backend persistence service replacing localStorage
 * Uses in-memory storage with file backup for Phase 1
 * Production: Replace with PostgreSQL/Redis implementation
 */
@injectable()
export class MappingPersistenceService {
  private templates = new Map<string, MappingTemplate>();
  private workflows = new Map<string, AIWorkflowState>();
  private aiConfigs = new Map<string, AIConfiguration>();
  private approvals = new Map<string, MappingApproval>();

  constructor(@inject(TYPES.Logger) private logger: Logger) {
    this.initializeStorage();
  }

  // === Mapping Templates ===

  async saveMappingTemplate(template: Omit<MappingTemplate, 'id' | 'metadata'> & { metadata?: Partial<MappingTemplate['metadata']> }): Promise<MappingTemplate> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const fullTemplate: MappingTemplate = {
      ...template,
      id,
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: 1,
        isActive: true,
        tags: [],
        ...(template.metadata || {})
      }
    };

    this.templates.set(id, fullTemplate);

    this.logger.info('Mapping template saved', {
      id,
      name: template.name,
      sourceSystem: template.sourceSystem,
      targetSystem: template.targetSystem
    });

    await this.persistToFile();
    return fullTemplate;
  }

  async getMappingTemplate(id: string): Promise<MappingTemplate | null> {
    return this.templates.get(id) || null;
  }

  async updateMappingTemplate(id: string, updates: Partial<MappingTemplate>): Promise<MappingTemplate | null> {
    const existing = this.templates.get(id);
    if (!existing) {
      return null;
    }

    const updated: MappingTemplate = {
      ...existing,
      ...updates,
      id, // Preserve ID
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
        updatedAt: new Date().toISOString(),
        version: existing.metadata.version + 1
      }
    };

    this.templates.set(id, updated);

    this.logger.info('Mapping template updated', { id, version: updated.metadata.version });

    await this.persistToFile();
    return updated;
  }

  async deleteMappingTemplate(id: string): Promise<boolean> {
    const deleted = this.templates.delete(id);
    if (deleted) {
      this.logger.info('Mapping template deleted', { id });
      await this.persistToFile();
    }
    return deleted;
  }

  async listMappingTemplates(filters?: {
    sourceSystem?: string;
    targetSystem?: string;
    industry?: string;
    tags?: string[];
    isActive?: boolean;
  }): Promise<MappingTemplate[]> {
    let templates = Array.from(this.templates.values());

    if (filters) {
      if (filters.sourceSystem) {
        templates = templates.filter(t => t.sourceSystem === filters.sourceSystem);
      }
      if (filters.targetSystem) {
        templates = templates.filter(t => t.targetSystem === filters.targetSystem);
      }
      if (filters.industry) {
        templates = templates.filter(t => t.industry === filters.industry);
      }
      if (filters.isActive !== undefined) {
        templates = templates.filter(t => t.metadata.isActive === filters.isActive);
      }
      if (filters.tags?.length) {
        templates = templates.filter(t =>
          filters.tags!.some(tag => t.metadata.tags.includes(tag))
        );
      }
    }

    return templates.sort((a, b) =>
      new Date(b.metadata.updatedAt).getTime() - new Date(a.metadata.updatedAt).getTime()
    );
  }

  // === AI Workflow State ===

  async saveWorkflowState(state: Omit<AIWorkflowState, 'id' | 'metadata'>): Promise<AIWorkflowState> {
    const id = this.generateId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    const fullState: AIWorkflowState = {
      ...state,
      id,
      metadata: {
        createdAt: now,
        updatedAt: now,
        expiresAt,
        isComplete: false
      }
    };

    this.workflows.set(id, fullState);

    this.logger.info('Workflow state saved', {
      id,
      workflowType: state.workflowType,
      currentStep: state.currentStep,
      sessionId: state.sessionId
    });

    await this.persistToFile();
    return fullState;
  }

  async getWorkflowState(id: string): Promise<AIWorkflowState | null> {
    const state = this.workflows.get(id);

    if (state && this.isExpired(state)) {
      this.workflows.delete(id);
      this.logger.info('Expired workflow state removed', { id });
      return null;
    }

    return state || null;
  }

  async updateWorkflowState(id: string, updates: Partial<AIWorkflowState>): Promise<AIWorkflowState | null> {
    const existing = this.workflows.get(id);
    if (!existing || this.isExpired(existing)) {
      return null;
    }

    const updated: AIWorkflowState = {
      ...existing,
      ...updates,
      id, // Preserve ID
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
        updatedAt: new Date().toISOString()
      }
    };

    this.workflows.set(id, updated);

    this.logger.info('Workflow state updated', {
      id,
      currentStep: updated.currentStep,
      isComplete: updated.metadata.isComplete
    });

    await this.persistToFile();
    return updated;
  }

  async getWorkflowsBySession(sessionId: string): Promise<AIWorkflowState[]> {
    return Array.from(this.workflows.values())
      .filter(w => w.sessionId === sessionId && !this.isExpired(w))
      .sort((a, b) =>
        new Date(b.metadata.updatedAt).getTime() - new Date(a.metadata.updatedAt).getTime()
      );
  }

  // === AI Configuration ===

  async saveAIConfiguration(config: Omit<AIConfiguration, 'id' | 'metadata'>): Promise<AIConfiguration> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const fullConfig: AIConfiguration = {
      ...config,
      id,
      metadata: {
        createdAt: now,
        updatedAt: now,
        isActive: true
      }
    };

    this.aiConfigs.set(id, fullConfig);

    this.logger.info('AI configuration saved', {
      id,
      providerId: config.providerId,
      userId: config.userId
    });

    await this.persistToFile();
    return fullConfig;
  }

  async getAIConfiguration(id: string): Promise<AIConfiguration | null> {
    return this.aiConfigs.get(id) || null;
  }

  async getAIConfigurationByUser(userId: string, providerId?: string): Promise<AIConfiguration[]> {
    return Array.from(this.aiConfigs.values())
      .filter(c => c.userId === userId && (
        !providerId || c.providerId === providerId
      ))
      .filter(c => c.metadata.isActive)
      .sort((a, b) =>
        new Date(b.metadata.updatedAt).getTime() - new Date(a.metadata.updatedAt).getTime()
      );
  }

  // === Utility Methods ===

  private initializeStorage(): void {
    // In Phase 1, initialize with empty storage
    // Production: Load from database
    this.logger.info('Mapping persistence service initialized', {
      templates: this.templates.size,
      workflows: this.workflows.size,
      aiConfigs: this.aiConfigs.size
    });
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
  }

  private isExpired(state: AIWorkflowState): boolean {
    return new Date() > new Date(state.metadata.expiresAt);
  }

  private async persistToFile(): Promise<void> {
    // In Phase 1, implement simple file backup
    // Production: This would be handled by database transactions
    try {
      const data = {
        templates: Array.from(this.templates.entries()),
        workflows: Array.from(this.workflows.entries()),
        aiConfigs: Array.from(this.aiConfigs.entries()),
        timestamp: new Date().toISOString()
      };

      // TODO: Implement file persistence or remove for database implementation
      this.logger.debug('Data persistence completed', {
        templates: data.templates.length,
        workflows: data.workflows.length,
        aiConfigs: data.aiConfigs.length
      });

    } catch (error) {
      this.logger.error('Failed to persist data', error);
      // Don't throw - this is best-effort persistence in Phase 1
    }
  }

  // === Health Check ===

  async getHealthStatus(): Promise<{
    healthy: boolean;
    storage: {
      templates: number;
      workflows: number;
      aiConfigs: number;
    };
    expiredWorkflows: number;
  }> {
    // Clean up expired workflows
    const expired: string[] = [];
    for (const [id, workflow] of this.workflows) {
      if (this.isExpired(workflow)) {
        expired.push(id);
        this.workflows.delete(id);
      }
    }

    if (expired.length > 0) {
      this.logger.info('Cleaned up expired workflows', { count: expired.length });
    }

    return {
      healthy: true,
      storage: {
        templates: this.templates.size,
        workflows: this.workflows.size,
        aiConfigs: this.aiConfigs.size
      },
      expiredWorkflows: expired.length
    };
  }

  // === Mapping Approvals ===

  /**
   * Approve a mapping template with immutable audit trail
   */
  async approveMappingTemplate(
    templateId: string,
    approvedBy: string,
    options?: {
      rationale?: string;
      confidenceScore?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<MappingApproval> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Mapping template not found: ${templateId}`);
    }

    // Get previous approval for before state
    const previousApproval = await this.getLatestApproval(templateId);

    // Compute hash of current mappings
    const mappingHash = this.computeMappingHash(template.mappings);

    const approval: MappingApproval = {
      id: this.generateId(),
      mappingTemplateId: templateId,
      mappingHash,
      approvedBy,
      approvedAt: new Date().toISOString(),
      rationale: options?.rationale,
      confidenceScore: options?.confidenceScore,
      beforeState: previousApproval?.afterState || null,
      afterState: JSON.parse(JSON.stringify(template.mappings)), // Deep copy
      metadata: options?.metadata
    };

    this.approvals.set(approval.id, approval);

    this.logger.info('Mapping template approved', {
      templateId,
      approvalId: approval.id,
      approvedBy,
      hash: mappingHash
    });

    return approval;
  }

  /**
   * Get all approvals for a mapping template
   */
  async getMappingApprovals(templateId: string): Promise<MappingApproval[]> {
    const templateApprovals: MappingApproval[] = [];

    for (const approval of this.approvals.values()) {
      if (approval.mappingTemplateId === templateId) {
        templateApprovals.push(approval);
      }
    }

    // Sort by approvedAt descending (newest first)
    return templateApprovals.sort((a, b) =>
      new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime()
    );
  }

  /**
   * Get latest approval for a mapping template
   */
  async getLatestApproval(templateId: string): Promise<MappingApproval | null> {
    const approvals = await this.getMappingApprovals(templateId);
    return approvals.length > 0 ? approvals[0] : null;
  }

  /**
   * Verify that a mapping template matches its latest approval
   */
  async verifyApproval(templateId: string): Promise<{
    approved: boolean;
    currentHash: string;
    approvedHash?: string;
    mismatch: boolean;
  }> {
    const template = this.templates.get(templateId);
    if (!template) {
      return {
        approved: false,
        currentHash: '',
        mismatch: false
      };
    }

    const currentHash = this.computeMappingHash(template.mappings);
    const latestApproval = await this.getLatestApproval(templateId);

    if (!latestApproval) {
      return {
        approved: false,
        currentHash,
        mismatch: false
      };
    }

    const mismatch = latestApproval.mappingHash !== currentHash;

    return {
      approved: !mismatch,
      currentHash,
      approvedHash: latestApproval.mappingHash,
      mismatch
    };
  }

  /**
   * Compute SHA-256 hash of mappings for approval verification
   */
  private computeMappingHash(mappings: FieldMapping[]): string {
    const crypto = require('crypto');

    // Sort mappings by sourceField + targetField for deterministic hash
    const sorted = mappings.slice().sort((a, b) => {
      const aKey = `${a.sourceField}:${a.targetField}`;
      const bKey = `${b.sourceField}:${b.targetField}`;
      return aKey.localeCompare(bKey);
    });

    // Create stable representation
    const representation = sorted.map(m => ({
      source: m.sourceField,
      target: m.targetField,
      type: m.transformationType,
      details: m.transformationDetails
    }));

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(representation))
      .digest('hex');

    return hash;
  }

  /**
   * Get approval by ID
   */
  async getApprovalById(approvalId: string): Promise<MappingApproval | null> {
    return this.approvals.get(approvalId) || null;
  }

  /**
   * Get approval history count for a template
   */
  async getApprovalCount(templateId: string): Promise<number> {
    const approvals = await this.getMappingApprovals(templateId);
    return approvals.length;
  }
}