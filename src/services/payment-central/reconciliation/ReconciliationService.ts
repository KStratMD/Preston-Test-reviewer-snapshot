import type { ReconciliationReport, PaymentTransaction } from '../../../types/paymentCentral';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';
import type { ProcessorReader, TransactionReader } from '../ports';

export class ReconciliationService {
  private readonly reports = new Map<string, ReconciliationReport>();

  constructor(
    private readonly processorReader: ProcessorReader,
    private readonly transactionReader: TransactionReader,
    private readonly runtime: PaymentCentralRuntime,
  ) {}

  async generateReconciliationReport(
    dateRange: { start: number; end: number },
    processorIds: string[] = []
  ): Promise<string> {
    const reportId = this.runtime.createId('report');

    // Filter transactions by date range and processors
    let transactions = this.transactionReader.listTransactions()
      .filter(t => t.timestamp >= dateRange.start && t.timestamp <= dateRange.end);

    if (processorIds.length > 0) {
      transactions = transactions.filter(t => processorIds.includes(t.processorId));
    }

    // Calculate summary
    const totalTransactions = transactions.length;
    const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);
    const totalFees = transactions.reduce((sum, t) => sum + t.fees.total, 0);
    const netAmount = totalAmount - totalFees;

    const reconciledTransactions = transactions.filter(t =>
      t.businessCentral.syncStatus === 'synced'
    ).length;
    const unreconciledTransactions = totalTransactions - reconciledTransactions;

    const reconciledAmount = transactions
      .filter(t => t.businessCentral.syncStatus === 'synced')
      .reduce((sum, t) => sum + t.amount, 0);
    const unreconciledAmount = totalAmount - reconciledAmount;

    // Generate processor breakdown
    const processorStats = new Map<string, {
      name: string;
      transactions: number;
      amount: number;
      fees: number;
      reconciled: number;
    }>();

    transactions.forEach(t => {
      const processor = this.processorReader.getProcessorById(t.processorId);
      const stats = processorStats.get(t.processorId) || {
        name: processor?.name || 'Unknown',
        transactions: 0,
        amount: 0,
        fees: 0,
        reconciled: 0,
      };

      stats.transactions++;
      stats.amount += t.amount;
      stats.fees += t.fees.total;
      if (t.businessCentral.syncStatus === 'synced') {
        stats.reconciled++;
      }

      processorStats.set(t.processorId, stats);
    });

    const processorBreakdown = Array.from(processorStats.entries()).map(([processorId, stats]) => ({
      processorId,
      processorName: stats.name,
      transactions: stats.transactions,
      amount: stats.amount,
      fees: stats.fees,
      net: stats.amount - stats.fees,
      reconciled: stats.reconciled,
      discrepancies: stats.transactions - stats.reconciled, // Simplified
    }));

    // Generate sample discrepancies for demo
    const discrepancies = this.generateSampleDiscrepancies(transactions);

    const report: ReconciliationReport = {
      id: reportId,
      dateRange,
      processors: processorIds.length > 0 ? processorIds : this.processorReader.listProcessors().map(p => p.id),
      summary: {
        totalTransactions,
        totalAmount,
        totalFees,
        netAmount,
        reconciledTransactions,
        unreconciledTransactions,
        reconciledAmount,
        unreconciledAmount,
        discrepancies: discrepancies.length,
        discrepancyAmount: discrepancies.reduce((sum, d) => sum + Math.abs(
          (d.processorAmount || 0) - (d.businessCentralAmount || 0)
        ), 0),
      },
      processorBreakdown,
      discrepancies,
      generatedAt: this.runtime.now(),
      generatedBy: 'system',
      status: 'completed',
    };

    this.reports.set(reportId, report);

    this.runtime.logger.info('Reconciliation report generated', {
      reportId,
      dateRange,
      totalTransactions,
      reconciledTransactions,
      discrepancies: discrepancies.length,
    });

    return reportId;
  }

  async getReconciliationReport(reportId: string): Promise<ReconciliationReport | null> {
    return this.reports.get(reportId) || null;
  }

  private generateSampleDiscrepancies(transactions: readonly PaymentTransaction[]): ReconciliationReport['discrepancies'] {
    const discrepancies: ReconciliationReport['discrepancies'] = [];
    const discrepancyCount = Math.floor(transactions.length * 0.02); // 2% discrepancy rate

    for (let i = 0; i < discrepancyCount; i++) {
      const transaction = transactions[Math.floor(this.runtime.random() * transactions.length)];
      const types: ReconciliationReport['discrepancies'][0]['type'][] = [
        'missing_bc', 'missing_processor', 'amount_mismatch', 'status_mismatch', 'duplicate'
      ];
      const selectedType = types[Math.floor(this.runtime.random() * types.length)];

      if (transaction && selectedType) {
        discrepancies.push({
          id: `disc_${this.runtime.now()}_${i}_${this.runtime.random().toString(36).slice(2, 2 + 6)}`,
          type: selectedType,
          severity: this.runtime.random() > 0.8 ? 'high' : this.runtime.random() > 0.6 ? 'medium' : 'low',
          processorId: transaction.processorId,
          transactionId: transaction.id,
          processorAmount: transaction.amount,
          businessCentralAmount: selectedType === 'amount_mismatch' ?
            transaction.amount + (this.runtime.random() * 200 - 100) : // +/- $100
            undefined,
          description: this.getDiscrepancyDescription(selectedType),
          suggestedAction: this.getDiscrepancySuggestedAction(selectedType),
          autoResolvable: selectedType === 'status_mismatch' || selectedType === 'duplicate',
        });
      }
    }

    return discrepancies;
  }

  private getDiscrepancyDescription(type: ReconciliationReport['discrepancies'][0]['type']): string {
    const descriptions = {
      missing_bc: 'Transaction exists in processor but not found in Business Central',
      missing_processor: 'Transaction exists in Business Central but not found in processor records',
      amount_mismatch: 'Transaction amounts differ between processor and Business Central',
      status_mismatch: 'Transaction status differs between systems',
      duplicate: 'Transaction appears to be duplicated in one or both systems',
    };
    return descriptions[type];
  }

  private getDiscrepancySuggestedAction(type: ReconciliationReport['discrepancies'][0]['type']): string {
    const actions = {
      missing_bc: 'Retry sync to Business Central or manually create journal entry',
      missing_processor: 'Verify processor webhook delivery or manually reconcile',
      amount_mismatch: 'Review fee calculations and currency conversion rates',
      status_mismatch: 'Update transaction status in both systems',
      duplicate: 'Remove duplicate entry and update reconciliation flags',
    };
    return actions[type];
  }
}
