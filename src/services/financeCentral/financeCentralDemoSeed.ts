import type {
  GLAccount, FinancialDocument, BankAccountBalance, FinancialEntity,
} from '../FinanceCentralService';

export interface FinanceCentralStores {
  glAccounts: Map<string, GLAccount>;
  financialDocuments: Map<string, FinancialDocument>;
  bankAccounts: Map<string, BankAccountBalance>;
  entities: Map<string, FinancialEntity>;
}

/** Pure demo seed for one tenant. Pinning `nowMs` keeps aging/cash-flow deterministic. */
export function buildFinanceCentralSeed(args: { tenantId: string; nowMs: number }): FinanceCentralStores {
  const now = args.nowMs;
  const day = 24 * 60 * 60 * 1000;
  const glAccounts = new Map<string, GLAccount>();
  const financialDocuments = new Map<string, FinancialDocument>();
  const bankAccounts = new Map<string, BankAccountBalance>();
  const entities = new Map<string, FinancialEntity>();

  // Initialize GL Accounts
  const glAccountsData: GLAccount[] = [
    { id: 'gl-1000', accountNumber: '1000', name: 'Cash - Operating', type: 'asset', subType: 'cash', balance: 2450000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-1010', accountNumber: '1010', name: 'Cash - Payroll', type: 'asset', subType: 'cash', balance: 500000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-1020', accountNumber: '1020', name: 'Cash - Savings', type: 'asset', subType: 'cash', balance: 500000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-1100', accountNumber: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'receivable', balance: 1250000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-1200', accountNumber: '1200', name: 'Inventory', type: 'asset', subType: 'inventory', balance: 890000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-2000', accountNumber: '2000', name: 'Accounts Payable', type: 'liability', subType: 'payable', balance: 890000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-2100', accountNumber: '2100', name: 'Accrued Expenses', type: 'liability', subType: 'accrued', balance: 125000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-3000', accountNumber: '3000', name: 'Retained Earnings', type: 'equity', subType: 'retained', balance: 2500000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-4000', accountNumber: '4000', name: 'Revenue - Products', type: 'revenue', subType: 'sales', balance: 7500000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-4100', accountNumber: '4100', name: 'Revenue - Services', type: 'revenue', subType: 'services', balance: 1250000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-5000', accountNumber: '5000', name: 'Cost of Goods Sold', type: 'expense', subType: 'cogs', balance: 4500000, currency: 'USD', isActive: true, lastUpdated: now },
    { id: 'gl-6000', accountNumber: '6000', name: 'Operating Expenses', type: 'expense', subType: 'operating', balance: 1700000, currency: 'USD', isActive: true, lastUpdated: now },
  ];
  glAccountsData.forEach(account => glAccounts.set(account.id, account));

  // Initialize Bank Accounts
  const bankAccountsData: BankAccountBalance[] = [
    { accountId: 'bank-1', accountName: 'Main Operating Account', bankName: 'Chase Bank', accountType: 'checking', balance: 2450000, availableBalance: 2400000, currency: 'USD', lastUpdated: now },
    { accountId: 'bank-2', accountName: 'Payroll Account', bankName: 'Chase Bank', accountType: 'checking', balance: 500000, availableBalance: 500000, currency: 'USD', lastUpdated: now },
    { accountId: 'bank-3', accountName: 'Reserve Savings', bankName: 'Wells Fargo', accountType: 'savings', balance: 500000, availableBalance: 500000, currency: 'USD', lastUpdated: now },
    { accountId: 'bank-4', accountName: 'Line of Credit', bankName: 'Bank of America', accountType: 'credit_line', balance: 0, availableBalance: 500000, currency: 'USD', lastUpdated: now },
  ];
  bankAccountsData.forEach(account => bankAccounts.set(account.accountId, account));

  // Initialize Financial Documents (invoices and bills)
  const invoices: FinancialDocument[] = [
    // Current invoices
    { id: 'inv-001', type: 'invoice', documentNumber: 'INV-2024-001', entityId: 'cust-1', entityName: 'Acme Corp', entityType: 'customer', amount: 125000, amountPaid: 0, amountDue: 125000, currency: 'USD', issueDate: now - 10 * day, dueDate: now + 20 * day, status: 'open', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-002', type: 'invoice', documentNumber: 'INV-2024-002', entityId: 'cust-2', entityName: 'TechStart Inc', entityType: 'customer', amount: 85000, amountPaid: 0, amountDue: 85000, currency: 'USD', issueDate: now - 5 * day, dueDate: now + 25 * day, status: 'open', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-003', type: 'invoice', documentNumber: 'INV-2024-003', entityId: 'cust-3', entityName: 'Global Services', entityType: 'customer', amount: 240000, amountPaid: 100000, amountDue: 140000, currency: 'USD', issueDate: now - 15 * day, dueDate: now + 15 * day, status: 'partial', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    // 1-30 days overdue
    { id: 'inv-004', type: 'invoice', documentNumber: 'INV-2024-004', entityId: 'cust-4', entityName: 'Pacific Industries', entityType: 'customer', amount: 175000, amountPaid: 0, amountDue: 175000, currency: 'USD', issueDate: now - 45 * day, dueDate: now - 15 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-005', type: 'invoice', documentNumber: 'INV-2024-005', entityId: 'cust-5', entityName: 'Eastern Supply', entityType: 'customer', amount: 95000, amountPaid: 0, amountDue: 95000, currency: 'USD', issueDate: now - 50 * day, dueDate: now - 20 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-006', type: 'invoice', documentNumber: 'INV-2024-006', entityId: 'cust-6', entityName: 'Mountain Trading', entityType: 'customer', amount: 80000, amountPaid: 0, amountDue: 80000, currency: 'USD', issueDate: now - 55 * day, dueDate: now - 25 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    // 31-60 days overdue
    { id: 'inv-007', type: 'invoice', documentNumber: 'INV-2024-007', entityId: 'cust-7', entityName: 'Coastal Manufacturing', entityType: 'customer', amount: 150000, amountPaid: 0, amountDue: 150000, currency: 'USD', issueDate: now - 75 * day, dueDate: now - 45 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-008', type: 'invoice', documentNumber: 'INV-2024-008', entityId: 'cust-8', entityName: 'Summit Solutions', entityType: 'customer', amount: 100000, amountPaid: 0, amountDue: 100000, currency: 'USD', issueDate: now - 80 * day, dueDate: now - 50 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    // 61-90 days overdue
    { id: 'inv-009', type: 'invoice', documentNumber: 'INV-2024-009', entityId: 'cust-9', entityName: 'Valley Enterprises', entityType: 'customer', amount: 75000, amountPaid: 0, amountDue: 75000, currency: 'USD', issueDate: now - 105 * day, dueDate: now - 75 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-010', type: 'invoice', documentNumber: 'INV-2024-010', entityId: 'cust-10', entityName: 'River Industries', entityType: 'customer', amount: 50000, amountPaid: 0, amountDue: 50000, currency: 'USD', issueDate: now - 110 * day, dueDate: now - 80 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    // Over 90 days
    { id: 'inv-011', type: 'invoice', documentNumber: 'INV-2024-011', entityId: 'cust-11', entityName: 'Desert Tech', entityType: 'customer', amount: 45000, amountPaid: 0, amountDue: 45000, currency: 'USD', issueDate: now - 135 * day, dueDate: now - 105 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
    { id: 'inv-012', type: 'invoice', documentNumber: 'INV-2024-012', entityId: 'cust-12', entityName: 'Frozen Foods Inc', entityType: 'customer', amount: 30000, amountPaid: 0, amountDue: 30000, currency: 'USD', issueDate: now - 150 * day, dueDate: now - 120 * day, status: 'overdue', glAccountId: 'gl-1100', terms: 'Net 30', lineItems: [] },
  ];

  const bills: FinancialDocument[] = [
    // Current bills
    { id: 'bill-001', type: 'bill', documentNumber: 'BILL-2024-001', entityId: 'vend-1', entityName: 'Supplier Corp', entityType: 'vendor', amount: 95000, amountPaid: 0, amountDue: 95000, currency: 'USD', issueDate: now - 10 * day, dueDate: now + 20 * day, status: 'open', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-002', type: 'bill', documentNumber: 'BILL-2024-002', entityId: 'vend-2', entityName: 'Parts Unlimited', entityType: 'vendor', amount: 125000, amountPaid: 0, amountDue: 125000, currency: 'USD', issueDate: now - 8 * day, dueDate: now + 22 * day, status: 'open', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-003', type: 'bill', documentNumber: 'BILL-2024-003', entityId: 'vend-3', entityName: 'Tech Components', entityType: 'vendor', amount: 100000, amountPaid: 50000, amountDue: 50000, currency: 'USD', issueDate: now - 20 * day, dueDate: now + 10 * day, status: 'partial', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    // 1-30 days overdue
    { id: 'bill-004', type: 'bill', documentNumber: 'BILL-2024-004', entityId: 'vend-4', entityName: 'Industrial Supply', entityType: 'vendor', amount: 145000, amountPaid: 0, amountDue: 145000, currency: 'USD', issueDate: now - 45 * day, dueDate: now - 15 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-005', type: 'bill', documentNumber: 'BILL-2024-005', entityId: 'vend-5', entityName: 'Office Supplies Co', entityType: 'vendor', amount: 85000, amountPaid: 0, amountDue: 85000, currency: 'USD', issueDate: now - 50 * day, dueDate: now - 20 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-006', type: 'bill', documentNumber: 'BILL-2024-006', entityId: 'vend-6', entityName: 'Logistics Inc', entityType: 'vendor', amount: 50000, amountPaid: 0, amountDue: 50000, currency: 'USD', issueDate: now - 52 * day, dueDate: now - 22 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    // 31-60 days overdue
    { id: 'bill-007', type: 'bill', documentNumber: 'BILL-2024-007', entityId: 'vend-7', entityName: 'Equipment Rental', entityType: 'vendor', amount: 120000, amountPaid: 0, amountDue: 120000, currency: 'USD', issueDate: now - 78 * day, dueDate: now - 48 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-008', type: 'bill', documentNumber: 'BILL-2024-008', entityId: 'vend-8', entityName: 'IT Services LLC', entityType: 'vendor', amount: 60000, amountPaid: 0, amountDue: 60000, currency: 'USD', issueDate: now - 82 * day, dueDate: now - 52 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    // 61-90 days overdue
    { id: 'bill-009', type: 'bill', documentNumber: 'BILL-2024-009', entityId: 'vend-9', entityName: 'Marketing Agency', entityType: 'vendor', amount: 45000, amountPaid: 0, amountDue: 45000, currency: 'USD', issueDate: now - 108 * day, dueDate: now - 78 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-010', type: 'bill', documentNumber: 'BILL-2024-010', entityId: 'vend-10', entityName: 'Consulting Group', entityType: 'vendor', amount: 25000, amountPaid: 0, amountDue: 25000, currency: 'USD', issueDate: now - 112 * day, dueDate: now - 82 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    // Over 90 days
    { id: 'bill-011', type: 'bill', documentNumber: 'BILL-2024-011', entityId: 'vend-11', entityName: 'Legal Services', entityType: 'vendor', amount: 25000, amountPaid: 0, amountDue: 25000, currency: 'USD', issueDate: now - 140 * day, dueDate: now - 110 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
    { id: 'bill-012', type: 'bill', documentNumber: 'BILL-2024-012', entityId: 'vend-12', entityName: 'Old Vendor LLC', entityType: 'vendor', amount: 15000, amountPaid: 0, amountDue: 15000, currency: 'USD', issueDate: now - 155 * day, dueDate: now - 125 * day, status: 'overdue', glAccountId: 'gl-2000', terms: 'Net 30', lineItems: [] },
  ];

  [...invoices, ...bills].forEach(doc => financialDocuments.set(doc.id, doc));

  // Initialize Entities for multi-entity consolidation
  const entitiesData: FinancialEntity[] = [
    { id: 'ent-1', name: 'Parent Corp', type: 'subsidiary', currency: 'USD', isElimination: false },
    { id: 'ent-2', name: 'West Region', type: 'division', parentId: 'ent-1', currency: 'USD', isElimination: false },
    { id: 'ent-3', name: 'East Region', type: 'division', parentId: 'ent-1', currency: 'USD', isElimination: false },
    { id: 'ent-4', name: 'Eliminations', type: 'subsidiary', parentId: 'ent-1', currency: 'USD', isElimination: true },
  ];
  entitiesData.forEach(entity => entities.set(entity.id, entity));

  return { glAccounts, financialDocuments, bankAccounts, entities };
}
