import type { Logger } from '../../utils/Logger';
import type { FinanceCentralRepository } from './FinanceCentralRepository';

const DAY_MS = 86_400_000;

/**
 * Seed FinanceCentral approvals for demo/dev environments.
 *
 * Spec §3 deletion plan moves the existing in-memory Map demo data out of
 * FinanceCentralService and into the DB via FinanceCentralRepository so the
 * dashboard reads the same source as the operator service. Calls are gated on
 * `NODE_ENV` so production starts never insert demo rows, and tests opt in by
 * exercising the repo directly.
 *
 * Idempotent: each row uses repo.insertIfMissing which ON CONFLICT DO NOTHING
 * on (tenant_id, approval_id). Restart-safe.
 */
export async function seedFinanceCentralDemoData(
  repo: FinanceCentralRepository,
  opts: { tenantId: string; logger?: Logger; nowMs?: number },
): Promise<{ inserted: number; skipped: number }> {
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'test') {
    return { inserted: 0, skipped: 0 };
  }

  const now = opts.nowMs ?? Date.now();
  const iso = (offsetDays: number): string =>
    new Date(now - offsetDays * DAY_MS).toISOString();

  const rows: Parameters<FinanceCentralRepository['insertIfMissing']>[0][] = [
    { tenantId: opts.tenantId, approvalId: 'appr-001', documentId: 'doc-appr-001', documentNumber: 'INV-2024-4521', documentType: 'invoice',         description: 'Monthly service invoice',          entityName: 'Supplier Corp',     amount: 45000,  currency: 'USD', submittedBy: 'jane.doe@company.com',     submittedAt: iso(2),   currentApprover: 'john.smith@company.com',         approvalLevel: 2, priority: 'medium' },
    { tenantId: opts.tenantId, approvalId: 'appr-002', documentId: 'doc-appr-002', documentNumber: 'PO-2024-892',   documentType: 'purchase_order',  description: 'Q1 hardware refresh',               entityName: 'Tech Parts LLC',    amount: 28000,  currency: 'USD', submittedBy: 'mike.jones@company.com',   submittedAt: iso(1),   currentApprover: 'jane.doe@company.com',           approvalLevel: 1, priority: 'high' },
    { tenantId: opts.tenantId, approvalId: 'appr-003', documentId: 'doc-appr-003', documentNumber: 'EXP-2024-156',  documentType: 'expense_report',  description: 'Client visit travel expenses',                                       employeeName: 'John Smith', amount: 2500,   currency: 'USD', submittedBy: 'john.smith@company.com',   submittedAt: iso(3),   currentApprover: 'finance@company.com',            approvalLevel: 1, priority: 'low' },
    { tenantId: opts.tenantId, approvalId: 'appr-004', documentId: 'doc-appr-004', documentNumber: 'BILL-2024-789', documentType: 'bill',            description: 'Office renovation final payment',  entityName: 'Construction Co',   amount: 125000, currency: 'USD', submittedBy: 'facilities@company.com',   submittedAt: iso(4),   currentApprover: 'cfo@company.com',                approvalLevel: 3, priority: 'high' },
    { tenantId: opts.tenantId, approvalId: 'appr-005', documentId: 'doc-appr-005', documentNumber: 'JE-2024-042',   documentType: 'journal_entry',   description: 'Month-end accrual adjustment',                                                                  amount: 35000,  currency: 'USD', submittedBy: 'accountant@company.com',   submittedAt: iso(1),   currentApprover: 'controller@company.com',         approvalLevel: 2, priority: 'medium' },
    { tenantId: opts.tenantId, approvalId: 'appr-006', documentId: 'doc-appr-006', documentNumber: 'PO-2024-893',   documentType: 'purchase_order',  description: 'Marketing campaign materials',      entityName: 'Print Services Inc', amount: 8500,  currency: 'USD', submittedBy: 'marketing@company.com',    submittedAt: iso(2),   currentApprover: 'marketing.director@company.com', approvalLevel: 1, priority: 'medium' },
    { tenantId: opts.tenantId, approvalId: 'appr-007', documentId: 'doc-appr-007', documentNumber: 'EXP-2024-157',  documentType: 'expense_report',  description: 'Conference attendance',                                                employeeName: 'Sarah Johnson', amount: 3200, currency: 'USD', submittedBy: 'sarah.johnson@company.com', submittedAt: iso(5),  currentApprover: 'hr@company.com',                 approvalLevel: 1, priority: 'low' },
    { tenantId: opts.tenantId, approvalId: 'appr-008', documentId: 'doc-appr-008', documentNumber: 'INV-2024-4522', documentType: 'invoice',         description: 'Software license renewal',          entityName: 'Software Vendor',   amount: 52000,  currency: 'USD', submittedBy: 'it@company.com',           submittedAt: iso(1),   currentApprover: 'cio@company.com',                approvalLevel: 2, priority: 'high' },
    { tenantId: opts.tenantId, approvalId: 'appr-009', documentId: 'doc-appr-009', documentNumber: 'BILL-2024-790', documentType: 'bill',            description: 'Quarterly insurance premium',      entityName: 'Insurance Corp',    amount: 18500,  currency: 'USD', submittedBy: 'admin@company.com',        submittedAt: iso(2),   currentApprover: 'finance@company.com',            approvalLevel: 1, priority: 'medium' },
    { tenantId: opts.tenantId, approvalId: 'appr-010', documentId: 'doc-appr-010', documentNumber: 'PO-2024-894',   documentType: 'purchase_order',  description: 'Emergency server replacement',     entityName: 'Dell Technologies', amount: 42000,  currency: 'USD', submittedBy: 'it@company.com',           submittedAt: iso(0.5), currentApprover: 'cio@company.com',                approvalLevel: 1, priority: 'urgent' },
    { tenantId: opts.tenantId, approvalId: 'appr-011', documentId: 'doc-appr-011', documentNumber: 'JE-2024-043',   documentType: 'journal_entry',   description: 'Intercompany transfer',                                                                          amount: 250000, currency: 'USD', submittedBy: 'controller@company.com',   submittedAt: iso(1),   currentApprover: 'cfo@company.com',                approvalLevel: 3, priority: 'high' },
    { tenantId: opts.tenantId, approvalId: 'appr-012', documentId: 'doc-appr-012', documentNumber: 'EXP-2024-158',  documentType: 'expense_report',  description: 'Team building event',                                                  employeeName: 'Mike Wilson',  amount: 4800,  currency: 'USD', submittedBy: 'mike.wilson@company.com',  submittedAt: iso(3),   currentApprover: 'hr@company.com',                 approvalLevel: 1, priority: 'low' },
  ];

  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const ok = await repo.insertIfMissing(row);
      if (ok) inserted += 1;
      else skipped += 1;
    } catch (err) {
      opts.logger?.warn('FinanceCentral demo seed row failed; continuing', {
        approval_id: row.approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  opts.logger?.info('FinanceCentral demo data seeded', {
    tenant_id: opts.tenantId,
    inserted,
    skipped,
  });

  return { inserted, skipped };
}
