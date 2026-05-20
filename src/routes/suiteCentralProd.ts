import * as express from 'express';
import type { NextFunction } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SuiteCentralConfigService } from '../services/SuiteCentralConfigService';
import type { SuiteCentralMonitoringService } from '../services/SuiteCentralMonitoringService';
import type { SuiteCentralConnectorProd } from '../connectors/SuiteCentralConnectorProd';
import type { IConnector } from '../interfaces/IConnector';

const router = express.Router();

// Environment Management Routes
router.get('/environments', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const environments = configService.getAllEnvironments();
  res.json(environments);
}));

router.post('/environments', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  
  const environmentData = req.body;
  const validationErrors = configService.validateEnvironmentConfig(environmentData);
  
  if (validationErrors.length > 0) {
    res.status(400).json({
      error: 'Validation failed',
      details: validationErrors
    });
    return;
  }

  const environmentId = await configService.createEnvironment(environmentData);
  res.status(201).json({ environmentId });
}));

router.get('/environments/:environmentId', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const environment = configService.getEnvironment(environmentId);
  if (!environment) {
    res.status(404).json({ error: 'Environment not found' });
    return;
  }
  
  res.json(environment);
}));

router.put('/environments/:environmentId', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const success = await configService.updateEnvironment(environmentId, req.body);
  if (!success) {
    res.status(404).json({ error: 'Environment not found' });
    return;
  }
  
  res.json({ success: true });
}));

// Credential Profile Management Routes
router.post('/credentials', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  
  const profileId = await configService.createCredentialProfile(req.body);
  res.status(201).json({ profileId });
}));

router.get('/credentials/:profileId', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { profileId } = req.params;
  const { decrypt } = req.query;
  
  if (!profileId) {
    res.status(400).json({ error: 'Profile ID is required' });
    return;
  }
  
  const profile = await configService.getCredentialProfile(profileId, decrypt === 'true');
  if (!profile) {
    res.status(404).json({ error: 'Credential profile not found' });
    return;
  }
  
  // Remove sensitive data if not decrypting
  if (decrypt !== 'true') {
    delete (profile as any).clientSecret;
  }
  
  res.json(profile);
}));

router.get('/environments/:environmentId/credentials', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const credentials = configService.getCredentialsByEnvironment(environmentId);
  
  // Remove sensitive data
  const sanitized = credentials.map(cred => {
    const { clientSecret, ...safe } = cred;
    return safe;
  });
  
  res.json(sanitized);
}));

// Integration Template Management Routes
router.get('/templates', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { sourceSystem } = req.query;
  
  const templates = sourceSystem ? 
    configService.getTemplatesBySourceSystem(sourceSystem as string) :
    configService.getAllTemplates();
    
  res.json(templates);
}));

router.post('/templates', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  
  const templateId = await configService.createIntegrationTemplate(req.body);
  res.status(201).json({ templateId });
}));

router.get('/templates/:templateId', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { templateId } = req.params;
  
  if (!templateId) {
    res.status(400).json({ error: 'Template ID is required' });
    return;
  }
  
  const template = configService.getIntegrationTemplate(templateId);
  if (!template) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  
  res.json(template);
}));

// Monitoring and Health Routes
router.get('/monitoring/health/:environmentId', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const healthCheck = await monitoringService.performHealthCheck(environmentId);
  res.json(healthCheck);
}));

router.get('/monitoring/health/:environmentId/history', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  const { limit } = req.query;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const history = monitoringService.getHealthHistory(environmentId, limit ? parseInt(limit as string, 10) : 50);
  res.json(history);
}));

router.get('/monitoring/alerts', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.query;
  
  const alerts = monitoringService.getActiveAlerts(environmentId as string | undefined);
  res.json(alerts);
}));

router.post('/monitoring/alerts/:alertId/resolve', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { alertId } = req.params;
  const { resolution } = req.body;
  
  if (!alertId) {
    res.status(400).json({ error: 'Alert ID is required' });
    return;
  }
  
  const success = await monitoringService.resolveAlert(alertId, resolution);
  if (!success) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  
  res.json({ success: true });
}));

router.get('/monitoring/usage/:environmentId', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const usage = monitoringService.getUsageMetrics(environmentId);
  if (!usage) {
    res.status(404).json({ error: 'Usage metrics not found' });
    return;
  }
  
  res.json(usage);
}));

router.get('/monitoring/insights/:environmentId', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const insights = await monitoringService.generatePerformanceInsights(environmentId);
  res.json(insights);
}));

router.get('/monitoring/dashboard/:environmentId', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const dashboard = await monitoringService.getMonitoringDashboard(environmentId);
  res.json(dashboard);
}));

router.post('/monitoring/:environmentId/start', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  const { intervalMs } = req.body;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  monitoringService.startMonitoring(environmentId, intervalMs || 300000);
  res.json({ message: 'Monitoring started', environmentId });
}));

router.post('/monitoring/:environmentId/stop', asyncHandler(async (req, res, next) => {
  const monitoringService = container.get<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  monitoringService.stopMonitoring(environmentId);
  res.json({ message: 'Monitoring stopped', environmentId });
}));

// Production Connector Operations Routes
router.post('/connector/test-connection', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<IConnector>(TYPES.SuiteCentralConnectorProd);
    
    // Initialize with provided auth config
    if (req.body.authConfig) {
      await connector.initialize(req.body.authConfig);
    }
    
    const status = await connector.testConnection();
    res.json(status);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

router.post('/connector/bulk-import', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<SuiteCentralConnectorProd>(TYPES.SuiteCentralConnectorProd);
    const { entityType, records, authConfig } = req.body;
    
    if (authConfig) {
      await connector.initialize(authConfig);
    }
    
    const operationId = await connector.bulkImport(entityType, records);
    res.json({ operationId });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

router.get('/connector/bulk-operations/:operationId', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<SuiteCentralConnectorProd>(TYPES.SuiteCentralConnectorProd);
    const { operationId } = req.params;
    
    if (!operationId) {
      res.status(400).json({ error: 'Operation ID is required' });
      return;
    }
    
    const operation = await connector.getBulkOperationStatus(operationId);
    if (!operation) {
      res.status(404).json({ error: 'Operation not found' });
      return;
    }
    
    res.json(operation);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

router.post('/connector/webhooks', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<SuiteCentralConnectorProd>(TYPES.SuiteCentralConnectorProd);
    const { targetUrl, events, authConfig } = req.body;
    
    if (authConfig) {
      await connector.initialize(authConfig);
    }
    
    const webhookId = await connector.setupWebhook(targetUrl, events);
    res.json({ webhookId });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

router.delete('/connector/webhooks/:webhookId', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<SuiteCentralConnectorProd>(TYPES.SuiteCentralConnectorProd);
    const { webhookId } = req.params;
    
    if (!webhookId) {
      res.status(400).json({ error: 'Webhook ID is required' });
      return;
    }
    
    const success = await connector.removeWebhook(webhookId);
    res.json({ success });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

// System Information and Health Report
router.get('/system/health-report', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  
  const healthReport = await configService.generateHealthReport();
  res.json(healthReport);
}));

router.get('/system/info', asyncHandler(async (req, res, next) => {
  try {
    const connector = container.get<IConnector>(TYPES.SuiteCentralConnectorProd);
    const systemInfo = await connector.getSystemInfo();
    res.json(systemInfo);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({ error: err.message });
  }
}));

// Performance Profile Routes
router.get('/performance/:environmentId', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { environmentId } = req.params;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  const profile = configService.getPerformanceProfile(environmentId);
  if (!profile) {
    res.status(404).json({ error: 'Performance profile not found' });
    return;
  }
  
  res.json(profile);
}));

router.post('/performance/:environmentId/update', asyncHandler(async (req, res, next) => {
  const configService = container.get<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService);
  const { environmentId } = req.params;
  const metrics = req.body;
  
  if (!environmentId) {
    res.status(400).json({ error: 'Environment ID is required' });
    return;
  }
  
  await configService.updatePerformanceProfile(environmentId, metrics);
  res.json({ success: true });
}));

export { router as suiteCentralProdRouter };