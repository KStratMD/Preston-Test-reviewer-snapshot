import { inject, injectable } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { ConnectorManager } from '../../integration/ConnectorManager';
import type { ConfigurationService } from '../../ConfigurationService';
import type { IConnector } from '../../../interfaces/IConnector';
import type { DataRecord, AuthConfig, AuthenticationConfig, IntegrationConfig, SystemConfig } from '../../../types';
import { compareInvoices, type NormalizedInvoice, type ReconciliationDiscrepancy } from '../invoiceComparison';
import { toMinorUnits } from '../money';
import type { Reconciler, ReconcilerRunContext } from './Reconciler';
import { ReconcilerConfigError } from './Reconciler';

export const NETSUITE_BC_INVOICE_RECONCILER_KEY = 'netsuite_business_central_invoice_reconciliation';

/** Thrown when a fetched invoice lacks a required key/amount/currency field. */
export class MissingRequiredFieldError extends Error {
  readonly system: string;
  readonly recordId: string;
  readonly field: string;
  constructor(system: string, recordId: string, field: string) {
    super(`reconciliation: ${system} invoice ${recordId} is missing required field '${field}'`);
    this.name = 'MissingRequiredFieldError';
    this.system = system;
    this.recordId = recordId;
    this.field = field;
  }
}

/** Thrown when a tenant's connector cannot be resolved (null or throw). */
export class ReconcilerConnectorError extends Error {
  readonly systemType: string;
  readonly reason: string;
  constructor(systemType: string, reason: string) {
    super(`reconciliation: could not resolve ${systemType} connector (${reason})`);
    this.name = 'ReconcilerConnectorError';
    this.systemType = systemType;
    this.reason = reason;
  }
}

/**
 * Resolved, validated config for the NS<->BC reconciler — the return of this
 * handler's concrete validateConfig(). Handler-specific by design (NOT on the
 * generic Reconciler interface). Auth fields are non-null past validation
 * (validateConfig throws config_missing_auth otherwise).
 */
export interface ValidatedNetSuiteBusinessCentralConfig {
  config: IntegrationConfig;
  netsuiteAuth: AuthenticationConfig;
  businessCentralAuth: AuthenticationConfig;
}

// Connector registry keys (systemType) — these select the connector class via
// ConnectorManager.getConnector → getConnectorRegistration(systemType). They must
// match connectorRegistry.ts EXACTLY: Business Central's key is 'businesscentral'
// (no underscore). These are distinct from the human-readable system LABELS
// ('netsuite' / 'business_central') used on the persisted exception rows below.
const NETSUITE_SYSTEM_TYPE = 'netsuite';
const BUSINESS_CENTRAL_SYSTEM_TYPE = 'businesscentral';

/** Collapse the only alias that exists (business_central → businesscentral); pass netsuite through. NARROW by design — must not become a general normalizer. */
function canonicalSystemType(system: string | SystemConfig): string {
  const raw = (typeof system === 'string' ? system : system.type).toLowerCase();
  return raw === 'business_central' ? BUSINESS_CENTRAL_SYSTEM_TYPE : raw;
}

// Candidate field names per side. Passthrough normalization (mapCommonFields)
// preserves raw connector keys, so amounts survive list() under these names.
// Ordered; first present non-null wins. Strict: none present -> fail the run.
const NS_KEY_FIELDS = ['tranId', 'tranid', 'externalDocumentNumber'];
const NS_AMOUNT_FIELDS = ['amount', 'total', 'foreigntotal'];
const NS_CURRENCY_FIELDS = ['currency', 'currencyName'];
const BC_KEY_FIELDS = ['number', 'externalDocumentNumber', 'documentNumber'];
const BC_AMOUNT_FIELDS = ['totalAmountIncludingTax', 'amount', 'totalAmount'];
const BC_CURRENCY_FIELDS = ['currencyCode', 'currency'];

@injectable()
export class NetSuiteBusinessCentralInvoiceReconciler implements Reconciler {
  readonly key = NETSUITE_BC_INVOICE_RECONCILER_KEY;

  constructor(
    @inject(TYPES.ConnectorManager) private readonly connectorManager: ConnectorManager,
    @inject(TYPES.ConfigurationService) private readonly configurationService: ConfigurationService,
  ) {}

  validateConfig(ctx: ReconcilerRunContext): ValidatedNetSuiteBusinessCentralConfig {
    if (ctx.integrationConfigId == null) {
      throw new ReconcilerConfigError('missing_schedule_config_ref');
    }
    const config = this.configurationService.getConfigurationForTenant(ctx.tenantId, ctx.integrationConfigId);
    if (!config) throw new ReconcilerConfigError('config_not_found', ctx.integrationConfigId);

    const sourceCanon = canonicalSystemType(config.sourceSystem);
    const targetCanon = canonicalSystemType(config.targetSystem);
    const pair = new Set([sourceCanon, targetCanon]);
    if (!(pair.size === 2 && pair.has(NETSUITE_SYSTEM_TYPE) && pair.has(BUSINESS_CENTRAL_SYSTEM_TYPE))) {
      throw new ReconcilerConfigError('config_system_pair_mismatch', `${sourceCanon}+${targetCanon}`);
    }

    const sourceAuth = config.sourceAuthentication ?? config.authentication?.source;
    const targetAuth = config.targetAuthentication ?? config.authentication?.target;
    const netsuiteAuth = sourceCanon === NETSUITE_SYSTEM_TYPE ? sourceAuth : targetAuth;
    const businessCentralAuth = sourceCanon === BUSINESS_CENTRAL_SYSTEM_TYPE ? sourceAuth : targetAuth;
    if (!netsuiteAuth || !businessCentralAuth) {
      // Name the unconfigured side(s) so an operator at a partially-configured
      // tenant doesn't have to check both.
      const missing = [!netsuiteAuth && NETSUITE_SYSTEM_TYPE, !businessCentralAuth && BUSINESS_CENTRAL_SYSTEM_TYPE]
        .filter(Boolean)
        .join(', ');
      throw new ReconcilerConfigError('config_missing_auth', `missing: ${missing}`);
    }

    return { config, netsuiteAuth, businessCentralAuth };
  }

  async run(ctx: ReconcilerRunContext): Promise<ReconciliationDiscrepancy[]> {
    const { config, netsuiteAuth, businessCentralAuth } = this.validateConfig(ctx);

    const netsuite = await this.initConnector(NETSUITE_SYSTEM_TYPE, config.id, netsuiteAuth);
    const businessCentral = await this.initConnector(BUSINESS_CENTRAL_SYSTEM_TYPE, config.id, businessCentralAuth);

    const nsRecords = await netsuite.list('invoice', {});
    const bcRecords = await businessCentral.list('invoice', {});

    const source = nsRecords.map(r =>
      this.normalize(r, 'netsuite', NS_KEY_FIELDS, NS_AMOUNT_FIELDS, NS_CURRENCY_FIELDS),
    );
    const target = bcRecords.map(r =>
      this.normalize(r, 'business_central', BC_KEY_FIELDS, BC_AMOUNT_FIELDS, BC_CURRENCY_FIELDS),
    );

    return compareInvoices(source, target, {
      sourceSystem: 'netsuite',
      targetSystem: 'business_central',
      toleranceMinorUnits: 0,
    });
  }

  /** Resolve the connector (config-scoped systemId) and initialize it before use. */
  private async initConnector(systemType: string, configId: string, auth: AuthConfig): Promise<IConnector> {
    let connector: IConnector | null;
    try {
      connector = await this.connectorManager.getConnector(systemType, `${systemType}_${configId}`);
    } catch (err) {
      throw new ReconcilerConnectorError(systemType, err instanceof Error ? err.message : String(err));
    }
    if (!connector) throw new ReconcilerConnectorError(systemType, 'resolved to null');
    try {
      await connector.initialize(auth);
    } catch (err) {
      // Wrap init failure (bad creds / network) in the same typed error as a
      // resolve failure so the monitoring/metrics layer classifies both connector
      // problems uniformly rather than seeing a raw connector exception.
      throw new ReconcilerConnectorError(systemType, `initialize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return connector;
  }

  private normalize(
    record: DataRecord,
    system: string,
    keyFields: string[],
    amountFields: string[],
    currencyFields: string[],
  ): NormalizedInvoice {
    const fields = (record.fields && typeof record.fields === 'object' ? record.fields : record) as Record<
      string,
      unknown
    >;
    const recordId = String(record.id ?? record.externalId ?? '(unknown)');

    // When all candidates are absent the error names the FIRST (canonical)
    // candidate for each field — the per-field candidate lists are best-effort
    // raw connector key names, so the canonical name is the most useful signal.
    const keyRaw = pickField(fields, keyFields);
    if (keyRaw === undefined) throw new MissingRequiredFieldError(system, recordId, keyFields[0]);
    const currencyRaw = pickField(fields, currencyFields);
    if (typeof currencyRaw !== 'string' || currencyRaw.trim() === '') {
      throw new MissingRequiredFieldError(system, recordId, currencyFields[0]);
    }
    const amountRaw = pickField(fields, amountFields);
    const amountMajor = parseAmount(amountRaw);
    if (amountMajor === null) throw new MissingRequiredFieldError(system, recordId, amountFields[0]);

    const currency = currencyRaw.toUpperCase();
    return {
      key: String(keyRaw),
      amountMajor,
      amountMinorUnits: toMinorUnits(amountMajor, currency),
      currency,
    };
  }
}

function pickField(fields: Record<string, unknown>, candidates: string[]): unknown | undefined {
  for (const name of candidates) {
    const v = fields[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}
