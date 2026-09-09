import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { ContractCentralService } from '../services/ContractCentralService';

const router = express.Router();

function getService(): ContractCentralService {
  return container.get<ContractCentralService>(TYPES.ContractCentralService);
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'contract-central' });
});

router.get('/metrics', asyncHandler(async (req, res) => {
  const service = getService();
  const metrics = await service.getMetrics();
  res.json(metrics);
}));

router.get('/by-type', asyncHandler(async (req, res) => {
  const service = getService();
  const byType = await service.getContractsByType();
  res.json(byType);
}));

// =============================================================================
// Contract CRUD
// =============================================================================

router.get('/contracts', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    type: req.query.type as string | undefined,
    status: req.query.status as string | undefined,
    partyId: req.query.partyId as string | undefined,
    expiringSoon: req.query.expiringSoon === 'true',
    search: req.query.search as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getContracts(filters as any);
  res.json(result);
}));

router.get('/contracts/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const contract = await service.getContract(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json(contract);
}));

router.get('/contracts/number/:number', asyncHandler(async (req, res) => {
  const service = getService();
  const contract = await service.getContractByNumber(req.params.number);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json(contract);
}));

router.post('/contracts', asyncHandler(async (req, res) => {
  const service = getService();
  const { name, description, type, partyA, partyB, terms, value, currency, startDate, endDate, autoRenew, renewalTermMonths, tags, customFields, createdBy } = req.body;

  if (!name || !type || !partyA || !partyB || !terms || value === undefined || !startDate || !endDate || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const contract = await service.createContract({
    name, description, type, partyA, partyB, terms, value, currency, startDate, endDate, autoRenew, renewalTermMonths, tags, customFields, createdBy,
  });

  res.status(201).json(contract);
}));

router.put('/contracts/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const contract = await service.updateContract(req.params.id, req.body);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.json(contract);
}));

// =============================================================================
// Contract Workflow
// =============================================================================

router.post('/contracts/:id/submit-review', asyncHandler(async (req, res) => {
  const service = getService();
  const { submittedBy } = req.body;
  if (!submittedBy) {
    return res.status(400).json({ error: 'submittedBy is required' });
  }
  const contract = await service.submitForReview(req.params.id, submittedBy);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found or not in draft status' });
  }
  res.json(contract);
}));

router.post('/contracts/:id/request-approval', asyncHandler(async (req, res) => {
  const service = getService();
  const { approvers } = req.body;
  if (!approvers || !Array.isArray(approvers)) {
    return res.status(400).json({ error: 'approvers array is required' });
  }
  const contract = await service.requestApproval(req.params.id, approvers);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found or not pending review' });
  }
  res.json(contract);
}));

router.post('/contracts/:id/approvals/:approvalId', asyncHandler(async (req, res) => {
  const service = getService();
  const { approved, comments } = req.body;
  if (approved === undefined) {
    return res.status(400).json({ error: 'approved is required' });
  }
  const contract = await service.processApproval(req.params.id, req.params.approvalId, { approved, comments });
  if (!contract) {
    return res.status(404).json({ error: 'Contract or approval not found' });
  }
  res.json(contract);
}));

router.post('/contracts/:id/sign', asyncHandler(async (req, res) => {
  const service = getService();
  const { signedBy, party } = req.body;
  if (!signedBy || !party || !['A', 'B'].includes(party)) {
    return res.status(400).json({ error: 'signedBy and party (A or B) are required' });
  }
  const contract = await service.signContract(req.params.id, { signedBy, party });
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found or not pending signature' });
  }
  res.json(contract);
}));

router.post('/contracts/:id/renew', asyncHandler(async (req, res) => {
  const service = getService();
  const { newEndDate, newValue, renewedBy } = req.body;
  if (!newEndDate || !renewedBy) {
    return res.status(400).json({ error: 'newEndDate and renewedBy are required' });
  }
  const contract = await service.renewContract(req.params.id, { newEndDate, newValue, renewedBy });
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found or not active' });
  }
  res.json(contract);
}));

router.post('/contracts/:id/terminate', asyncHandler(async (req, res) => {
  const service = getService();
  const { reason, terminatedBy, effectiveDate } = req.body;
  if (!reason || !terminatedBy) {
    return res.status(400).json({ error: 'reason and terminatedBy are required' });
  }
  const contract = await service.terminateContract(req.params.id, { reason, terminatedBy, effectiveDate });
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found or not active' });
  }
  res.json(contract);
}));

// =============================================================================
// Expiring & Actions
// =============================================================================

router.get('/expiring', asyncHandler(async (req, res) => {
  const service = getService();
  const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
  const contracts = await service.getExpiringContracts(days);
  res.json(contracts);
}));

router.get('/actions', asyncHandler(async (req, res) => {
  const service = getService();
  const actions = await service.getPendingActions();
  res.json(actions);
}));

router.post('/contracts/:id/actions', asyncHandler(async (req, res) => {
  const service = getService();
  const { action, assignee, dueDate } = req.body;
  if (!action || !assignee || !dueDate) {
    return res.status(400).json({ error: 'action, assignee, and dueDate are required' });
  }
  const contractAction = await service.createAction(req.params.id, { action, assignee, dueDate });
  if (!contractAction) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  res.status(201).json(contractAction);
}));

router.post('/actions/:id/complete', asyncHandler(async (req, res) => {
  const service = getService();
  const action = await service.completeAction(req.params.id);
  if (!action) {
    return res.status(404).json({ error: 'Action not found' });
  }
  res.json(action);
}));

router.get('/activity', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
  const activity = await service.getRecentActivity(limit);
  res.json(activity);
}));

export { router as contractCentralRouter };
