/**
 * Mapping Persistence API Routes - Backend storage endpoints
 * Phase 1 Implementation: Replaces localStorage with proper backend persistence
 */

import { Router, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { TYPES } from '../inversify/types';
import { logger, type Logger } from '../utils/Logger';
import { MappingPersistenceService, type MappingTemplate, type AIWorkflowState, type AIConfiguration } from '../services/persistence/MappingPersistenceService';

export interface AuthenticatedRequest extends Request {
  // user property inherited from global Request augmentation (src/types/express.d.ts)
  sessionId?: string;
}

@injectable()
export class MappingPersistenceController {
  private router: Router;
  private persistenceService: MappingPersistenceService;

  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.router = Router();
    this.persistenceService = new MappingPersistenceService(logger);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Mapping Templates
    this.router.post('/templates', this.createMappingTemplate.bind(this));
    this.router.get('/templates', this.listMappingTemplates.bind(this));
    this.router.get('/templates/:id', this.getMappingTemplate.bind(this));
    this.router.put('/templates/:id', this.updateMappingTemplate.bind(this));
    this.router.delete('/templates/:id', this.deleteMappingTemplate.bind(this));

    // Workflow State
    this.router.post('/workflows', this.createWorkflowState.bind(this));
    this.router.get('/workflows/:id', this.getWorkflowState.bind(this));
    this.router.put('/workflows/:id', this.updateWorkflowState.bind(this));
    this.router.get('/sessions/:sessionId/workflows', this.getSessionWorkflows.bind(this));

    // AI Configuration - TODO: Implement these methods
    // this.router.post('/ai-config', this.createAIConfiguration.bind(this));
    // this.router.get('/ai-config/:id', this.getAIConfiguration.bind(this));
    // this.router.get('/users/:userId/ai-config', this.getUserAIConfigurations.bind(this));

    // Health and Status
    this.router.get('/health', this.getHealthStatus.bind(this));

    // Migration endpoint for localStorage data
    this.router.post('/migrate', this.migrateFromLocalStorage.bind(this));
  }

  /**
   * Create mapping template
   * POST /api/persistence/templates
   */
  private async createMappingTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        name,
        sourceSystem,
        targetSystem,
        industry,
        businessProcess,
        mappings,
        tags = []
      } = req.body;

      if (!name || !sourceSystem || !targetSystem || !mappings) {
        res.status(400).json({
          error: 'Missing required fields',
          required: ['name', 'sourceSystem', 'targetSystem', 'mappings']
        });
        return;
      }

      const template = await this.persistenceService.saveMappingTemplate({
        name,
        sourceSystem,
        targetSystem,
        industry,
        businessProcess,
        mappings,
        metadata: {
          createdBy: req.user?.id,
          tags: Array.isArray(tags) ? tags : []
        }
      } as any);

      res.status(201).json({
        success: true,
        template
      });

    } catch (error) {
      this.logger.error('Create mapping template failed', error);
      res.status(500).json({
        error: 'Failed to create mapping template',
        message: error.message
      });
    }
  }

  /**
   * List mapping templates
   * GET /api/persistence/templates
   */
  private async listMappingTemplates(req: Request, res: Response): Promise<void> {
    try {
      const {
        sourceSystem,
        targetSystem,
        industry,
        tags,
        isActive
      } = req.query;

      const filters: Record<string, unknown> = {};

      if (sourceSystem) filters.sourceSystem = sourceSystem as string;
      if (targetSystem) filters.targetSystem = targetSystem as string;
      if (industry) filters.industry = industry as string;
      if (isActive !== undefined) filters.isActive = isActive === 'true';
      if (tags) {
        filters.tags = Array.isArray(tags) ? tags as string[] : [tags as string];
      }

      const templates = await this.persistenceService.listMappingTemplates(filters);

      res.json({
        success: true,
        templates,
        count: templates.length
      });

    } catch (error) {
      this.logger.error('List mapping templates failed', error);
      res.status(500).json({
        error: 'Failed to list mapping templates',
        message: error.message
      });
    }
  }

  /**
   * Get mapping template
   * GET /api/persistence/templates/:id
   */
  private async getMappingTemplate(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const template = await this.persistenceService.getMappingTemplate(id);

      if (!template) {
        res.status(404).json({
          error: 'Template not found',
          id
        });
        return;
      }

      res.json({
        success: true,
        template
      });

    } catch (error) {
      this.logger.error('Get mapping template failed', error);
      res.status(500).json({
        error: 'Failed to get mapping template',
        message: error.message
      });
    }
  }

  /**
   * Update mapping template
   * PUT /api/persistence/templates/:id
   */
  private async updateMappingTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Don't allow updating metadata directly
      delete updates.metadata;

      const template = await this.persistenceService.updateMappingTemplate(id, updates);

      if (!template) {
        res.status(404).json({
          error: 'Template not found',
          id
        });
        return;
      }

      res.json({
        success: true,
        template
      });

    } catch (error) {
      this.logger.error('Update mapping template failed', error);
      res.status(500).json({
        error: 'Failed to update mapping template',
        message: error.message
      });
    }
  }

  /**
   * Delete mapping template
   * DELETE /api/persistence/templates/:id
   */
  private async deleteMappingTemplate(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const deleted = await this.persistenceService.deleteMappingTemplate(id);

      if (!deleted) {
        res.status(404).json({
          error: 'Template not found',
          id
        });
        return;
      }

      res.json({
        success: true,
        message: 'Template deleted'
      });

    } catch (error) {
      this.logger.error('Delete mapping template failed', error);
      res.status(500).json({
        error: 'Failed to delete mapping template',
        message: error.message
      });
    }
  }

  /**
   * Create workflow state
   * POST /api/persistence/workflows
   */
  private async createWorkflowState(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        workflowType,
        currentStep,
        totalSteps,
        data
      } = req.body;

      if (!workflowType || currentStep === undefined || !totalSteps || !data) {
        res.status(400).json({
          error: 'Missing required fields',
          required: ['workflowType', 'currentStep', 'totalSteps', 'data']
        });
        return;
      }

      const sessionId = req.sessionId || req.headers['x-session-id'] as string || 'default';

      const workflow = await this.persistenceService.saveWorkflowState({
        userId: req.user?.id,
        sessionId,
        workflowType,
        currentStep,
        totalSteps,
        data
      });

      res.status(201).json({
        success: true,
        workflow
      });

    } catch (error) {
      this.logger.error('Create workflow state failed', error);
      res.status(500).json({
        error: 'Failed to create workflow state',
        message: error.message
      });
    }
  }

  /**
   * Get workflow state
   * GET /api/persistence/workflows/:id
   */
  private async getWorkflowState(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const workflow = await this.persistenceService.getWorkflowState(id);

      if (!workflow) {
        res.status(404).json({
          error: 'Workflow not found or expired',
          id
        });
        return;
      }

      res.json({
        success: true,
        workflow
      });

    } catch (error) {
      this.logger.error('Get workflow state failed', error);
      res.status(500).json({
        error: 'Failed to get workflow state',
        message: error.message
      });
    }
  }

  /**
   * Update workflow state
   * PUT /api/persistence/workflows/:id
   */
  private async updateWorkflowState(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body;

      const workflow = await this.persistenceService.updateWorkflowState(id, updates);

      if (!workflow) {
        res.status(404).json({
          error: 'Workflow not found or expired',
          id
        });
        return;
      }

      res.json({
        success: true,
        workflow
      });

    } catch (error) {
      this.logger.error('Update workflow state failed', error);
      res.status(500).json({
        error: 'Failed to update workflow state',
        message: error.message
      });
    }
  }

  /**
   * Get session workflows
   * GET /api/persistence/sessions/:sessionId/workflows
   */
  private async getSessionWorkflows(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      const workflows = await this.persistenceService.getWorkflowsBySession(sessionId);

      res.json({
        success: true,
        workflows,
        count: workflows.length
      });

    } catch (error) {
      this.logger.error('Get session workflows failed', error);
      res.status(500).json({
        error: 'Failed to get session workflows',
        message: error.message
      });
    }
  }

  /**
   * Health status
   * GET /api/persistence/health
   */
  private async getHealthStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = await this.persistenceService.getHealthStatus();

      res.json({
        success: true,
        ...status,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.logger.error('Get health status failed', error);
      res.status(500).json({
        error: 'Health check failed',
        message: error.message
      });
    }
  }

  /**
   * Migrate from localStorage
   * POST /api/persistence/migrate
   */
  private async migrateFromLocalStorage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data } = req.body;

      if (!data) {
        res.status(400).json({
          error: 'Migration data is required'
        });
        return;
      }

      const results = {
        templates: 0,
        workflows: 0,
        aiConfigs: 0,
        errors: [] as string[]
      };

      // Migrate templates
      if (data.templates && Array.isArray(data.templates)) {
        for (const template of data.templates) {
          try {
            await this.persistenceService.saveMappingTemplate({
              ...template,
              metadata: {
                ...template.metadata,
                createdBy: req.user?.id || 'migration'
              }
            });
            results.templates++;
          } catch (error) {
            results.errors.push(`Template migration failed: ${error.message}`);
          }
        }
      }

      // Migrate workflow states
      if (data.workflows && Array.isArray(data.workflows)) {
        for (const workflow of data.workflows) {
          try {
            await this.persistenceService.saveWorkflowState({
              ...workflow,
              userId: req.user?.id || 'migration'
            });
            results.workflows++;
          } catch (error) {
            results.errors.push(`Workflow migration failed: ${error.message}`);
          }
        }
      }

      res.json({
        success: true,
        message: 'Migration completed',
        results
      });

    } catch (error) {
      this.logger.error('Migration from localStorage failed', error);
      res.status(500).json({
        error: 'Migration failed',
        message: error.message
      });
    }
  }

  getRouter(): Router {
    return this.router;
  }
}

// Export route factory function
export function createMappingPersistenceRoutes(logger: Logger): Router {
  const controller = new MappingPersistenceController(logger);
  return controller.getRouter();
}