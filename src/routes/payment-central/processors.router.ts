import * as express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { PaymentCentralService } from '../../services/PaymentCentralService';

const router = express.Router();

function getPaymentService(): PaymentCentralService {
  return container.get<PaymentCentralService>(TYPES.PaymentCentralService);
}

router.get('/processors', asyncHandler(async (req, res, next) => {
  const processors = await getPaymentService().getPaymentProcessors();
  res.json(processors);
}));

router.post('/processors', asyncHandler(async (req, res, next) => {
  const processorId = await getPaymentService().configureProcessor(req.body);
  res.status(201).json({ processorId });
}));

router.get('/transactions', asyncHandler(async (req, res, next) => {
  const {
    processorIds,
    status,
    startDate,
    endDate,
    minAmount,
    maxAmount,
    customerIds,
    syncStatus,
    limit = '50',
    offset = '0'
  } = req.query;

  const filters: Record<string, unknown> = {
    limit: parseInt(limit as string, 10),
    offset: parseInt(offset as string, 10),
  };

  if (processorIds) {
    filters.processorIds = Array.isArray(processorIds) ? processorIds : [processorIds];
  }

  if (status) {
    filters.status = Array.isArray(status) ? status : [status];
  }

  if (startDate && endDate) {
    filters.dateRange = {
      start: parseInt(startDate as string, 10),
      end: parseInt(endDate as string, 10),
    };
  }

  if (minAmount || maxAmount) {
    filters.amountRange = {
      min: minAmount ? parseFloat(minAmount as string) : 0,
      max: maxAmount ? parseFloat(maxAmount as string) : Number.MAX_VALUE,
    };
  }

  if (customerIds) {
    filters.customerIds = Array.isArray(customerIds) ? customerIds : [customerIds];
  }

  if (syncStatus) {
    filters.syncStatus = Array.isArray(syncStatus) ? syncStatus : [syncStatus];
  }

  const result = await getPaymentService().getTransactions(filters);
  res.json(result);
}));

router.post('/transactions/:transactionId/sync', asyncHandler(async (req, res, next) => {
  const { transactionId } = req.params;

  if (!transactionId) {
    res.status(400).json({ error: 'Transaction ID is required' });
    return;
  }

  const result = await getPaymentService().syncTransactionToBusinessCentral(transactionId);

  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
}));

router.get('/analytics', asyncHandler(async (req, res, next) => {
  const { timeRangeMs = '2592000000' } = req.query;
  const timeRange = parseInt(timeRangeMs as string, 10);

  const analytics = await getPaymentService().getPaymentAnalytics(timeRange);
  res.json(analytics);
}));

router.get('/health', asyncHandler(async (req, res, next) => {
  const paymentService = getPaymentService();
  const processors = await paymentService.getPaymentProcessors();
  const activeProcessors = processors.filter(p => p.status === 'active').length;
  const totalProcessors = processors.length;

  const recentTransactions = await paymentService.getTransactions({
    dateRange: {
      start: Date.now() - (24 * 60 * 60 * 1000),
      end: Date.now(),
    },
    limit: 1000,
  });

  const successfulTransactions = recentTransactions.transactions.filter(
    t => t.status === 'completed'
  ).length;
  const successRate = recentTransactions.totalCount > 0 ?
    (successfulTransactions / recentTransactions.totalCount) * 100 : 100;

  const health = {
    status: successRate >= 95 && activeProcessors === totalProcessors ? 'healthy' :
            successRate >= 85 && activeProcessors >= totalProcessors * 0.8 ? 'degraded' : 'critical',
    processors: {
      active: activeProcessors,
      total: totalProcessors,
      healthScore: totalProcessors > 0 ? (activeProcessors / totalProcessors) * 100 : 100,
    },
    transactions: {
      last24h: recentTransactions.totalCount,
      successRate: parseFloat(successRate.toFixed(2)),
      successful: successfulTransactions,
    },
    timestamp: Date.now(),
  };

  res.json(health);
}));

router.get('/dashboard', asyncHandler(async (req, res, next) => {
  const paymentService = getPaymentService();

  const analytics = await paymentService.getPaymentAnalytics();
  const recentTransactions = await paymentService.getTransactions({
    limit: 10,
    dateRange: {
      start: Date.now() - (7 * 24 * 60 * 60 * 1000),
      end: Date.now(),
    }
  });
  const processors = await paymentService.getPaymentProcessors();
  const unreconciledTransactions = await paymentService.getTransactions({
    syncStatus: ['pending', 'failed'],
    limit: 50,
  });

  const dashboard = {
    summary: analytics.summary,
    processors: processors.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      status: p.status,
      dailyLimit: p.limits.dailyVolume,
      fees: p.fees,
    })),
    recentTransactions: recentTransactions.transactions.slice(0, 5),
    reconciliation: {
      rate: analytics.reconciliationHealth.reconciliationRate,
      unreconciledCount: unreconciledTransactions.totalCount,
      unreconciledAmount: analytics.reconciliationHealth.unreconciledAmount,
      oldestUnreconciled: analytics.reconciliationHealth.oldestUnreconciledTransaction,
    },
    riskSummary: {
      averageRiskScore: analytics.riskAnalysis.averageRiskScore,
      fraudPrevented: analytics.riskAnalysis.fraudPrevented,
      chargebackRate: analytics.riskAnalysis.chargebackRate,
    },
    topProcessors: analytics.processorPerformance
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3),
    alerts: [
      ...(analytics.reconciliationHealth.reconciliationRate < 90 ? [{
        id: 'reconciliation_low',
        type: 'warning',
        message: `Reconciliation rate is ${analytics.reconciliationHealth.reconciliationRate.toFixed(1)}% (below 90% threshold)`,
        severity: 'medium',
        timestamp: Date.now(),
      }] : []),
      ...(analytics.riskAnalysis.chargebackRate > 0.5 ? [{
        id: 'chargeback_high',
        type: 'alert',
        message: `Chargeback rate is ${analytics.riskAnalysis.chargebackRate.toFixed(2)}% (above 0.5% threshold)`,
        severity: 'high',
        timestamp: Date.now(),
      }] : []),
      ...(processors.filter(p => p.status !== 'active').map(p => ({
        id: `processor_${p.id}_down`,
        type: 'error',
        message: `Payment processor ${p.name} is ${p.status}`,
        severity: 'critical',
        timestamp: Date.now(),
      }))),
    ],
    lastUpdated: Date.now(),
  };

  res.json(dashboard);
}));

router.post('/transactions/bulk-sync', asyncHandler(async (req, res, next) => {
  const { transactionIds } = req.body;

  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    res.status(400).json({ error: 'Transaction IDs array is required' });
    return;
  }

  const paymentService = getPaymentService();
  const results = {
    successful: [] as string[],
    failed: [] as { transactionId: string; error: string }[],
  };

  for (const transactionId of transactionIds) {
    try {
      const result = await paymentService.syncTransactionToBusinessCentral(transactionId);
      if (result.success) {
        results.successful.push(transactionId);
      } else {
        results.failed.push({
          transactionId,
          error: result.error || 'Unknown error',
        });
      }
    } catch (error) {
      results.failed.push({
        transactionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  res.json({
    total: transactionIds.length,
    successful: results.successful.length,
    failed: results.failed.length,
    results,
  });
}));

router.get('/export/transactions', asyncHandler(async (req, res, next) => {
  const {
    startDate,
    endDate,
    processorIds,
    format = 'json'
  } = req.query;

  const filters: Record<string, unknown> = {};

  if (startDate && endDate) {
    filters.dateRange = {
      start: parseInt(startDate as string, 10),
      end: parseInt(endDate as string, 10),
    };
  }

  if (processorIds) {
    filters.processorIds = Array.isArray(processorIds) ? processorIds : [processorIds];
  }

  const result = await getPaymentService().getTransactions({
    ...filters,
    limit: 10000,
  });

  if (format === 'csv') {
    const headers = [
      'Transaction ID', 'Processor', 'Amount', 'Currency', 'Status', 'Type',
      'Customer ID', 'Merchant', 'Payment Method', 'Risk Level', 'Sync Status',
      'Processing Fee', 'Total Fees', 'Timestamp'
    ];

    const csvRows = result.transactions.map(t => [
      t.id,
      t.processorId,
      t.amount,
      t.currency,
      t.status,
      t.type,
      t.customer.id,
      t.merchant.name,
      t.paymentMethod.type,
      t.risk.level,
      t.businessCentral.syncStatus,
      t.fees.processingFee,
      t.fees.total,
      new Date(t.timestamp).toISOString()
    ]);

    const csv = [headers, ...csvRows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payment-transactions.csv"');
    res.send(csv);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="payment-transactions.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      totalTransactions: result.totalCount,
      transactions: result.transactions,
    });
  }
}));

export { router as paymentCentralProcessorsRouter };
