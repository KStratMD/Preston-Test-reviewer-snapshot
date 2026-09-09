import * as express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { PaymentCentralService } from '../../services/PaymentCentralService';

const router = express.Router();

function getPaymentService(): PaymentCentralService {
  return container.get<PaymentCentralService>(TYPES.PaymentCentralService);
}

router.get('/schedules', asyncHandler(async (req, res, next) => {
  const schedules = await getPaymentService().getDunningSchedules();
  res.json(schedules);
}));

router.get('/schedules/:scheduleId', asyncHandler(async (req, res, next) => {
  const { scheduleId } = req.params;

  const schedule = await getPaymentService().getDunningSchedule(scheduleId);
  if (!schedule) {
    res.status(404).json({ error: 'Dunning schedule not found' });
    return;
  }

  res.json(schedule);
}));

router.post('/schedules', asyncHandler(async (req, res, next) => {
  const schedule = await getPaymentService().saveDunningSchedule(req.body);
  res.status(201).json(schedule);
}));

router.patch('/schedules/:scheduleId', asyncHandler(async (req, res, next) => {
  const { scheduleId } = req.params;

  const schedule = await getPaymentService().updateDunningSchedule(scheduleId, req.body);
  if (!schedule) {
    res.status(404).json({ error: 'Dunning schedule not found' });
    return;
  }

  res.json(schedule);
}));

router.delete('/schedules/:scheduleId', asyncHandler(async (req, res, next) => {
  const { scheduleId } = req.params;

  const deleted = await getPaymentService().deleteDunningSchedule(scheduleId);
  if (!deleted) {
    res.status(404).json({ error: 'Dunning schedule not found' });
    return;
  }

  res.json({ success: true, message: 'Schedule deleted' });
}));

router.get('/entries', asyncHandler(async (req, res, next) => {
  const {
    scheduleId,
    status,
    level,
    daysOverdueMin,
    daysOverdueMax,
    amountMin,
    amountMax,
    customerId,
    limit = '50',
    offset = '0'
  } = req.query;

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (scheduleId) filters.scheduleId = scheduleId;
  if (status) filters.status = Array.isArray(status) ? status : [status];
  if (level) {
    const levelArray = Array.isArray(level) ? level : [level];
    filters.level = levelArray.map(l => parseInt(l as string, 10));
  }
  if (daysOverdueMin) filters.daysOverdueMin = parseInt(daysOverdueMin as string, 10);
  if (daysOverdueMax) filters.daysOverdueMax = parseInt(daysOverdueMax as string, 10);
  if (amountMin) filters.amountMin = parseFloat(amountMin as string);
  if (amountMax) filters.amountMax = parseFloat(amountMax as string);
  if (customerId) filters.customerId = customerId;

  const result = await getPaymentService().getDunningEntries(filters);
  res.json(result);
}));

router.get('/entries/:entryId', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  const entry = await getPaymentService().getDunningEntry(entryId);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found' });
    return;
  }

  res.json(entry);
}));

router.post('/entries/:entryId/remind', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  const result = await getPaymentService().sendDunningReminder(entryId);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
}));

router.post('/entries/:entryId/ai-analyze', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  if (!entryId) {
    res.status(400).json({ error: 'Entry ID is required' });
    return;
  }

  const paymentService = getPaymentService();
  const entry = await paymentService.getDunningEntry(entryId);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found' });
    return;
  }

  const result = await paymentService.analyzeDunningEntry(entryId);

  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({
    entryId,
    entry,
    aiAnalysis: result.aiAnalysis || null,
    generatedMessage: result.aiAnalysis?.generatedMessage || null,
    preview: true,
    timestamp: Date.now(),
  });
}));

router.post('/entries/:entryId/pause', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;
  const { reason = 'Manually paused' } = req.body;

  const entry = await getPaymentService().pauseDunning(entryId, reason);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found' });
    return;
  }

  res.json(entry);
}));

router.post('/entries/:entryId/resume', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  const entry = await getPaymentService().resumeDunning(entryId);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found or not paused' });
    return;
  }

  res.json(entry);
}));

router.post('/entries/:entryId/paid', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;
  const { paymentAmount } = req.body;

  if (!paymentAmount || isNaN(paymentAmount)) {
    res.status(400).json({ error: 'Valid payment amount is required' });
    return;
  }

  const entry = await getPaymentService().markDunningPaid(entryId, paymentAmount);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found' });
    return;
  }

  res.json(entry);
}));

router.post('/entries/:entryId/escalate', asyncHandler(async (req, res, next) => {
  const { entryId } = req.params;

  const entry = await getPaymentService().escalateToCollections(entryId);
  if (!entry) {
    res.status(404).json({ error: 'Dunning entry not found' });
    return;
  }

  res.json(entry);
}));

router.get('/statistics', asyncHandler(async (req, res, next) => {
  const statistics = await getPaymentService().getDunningStatistics();
  res.json(statistics);
}));

router.post('/process', asyncHandler(async (req, res, next) => {
  const result = await getPaymentService().processPendingDunning();
  res.json(result);
}));

router.get('/dashboard', asyncHandler(async (req, res, next) => {
  const paymentService = getPaymentService();

  const [schedules, statistics, recentEntries] = await Promise.all([
    paymentService.getDunningSchedules(),
    paymentService.getDunningStatistics(),
    paymentService.getDunningEntries({ limit: 10 }),
  ]);

  res.json({
    schedules: schedules.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      levels: s.levels.length,
    })),
    statistics,
    recentEntries: recentEntries.entries,
    lastUpdated: Date.now(),
  });
}));

export { router as paymentCentralDunningRouter };
