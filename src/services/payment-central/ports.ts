import type { PaymentProcessor, PaymentTransaction } from '../../types/paymentCentral';

export interface ProcessorReader {
  getProcessorById(id: string): PaymentProcessor | undefined;
  listProcessors(): readonly PaymentProcessor[];
}

export interface TransactionReader {
  getTransactionById(id: string): PaymentTransaction | undefined;
  listTransactions(): readonly PaymentTransaction[];
}
