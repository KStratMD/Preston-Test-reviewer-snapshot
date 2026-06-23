import type { PIIFinding } from './DLPService';

// Single source of truth for outbound PII risk taxonomy. The set membership
// (HIGH_RISK_PII / MEDIUM_RISK_PII) is what `classifyFindingsRisk` returns;
// `f.severity` only escalates to HIGH (for `critical`/`high`). Mid-tier
// (`medium`) severities alone never promote a finding's bucket — types
// outside MEDIUM_RISK_PII stay LOW even with severity='medium', so
// `email`/`ip_address` don't trip the HITL queue. Drift here changes that
// contract directly; co-located regression tests in
// tests/unit/services/security/findingsRiskClassifier.test.ts pin the
// matrix end-to-end.
const HIGH_RISK_PII: ReadonlySet<string> = new Set([
  'ssn',
  'credit_card',
  'bank_account',
  'medical_record_number',
  'passport',
  'drivers_license',
  'api_key',
  'jwt_token',
]);

const MEDIUM_RISK_PII: ReadonlySet<string> = new Set([
  'phone',
  'phone_intl',
  'date_of_birth',
  'name',
]);

export function classifyFindingsRisk(findings: readonly PIIFinding[]): 'none' | 'low' | 'medium' | 'high' {
  if (findings.length === 0) return 'none';
  if (findings.some(f => HIGH_RISK_PII.has(f.type) || f.severity === 'critical' || f.severity === 'high')) {
    return 'high';
  }
  if (findings.some(f => MEDIUM_RISK_PII.has(f.type))) {
    return 'medium';
  }
  return 'low';
}
