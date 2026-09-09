import type { AuditLog } from '../../../database/types';
import { SYSTEM_IDENTITY } from '../../governance/identityContext';
import type {
  AuditContext,
  AuditEvent,
  AuditLog as AIAuditLog,
  AuditOutcome,
  ComplianceInfo,
  RetentionInfo,
} from './AuditService';

export interface AuditDlpPersistenceMetadata {
  approved: boolean;
  approvalRequired: boolean;
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  findings: string[];
  redacted: boolean;
  blocked: boolean;
  omittedRawDetails: boolean;
}

export interface PersistedAIAuditDetails {
  schemaVersion: 1;
  source: 'ai-orchestrator-audit-service';
  sessionId: string;
  event: AuditEvent;
  context: AuditContext;
  outcome: AuditOutcome;
  compliance: ComplianceInfo;
  retention: RetentionInfo;
  auditDlp: AuditDlpPersistenceMetadata;
}

const SOURCE = 'ai-orchestrator-audit-service';

export function buildPersistedAIAuditDetails(
  auditLog: AIAuditLog,
  auditDlp: AuditDlpPersistenceMetadata,
): PersistedAIAuditDetails {
  return {
    schemaVersion: 1,
    source: SOURCE,
    sessionId: auditLog.sessionId,
    event: auditLog.event,
    context: auditLog.context,
    outcome: auditLog.outcome,
    compliance: auditLog.compliance,
    retention: auditLog.retention,
    auditDlp,
  };
}

export function hydrateAIAuditLog(row: AuditLog): AIAuditLog {
  const details = row.details;
  const envelope = isPersistedAIAuditDetails(details) ? details : undefined;

  if (!envelope) {
    return hydrateFallbackAIAuditLog(row);
  }

  return {
    id: row.id,
    timestamp: toDate(row.created_at),
    sessionId: envelope.sessionId,
    userId: row.user_id === SYSTEM_IDENTITY.userId ? undefined : row.user_id,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    event: envelope.event,
    context: envelope.context,
    outcome: envelope.outcome,
    compliance: rehydrateCompliance(envelope.compliance),
    retention: rehydrateRetention(envelope.retention),
  };
}

function hydrateFallbackAIAuditLog(row: AuditLog): AIAuditLog {
  const success = row.result !== 'failure';
  return {
    id: row.id,
    timestamp: toDate(row.created_at),
    sessionId: row.resource_id,
    userId: row.user_id === SYSTEM_IDENTITY.userId ? undefined : row.user_id,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    event: {
      type: 'data_access',
      action: row.action,
      resource: row.resource_type,
      details: typeof row.details === 'object' && row.details !== null ? row.details as Record<string, unknown> : {},
    },
    context: {
      agents: [],
      cost: 0,
      executionTime: row.duration_ms ?? 0,
      dataClassification: 'internal',
    },
    outcome: {
      success,
      resultSummary: success ? 'Persisted audit log entry' : row.error_message ?? 'Persisted audit log failure',
      riskLevel: 'low',
      governanceFlags: [],
      errors: row.error_message ? [row.error_message] : [],
      warnings: [],
    },
    compliance: {
      regulation: ['Internal'],
      retentionRequired: true,
      encryptionRequired: false,
      anonymizationRequired: false,
      approvalRequired: false,
    },
    retention: {
      retentionPeriod: 90,
      purgeDate: new Date(toDate(row.created_at).getTime() + 90 * 24 * 60 * 60 * 1000),
      archiveRequired: false,
      legalHold: false,
    },
  };
}

function isPersistedAIAuditDetails(value: unknown): value is PersistedAIAuditDetails {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { schemaVersion?: unknown; source?: unknown };
  return candidate.schemaVersion === 1 && candidate.source === SOURCE;
}

export function isAIAuditRow(row: { details: object | null }): boolean {
  return isPersistedAIAuditDetails(row.details);
}

function rehydrateCompliance(value: ComplianceInfo): ComplianceInfo {
  return {
    ...value,
    approvalDate: value.approvalDate ? toDate(value.approvalDate) : undefined,
  };
}

function rehydrateRetention(value: RetentionInfo): RetentionInfo {
  return {
    ...value,
    purgeDate: toDate(value.purgeDate),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
