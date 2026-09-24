/**
 * Embedded ERP Surface Contract — typed shape shared by host and guest.
 *
 * See docs/architecture/embedded-erp-surface-contract.md and
 * docs/adr/ADR-018-embedded-erp-surface-contract.md for the canonical spec.
 *
 * This file is the single source of truth for the contract types. Any change
 * here is a contract-level change and must be reflected in the architecture
 * doc + ADR-018, plus a re-stamp of any adapter conformance tests in
 * tests/playwright/embedded/adapter-conformance.spec.ts (added by PR 10b).
 */

export type EmbeddedPlatform = 'netsuite' | 'business_central' | 'standalone';

export type EmbeddedModule =
  | 'reconciliation'
  | 'lineage'
  | 'approvals'
  | 'sync_health'
  | 'compliance'
  | 'flow_templates'
  | 'sync_error_triage';

export interface EmbeddedErpRecord {
  type: string;
  id: string;
  url?: string;
}

export interface EmbeddedContext {
  // Identity
  tenantId: string;
  userId: string;
  userRoles: string[];
  // Platform
  platform: EmbeddedPlatform;
  platformAccountId?: string;
  // ERP record context (when launched from a record page)
  erpRecord?: EmbeddedErpRecord;
  // Session
  sessionId: string;
  sessionExpiresAt: string; // ISO 8601
  // postMessage gating
  expectedHostOrigin: string;
  csrfToken: string;
}

export interface EmbeddedNavigationEntry {
  module: EmbeddedModule;
  label: string;
  href: string;
  requiredRoles: string[];
}
