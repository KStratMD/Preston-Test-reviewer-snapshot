/**
 * Canonical Connector Registry — single source-of-truth for every connector
 * shipped in this repo, AND the canonical wiring for connectors that have a
 * `factory` closure: `ConnectorManager` and `inversify.config.ts` both consume
 * the per-entry `factory(systemId, deps)` closure to build those instances.
 *
 * Two intentional exceptions still hand-roll their own `new` calls:
 *   - `SquireConnector` (DI-only) — bound directly in `inversify.config.ts`;
 *     not reachable through `ConnectorManager.createConnector()` by design.
 *   - `SuiteCentralConnectorProd` (DI-only) — bound directly in
 *     `inversify.config.ts`; constructed per-operation by
 *     `src/services/suitecentral/controlPlane/SuiteCentralConnectorFactory.ts`.
 * Both lack a registry `factory` closure, so the wiring-drift gate exempts
 * them. Every other connector either has a `factory` closure here (in which
 * case the gate forbids `new` outside this file) or has no production
 * instantiation path at all (the demo-only connectors with no DI binding).
 *
 * Why this file exists: before the registry, "what connectors do we have?"
 * required cross-referencing four locations (`ConnectorManager.createConnector()`
 * switch, `inversify.config.ts` bindings, `src/connectors/*Connector.ts` AST
 * scan, proof-card directory listing). Each drifted at its own pace. The
 * registry collapses *ownership* of the connector list to one declarative file.
 *
 * What the audit gate (`audit-status-claims --check-wired-connectors`)
 * enforces today (PR 6A + 6A-2):
 *   - registry ↔ source-AST ↔ proof-card consistency (PR 6A);
 *   - every connector class file has a registry entry, every registry entry
 *     references a real connector source file, productionStatus and
 *     proofCardPath agree between class and registry, registry-declared keys
 *     and classNames are unique and well-shaped (PR 6A);
 *   - **wiring drift** (PR 6A-2): any connector class that has a registry
 *     `factory` closure is instantiated only inside this file. A
 *     `new <Name>Connector(` anywhere else under `src/` fails CI (tests and
 *     `scripts/` are exempt — see `WIRING_SCAN_DIRS` in
 *     `scripts/lib/connector-scan.mjs`). The gate also catches aliased
 *     imports (`new NS(...)` from `import { NetSuiteConnector as NS }`) and
 *     namespace member access (`new c.NetSuiteConnector(...)`).
 *   - the `factory` field's *value* must be an inline callable expression
 *     — an arrow function or a function expression. Bare identifiers
 *     (`factory: makeFactory` referring to a top-level function declaration)
 *     are intentionally rejected; the contract expects an inline closure
 *     so reviewers can see the constructor pattern at the point of
 *     declaration. A stale `factory: undefined` also fails the audit.
 *
 * Adding connector #19: see AGENTS.md → "How to add connector #19" — the only
 * mandatory touchpoint is this file (one new entry).
 */
import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import type { AuthService } from '../services/AuthService';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

import { AdyenConnector } from './AdyenConnector';
import { BusinessCentralConnector } from './BusinessCentralConnector';
import { DynamicsConnector } from './DynamicsConnector';
import { HubSpotConnector } from './HubSpotConnector';
import { NetSuiteConnector } from './NetSuiteConnector';
import { OracleConnector } from './OracleConnector';
import { PayPalConnector } from './PayPalConnector';
import { PayQuickerConnector } from './PayQuickerConnector';
import { SAPConnector } from './SAPConnector';
import { SalesforceConnector } from './SalesforceConnector';
import { SampleTypedConnector } from './SampleTypedConnector';
import { ShipStationConnector } from './ShipStationConnector';
import { ShopifyConnector } from './ShopifyConnector';
import { SquireConnector } from './SquireConnector';
import { StripeConnector } from './StripeConnector';
import { SuiteCentralConnector } from './SuiteCentralConnector';
import { SuiteCentralConnectorProd } from './SuiteCentralConnectorProd';
import { SuiteCentralProductionConnector } from './SuiteCentralProductionConnector';

/**
 * Production-readiness tier. Mirrors the `static readonly productionStatus`
 * field on each connector class — `audit-status-claims --check-wired-connectors`
 * fails CI if the registry value disagrees with the class field.
 *
 * Note on naming: the spec in `docs/plans/2026-05-01-a-grade-remediation-plan-merged.md`
 * uses the shorthand `'demo'`; the codebase has shipped `'demo_only'` since
 * Phase 3 (PR #692). Registry preserves `'demo_only'` to avoid a churn-only
 * rename across 11 connector classes + audit scripts + metrics. PR 6B (variant
 * cleanup) is the natural place to revisit if the rename is wanted.
 */
export type ProductionStatus = 'production' | 'beta' | 'demo_only' | 'stub';

/**
 * Bulk-write rollback semantics — declared per connector. Consumed by PR 14's
 * `FlowExecutor` when dispatching `target.operation === 'bulk_upsert'`.
 *
 * - `transactional`: connector wraps the batch in a single transaction;
 *   partial-failure → full rollback at the connector layer.
 * - `compensating`: connector applies rows one-by-one; on partial failure,
 *   `FlowExecutor` invokes per-row revert via the connector's
 *   `compensateRow()` method (PR 14 contract).
 * - `unsupported`: connector does not expose a bulk-write method; flow
 *   templates may not target it with `bulk_upsert`.
 *
 * Today (PR 6A + 6A-2) every connector is `'unsupported'` — `bulkUpsert`
 * itself is a PR 14 deliverable. PR 14 will revise registry entries as bulk
 * paths land.
 */
export type BulkRollbackStrategy = 'transactional' | 'compensating' | 'unsupported';

/**
 * Dependencies a connector factory closure may need. Threaded by
 * `ConnectorManager.createConnector()` and by `inversify.config.ts` DI
 * bindings; closures take only what they use. The fields are deliberately
 * minimal — connectors that need additional services resolve them through
 * `AuthService` (credentials) or are instantiated on routes that have access
 * to the wider DI container.
 */
export interface ConnectorDeps {
  logger: Logger;
  authService: AuthService;
  outboundGovernance: OutboundGovernanceService;
}

export interface ConnectorRegistration {
  /**
   * Stable connector identifier used in routes, sync configs, and AuthService
   * keys. Lowercase ASCII; underscores allowed for variant-key disambiguation
   * (e.g. `suitecentral_prod` vs `suitecentral_production`). Must be unique.
   */
  key: string;
  /** Class name (matches the source file basename and the exported class). */
  className: string;
  /**
   * Class reference for direct inspection. The registry-vs-AST cross-check in
   * `audit-status-claims --check-wired-connectors` confirms each className
   * matches its file's actual exported class.
   *
   * The constructor signature varies across connectors — that variance is
   * encapsulated in the per-entry `factory` closure below. We type as
   * `new (...args: unknown[]) => IConnector` rather than spec'ing a unified
   * shape; `unknown[]` is materially safer than `any[]` (forbids implicit
   * truthy-assignment of misshaped args at call sites).
   */
  classRef: new (...args: unknown[]) => IConnector;
  /** Production-readiness tier — must match the class's `static productionStatus`. */
  productionStatus: ProductionStatus;
  /**
   * Repo-relative path to the proof card under `docs/review/proof-cards/`.
   * Required for `productionStatus === 'production'` (the same gate enforced
   * on `static readonly proofCard` by `audit-status-claims`).
   */
  proofCardPath?: string;
  /**
   * Doc-form credential requirements — the conceptual list of fields the
   * connector needs at `initialize()` time. Used in onboarding docs and the
   * future production-readiness checklist. Not literal `process.env` reads;
   * connectors resolve credentials through `AuthService` /
   * `SecureCredentialManager`. Empty array for demo-only / stub connectors
   * that have no real auth path.
   */
  credentialRequirements: string[];
  /**
   * Closure that builds an instance of this connector. When set, this is the
   * canonical wiring: `ConnectorManager.createConnector()` and any DI binding
   * for this connector both call into this closure. When absent, the
   * connector is unreachable through `ConnectorManager` (its DI binding, if
   * any, must instantiate it directly — see the Squire and
   * SuiteCentralConnectorProd entries for the only two such cases today).
   *
   * `systemId` is the runtime instance id (passed through from the caller —
   * `ConnectorManager` derives it from the integration config; DI bindings
   * hardcode a constant). Closures that don't use it (e.g. HubSpot,
   * ShipStation, which derive their identity inside the class) ignore the
   * parameter; the type signature still requires it for symmetry.
   */
  factory?: (systemId: string, deps: ConnectorDeps) => IConnector;
  /**
   * Whether `inversify.config.ts` binds this connector under a
   * `TYPES.<Name>Connector` symbol. Most production paths can run without DI
   * (HTTP routes use `ConnectorManager` directly); DI is mainly for cross-
   * service injection where a singleton connector is convenient. This stays
   * a declared boolean: DI bindings retain hand-rolled wrapping concerns
   * (`wrapWithDecorator`, `TYPES.<Name>` symbol) that aren't generic enough
   * to derive from the registry shape alone.
   */
  diBindingAvailable: boolean;
  /** Bulk-write semantics — see `BulkRollbackStrategy` doc. */
  bulkRollbackStrategy: BulkRollbackStrategy;
  /** Free-form note: legacy naming exception, mock-only path, etc. */
  notes?: string;
}

/**
 * The 18-connector source-of-truth list. Sorted alphabetically by `key` for
 * stable diff comparison. The audit gate fails CI if:
 *   - any `<Name>Connector.ts` file lacks a matching registry entry,
 *   - any registry entry references a non-existent file,
 *   - `productionStatus` disagrees with the class's `static productionStatus`,
 *   - a `'production'` entry has no `factory` closure or no proof card,
 *   - duplicate keys exist (uniqueness invariant),
 *   - any connector class with a `factory` closure is instantiated outside
 *     this file (`new XxxConnector(`).
 *
 * Adding connector #19 is documented in AGENTS.md.
 */
export const CONNECTOR_REGISTRY: readonly ConnectorRegistration[] = [
  {
    key: 'adyen',
    className: 'AdyenConnector',
    classRef: AdyenConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real Adyen API scaffolding present; demo fallback when isDemoMode() / isTestEnvironment(). DI binding commented out in inversify.config.ts.',
  },
  {
    key: 'businesscentral',
    className: 'BusinessCentralConnector',
    classRef: BusinessCentralConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'production',
    proofCardPath: 'docs/review/proof-cards/business-central-connector.md',
    credentialRequirements: ['BC_TENANT_ID', 'BC_CLIENT_ID', 'BC_CLIENT_SECRET', 'BC_ENVIRONMENT'],
    factory: (systemId, deps) =>
      new BusinessCentralConnector(systemId, deps.logger, deps.authService, deps.outboundGovernance),
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
  },
  {
    key: 'dynamics',
    className: 'DynamicsConnector',
    classRef: DynamicsConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    factory: (systemId, deps) => new DynamicsConnector(systemId, deps.logger, deps.authService),
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real Dynamics 365 Web API v9.2 scaffolding; demo fallback when isDemoMode() or demoCredentials.',
  },
  {
    key: 'hubspot',
    className: 'HubSpotConnector',
    classRef: HubSpotConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'production',
    proofCardPath: 'docs/review/proof-cards/hubspot-connector.md',
    credentialRequirements: ['HUBSPOT_API_KEY'],
    factory: (_systemId, deps) => new HubSpotConnector(deps.logger, deps.outboundGovernance),
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Auth resolved during initialize() lifecycle; constructor takes (logger, outboundGovernance) — different shape from BC/NetSuite/Salesforce. systemId is unused.',
  },
  {
    key: 'netsuite',
    className: 'NetSuiteConnector',
    classRef: NetSuiteConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'production',
    proofCardPath: 'docs/review/proof-cards/netsuite-connector.md',
    credentialRequirements: [
      'NETSUITE_ACCOUNT_ID',
      'NETSUITE_CONSUMER_KEY',
      'NETSUITE_CONSUMER_SECRET',
      'NETSUITE_TOKEN_ID',
      'NETSUITE_TOKEN_SECRET',
    ],
    factory: (systemId, deps) =>
      new NetSuiteConnector(systemId, deps.logger, deps.authService, deps.outboundGovernance),
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'OAuth1 HMAC-SHA256 via src/utils/oauth1Helper.ts; tested against sandbox TSTDRV2698307.',
  },
  {
    key: 'oracle',
    className: 'OracleConnector',
    classRef: OracleConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'beta',
    proofCardPath: 'docs/review/proof-cards/oracle-connector.md',
    credentialRequirements: ['ORACLE_ORDS_BASE_URL', 'ORACLE_USERNAME', 'ORACLE_PASSWORD'],
    factory: (systemId, deps) => new OracleConnector(systemId, deps.logger, deps.authService, deps.outboundGovernance),
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'ORDS REST scaffolding; basic CRUD only — needs broader API depth before promotion to production. Constructor takes (systemId, logger, authService, outboundGovernance).',
  },
  {
    key: 'paypal',
    className: 'PayPalConnector',
    classRef: PayPalConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real PayPal REST API OAuth2 scaffolding; demo fallback. DI binding commented out in inversify.config.ts.',
  },
  {
    key: 'payquicker',
    className: 'PayQuickerConnector',
    classRef: PayQuickerConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'stub',
    proofCardPath: 'docs/review/proof-cards/payquicker-connector.md',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Explicit stub: authenticate() throws "not yet implemented"; CRUD methods return demo stubs.',
  },
  {
    key: 'salesforce',
    className: 'SalesforceConnector',
    classRef: SalesforceConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'production',
    proofCardPath: 'docs/review/proof-cards/salesforce-connector.md',
    credentialRequirements: [
      'SALESFORCE_USERNAME',
      'SALESFORCE_PASSWORD',
      'SALESFORCE_CLIENT_ID',
      'SALESFORCE_CLIENT_SECRET',
    ],
    factory: (systemId, deps) =>
      new SalesforceConnector(systemId, deps.logger, deps.authService, deps.outboundGovernance),
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'OAuth2 ROPC against Salesforce REST API; no inversify binding (used through ConnectorManager).',
  },
  {
    key: 'sample',
    className: 'SampleTypedConnector',
    classRef: SampleTypedConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Template/scaffold demonstrating type-safe MockConnectorBase; in-process mock against fictitious api.sample.com.',
  },
  {
    key: 'sap',
    className: 'SAPConnector',
    classRef: SAPConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    factory: (systemId, deps) => new SAPConnector(systemId, deps.logger, deps.authService),
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real SAP OData v2 scaffolding (Basic + ApiKey + X-CSRF-Token); demo fallback.',
  },
  {
    key: 'shipstation',
    className: 'ShipStationConnector',
    classRef: ShipStationConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'production',
    proofCardPath: 'docs/review/proof-cards/shipstation-connector.md',
    credentialRequirements: ['SHIPSTATION_API_KEY', 'SHIPSTATION_API_SECRET'],
    factory: (_systemId, deps) => new ShipStationConnector(deps.logger, deps.outboundGovernance),
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Auth resolved during initialize(); constructor takes (logger, outboundGovernance). systemId is unused.',
  },
  {
    key: 'shopify',
    className: 'ShopifyConnector',
    classRef: ShopifyConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    factory: (systemId, deps) => new ShopifyConnector(systemId, deps.logger),
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real Shopify Admin REST scaffolding (X-Shopify-Access-Token); shipped via DemoConnectorDecorator wrap.',
  },
  {
    key: 'squire',
    className: 'SquireConnector',
    classRef: SquireConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'In-process MockConnectorBase backed by JSON fixtures; no real HTTP path. DI-only — no factory closure (intentional: Squire is not reachable through ConnectorManager.createConnector); the inversify binding instantiates it directly.',
  },
  {
    key: 'stripe',
    className: 'StripeConnector',
    classRef: StripeConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real Stripe REST scaffolding (Bearer auth); demo fallback. DI binding commented out in inversify.config.ts.',
  },
  {
    key: 'suitecentral',
    className: 'SuiteCentralConnector',
    classRef: SuiteCentralConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    factory: (systemId, deps) =>
      new SuiteCentralConnector('SuiteCentral', systemId, deps.logger, deps.authService, undefined),
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'In-process MockConnectorBase backed by JSON fixtures; production NetSuite-native variant lives in SuiteCentralProductionConnector. Factory passes the systemType string explicitly so DI bindings (which previously hardcoded "suitecentral" as systemId) still produce a constructor-equivalent instance when they call entry.factory("suitecentral", deps); the 5th argument is the optional circuitBreakerOptions, left undefined.',
  },
  {
    key: 'suitecentral_prod',
    className: 'SuiteCentralConnectorProd',
    classRef: SuiteCentralConnectorProd as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: true,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Legacy *ConnectorProd.ts naming exception; bound at inversify.config.ts and constructed per-operation by src/services/suitecentral/controlPlane/SuiteCentralConnectorFactory.ts (PR-A6 retired the legacy suiteCentralProd router that previously used it). DI-only — no factory closure (not reachable through ConnectorManager.createConnector by design). PR 6B will consolidate the three SuiteCentral variants.',
  },
  {
    key: 'suitecentral_production',
    className: 'SuiteCentralProductionConnector',
    classRef: SuiteCentralProductionConnector as unknown as new (...args: unknown[]) => IConnector,
    productionStatus: 'demo_only',
    credentialRequirements: [],
    diBindingAvailable: false,
    bulkRollbackStrategy: 'unsupported',
    notes: 'Real SuiteCentral API scaffolding (Bearer + X-SuiteCentral-Tenant) for 6 modules; falls back to squireMockData when isProductionMode is false.',
  },
];

/**
 * Lookup by registry key. Returns `undefined` for unknown keys; callers
 * decide whether that's an error or expected (e.g., dynamic system types in
 * test fixtures).
 */
export function getConnectorRegistration(key: string): ConnectorRegistration | undefined {
  return CONNECTOR_REGISTRY.find((entry) => entry.key === key);
}

/** Returns all connector entries with `productionStatus === 'production'`. */
export function listProductionConnectors(): ConnectorRegistration[] {
  return CONNECTOR_REGISTRY.filter((entry) => entry.productionStatus === 'production');
}

/**
 * Returns all connector entries that expose a `factory` closure. Equivalent to
 * "reachable through `ConnectorManager.createConnector()`". Replaces the
 * previous `factoryAvailable: boolean` flag — the boolean is now derivable from
 * `factory !== undefined`, eliminating the "switch case removed but boolean
 * stale" failure mode.
 */
export function listFactoryWiredConnectors(): ConnectorRegistration[] {
  return CONNECTOR_REGISTRY.filter((entry) => entry.factory !== undefined);
}

/** Returns all connector entries with `diBindingAvailable === true`. */
export function listDIBoundConnectors(): ConnectorRegistration[] {
  return CONNECTOR_REGISTRY.filter((entry) => entry.diBindingAvailable);
}
