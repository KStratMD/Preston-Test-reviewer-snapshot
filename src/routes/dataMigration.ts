import express from 'express';
import type { NextFunction } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { validateRequest } from '../middleware/validation';
import { z } from 'zod';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { DataMigrationAccelerator, MigrationPlan } from '../services/DataMigrationAccelerator';

const router = express.Router();

// Validation schemas
const createPlanValidation = z.object({
  name: z.string().min(1, 'Migration plan name is required'),
  description: z.string().optional(),
  sourceSystem: z.string().min(1, 'Source system is required'),
  targetSystem: z.string().min(1, 'Target system is required'),
  phases: z.array(z.object({
    name: z.string().min(1, 'Phase name is required'),
    entityType: z.string().min(1, 'Phase entity type is required'),
    order: z.number().int().min(0, 'Phase order must be a positive integer'),
    batchSize: z.number().int().min(1, 'Batch size must be a positive integer'),
    estimatedRecords: z.number().int().min(0, 'Estimated records must be non-negative'),
  })).min(1, 'At least one phase is required'),
  mappings: z.array(z.any()),
  validationRules: z.array(z.any()),
});

const updatePlanValidation = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'ready', 'running', 'paused', 'completed', 'failed']).optional(),
});

const planIdValidation = z.object({
  planId: z.string().uuid('Invalid plan ID'),
});

/**
 * @api {post} /api/data-migration/plans Create Migration Plan
 * @apiName CreateMigrationPlan
 * @apiGroup DataMigration
 * @apiDescription Create a new data migration plan with phases, mappings, and validation rules
 * 
 * @apiBody {String} name Migration plan name
 * @apiBody {String} [description] Plan description
 * @apiBody {String} sourceSystem Source system identifier
 * @apiBody {String} targetSystem Target system identifier
 * @apiBody {Object[]} phases Migration phases
 * @apiBody {String} phases.name Phase name
 * @apiBody {String} phases.entityType Entity type for this phase
 * @apiBody {Number} phases.order Execution order
 * @apiBody {Number} phases.batchSize Batch processing size
 * @apiBody {Number} phases.estimatedRecords Estimated record count
 * @apiBody {Object[]} mappings Field mappings
 * @apiBody {Object[]} validationRules Validation rules
 * 
 * @apiSuccess {Object} plan Created migration plan
 * @apiSuccess {String} plan.id Plan unique identifier
 * @apiSuccess {String} plan.name Plan name
 * @apiSuccess {String} plan.status Plan status
 * @apiSuccess {Date} plan.createdAt Creation timestamp
 */
router.post('/plans', validateRequest(createPlanValidation), asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const plan = await dataMigrationService.createMigrationPlan(req.body);
  
  res.status(201).json({
    success: true,
    data: plan,
    message: 'Migration plan created successfully'
  });
  return;
}));

/**
 * @api {get} /api/data-migration/plans List Migration Plans
 * @apiName ListMigrationPlans
 * @apiGroup DataMigration
 * @apiDescription Get all migration plans
 * 
 * @apiSuccess {Object[]} plans Array of migration plans
 * @apiSuccess {String} plans.id Plan ID
 * @apiSuccess {String} plans.name Plan name
 * @apiSuccess {String} plans.status Plan status
 * @apiSuccess {String} plans.sourceSystem Source system
 * @apiSuccess {String} plans.targetSystem Target system
 * @apiSuccess {Number} plans.processedRecords Processed records count
 * @apiSuccess {Number} plans.successfulRecords Successful records count
 * @apiSuccess {Number} plans.failedRecords Failed records count
 */
router.get('/plans', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const plans = await dataMigrationService.listMigrationPlans();
  
  res.json({
    success: true,
    data: plans,
    count: plans.length
  });
  return;
}));

/**
 * @api {get} /api/data-migration/plans/:planId Get Migration Plan
 * @apiName GetMigrationPlan
 * @apiGroup DataMigration
 * @apiDescription Get detailed migration plan information
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {Object} plan Migration plan details
 * @apiSuccess {String} plan.id Plan ID
 * @apiSuccess {String} plan.name Plan name
 * @apiSuccess {Object[]} plan.phases Migration phases
 * @apiSuccess {Object[]} plan.mappings Field mappings
 * @apiSuccess {Object[]} plan.validationRules Validation rules
 */
router.get('/plans/:planId', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const plan = await dataMigrationService.getMigrationPlan(req.params.planId!);
  
  if (!plan) {
    res.status(404).json({
      success: false,
      message: 'Migration plan not found'
    });
    return;
  }
  
  res.json({
    success: true,
    data: plan
  });
  return;
}));

/**
 * @api {put} /api/data-migration/plans/:planId Update Migration Plan
 * @apiName UpdateMigrationPlan
 * @apiGroup DataMigration
 * @apiDescription Update migration plan details
 * 
 * @apiParam {String} planId Migration plan ID
 * @apiBody {String} [name] Plan name
 * @apiBody {String} [description] Plan description
 * @apiBody {String} [status] Plan status
 * 
 * @apiSuccess {Object} plan Updated migration plan
 */
router.put('/plans/:planId', validateRequest(updatePlanValidation), asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const plan = await dataMigrationService.updateMigrationPlan(req.params.planId!, req.body);
  
  res.json({
    success: true,
    data: plan,
    message: 'Migration plan updated successfully'
  });
  return;
}));

/**
 * @api {post} /api/data-migration/plans/:planId/start Start Migration
 * @apiName StartMigration
 * @apiGroup DataMigration
 * @apiDescription Start executing a migration plan
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {Object} progress Migration progress information
 * @apiSuccess {String} progress.planId Plan ID
 * @apiSuccess {String} progress.status Migration status
 * @apiSuccess {Number} progress.overallProgress Overall progress percentage
 * @apiSuccess {Date} progress.startTime Migration start time
 */
router.post('/plans/:planId/start', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const progress = await dataMigrationService.startMigration(req.params.planId!);
  
  res.json({
    success: true,
    data: progress,
    message: 'Migration started successfully'
  });
  return;
}));

/**
 * @api {get} /api/data-migration/plans/:planId/progress Get Migration Progress
 * @apiName GetMigrationProgress
 * @apiGroup DataMigration
 * @apiDescription Get real-time migration progress
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {Object} progress Migration progress details
 * @apiSuccess {String} progress.status Current status
 * @apiSuccess {Number} progress.overallProgress Overall progress (0-100)
 * @apiSuccess {Number} progress.phaseProgress Current phase progress (0-100)
 * @apiSuccess {String} progress.currentPhase Current phase name
 * @apiSuccess {Number} progress.recordsPerSecond Processing rate
 * @apiSuccess {Object[]} progress.errors Migration errors
 * @apiSuccess {Object[]} progress.warnings Migration warnings
 * @apiSuccess {Object} progress.metadata Additional metadata
 */
router.get('/plans/:planId/progress', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const progress = await dataMigrationService.getMigrationProgress(req.params.planId!);
  
  if (!progress) {
    res.status(404).json({
      success: false,
      message: 'Migration progress not found - migration may not be active'
    });
    return;
  }
  
  res.json({
    success: true,
    data: progress
  });
  return;
}));

/**
 * @api {post} /api/data-migration/plans/:planId/pause Pause Migration
 * @apiName PauseMigration
 * @apiGroup DataMigration
 * @apiDescription Pause a running migration
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {String} message Success message
 */
router.post('/plans/:planId/pause', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  await dataMigrationService.pauseMigration(req.params.planId!);
  
  res.json({
    success: true,
    message: 'Migration paused successfully'
  });
  return;
}));

/**
 * @api {post} /api/data-migration/plans/:planId/resume Resume Migration
 * @apiName ResumeMigration
 * @apiGroup DataMigration
 * @apiDescription Resume a paused migration
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {String} message Success message
 */
router.post('/plans/:planId/resume', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  await dataMigrationService.resumeMigration(req.params.planId!);
  
  res.json({
    success: true,
    message: 'Migration resumed successfully'
  });
  return;
}));

/**
 * @api {post} /api/data-migration/plans/:planId/stop Stop Migration
 * @apiName StopMigration
 * @apiGroup DataMigration
 * @apiDescription Stop a running migration
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {String} message Success message
 */
router.post('/plans/:planId/stop', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  await dataMigrationService.stopMigration(req.params.planId!);
  
  res.json({
    success: true,
    message: 'Migration stopped successfully'
  });
  return;
}));

/**
 * @api {get} /api/data-migration/plans/:planId/quality-report Get Data Quality Report
 * @apiName GetDataQualityReport
 * @apiGroup DataMigration
 * @apiDescription Generate data quality report for a migration plan
 * 
 * @apiParam {String} planId Migration plan ID
 * 
 * @apiSuccess {Object} report Data quality report
 * @apiSuccess {Number} report.overallScore Overall quality score (0-100)
 * @apiSuccess {Object} report.metrics Quality metrics breakdown
 * @apiSuccess {Number} report.metrics.completeness Completeness score
 * @apiSuccess {Number} report.metrics.accuracy Accuracy score
 * @apiSuccess {Number} report.metrics.consistency Consistency score
 * @apiSuccess {Number} report.metrics.validity Validity score
 * @apiSuccess {Number} report.metrics.uniqueness Uniqueness score
 * @apiSuccess {Object[]} report.issues Data quality issues
 * @apiSuccess {String[]} report.recommendations Improvement recommendations
 */
router.get('/plans/:planId/quality-report', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  const dataMigrationService = container.get<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator);
  
  const report = await dataMigrationService.generateDataQualityReport(req.params.planId!);
  
  res.json({
    success: true,
    data: report
  });
  return;
}));

/**
 * @api {get} /api/data-migration/templates Get Migration Templates
 * @apiName GetMigrationTemplates
 * @apiGroup DataMigration
 * @apiDescription Get pre-configured migration plan templates
 * 
 * @apiSuccess {Object[]} templates Available migration templates
 * @apiSuccess {String} templates.id Template ID
 * @apiSuccess {String} templates.name Template name
 * @apiSuccess {String} templates.description Template description
 * @apiSuccess {String} templates.sourceSystem Source system
 * @apiSuccess {String} templates.targetSystem Target system
 * @apiSuccess {Object[]} templates.phases Pre-configured phases
 */
router.get('/templates', asyncHandler(async (req, res, next: NextFunction): Promise<void> => {
  // Return predefined templates for common migration scenarios
  const templates = [
    {
      id: 'legacy-to-netsuite',
      name: 'Legacy System to NetSuite',
      description: 'Migrate data from legacy system to NetSuite ERP',
      sourceSystem: 'Legacy',
      targetSystem: 'NetSuite',
      phases: [
        {
          id: 'customers',
          name: 'Customer Migration',
          description: 'Migrate customer records',
          order: 1,
          entityType: 'customer',
          batchSize: 100,
          estimatedRecords: 5000,
          parallelizable: true,
          configuration: {
            loadOptions: {
              mode: 'upsert',
              conflictResolution: 'merge',
              enableReferentialIntegrity: true
            }
          }
        },
        {
          id: 'items',
          name: 'Item Migration',
          description: 'Migrate inventory items',
          order: 2,
          entityType: 'item',
          batchSize: 200,
          estimatedRecords: 10000,
          parallelizable: true,
          configuration: {
            loadOptions: {
              mode: 'upsert',
              conflictResolution: 'overwrite',
              enableReferentialIntegrity: true
            }
          }
        },
        {
          id: 'transactions',
          name: 'Transaction Migration',
          description: 'Migrate historical transactions',
          order: 3,
          entityType: 'transaction',
          dependsOn: ['customers', 'items'],
          batchSize: 50,
          estimatedRecords: 25000,
          parallelizable: false,
          configuration: {
            loadOptions: {
              mode: 'insert',
              conflictResolution: 'skip',
              enableReferentialIntegrity: true
            }
          }
        }
      ],
      mappings: [
        {
          sourceField: 'customer_id',
          targetField: 'externalid',
          transformationType: 'direct',
          isRequired: true
        },
        {
          sourceField: 'company_name',
          targetField: 'companyname',
          transformationType: 'direct',
          isRequired: true
        },
        {
          sourceField: 'first_name',
          targetField: 'firstname',
          transformationType: 'direct',
          isRequired: false
        }
      ],
      validationRules: [
        {
          id: 'customer-required-fields',
          name: 'Customer Required Fields',
          field: 'companyname',
          type: 'required',
          rule: 'not_empty',
          errorMessage: 'Company name is required'
        }
      ]
    },
    {
      id: 'salesforce-to-netsuite',
      name: 'Salesforce to NetSuite',
      description: 'Migrate CRM data from Salesforce to NetSuite',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      phases: [
        {
          id: 'accounts',
          name: 'Account Migration',
          description: 'Migrate Salesforce accounts to NetSuite customers',
          order: 1,
          entityType: 'customer',
          batchSize: 150,
          estimatedRecords: 3000,
          parallelizable: true,
          configuration: {
            extractionQuery: 'SELECT Id, Name, BillingStreet, BillingCity FROM Account',
            loadOptions: {
              mode: 'upsert',
              conflictResolution: 'merge',
              enableReferentialIntegrity: true
            }
          }
        },
        {
          id: 'opportunities',
          name: 'Opportunity Migration',
          description: 'Migrate opportunities to sales orders',
          order: 2,
          entityType: 'salesorder',
          dependsOn: ['accounts'],
          batchSize: 75,
          estimatedRecords: 8000,
          parallelizable: false,
          configuration: {
            extractionQuery: 'SELECT Id, Name, AccountId, Amount, CloseDate FROM Opportunity WHERE StageName = \'Closed Won\'',
            loadOptions: {
              mode: 'insert',
              conflictResolution: 'skip',
              enableReferentialIntegrity: true
            }
          }
        }
      ],
      mappings: [
        {
          sourceField: 'Id',
          targetField: 'externalid',
          transformationType: 'direct',
          isRequired: true
        },
        {
          sourceField: 'Name',
          targetField: 'companyname',
          transformationType: 'direct',
          isRequired: true
        }
      ],
      validationRules: [
        {
          id: 'account-name-validation',
          name: 'Account Name Validation',
          field: 'companyname',
          type: 'required',
          rule: 'not_empty',
          errorMessage: 'Account name cannot be empty'
        }
      ]
    }
  ];
  
  res.json({
    success: true,
    data: templates,
    count: templates.length
  });
  return;
}));

export default router;