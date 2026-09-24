import type { ReconciliationCadence } from './cadence';

export type ReconciliationExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ReconciliationExceptionStatus = 'open' | 'assigned' | 'resolved' | 'dismissed';

export interface NewReconciliationException {
  tenantId: string;
  sourceSystem: string;
  targetSystem: string;
  sourceRecordId: string;
  targetRecordId?: string | null;
  exceptionType: string;
  severity: ReconciliationExceptionSeverity;
  amountDelta?: number | null;
  currency?: string | null;
  description: string;
  suggestedAction: string;
  assignedTo?: string | null;
  dueAt?: string | null;
}

export interface ReconciliationExceptionView {
  id: string;
  tenantId: string;
  sourceSystem: string;
  targetSystem: string;
  sourceRecordId: string;
  targetRecordId: string | null;
  exceptionType: string;
  severity: ReconciliationExceptionSeverity;
  status: ReconciliationExceptionStatus;
  amountDelta: number | null;
  currency: string | null;
  description: string;
  suggestedAction: string;
  assignedTo: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationScheduleTick {
  schedulesRun: number;
  exceptionsCreated: number;
  /** Orphaned `running` run rows reclaimed to `failed` by the step-0 TTL sweep this tick. */
  staleRunsReclaimed: number;
}

export interface NewReconciliationScheduleInput {
  tenantId: string;
  name: string;
  cadence: ReconciliationCadence;
  handlerKey: string;
  integrationConfigId: string;
}

/** Partial schedule mutation. handlerKey is immutable (omit it). Only provided fields change. */
export interface UpdateReconciliationScheduleInput {
  name?: string;
  cadence?: ReconciliationCadence;
  active?: boolean;
  integrationConfigId?: string;
}

export interface ReconciliationScheduleView {
  id: string;
  tenantId: string;
  name: string;
  cadence: ReconciliationCadence;
  handlerKey: string;
  active: boolean;
  nextRunAt: string;
  integrationConfigId: string;
  createdAt: string;
  updatedAt: string;
}
