/**
 * sampleHubSpotToNetSuiteContact — the reference template for FlowExecutor.
 *
 * Why this one ships as the PR 14 sample:
 *   - HubSpot and NetSuite are both production-tier connectors in the
 *     registry, so the dispatch path is realistic and not gated on a future
 *     beta-to-production promotion.
 *   - Contact records carry name + email (DLP-recognised PII), so the
 *     governance branch (approve / queue / block) is exercised by realistic
 *     data without contrived fixtures.
 *   - Single-row `create` operation — matches the narrow PR 14 scope.
 *
 * The three production templates promised by the merged remediation plan
 * (Squire→NS OTC create, HubSpot→NS PTP create, Squire→NS Payouts
 * bulk_upsert) land in PR 14b alongside Lineage (PR 12) and Ownership
 * (PR 13) integration. This sample exists today so FlowExecutor + the
 * CI gate have a real consumer to walk end-to-end.
 */

import type { FlowContext, FlowTemplate, ValidationResult } from '../FlowTemplate';

/**
 * Shape of a HubSpot contact-created webhook event, narrowed to the fields the
 * transform actually reads. HubSpot's real payload is wider; the template
 * deliberately ignores fields outside this minimum set so a future field
 * addition on the HubSpot side does not implicitly change the target write.
 */
export interface HubSpotContactEvent {
  eventId: string;
  occurredAt: string;
  contact: {
    id: string;
    properties: {
      email?: string;
      firstname?: string;
      lastname?: string;
      company?: string;
      phone?: string;
    };
  };
}

/**
 * Shape of the NetSuite Contact record assembled by the transform.
 * Index signature satisfies FlowTemplate's `TTargetRecord extends Record<string, unknown>`
 * generic bound — fields above are documentation for readers; the
 * connector consumes the value as `DataRecord`.
 */
export interface NetSuiteContactRecord extends Record<string, unknown> {
  externalId: string;
  email: string;
  firstName: string;
  lastName: string;
  companyName: string;
  phone: string;
}

export const sampleHubSpotToNetSuiteContact: FlowTemplate<HubSpotContactEvent, NetSuiteContactRecord> = {
  id: 'sample-hubspot-to-netsuite-contact-v1',
  category: 'master_data_sync',
  version: '1.0.0',

  source: { system: 'hubspot', eventType: 'contact.created' },
  target: { system: 'netsuite', recordType: 'Contact', operation: 'create' },

  description:
    'Sample governed flow — propagate a HubSpot contact creation event to NetSuite as a Contact record. ' +
    'Exists to exercise FlowExecutor end-to-end against real production-tier connectors. The three ' +
    'production templates (OTC, PTP, Payouts) ship in PR 14b alongside Lineage + Ownership integration.',

  governanceCallouts: [
    'PII (email, firstName, lastName, phone) is DLP-scanned before the NetSuite write — high-risk PII triggers the HITL approval queue (PR 3A/3B/3C).',
    'No customer auto-creation — Contact records are independent in this sample. PR 14b will wire ownership-aware customer matching.',
    'Lineage hops not yet recorded (PR 12). Audit trail is OutboundGovernanceService.auditMetadata only.',
  ],

  async transform(event: HubSpotContactEvent, _ctx: FlowContext): Promise<NetSuiteContactRecord> {
    const p = event.contact.properties;
    return {
      externalId: `hubspot:${event.contact.id}`,
      email: p.email ?? '',
      firstName: p.firstname ?? '',
      lastName: p.lastname ?? '',
      companyName: p.company ?? '',
      phone: p.phone ?? '',
    };
  },

  async validate(record: NetSuiteContactRecord, _ctx: FlowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!record.email && !record.lastName) {
      errors.push('contact must have either email or lastName to be writable to NetSuite');
    }
    return { ok: errors.length === 0, errors };
  },

  riskClassification(record: NetSuiteContactRecord): 'low' | 'medium' | 'high' {
    // Contact records carry PII; route through governance with a medium hint
    // so OutboundGovernanceService's DLP scan can override upward to 'high'
    // when high-severity findings appear.
    return record.email || record.phone ? 'medium' : 'low';
  },

  retryPolicy: {
    maxAttempts: 3,
    backoffMs: 1000,
    idempotencyKey: (event: unknown) => {
      // PR 14 narrowed: the executor doesn't read this yet. The CI gate
      // verifies the key shape — present, callable, derives from event.
      const e = event as HubSpotContactEvent;
      return `hubspot-contact:${e.contact.id}:${e.eventId}`;
    },
  },
};
