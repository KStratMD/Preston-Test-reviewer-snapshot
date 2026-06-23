/**
 * Comprehensive unit tests for MappingPersistenceService
 * Covers: saveMappingTemplate, getMappingTemplate, updateMappingTemplate,
 *         deleteMappingTemplate, listMappingTemplates, saveWorkflowState,
 *         getWorkflowState, updateWorkflowState, getWorkflowsBySession,
 *         saveAIConfiguration, getAIConfiguration, getAIConfigurationByUser,
 *         getHealthStatus, approveMappingTemplate, getMappingApprovals,
 *         getLatestApproval, verifyApproval, getApprovalById, getApprovalCount
 */
import 'reflect-metadata';
import { MappingPersistenceService } from '../../../../src/services/persistence/MappingPersistenceService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('MappingPersistenceService', () => {
  let service: MappingPersistenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MappingPersistenceService(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Mapping persistence service initialized', expect.any(Object));
    });
  });

  // === Mapping Templates ===
  describe('saveMappingTemplate', () => {
    it('should save a template with generated id and metadata', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Test Template',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        mappings: [{ sourceField: 'Name', targetField: 'companyname', transformationType: 'direct' }],
      });
      expect(template.id).toBeDefined();
      expect(template.name).toBe('Test Template');
      expect(template.metadata.version).toBe(1);
      expect(template.metadata.isActive).toBe(true);
      expect(template.metadata.createdAt).toBeDefined();
    });

    it('should preserve partial metadata if provided', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Tagged',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [],
        metadata: { tags: ['crm', 'sync'] } as any,
      });
      expect(template.metadata.tags).toEqual(['crm', 'sync']);
    });
  });

  describe('getMappingTemplate', () => {
    it('should retrieve a saved template', async () => {
      const saved = await service.saveMappingTemplate({
        name: 'Get Test',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [],
      });
      const retrieved = await service.getMappingTemplate(saved.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Get Test');
    });

    it('should return null for nonexistent id', async () => {
      const result = await service.getMappingTemplate('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateMappingTemplate', () => {
    it('should update template and increment version', async () => {
      const saved = await service.saveMappingTemplate({
        name: 'Original',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [],
      });
      const updated = await service.updateMappingTemplate(saved.id, { name: 'Updated' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated');
      expect(updated!.metadata.version).toBe(2);
      expect(updated!.id).toBe(saved.id);
    });

    it('should return null for nonexistent id', async () => {
      const result = await service.updateMappingTemplate('nonexistent', { name: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('deleteMappingTemplate', () => {
    it('should delete a template', async () => {
      const saved = await service.saveMappingTemplate({
        name: 'Delete Me',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [],
      });
      const result = await service.deleteMappingTemplate(saved.id);
      expect(result).toBe(true);
      const retrieved = await service.getMappingTemplate(saved.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for nonexistent id', async () => {
      const result = await service.deleteMappingTemplate('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listMappingTemplates', () => {
    beforeEach(async () => {
      await service.saveMappingTemplate({ name: 'T1', sourceSystem: 'Salesforce', targetSystem: 'NetSuite', industry: 'Finance', mappings: [], metadata: { tags: ['crm'] } as any });
      await service.saveMappingTemplate({ name: 'T2', sourceSystem: 'SAP', targetSystem: 'NetSuite', industry: 'Manufacturing', mappings: [], metadata: { tags: ['erp'] } as any });
      await service.saveMappingTemplate({ name: 'T3', sourceSystem: 'Salesforce', targetSystem: 'BusinessCentral', industry: 'Finance', mappings: [] });
    });

    it('should list all templates when no filters', async () => {
      const templates = await service.listMappingTemplates();
      expect(templates.length).toBe(3);
    });

    it('should filter by sourceSystem', async () => {
      const templates = await service.listMappingTemplates({ sourceSystem: 'Salesforce' });
      expect(templates.length).toBe(2);
    });

    it('should filter by targetSystem', async () => {
      const templates = await service.listMappingTemplates({ targetSystem: 'NetSuite' });
      expect(templates.length).toBe(2);
    });

    it('should filter by industry', async () => {
      const templates = await service.listMappingTemplates({ industry: 'Finance' });
      expect(templates.length).toBe(2);
    });

    it('should filter by isActive', async () => {
      const templates = await service.listMappingTemplates({ isActive: true });
      expect(templates.length).toBe(3);
    });

    it('should filter by tags', async () => {
      const templates = await service.listMappingTemplates({ tags: ['crm'] });
      expect(templates.length).toBe(1);
      expect(templates[0].name).toBe('T1');
    });

    it('should sort by updatedAt descending', async () => {
      const templates = await service.listMappingTemplates();
      for (let i = 1; i < templates.length; i++) {
        expect(new Date(templates[i - 1].metadata.updatedAt).getTime())
          .toBeGreaterThanOrEqual(new Date(templates[i].metadata.updatedAt).getTime());
      }
    });
  });

  // === AI Workflow State ===
  describe('saveWorkflowState', () => {
    it('should save workflow state', async () => {
      const state = await service.saveWorkflowState({
        sessionId: 'session-1',
        workflowType: 'field_mapping',
        currentStep: 1,
        totalSteps: 5,
        data: { fields: [] },
      });
      expect(state.id).toBeDefined();
      expect(state.metadata.isComplete).toBe(false);
      expect(state.metadata.expiresAt).toBeDefined();
    });
  });

  describe('getWorkflowState', () => {
    it('should retrieve saved workflow', async () => {
      const saved = await service.saveWorkflowState({
        sessionId: 's1',
        workflowType: 'integration_wizard',
        currentStep: 1,
        totalSteps: 3,
        data: {},
      });
      const retrieved = await service.getWorkflowState(saved.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe('s1');
    });

    it('should return null for nonexistent id', async () => {
      const result = await service.getWorkflowState('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for expired workflow', async () => {
      const saved = await service.saveWorkflowState({
        sessionId: 's-expired',
        workflowType: 'field_mapping',
        currentStep: 1,
        totalSteps: 1,
        data: {},
      });
      // Manually expire it
      const state = await service.getWorkflowState(saved.id);
      if (state) {
        state.metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
      }
      const result = await service.getWorkflowState(saved.id);
      expect(result).toBeNull();
    });
  });

  describe('updateWorkflowState', () => {
    it('should update workflow state', async () => {
      const saved = await service.saveWorkflowState({
        sessionId: 's1',
        workflowType: 'data_quality',
        currentStep: 1,
        totalSteps: 4,
        data: {},
      });
      const updated = await service.updateWorkflowState(saved.id, { currentStep: 2 });
      expect(updated).toBeDefined();
      expect(updated!.currentStep).toBe(2);
    });

    it('should return null for nonexistent id', async () => {
      const result = await service.updateWorkflowState('nonexistent', { currentStep: 2 });
      expect(result).toBeNull();
    });
  });

  describe('getWorkflowsBySession', () => {
    it('should return workflows for a session', async () => {
      await service.saveWorkflowState({ sessionId: 'sess-A', workflowType: 'field_mapping', currentStep: 1, totalSteps: 3, data: {} });
      await service.saveWorkflowState({ sessionId: 'sess-A', workflowType: 'data_quality', currentStep: 1, totalSteps: 2, data: {} });
      await service.saveWorkflowState({ sessionId: 'sess-B', workflowType: 'field_mapping', currentStep: 1, totalSteps: 1, data: {} });

      const workflows = await service.getWorkflowsBySession('sess-A');
      expect(workflows.length).toBe(2);
    });
  });

  // === AI Configuration ===
  describe('saveAIConfiguration', () => {
    it('should save AI config', async () => {
      const config = await service.saveAIConfiguration({
        userId: 'user-1',
        providerId: 'openai',
        settings: { model: 'gpt-4o', temperature: 0.3 },
      });
      expect(config.id).toBeDefined();
      expect(config.metadata.isActive).toBe(true);
    });
  });

  describe('getAIConfiguration', () => {
    it('should retrieve saved config', async () => {
      const saved = await service.saveAIConfiguration({
        userId: 'user-1',
        providerId: 'openai',
        settings: { model: 'gpt-4o' },
      });
      const retrieved = await service.getAIConfiguration(saved.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.providerId).toBe('openai');
    });

    it('should return null for nonexistent id', async () => {
      const result = await service.getAIConfiguration('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAIConfigurationByUser', () => {
    it('should return configs for a user', async () => {
      await service.saveAIConfiguration({ userId: 'u1', providerId: 'openai', settings: {} });
      await service.saveAIConfiguration({ userId: 'u1', providerId: 'claude', settings: {} });
      await service.saveAIConfiguration({ userId: 'u2', providerId: 'openai', settings: {} });

      const configs = await service.getAIConfigurationByUser('u1');
      expect(configs.length).toBe(2);
    });

    it('should filter by providerId', async () => {
      await service.saveAIConfiguration({ userId: 'u1', providerId: 'openai', settings: {} });
      await service.saveAIConfiguration({ userId: 'u1', providerId: 'claude', settings: {} });

      const configs = await service.getAIConfigurationByUser('u1', 'openai');
      expect(configs.length).toBe(1);
      expect(configs[0].providerId).toBe('openai');
    });
  });

  // === Health Status ===
  describe('getHealthStatus', () => {
    it('should return healthy status', async () => {
      const status = await service.getHealthStatus();
      expect(status.healthy).toBe(true);
      expect(status.storage.templates).toBe(0);
      expect(status.storage.workflows).toBe(0);
      expect(status.storage.aiConfigs).toBe(0);
    });

    it('should clean up expired workflows', async () => {
      const saved = await service.saveWorkflowState({
        sessionId: 's-expired',
        workflowType: 'field_mapping',
        currentStep: 1,
        totalSteps: 1,
        data: {},
      });
      // Manually expire
      const state = await service.getWorkflowState(saved.id);
      // Re-save with expired time (need to access internal)
      const saved2 = await service.saveWorkflowState({
        sessionId: 's-expired-2',
        workflowType: 'field_mapping',
        currentStep: 1,
        totalSteps: 1,
        data: {},
      });
      // Get the workflow and manually set its expiry
      const wf = await service.getWorkflowState(saved2.id);
      if (wf) {
        wf.metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
      }

      const status = await service.getHealthStatus();
      expect(status.expiredWorkflows).toBe(1);
    });
  });

  // === Mapping Approvals ===
  describe('approveMappingTemplate', () => {
    it('should approve a template', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Approve Me',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'a', targetField: 'b', transformationType: 'direct' }],
      });

      const approval = await service.approveMappingTemplate(template.id, 'admin@test.com', {
        rationale: 'Looks good',
        confidenceScore: 0.95,
      });

      expect(approval.id).toBeDefined();
      expect(approval.mappingTemplateId).toBe(template.id);
      expect(approval.approvedBy).toBe('admin@test.com');
      expect(approval.rationale).toBe('Looks good');
      expect(approval.confidenceScore).toBe(0.95);
      expect(approval.mappingHash).toBeDefined();
      expect(approval.beforeState).toBeNull(); // First approval
      expect(approval.afterState.length).toBe(1);
    });

    it('should throw for nonexistent template', async () => {
      await expect(service.approveMappingTemplate('nonexistent', 'admin'))
        .rejects.toThrow('Mapping template not found');
    });

    it('should track before/after state on second approval', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Multi Approve',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'a', targetField: 'b', transformationType: 'direct' }],
      });

      const first = await service.approveMappingTemplate(template.id, 'admin');
      expect(first.beforeState).toBeNull();

      // Update and re-approve
      await service.updateMappingTemplate(template.id, {
        mappings: [
          { sourceField: 'a', targetField: 'b', transformationType: 'direct' },
          { sourceField: 'c', targetField: 'd', transformationType: 'lookup' },
        ],
      });

      const second = await service.approveMappingTemplate(template.id, 'admin');
      expect(second.beforeState).toBeDefined();
      expect(second.afterState.length).toBe(2);
    });
  });

  describe('getMappingApprovals', () => {
    it('should return approvals for a template', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Approvals',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      await service.approveMappingTemplate(template.id, 'admin1');
      await service.approveMappingTemplate(template.id, 'admin2');

      const approvals = await service.getMappingApprovals(template.id);
      expect(approvals.length).toBe(2);
    });

    it('should return empty for template with no approvals', async () => {
      const approvals = await service.getMappingApprovals('no-approvals');
      expect(approvals.length).toBe(0);
    });
  });

  describe('getLatestApproval', () => {
    it('should return latest approval', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Latest',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      await service.approveMappingTemplate(template.id, 'first');
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 5));
      await service.approveMappingTemplate(template.id, 'second');

      const latest = await service.getLatestApproval(template.id);
      expect(latest).toBeDefined();
      expect(latest!.approvedBy).toBe('second');
    });

    it('should return null when no approvals', async () => {
      const result = await service.getLatestApproval('no-approvals');
      expect(result).toBeNull();
    });
  });

  describe('verifyApproval', () => {
    it('should verify matching approval', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Verify',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      await service.approveMappingTemplate(template.id, 'admin');

      const verification = await service.verifyApproval(template.id);
      expect(verification.approved).toBe(true);
      expect(verification.mismatch).toBe(false);
    });

    it('should detect mismatch after modification', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Mismatch',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      await service.approveMappingTemplate(template.id, 'admin');
      await service.updateMappingTemplate(template.id, {
        mappings: [{ sourceField: 'changed', targetField: 'field', transformationType: 'lookup' }],
      });

      const verification = await service.verifyApproval(template.id);
      expect(verification.approved).toBe(false);
      expect(verification.mismatch).toBe(true);
    });

    it('should return not approved for nonexistent template', async () => {
      const verification = await service.verifyApproval('nonexistent');
      expect(verification.approved).toBe(false);
      expect(verification.currentHash).toBe('');
    });

    it('should return not approved when no approval exists', async () => {
      const template = await service.saveMappingTemplate({
        name: 'No Approval',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      const verification = await service.verifyApproval(template.id);
      expect(verification.approved).toBe(false);
      expect(verification.mismatch).toBe(false);
    });
  });

  describe('getApprovalById', () => {
    it('should retrieve approval by id', async () => {
      const template = await service.saveMappingTemplate({
        name: 'By ID',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      const approval = await service.approveMappingTemplate(template.id, 'admin');
      const retrieved = await service.getApprovalById(approval.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.approvedBy).toBe('admin');
    });

    it('should return null for nonexistent approval', async () => {
      const result = await service.getApprovalById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getApprovalCount', () => {
    it('should return count of approvals', async () => {
      const template = await service.saveMappingTemplate({
        name: 'Count',
        sourceSystem: 'A',
        targetSystem: 'B',
        mappings: [{ sourceField: 'x', targetField: 'y', transformationType: 'direct' }],
      });
      await service.approveMappingTemplate(template.id, 'admin1');
      await service.approveMappingTemplate(template.id, 'admin2');

      const count = await service.getApprovalCount(template.id);
      expect(count).toBe(2);
    });

    it('should return 0 for template with no approvals', async () => {
      const count = await service.getApprovalCount('no-approvals');
      expect(count).toBe(0);
    });
  });
});
