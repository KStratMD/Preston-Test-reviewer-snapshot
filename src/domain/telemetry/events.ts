export interface TelemetryEvent {
  id: string;
  timestamp: number;
  type: string;
  flowId?: string;
  userId?: string;
  metadata: Record<string, unknown>;
}

export interface IntegrationFlowStartedEvent extends TelemetryEvent {
  type: 'IntegrationFlowStarted';
  flowId: string;
  sourceSystem: string;
  targetSystem: string;
  recordCount: number;
}

export interface IntegrationFlowCompletedEvent extends TelemetryEvent {
  type: 'IntegrationFlowCompleted';
  flowId: string;
  sourceSystem: string;
  targetSystem: string;
  recordCount: number;
  successCount: number;
  failureCount: number;
  durationMs: number;
}

export interface IntegrationFlowFailedEvent extends TelemetryEvent {
  type: 'IntegrationFlowFailed';
  flowId: string;
  sourceSystem: string;
  targetSystem: string;
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}

export interface DLQMessageCreatedEvent extends TelemetryEvent {
  type: 'DLQMessageCreated';
  flowId: string;
  messageId: string;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
  payloadSize: number;
}

export interface DLQMessageReplayedEvent extends TelemetryEvent {
  type: 'DLQMessageReplayed';
  flowId: string;
  messageId: string;
  success: boolean;
  retryCount: number;
}

export interface RetryScheduledEvent extends TelemetryEvent {
  type: 'RetryScheduled';
  flowId: string;
  messageId: string;
  retryCount: number;
  scheduleDelayMs: number;
  nextAttemptAt: number;
}

export interface MappingSuggestedEvent extends TelemetryEvent {
  type: 'MappingSuggested';
  flowId: string;
  sourceField: string;
  targetField: string;
  confidence: number;
  transformationType: string;
}

export interface MappingAcceptedEvent extends TelemetryEvent {
  type: 'MappingAccepted';
  flowId: string;
  sourceField: string;
  targetField: string;
  confidence: number;
  transformationType: string;
  userId: string;
}

export interface MappingRejectedEvent extends TelemetryEvent {
  type: 'MappingRejected';
  flowId: string;
  sourceField: string;
  suggestedTargetField: string;
  actualTargetField?: string;
  confidence: number;
  userId: string;
  reason?: string;
}

export interface MigrationJobStartedEvent extends TelemetryEvent {
  type: 'MigrationJobStarted';
  jobId: string;
  flowId: string;
  totalRecords: number;
  estimatedDurationMs: number;
}

export interface MigrationJobProgressEvent extends TelemetryEvent {
  type: 'MigrationJobProgress';
  jobId: string;
  flowId: string;
  processedRecords: number;
  totalRecords: number;
  successCount: number;
  failureCount: number;
}

export interface MigrationJobCompletedEvent extends TelemetryEvent {
  type: 'MigrationJobCompleted';
  jobId: string;
  flowId: string;
  totalRecords: number;
  successCount: number;
  failureCount: number;
  durationMs: number;
}

export interface MigrationJobFailedEvent extends TelemetryEvent {
  type: 'MigrationJobFailed';
  jobId: string;
  flowId: string;
  errorCode: string;
  errorMessage: string;
  processedRecords: number;
  totalRecords: number;
}

export interface AuditEvent extends TelemetryEvent {
  type: 'AuditEvent';
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  piiTouched: boolean;
  ip: string;
  userAgent: string;
  outcome: 'success' | 'failure';
}

export interface RateLimitHitEvent extends TelemetryEvent {
  type: 'RateLimitHit';
  flowId: string;
  connector: string;
  endpoint: string;
  currentRate: number;
  limitThreshold: number;
  backoffMs: number;
}

export interface PaymentReconciliationEvent extends TelemetryEvent {
  type: 'PaymentReconciliation';
  processor: string;
  transactionId: string;
  netsuiteRecordId?: string;
  amount: number;
  currency: string;
  status: 'matched' | 'variance' | 'unmatched';
  varianceAmount?: number;
}

export type AllTelemetryEvents =
  | IntegrationFlowStartedEvent
  | IntegrationFlowCompletedEvent
  | IntegrationFlowFailedEvent
  | DLQMessageCreatedEvent
  | DLQMessageReplayedEvent
  | RetryScheduledEvent
  | MappingSuggestedEvent
  | MappingAcceptedEvent
  | MappingRejectedEvent
  | MigrationJobStartedEvent
  | MigrationJobProgressEvent
  | MigrationJobCompletedEvent
  | MigrationJobFailedEvent
  | AuditEvent
  | RateLimitHitEvent
  | PaymentReconciliationEvent;