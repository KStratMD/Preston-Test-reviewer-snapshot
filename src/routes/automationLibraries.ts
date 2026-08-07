import * as express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { AutomationLibrariesService } from '../services/AutomationLibrariesService';

const router = express.Router();

// Library Management Routes
router.get('/libraries', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const { category } = req.query;
  const libraries = await automationService.getLibraries(category as any);
  
  res.json(libraries);
}));

router.get('/libraries/:libraryId', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  const libraryId = req.params.libraryId;
  
  if (!libraryId) {
    return res.status(400).json({ error: 'Library ID required' });
  }
  
  const library = await automationService.getLibrary(libraryId);
  
  if (!library) {
    return res.status(404).json({ error: 'Library not found' });
  }
  
  res.json(library);
}));

// PayoutCentral Routes
router.get('/payout/executions', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const {
    status,
    vendorId,
    limit = 50,
    offset = 0
  } = req.query;
  
  const executions = await automationService.getPayoutExecutions({
    status: status ? [status as any] : undefined,
    vendorId: vendorId as string,
    limit: Number(limit),
    offset: Number(offset)
  });
  
  res.json(executions);
}));

router.post('/payout/execute', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const { vendorId, amount, description, paymentMethod, metadata } = req.body;
  const executionId = await automationService.executePayoutAutomation(
    vendorId, 
    amount, 
    description, 
    paymentMethod, 
    metadata
  );
  res.status(201).json({ executionId });
}));

// QualityCentral Routes
router.get('/quality/results', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const {
    integrationId,
    status,
    limit = 50,
    offset = 0
  } = req.query;
  
  const results = await automationService.getQualityResults({
    status: status ? [status as any] : undefined,
    limit: Number(limit),
    offset: Number(offset)
  });
  
  res.json(results);
}));

router.post('/quality/execute', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const { templateId, targetType, targetId, targetName } = req.body;
  if (!templateId || !targetType || !targetId || !targetName) {
    return res.status(400).json({ error: 'templateId, targetType, targetId, and targetName are required' });
  }
  const result = await automationService.executeQualityCheck(templateId, targetType, targetId, targetName);
  res.json(result);
}));

// InstallerCentral Routes
router.get('/installer/tasks', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const {
    status,
    environment,
    customerId,
    limit = 50,
    offset = 0
  } = req.query;
  
  const tasks = await automationService.getInstallerTasks({
    status: status ? [status as any] : undefined,
    environment: environment as any,
    limit: Number(limit),
    offset: Number(offset)
  });
  
  res.json(tasks);
}));

router.post('/installer/execute', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const { templateId, targetType, targetName, targetVersion, environment, executedBy } = req.body;
  if (!templateId || !targetType || !targetName || !targetVersion || !environment || !executedBy) {
    return res.status(400).json({ error: 'templateId, targetType, targetName, targetVersion, environment, and executedBy are required' });
  }
  const taskId = await automationService.executeInstaller(templateId, targetType, targetName, targetVersion, environment, executedBy);
  res.status(201).json({ taskId });
}));

// Analytics Routes
router.get('/analytics', asyncHandler(async (req, res, next) => {
  const automationService = container.get<AutomationLibrariesService>(TYPES.AutomationLibrariesService);
  
  const analytics = await automationService.getAnalytics();
  res.json(analytics);
}));

export { router as automationLibrariesRouter };