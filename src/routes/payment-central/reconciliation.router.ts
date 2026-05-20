import * as express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { PaymentCentralService } from '../../services/PaymentCentralService';

const router = express.Router();

function getPaymentService(): PaymentCentralService {
  return container.get<PaymentCentralService>(TYPES.PaymentCentralService);
}

router.post('/reports', asyncHandler(async (req, res, next) => {
  const { startDate, endDate, processorIds = [] } = req.body;

  if (!startDate || !endDate) {
    res.status(400).json({ error: 'Start date and end date are required' });
    return;
  }

  const reportId = await getPaymentService().generateReconciliationReport(
    { start: startDate, end: endDate },
    processorIds
  );

  res.status(201).json({ reportId });
}));

router.get('/reports/:reportId', asyncHandler(async (req, res, next) => {
  const { reportId } = req.params;

  if (!reportId) {
    res.status(400).json({ error: 'Report ID is required' });
    return;
  }

  const report = await getPaymentService().getReconciliationReport(reportId);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }

  res.json(report);
}));

export { router as paymentCentralReconciliationRouter };
