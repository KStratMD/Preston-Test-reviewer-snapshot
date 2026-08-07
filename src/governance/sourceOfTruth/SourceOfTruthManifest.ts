/**
 * Source-of-Truth Manifest (PR 13).
 *
 * Declares which system owns each canonical entity that governed flows
 * write. Consumed by:
 *   - OwnershipResolver — runtime validation at FlowExecutor pre-flight
 *   - scripts/check-source-of-truth-coverage.mjs — CI gate
 *
 * Wedge claim: ownership is enforced on every governed-flow write via
 * OwnershipResolver. Direct connector writes (route handlers, sync jobs)
 * stay audited-but-not-policy-gated until PR 13b.
 */

/**
 * Canonical systems that can own (or read) an entity. Snake_case form;
 * registry-key normalization is explicit via SOURCE_SYSTEM_TO_CONNECTOR_KEY.
 * 'squire' maps to a real (demo-only) entry in CONNECTOR_REGISTRY for DI
 * parity; it can be targeted by FlowExecutor's connector contract check
 * like any other SourceSystem.
 */
export type SourceSystem =
  | 'netsuite'
  | 'business_central'
  | 'salesforce'
  | 'hubspot'
  | 'shipstation'
  | 'squire'
  | 'stripe'
  | 'shopify';

/**
 * Identities that can write to a connector. SourceSystems plus
 * non-connector caller identities (operator UI, automation, webhooks).
 * Kept parallel to SourceSystem so the manifest's owner: SourceSystem
 * constraint stays tight — operator_action can never be an owner.
 *
 * Consumed by guardedWrite, OwnershipResolver.validateWrite input,
 * and the WriteBlockedError subclass `detail` shapes.
 */
export type CallerSystem =
  | SourceSystem
  | 'operator_action'
  | 'sync_error_remediation'
  | 'webhook_relay'
  | 'integration_engine'     // IntegrationService + IntegrationExecutor
  | 'sync_orchestrator';     // SyncCentralOrchestrator

/**
 * Maps SourceSystem → ConnectorRegistry.key. Every SourceSystem maps to a
 * real CONNECTOR_REGISTRY entry. The CI gate validates each value
 * resolves to a real entry. Distinct from SourceSystem so the canonical
 * snake_case form survives the registry's run-together 'businesscentral'
 * key. The 'squire' mapping points at the demo-only SuiteCentral mock
 * connector entry that exists for DI parity. Future Squire-internal-only
 * sources that genuinely lack an IConnector will require a parallel
 * routing decision (not a null sentinel here).
 */
export const SOURCE_SYSTEM_TO_CONNECTOR_KEY: Record<SourceSystem, string> = {
  netsuite: 'netsuite',
  business_central: 'businesscentral',
  salesforce: 'salesforce',
  hubspot: 'hubspot',
  shipstation: 'shipstation',
  squire: 'squire',
  stripe: 'stripe',
  shopify: 'shopify',
};

/**
 * Canonical entities that governed flow templates may target. Adding an
 * entity is a manifest change AND a flow-template change — the CI gate
 * fails closed on any FlowTemplate.target.canonicalEntity that is not
 * declared here.
 */
export type CanonicalEntity =
  | 'customer'
  | 'contact'
  | 'vendor'
  | 'invoice'
  | 'payment'
  | 'payout_batch'
  | 'product'
  | 'inventory_level'
  | 'sales_order'
  | 'deal'
  | 'ticket';

/**
 * Frozen set of canonical-entity strings — kept in lockstep with the
 * `CanonicalEntity` union above. `isCanonicalEntity` is the only place
 * the literal list is repeated; growing the union here also requires
 * growing this set. Used by guardedWrite (and downstream) to discriminate
 * canonical entities from arbitrary connector-side record types flowing
 * through after Copilot R1 cluster-B widening.
 */
export const CANONICAL_ENTITIES: ReadonlySet<CanonicalEntity> = new Set<CanonicalEntity>([
  'customer',
  'contact',
  'vendor',
  'invoice',
  'payment',
  'payout_batch',
  'product',
  'inventory_level',
  'sales_order',
  'deal',
  'ticket',
]);

export function isCanonicalEntity(value: string): value is CanonicalEntity {
  return CANONICAL_ENTITIES.has(value as CanonicalEntity);
}

/**
 * Conflict-resolution policies. The first three are implemented this PR.
 * merge_field_level and queue_for_human are declared so future PRs extend
 * behavior without extending the type surface. The CI gate hard-fails on
 * any manifest entry using a deferred policy; OwnershipResolver throws
 * PolicyNotYetImplementedError at runtime as defense-in-depth.
 */
export type ConflictPolicy =
  | 'source_wins'
  | 'target_wins'
  | 'reject_with_alert'
  | 'merge_field_level'
  | 'queue_for_human';

export interface OwnershipDeclaration {
  entity: CanonicalEntity;
  owner: SourceSystem;
  consumers: SourceSystem[];
  fieldOverrides?: {
    fieldPath: string;
    owner: SourceSystem;
    rationale: string;
  }[];
  conflictPolicy: ConflictPolicy;
  conflictPolicyRationale: string;
  knownLoops?: {
    counterpart: SourceSystem;
    windowMs: number;
    breakingCondition: string;
  }[];
}

export const SOURCE_OF_TRUTH_MANIFEST: OwnershipDeclaration[] = [
  {
    entity: 'customer',
    owner: 'netsuite',
    consumers: ['salesforce', 'hubspot', 'shipstation', 'squire'],
    fieldOverrides: [
      {
        fieldPath: 'salesPipelineStage',
        owner: 'salesforce',
        rationale: 'Salesforce is the system of engagement; pipeline state lives there',
      },
      {
        fieldPath: 'marketingConsent.email',
        owner: 'hubspot',
        rationale: 'GDPR consent capture is HubSpot-side',
      },
    ],
    conflictPolicy: 'reject_with_alert',
    conflictPolicyRationale:
      'NetSuite is the financial source of truth; non-owner writes indicate data hygiene problem',
  },
  {
    entity: 'contact',
    owner: 'hubspot',
    consumers: ['netsuite', 'salesforce'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale:
      'HubSpot is the CRM system of engagement; NetSuite/Salesforce project contacts from CRM for billing and account management. Non-CRM writes lose to the HubSpot-side update on the next sync.',
  },
  {
    entity: 'vendor',
    owner: 'netsuite',
    consumers: ['business_central', 'shipstation'],
    conflictPolicy: 'reject_with_alert',
    conflictPolicyRationale: 'Vendor master data lives in the financial system of record',
  },
  {
    entity: 'invoice',
    owner: 'netsuite',
    consumers: ['business_central', 'stripe'],
    conflictPolicy: 'reject_with_alert',
    conflictPolicyRationale: 'Invoices are immutable financial records; non-owner mutations are data hygiene problems',
  },
  {
    entity: 'payment',
    owner: 'stripe',
    consumers: ['netsuite', 'business_central'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale: 'Stripe is the payment processor; ERPs are projections of authoritative payment state',
    knownLoops: [
      {
        counterpart: 'netsuite',
        windowMs: 60_000,
        breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      },
    ],
  },
  {
    entity: 'payout_batch',
    owner: 'squire',
    consumers: ['netsuite', 'business_central'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale: 'Squire is the system of record for payout events; ERPs are projections',
    knownLoops: [
      {
        counterpart: 'netsuite',
        windowMs: 60_000,
        breakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      },
    ],
  },
  {
    entity: 'product',
    owner: 'shopify',
    consumers: ['netsuite', 'business_central', 'shipstation'],
    conflictPolicy: 'target_wins',
    conflictPolicyRationale: 'Shopify is the product catalog; ERPs project for accounting and may override SKU-side fields',
  },
  {
    entity: 'inventory_level',
    owner: 'shipstation',
    consumers: ['netsuite', 'shopify'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale: 'ShipStation is closest to the warehouse; downstream systems should not overwrite shipped counts',
  },
  {
    entity: 'sales_order',
    owner: 'shopify',
    consumers: ['netsuite', 'shipstation'],
    conflictPolicy: 'reject_with_alert',
    conflictPolicyRationale: 'Sales orders carry customer commitments; only the storefront mutates them',
  },
  {
    entity: 'deal',
    owner: 'hubspot',
    consumers: ['netsuite'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale:
      'HubSpot is the CRM system of engagement; deals are owned there. NetSuite projects deals for revenue tracking. Non-CRM writes lose to the HubSpot-side update on the next sync.',
  },
  {
    entity: 'ticket',
    owner: 'hubspot',
    consumers: ['netsuite'],
    conflictPolicy: 'source_wins',
    conflictPolicyRationale:
      'HubSpot Service Hub owns ticket state. NetSuite may project tickets for case-related billing context. Non-Service-Hub writes lose to the HubSpot-side update.',
  },
];

/**
 * Runtime-narrowing type guard from the broader CallerSystem (13 members)
 * to the SourceSystem subset (8 members). Derived from the keys of
 * SOURCE_SYSTEM_TO_CONNECTOR_KEY so adding/removing a SourceSystem only
 * requires one edit (the Record's keys) — the set stays in sync with the
 * type by construction. Consumed by guardedWrite to skip detectLoop for
 * non-connector callers (operator_action, sync_error_remediation, etc.)
 * which can never participate in a reciprocal-write loop because lineage
 * events are keyed by SourceSystem.
 */
const SOURCE_SYSTEMS: ReadonlySet<SourceSystem> = new Set(
  Object.keys(SOURCE_SYSTEM_TO_CONNECTOR_KEY) as SourceSystem[],
);

export function isSourceSystem(c: CallerSystem): c is SourceSystem {
  return SOURCE_SYSTEMS.has(c as SourceSystem);
}
