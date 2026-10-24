import type { RequestHandler } from 'express';
import type { WorkflowEngineService } from '../services/workflowCentral/WorkflowEngineService';

export function workflowCentralReadyGate(engine: WorkflowEngineService): RequestHandler {
  return (_req, res, next) => {
    if (engine.hydrationReady) return next();
    res.status(503).json({
      ok: false,
      code: 'service_unavailable',
      message: 'workflow-central is still hydrating; retry shortly',
    });
  };
}
