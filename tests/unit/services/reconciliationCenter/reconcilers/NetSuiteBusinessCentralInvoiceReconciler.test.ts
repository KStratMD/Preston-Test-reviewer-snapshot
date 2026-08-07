import {
  NetSuiteBusinessCentralInvoiceReconciler,
  MissingRequiredFieldError,
  ReconcilerConnectorError,
} from '../../../../../src/services/reconciliationCenter/reconcilers/NetSuiteBusinessCentralInvoiceReconciler';
import { ReconcilerConfigError } from '../../../../../src/services/reconciliationCenter/reconcilers/Reconciler';
import type { DataRecord } from '../../../../../src/types';

function connectorWith(records: DataRecord[]): { list: jest.Mock; initialize: jest.Mock } {
  return { list: jest.fn().mockResolvedValue(records), initialize: jest.fn().mockResolvedValue(undefined) };
}
function managerWith(ns: unknown, bc: unknown): { getConnector: jest.Mock } {
  return { getConnector: jest.fn((type: string) => Promise.resolve(type === 'netsuite' ? ns : bc)) };
}
function configServiceWith(config: unknown): { getConfigurationForTenant: jest.Mock } {
  return { getConfigurationForTenant: jest.fn().mockReturnValue(config) };
}
// Minimal IntegrationConfig-shaped object — the reconciler reads only these fields.
const makeConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'cfg_1',
  tenantId: 't1',
  sourceSystem: 'netsuite',
  targetSystem: 'businesscentral',
  sourceAuthentication: { type: 'oauth1' },
  targetAuthentication: { type: 'oauth2' },
  ...over,
});
const ctx = (over: Partial<{ tenantId: string; integrationConfigId: string | null }> = {}) => ({
  tenantId: 't1',
  integrationConfigId: 'cfg_1',
  ...over,
});

const nsInvoice = (tranId: string, amount: number, currency = 'USD'): DataRecord => ({
  id: tranId, fields: { tranId, amount, currency },
});
const bcInvoice = (number: string, amount: number, currency = 'USD'): DataRecord => ({
  id: number, fields: { number, totalAmountIncludingTax: amount, currencyCode: currency },
});
const make = (mgr: unknown, cfg: unknown) =>
  new NetSuiteBusinessCentralInvoiceReconciler(mgr as never, cfg as never);

describe('NetSuiteBusinessCentralInvoiceReconciler', () => {
  it('has the expected handler key', () => {
    const r = make(managerWith(connectorWith([]), connectorWith([])), configServiceWith(makeConfig()));
    expect(r.key).toBe('netsuite_business_central_invoice_reconciliation');
  });

  it('resolves the tenant config, initializes both connectors, then lists and compares', async () => {
    const ns = connectorWith([nsInvoice('INV-1', 120)]);
    const bc = connectorWith([bcInvoice('INV-1', 100)]);
    const cfg = configServiceWith(makeConfig());
    const r = make(managerWith(ns, bc), cfg);

    const out = await r.run(ctx());

    expect(cfg.getConfigurationForTenant).toHaveBeenCalledWith('t1', 'cfg_1');
    expect(ns.initialize).toHaveBeenCalledWith({ type: 'oauth1' });
    expect(bc.initialize).toHaveBeenCalledWith({ type: 'oauth2' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ exceptionType: 'amount_mismatch', sourceRecordId: 'INV-1', amountDelta: 20 });
  });

  it('resolves connectors by config-scoped systemIds (BC key = businesscentral, no underscore)', async () => {
    const mgr = managerWith(connectorWith([]), connectorWith([]));
    await make(mgr, configServiceWith(makeConfig())).run(ctx());
    expect(mgr.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_cfg_1');
    expect(mgr.getConnector).toHaveBeenCalledWith('businesscentral', 'businesscentral_cfg_1');
  });

  it('initializes each connector BEFORE listing from it (ordering — the behavioral core)', async () => {
    const ns = connectorWith([]);
    const bc = connectorWith([]);
    await make(managerWith(ns, bc), configServiceWith(makeConfig())).run(ctx());
    expect(ns.initialize.mock.invocationCallOrder[0]).toBeLessThan(ns.list.mock.invocationCallOrder[0]);
    expect(bc.initialize.mock.invocationCallOrder[0]).toBeLessThan(bc.list.mock.invocationCallOrder[0]);
  });

  it('maps auth by canonical system type even when source/target roles are reversed', async () => {
    const ns = connectorWith([]);
    const bc = connectorWith([]);
    const cfg = configServiceWith(makeConfig({
      sourceSystem: 'businesscentral', targetSystem: 'netsuite',
      sourceAuthentication: { type: 'bc-auth' }, targetAuthentication: { type: 'ns-auth' },
    }));
    await make(managerWith(ns, bc), cfg).run(ctx());
    expect(ns.initialize).toHaveBeenCalledWith({ type: 'ns-auth' });
    expect(bc.initialize).toHaveBeenCalledWith({ type: 'bc-auth' });
  });

  it('accepts the business_central alias and normalizes it to businesscentral', async () => {
    const mgr = managerWith(connectorWith([]), connectorWith([]));
    const cfg = configServiceWith(makeConfig({ targetSystem: 'business_central' }));
    await expect(make(mgr, cfg).run(ctx())).resolves.toEqual([]);
    expect(mgr.getConnector).toHaveBeenCalledWith('businesscentral', 'businesscentral_cfg_1');
  });

  it('resolves effective auth via the authentication.source/target fallback', async () => {
    const ns = connectorWith([]);
    const bc = connectorWith([]);
    const cfg = configServiceWith(makeConfig({
      sourceAuthentication: undefined, targetAuthentication: undefined,
      authentication: { source: { type: 'ns-nested' }, target: { type: 'bc-nested' } },
    }));
    await make(managerWith(ns, bc), cfg).run(ctx());
    expect(ns.initialize).toHaveBeenCalledWith({ type: 'ns-nested' });
    expect(bc.initialize).toHaveBeenCalledWith({ type: 'bc-nested' });
  });

  it('fails clean with missing_schedule_config_ref when integrationConfigId is null', async () => {
    const r = make(managerWith(connectorWith([]), connectorWith([])), configServiceWith(makeConfig()));
    // Assert the concrete typed error (not just any object carrying a reasonCode),
    // since callers/metrics discriminate on `instanceof ReconcilerConfigError`.
    const err = await r.run(ctx({ integrationConfigId: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcilerConfigError);
    expect((err as ReconcilerConfigError).reasonCode).toBe('missing_schedule_config_ref');
  });

  it('fails clean with config_not_found when the tenant config is missing', async () => {
    const r = make(managerWith(connectorWith([]), connectorWith([])), configServiceWith(undefined));
    const err = await r.run(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcilerConfigError);
    expect((err as ReconcilerConfigError).reasonCode).toBe('config_not_found');
  });

  it('fails clean with config_system_pair_mismatch for a non-NS/BC pairing', async () => {
    const cfg = configServiceWith(makeConfig({ sourceSystem: 'salesforce' }));
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    const err = await r.run(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcilerConfigError);
    expect((err as ReconcilerConfigError).reasonCode).toBe('config_system_pair_mismatch');
  });

  it('fails clean with config_missing_auth when one side has no effective auth', async () => {
    const cfg = configServiceWith(makeConfig({ targetAuthentication: undefined, authentication: undefined }));
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    const err = await r.run(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcilerConfigError);
    expect((err as ReconcilerConfigError).reasonCode).toBe('config_missing_auth');
    // names the unconfigured side(s) for operator debugging
    expect((err as Error).message).toMatch(/businesscentral/);
  });

  it('canonicalizes a SystemConfig object (not just a string) for the system pair', async () => {
    const mgr = managerWith(connectorWith([]), connectorWith([]));
    const cfg = configServiceWith(makeConfig({ targetSystem: { type: 'business_central', systemId: 'bc1' } }));
    await expect(make(mgr, cfg).run(ctx())).resolves.toEqual([]);
    expect(mgr.getConnector).toHaveBeenCalledWith('businesscentral', 'businesscentral_cfg_1');
  });

  it('wraps a getConnector throw in ReconcilerConnectorError', async () => {
    const mgr = { getConnector: jest.fn().mockRejectedValue(new Error('registry boom')) };
    const r = make(mgr, configServiceWith(makeConfig()));
    await expect(r.run(ctx())).rejects.toBeInstanceOf(ReconcilerConnectorError);
  });

  it('wraps a null getConnector resolution in ReconcilerConnectorError', async () => {
    const mgr = { getConnector: jest.fn().mockResolvedValue(null) };
    const r = make(mgr, configServiceWith(makeConfig()));
    await expect(r.run(ctx())).rejects.toBeInstanceOf(ReconcilerConnectorError);
  });

  it('wraps a connector.initialize() failure in ReconcilerConnectorError', async () => {
    const ns = { list: jest.fn().mockResolvedValue([]), initialize: jest.fn().mockRejectedValue(new Error('401 bad creds')) };
    const bc = connectorWith([]);
    const r = make(managerWith(ns, bc), configServiceWith(makeConfig()));
    const err = await r.run(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcilerConnectorError);
    expect((err as Error).message).toMatch(/initialize failed/);
  });

  it('throws MissingRequiredFieldError when an invoice is missing its amount field', async () => {
    const ns = connectorWith([{ id: 'INV-9', fields: { tranId: 'INV-9', currency: 'USD' } }]);
    const bc = connectorWith([]);
    const r = make(managerWith(ns, bc), configServiceWith(makeConfig()));
    await expect(r.run(ctx())).rejects.toBeInstanceOf(MissingRequiredFieldError);
  });

  it('throws MissingRequiredFieldError when an invoice is missing its currency field', async () => {
    const ns = connectorWith([{ id: 'INV-8', fields: { tranId: 'INV-8', amount: 100 } }]);
    const bc = connectorWith([]);
    const r = make(managerWith(ns, bc), configServiceWith(makeConfig()));
    await expect(r.run(ctx())).rejects.toBeInstanceOf(MissingRequiredFieldError);
  });

  it('throws MissingRequiredFieldError when an invoice is missing its key field', async () => {
    const ns = connectorWith([{ id: 'INV-7', fields: { amount: 100, currency: 'USD' } }]); // no tranId/key
    const bc = connectorWith([]);
    const r = make(managerWith(ns, bc), configServiceWith(makeConfig()));
    await expect(r.run(ctx())).rejects.toBeInstanceOf(MissingRequiredFieldError);
  });

  it('treats a zero amount as a real value (not missing) — matched zeros yield no discrepancy', async () => {
    const ns = connectorWith([nsInvoice('INV-0', 0)]);
    const bc = connectorWith([bcInvoice('INV-0', 0)]);
    const r = make(managerWith(ns, bc), configServiceWith(makeConfig()));
    await expect(r.run(ctx())).resolves.toEqual([]); // 0 === 0, no MissingRequiredFieldError, no mismatch
  });
});

describe('validateConfig (static, no network)', () => {
  it('throws config_not_found when the tenant config is absent', () => {
    const r = make(managerWith(connectorWith([]), connectorWith([])), configServiceWith(undefined));
    let thrown: unknown;
    try { r.validateConfig(ctx()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ReconcilerConfigError);
    expect((thrown as ReconcilerConfigError).reasonCode).toBe('config_not_found');
  });

  it('throws config_system_pair_mismatch when systems are not NS+BC', () => {
    const cfg = configServiceWith(makeConfig({ targetSystem: 'salesforce' }));
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    let thrown: unknown;
    try { r.validateConfig(ctx()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ReconcilerConfigError);
    expect((thrown as ReconcilerConfigError).reasonCode).toBe('config_system_pair_mismatch');
  });

  it('throws config_missing_auth when a side has no auth', () => {
    const cfg = configServiceWith(makeConfig({ targetAuthentication: undefined, authentication: undefined }));
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    let thrown: unknown;
    try { r.validateConfig(ctx()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ReconcilerConfigError);
    expect((thrown as ReconcilerConfigError).reasonCode).toBe('config_missing_auth');
  });

  it('throws missing_schedule_config_ref when the context id is null', () => {
    const r = make(managerWith(connectorWith([]), connectorWith([])), configServiceWith(makeConfig()));
    let thrown: unknown;
    try { r.validateConfig(ctx({ integrationConfigId: null })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ReconcilerConfigError);
    expect((thrown as ReconcilerConfigError).reasonCode).toBe('missing_schedule_config_ref');
  });

  it('returns the resolved config + per-side auth on a valid NS<->BC config', () => {
    const cfg = configServiceWith(makeConfig());
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    const result = r.validateConfig(ctx());
    expect(result.config.id).toBe('cfg_1');
    expect(result.netsuiteAuth).toEqual({ type: 'oauth1' });
    expect(result.businessCentralAuth).toEqual({ type: 'oauth2' });
  });

  it('run() does not double the config lookup (validateConfig result is reused)', async () => {
    const cfg = configServiceWith(makeConfig());
    const r = make(managerWith(connectorWith([]), connectorWith([])), cfg);
    await r.run(ctx());
    expect(cfg.getConfigurationForTenant).toHaveBeenCalledTimes(1);
  });
});
