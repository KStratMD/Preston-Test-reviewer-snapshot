import * as express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { PaymentCentralService } from '../../services/PaymentCentralService';

const router = express.Router();

function getPaymentService(): PaymentCentralService {
  return container.get<PaymentCentralService>(TYPES.PaymentCentralService);
}

router.get('/accounts', asyncHandler(async (req, res, next) => {
  const accounts = await getPaymentService().getGLAccounts();
  res.json(accounts);
}));

router.get('/accounts/:accountId', asyncHandler(async (req, res, next) => {
  const { accountId } = req.params;

  const account = await getPaymentService().getGLAccount(accountId);
  if (!account) {
    res.status(404).json({ error: 'GL account not found' });
    return;
  }

  res.json(account);
}));

router.get('/journal-entries', asyncHandler(async (req, res, next) => {
  const {
    status,
    startDate,
    endDate,
    transactionId,
    accountId,
    minAmount,
    maxAmount,
    limit = '50',
    offset = '0'
  } = req.query;

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (status) filters.status = Array.isArray(status) ? status : [status];
  if (transactionId) filters.transactionId = transactionId;
  if (accountId) filters.accountId = accountId;
  if (startDate) filters.startDate = parseInt(startDate as string, 10);
  if (endDate) filters.endDate = parseInt(endDate as string, 10);
  if (minAmount) filters.minAmount = parseFloat(minAmount as string);
  if (maxAmount) filters.maxAmount = parseFloat(maxAmount as string);

  const result = await getPaymentService().getJournalEntries(filters);
  res.json(result);
}));

router.get('/journal-entries/:entryId', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  const entry = await getPaymentService().getJournalEntry(entryId);
  if (!entry) {
    res.status(404).json({ error: 'Journal entry not found' });
    return;
  }

  res.json(entry);
}));

router.post('/journal-entries/from-transaction', asyncHandler(async (req, res, next) => {
  const { transactionId } = req.body;

  if (!transactionId) {
    res.status(400).json({ error: 'Transaction ID is required' });
    return;
  }

  const result = await getPaymentService().createJournalEntryFromTransaction(transactionId);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.status(201).json(result);
}));

router.post('/journal-entries/:entryId/approve', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;
  const { approvedBy = 'system' } = req.body;

  try {
    const entry = await getPaymentService().approveJournalEntry(entryId, approvedBy);
    if (!entry) {
      res.status(404).json({ error: 'Journal entry not found' });
      return;
    }
    res.json(entry);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Approval failed' });
  }
}));

router.post('/journal-entries/:entryId/post', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;
  const { postedBy = 'system' } = req.body;

  const result = await getPaymentService().postJournalEntry(entryId, postedBy);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
}));

router.post('/journal-entries/:entryId/void', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;
  const { reason } = req.body;

  if (!reason) {
    res.status(400).json({ error: 'Void reason is required' });
    return;
  }

  try {
    const entry = await getPaymentService().voidJournalEntry(entryId, reason);
    if (!entry) {
      res.status(404).json({ error: 'Journal entry not found' });
      return;
    }
    res.json(entry);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Void failed' });
  }
}));

router.get('/batches', asyncHandler(async (req, res, next) => {
  const {
    status,
    startDate,
    endDate,
    limit = '50',
    offset = '0'
  } = req.query;

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (status) filters.status = Array.isArray(status) ? status : [status];
  if (startDate) filters.startDate = parseInt(startDate as string, 10);
  if (endDate) filters.endDate = parseInt(endDate as string, 10);

  const result = await getPaymentService().getPostingBatches(filters);
  res.json(result);
}));

router.get('/batches/:batchId', asyncHandler(async (req, res, next) => {
  const { batchId } = req.params;

  const batch = await getPaymentService().getPostingBatch(batchId);
  if (!batch) {
    res.status(404).json({ error: 'Posting batch not found' });
    return;
  }

  res.json(batch);
}));

router.post('/batches', asyncHandler(async (req, res, next) => {
  const { name, entryIds, createdBy = 'system' } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Batch name is required' });
    return;
  }

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    res.status(400).json({ error: 'Entry IDs array is required' });
    return;
  }

  try {
    const batch = await getPaymentService().createPostingBatch(name, entryIds, createdBy);
    res.status(201).json(batch);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Batch creation failed' });
  }
}));

router.post('/batches/:batchId/process', asyncHandler(async (req, res, next) => {
  const { batchId } = req.params;
  const { processedBy = 'system' } = req.body;

  try {
    const batch = await getPaymentService().processPostingBatch(batchId, processedBy);
    res.json(batch);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Batch processing failed' });
  }
}));

router.get('/statistics', asyncHandler(async (req, res, next) => {
  const statistics = await getPaymentService().getGLPostingStatistics();
  res.json(statistics);
}));

router.get('/dashboard', asyncHandler(async (req, res, next) => {
  const dashboard = await getPaymentService().getGLPostingDashboard();
  res.json(dashboard);
}));

export { router as paymentCentralGlRouter };
