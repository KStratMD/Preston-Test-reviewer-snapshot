/**
 * Task 6 (2026-07-27 NetSuite serialized-asset sync plan) — the live
 * activation-readiness evaluator.
 *
 * The readiness sequence is fixed (plan step list):
 *   1. global env flag + strict tenant flag;
 *   2. BOTH systems are strict `SystemConfig` values with
 *      `credentialSource: 'secret_manager'` and a non-empty `systemId`;
 *   3. connectors initialize through the prerequisite-B `ConnectorManager`
 *      resolver, from the STORED tenant-owned config;
 *   4. Product2 + Asset describe data from that initialized target connector;
 *   5. object accessibility/createability/updateability;
 *   6. configured fields exist, are External ID and unique;
 *   7. `Asset.Product2Id.referenceTo` contains `Product2`;
 *   8. Product2 queryability + principal-specific Asset create/update permission;
 *   9. sanitized blockers and field-name CHOICES only — never a raw describe payload.
 *
 * Two fail-closed rules are load-bearing and pinned here:
 *   - a tenant-setting STORAGE failure PROPAGATES as `ServiceUnavailableAppError`
 *     (503). It is never swallowed into "not ready" ambiguity and never into an
 *     implicit allow.
 *   - nothing before the rollout/tenant/managed-credential checks pass may touch
 *     the network. An unmanaged credential reference must not reach
 *     `initializeConnectorsForConfig`.
 */

import {
  SerializedAssetReadinessService,
  type SerializedAssetConnectorProvisioner,
  type SerializedAssetTenantSettingReader,
} from '../../../../src/services/serializedAsset/SerializedAssetReadinessService';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import { DefaultConnectorCredentialResolver } from '../../../../src/services/integration/ConnectorCredentialResolver';
import {
  TenantSettingSystemCredentialRegistry,
  managedSystemRegistryKey,
  type TenantSystemSettingReader,
} from '../../../../src/services/integration/TenantSystemCredentialRegistry';
import type { SecureCredentialManager } from '../../../../src/services/SecureCredentialManager';
import { NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY } from '../../../../src/config/runtimeFlags';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { IntegrationConfig } from '../../../../src/types';
import type {
  SalesforceFieldDescription,
  SalesforceObjectDescription,
} from '../../../../src/types/serializedAsset';

const ASSET_EXTERNAL_ID = 'Serial_External_Id__c';
const PRODUCT_EXTERNAL_ID = 'SKU__c';

function makeField(overrides: Partial<SalesforceFieldDescription> & { name: string }): SalesforceFieldDescription {
  return {
    type: 'string',
    createable: true,
    updateable: true,
    queryable: true,
    externalId: false,
    unique: false,
    referenceTo: [],
    ...overrides,
  };
}

function makeAssetDescribe(overrides: Partial<SalesforceObjectDescription> = {}): SalesforceObjectDescription {
  return {
    name: 'Asset',
    createable: true,
    updateable: true,
    queryable: true,
    fields: [
      makeField({ name: ASSET_EXTERNAL_ID, externalId: true, unique: true }),
      makeField({ name: 'SerialNumber' }),
      makeField({ name: 'Product2Id', type: 'reference', referenceTo: ['Product2'] }),
      makeField({ name: 'Status' }),
    ],
    ...overrides,
  };
}

function makeProductDescribe(overrides: Partial<SalesforceObjectDescription> = {}): SalesforceObjectDescription {
  return {
    name: 'Product2',
    createable: true,
    updateable: true,
    queryable: true,
    fields: [
      makeField({ name: PRODUCT_EXTERNAL_ID, externalId: true, unique: true }),
      makeField({ name: 'Name' }),
    ],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'NetSuite serialized assets',
    sourceSystem: { type: 'netsuite', systemId: 'ns-prod', credentialSource: 'secret_manager' },
    targetSystem: { type: 'salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [
      { sourceField: 'id', targetField: ASSET_EXTERNAL_ID },
      { sourceField: 'inventoryNumber', targetField: 'SerialNumber' },
      { sourceField: 'item.id', targetField: 'Product2Id' },
    ],
    transformationRules: [],
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig: {
      executionProfile: 'netsuite_serialized_asset',
      productExternalIdField: PRODUCT_EXTERNAL_ID,
      assetExternalIdField: ASSET_EXTERNAL_ID,
      serialNumberTargetField: 'SerialNumber',
      productReferenceTargetField: 'Product2Id',
    },
    ...overrides,
  } as IntegrationConfig;
}

interface Harness {
  service: SerializedAssetReadinessService;
  provisioner: {
    initializeConnectorsForConfig: jest.Mock;
    getConnector: jest.Mock;
  };
  describeSObject: jest.Mock;
  settingReader: { getBooleanStrict: jest.Mock };
}

function makeHarness(options: {
  tenantEnabled?: boolean | Error;
  asset?: SalesforceObjectDescription;
  product?: SalesforceObjectDescription;
  describeError?: Error;
  initializeError?: Error;
  connector?: Partial<IConnector>;
} = {}): Harness {
  const describeSObject = jest.fn(async (entityType: 'Product2' | 'Asset') => {
    if (options.describeError) throw options.describeError;
    return entityType === 'Asset'
      ? (options.asset ?? makeAssetDescribe())
      : (options.product ?? makeProductDescribe());
  });

  const connector = options.connector ?? ({
    describeSObject,
    findProduct2ByExternalId: jest.fn(async () => []),
  } as unknown as IConnector);

  const provisioner = {
    initializeConnectorsForConfig: jest.fn(async () => {
      if (options.initializeError) throw options.initializeError;
    }),
    getConnector: jest.fn(async () => connector as IConnector),
  };

  const settingReader = {
    getBooleanStrict: jest.fn(async () => {
      if (options.tenantEnabled instanceof Error) throw options.tenantEnabled;
      return options.tenantEnabled ?? true;
    }),
  };

  const service = new SerializedAssetReadinessService(
    async () => settingReader as SerializedAssetTenantSettingReader,
    provisioner as unknown as SerializedAssetConnectorProvisioner,
  );

  return { service, provisioner, describeSObject, settingReader };
}

function codes(result: { blockers: { code: string }[] }): string[] {
  return result.blockers.map((blocker) => blocker.code);
}

describe('SerializedAssetReadinessService', () => {
  const originalFlag = process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;

  beforeEach(() => {
    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalFlag === undefined) {
      delete process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;
    } else {
      process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = originalFlag;
    }
  });

  describe('rollout gate (step 1)', () => {
    it('blocks with global_capability_disabled and performs NO network I/O when the env flag is unset', async () => {
      delete process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;
      const harness = makeHarness();

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toContain('global_capability_disabled');
      expect(harness.provisioner.initializeConnectorsForConfig).not.toHaveBeenCalled();
      expect(harness.describeSObject).not.toHaveBeenCalled();
    });

    it('blocks with tenant_capability_disabled when the strict tenant setting is false', async () => {
      const harness = makeHarness({ tenantEnabled: false });

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toContain('tenant_capability_disabled');
      expect(harness.settingReader.getBooleanStrict).toHaveBeenCalledWith(
        'tenant-a',
        NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY,
      );
      expect(harness.provisioner.initializeConnectorsForConfig).not.toHaveBeenCalled();
    });

    it('PROPAGATES a tenant-setting storage failure as ServiceUnavailableAppError (never "not ready", never allow)', async () => {
      const harness = makeHarness({ tenantEnabled: new Error('connection terminated unexpectedly') });

      await expect(harness.service.evaluate(makeConfig())).rejects.toBeInstanceOf(ServiceUnavailableAppError);
      expect(harness.provisioner.initializeConnectorsForConfig).not.toHaveBeenCalled();
    });

    it('does not leak the storage failure detail into the surfaced message', async () => {
      const harness = makeHarness({ tenantEnabled: new Error('password=hunter2 at db.internal:5432') });

      await expect(harness.service.evaluate(makeConfig())).rejects.toThrow(
        /serialized-asset readiness could not be determined/i,
      );
    });
  });

  describe('managed-credential enforcement (step 2)', () => {
    it.each([
      ['a legacy string system reference', { targetSystem: 'salesforce' }],
      ['an inline credentialSource', { targetSystem: { type: 'salesforce', systemId: 'sf', credentialSource: 'inline' } }],
      ['an environment credentialSource', { targetSystem: { type: 'salesforce', systemId: 'sf', credentialSource: 'environment' } }],
      ['a missing systemId', { targetSystem: { type: 'salesforce', systemId: '', credentialSource: 'secret_manager' } }],
      ['an unmanaged SOURCE system', { sourceSystem: 'netsuite' }],
    ])('blocks with managed_credentials_required and performs NO network I/O for %s', async (_label, overrides) => {
      const harness = makeHarness();

      const result = await harness.service.evaluate(makeConfig(overrides as Partial<IntegrationConfig>));

      expect(result.ready).toBe(false);
      expect(codes(result)).toContain('managed_credentials_required');
      expect(harness.provisioner.initializeConnectorsForConfig).not.toHaveBeenCalled();
      expect(harness.describeSObject).not.toHaveBeenCalled();
    });
  });

  describe('connector provisioning (step 3)', () => {
    it('initializes connectors from the STORED config object itself — never from caller-supplied data', async () => {
      const harness = makeHarness();
      const config = makeConfig();

      await harness.service.evaluate(config);

      expect(harness.provisioner.initializeConnectorsForConfig).toHaveBeenCalledTimes(1);
      expect(harness.provisioner.initializeConnectorsForConfig).toHaveBeenCalledWith(config);
      // The target connector is retrieved under the SAME cache key
      // `initializeConnectorsForConfig` used, so readiness reads through the
      // instance that received the resolved managed credentials.
      expect(harness.provisioner.getConnector).toHaveBeenCalledWith('salesforce', `salesforce_${config.id}`);
    });

    it('describes the CALLER-SUPPLIED connector when one is given, not a second resolved instance', async () => {
      // Task 7 runtime re-check: readiness is the gate protecting decision 4's
      // External-ID-uniqueness assumption, so it must inspect the same instance
      // the Asset upsert goes through.
      const suppliedDescribe = jest.fn(async (entityType: 'Product2' | 'Asset') =>
        entityType === 'Asset' ? makeAssetDescribe() : makeProductDescribe(),
      );
      const supplied = {
        describeSObject: suppliedDescribe,
        findProduct2ByExternalId: jest.fn(async () => []),
      } as unknown as IConnector;
      const harness = makeHarness();
      const config = makeConfig();

      const result = await harness.service.evaluate(config, { targetConnector: supplied });

      expect(result.ready).toBe(true);
      expect(suppliedDescribe).toHaveBeenCalledWith('Product2');
      expect(suppliedDescribe).toHaveBeenCalledWith('Asset');
      // The manager's own instance is never retrieved or described.
      expect(harness.provisioner.getConnector).not.toHaveBeenCalled();
      expect(harness.describeSObject).not.toHaveBeenCalled();
    });

    it('a caller-supplied connector NEVER bypasses the credential-ownership funnel', async () => {
      // initializeConnectorsForConfig is the single funnel through which
      // TenantSystemCredentialRegistry's cross-tenant check runs. Supplying a
      // connector overrides only the RETRIEVAL, never the ownership check.
      const supplied = {
        describeSObject: jest.fn(async () => makeAssetDescribe()),
        findProduct2ByExternalId: jest.fn(async () => []),
      } as unknown as IConnector;
      const harness = makeHarness();
      const config = makeConfig();

      await harness.service.evaluate(config, { targetConnector: supplied });

      expect(harness.provisioner.initializeConnectorsForConfig).toHaveBeenCalledTimes(1);
      expect(harness.provisioner.initializeConnectorsForConfig).toHaveBeenCalledWith(config);
    });

    it('a caller-supplied connector still fails closed when the ownership check is undeterminable', async () => {
      const supplied = {
        describeSObject: jest.fn(async () => makeAssetDescribe()),
        findProduct2ByExternalId: jest.fn(async () => []),
      } as unknown as IConnector;
      const harness = makeHarness({
        initializeError: new ServiceUnavailableAppError('ownership could not be determined'),
      });

      await expect(
        harness.service.evaluate(makeConfig(), { targetConnector: supplied }),
      ).rejects.toBeInstanceOf(ServiceUnavailableAppError);
      expect(supplied.describeSObject).not.toHaveBeenCalled();
    });

    it('PROPAGATES an undeterminable ownership/credential check as 503 instead of classifying it as a blocker', async () => {
      // The registry raises ServiceUnavailableAppError when it cannot READ the
      // ownership registration (tenant-settings outage). Funnelling that into
      // classifyDiscoveryFailure would report an outage as a DENY - identical
      // to a real discovery failure - and turn activation into a 409 instead of
      // the documented 503. `readTenantFlag` already gets this right by
      // throwing before the try; the discover() catch must not undo it.
      const harness = makeHarness({
        initializeError: new ServiceUnavailableAppError('ownership could not be determined'),
      });

      await expect(harness.service.evaluate(makeConfig())).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );
      expect(harness.describeSObject).not.toHaveBeenCalled();
    });

    it('PROPAGATES a 503 raised by describe itself rather than downgrading it to a blocker', async () => {
      const harness = makeHarness({
        describeError: new ServiceUnavailableAppError('cannot determine'),
      });

      await expect(harness.service.evaluate(makeConfig())).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );
    });

    it('blocks with discovery_unavailable when the credential resolver / initialization fails', async () => {
      const harness = makeHarness({ initializeError: new Error('secret manager lookup failed for sf-prod') });

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toEqual(['discovery_unavailable']);
      expect(harness.describeSObject).not.toHaveBeenCalled();
    });

    it('blocks with discovery_unavailable when the target connector lacks the describe capability', async () => {
      const harness = makeHarness({ connector: {} as Partial<IConnector> });

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toEqual(['discovery_unavailable']);
    });

    it('blocks with discovery_unavailable when describe itself fails', async () => {
      const harness = makeHarness({ describeError: new Error('ECONNRESET') });

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toEqual(['discovery_unavailable']);
    });

    it('blocks with permission_denied when describe fails with an insufficient-access refusal', async () => {
      const harness = makeHarness({
        describeError: new Error('Request failed with status code 403: INSUFFICIENT_ACCESS_OR_READONLY'),
      });

      const result = await harness.service.evaluate(makeConfig());

      expect(result.ready).toBe(false);
      expect(codes(result)).toEqual(['permission_denied']);
    });
  });

  describe('object-level checks (step 5)', () => {
    it('blocks with object_not_writable when Asset is not createable', async () => {
      const harness = makeHarness({ asset: makeAssetDescribe({ createable: false }) });

      const result = await harness.service.evaluate(makeConfig());

      expect(codes(result)).toContain('object_not_writable');
    });

    it('blocks with object_not_writable when Asset is not updateable', async () => {
      const harness = makeHarness({ asset: makeAssetDescribe({ updateable: false }) });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('object_not_writable');
    });
  });

  describe('field-level checks (steps 6-8)', () => {
    it('blocks with field_missing when a configured field is absent from the describe', async () => {
      const harness = makeHarness({
        asset: makeAssetDescribe({
          fields: [
            makeField({ name: 'SerialNumber' }),
            makeField({ name: 'Product2Id', type: 'reference', referenceTo: ['Product2'] }),
          ],
        }),
      });

      const result = await harness.service.evaluate(makeConfig());

      expect(codes(result)).toContain('field_missing');
      expect(result.ready).toBe(false);
    });

    it('blocks with field_not_external_id when the configured key field is not an External ID', async () => {
      const harness = makeHarness({
        product: makeProductDescribe({
          fields: [makeField({ name: PRODUCT_EXTERNAL_ID, externalId: false, unique: true })],
        }),
      });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('field_not_external_id');
    });

    it('blocks with field_not_unique when the configured key field is not unique', async () => {
      const harness = makeHarness({
        asset: makeAssetDescribe({
          fields: [
            makeField({ name: ASSET_EXTERNAL_ID, externalId: true, unique: false }),
            makeField({ name: 'SerialNumber' }),
            makeField({ name: 'Product2Id', type: 'reference', referenceTo: ['Product2'] }),
          ],
        }),
      });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('field_not_unique');
    });

    it('blocks with relationship_invalid when Asset.Product2Id does not reference Product2', async () => {
      const harness = makeHarness({
        asset: makeAssetDescribe({
          fields: [
            makeField({ name: ASSET_EXTERNAL_ID, externalId: true, unique: true }),
            makeField({ name: 'SerialNumber' }),
            makeField({ name: 'Product2Id', type: 'reference', referenceTo: ['Pricebook2'] }),
          ],
        }),
      });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('relationship_invalid');
    });

    it('blocks with permission_denied when Product2 is not queryable', async () => {
      const harness = makeHarness({ product: makeProductDescribe({ queryable: false }) });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('permission_denied');
    });

    it('blocks with permission_denied when the principal cannot create/update a written Asset field', async () => {
      const harness = makeHarness({
        asset: makeAssetDescribe({
          fields: [
            makeField({ name: ASSET_EXTERNAL_ID, externalId: true, unique: true }),
            makeField({ name: 'SerialNumber', createable: false, updateable: false }),
            makeField({ name: 'Product2Id', type: 'reference', referenceTo: ['Product2'] }),
          ],
        }),
      });

      expect(codes(await harness.service.evaluate(makeConfig()))).toContain('permission_denied');
    });
  });

  describe('draft discovery and field choices', () => {
    it('still discovers (and returns filtered choices) for a draft whose field selections are missing', async () => {
      const harness = makeHarness();
      const draft = makeConfig({
        fieldMappings: [],
        executionProfileConfig: { executionProfile: 'netsuite_serialized_asset' },
      } as Partial<IntegrationConfig>);

      const result = await harness.service.evaluate(draft);

      expect(result.ready).toBe(false);
      expect(codes(result)).toContain('profile_invalid');
      expect(harness.describeSObject).toHaveBeenCalledTimes(2);
      expect(result.productExternalIdFields).toEqual([PRODUCT_EXTERNAL_ID]);
      expect(result.assetExternalIdFields).toEqual([ASSET_EXTERNAL_ID]);
    });

    it('returns only External-ID + unique field NAMES as choices — never a raw describe payload', async () => {
      const harness = makeHarness();

      const result = await harness.service.evaluate(makeConfig());

      expect(result.productExternalIdFields).toEqual([PRODUCT_EXTERNAL_ID]);
      expect(result.assetExternalIdFields).toEqual([ASSET_EXTERNAL_ID]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('referenceTo');
      expect(serialized).not.toContain('createable');
      expect(serialized).not.toContain('queryable');
    });
  });

  describe('clean readiness', () => {
    it('returns ready with zero blockers and an ISO checkedAt when every check passes', async () => {
      const harness = makeHarness();

      const result = await harness.service.evaluate(makeConfig());

      expect(result.blockers).toEqual([]);
      expect(result.ready).toBe(true);
      expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
    });

    it('honors optional status/location target fields when they exist and are writable', async () => {
      const harness = makeHarness();
      const config = makeConfig({
        fieldMappings: [
          { sourceField: 'id', targetField: ASSET_EXTERNAL_ID },
          { sourceField: 'inventoryNumber', targetField: 'SerialNumber' },
          { sourceField: 'item.id', targetField: 'Product2Id' },
          { sourceField: 'status', targetField: 'Status' },
        ],
        executionProfileConfig: {
          executionProfile: 'netsuite_serialized_asset',
          productExternalIdField: PRODUCT_EXTERNAL_ID,
          assetExternalIdField: ASSET_EXTERNAL_ID,
          serialNumberTargetField: 'SerialNumber',
          productReferenceTargetField: 'Product2Id',
          statusTargetField: 'Status',
        },
      } as Partial<IntegrationConfig>);

      const result = await harness.service.evaluate(config);

      expect(result.blockers).toEqual([]);
      expect(result.ready).toBe(true);
    });
  });

  /**
   * SECURITY - cross-tenant credential USE, proven through the REAL ownership
   * registry and the REAL credential resolver.
   *
   * A tenant-A user can always save a specialized DRAFT (drafts bypass every
   * activation gate by design). If that draft may name an arbitrary
   * `systemId`, readiness would resolve ANOTHER tenant's brokered Salesforce
   * credentials, initialize a connector against that org, and return that
   * org's External-ID field API names - a credential-backed cross-tenant read.
   *
   * The provisioner double below mirrors ConnectorManager's real logic
   * (resolve credentials, then initialize only if auth came back), so the
   * assertions cover the whole chain: registry -> resolver ->
   * SecureCredentialManager -> connector.initialize -> describe.
   */
  describe('cross-tenant systemId (real registry + real resolver)', () => {
    const OWNER_TENANT = 'tenant-a';
    const OWNED_SYSTEM_ID = 'tenant-a-sf-prod';
    const FOREIGN_SYSTEM_ID = 'tenant-b-sf-prod';

    function makeWiring() {
      const getStringStrict = jest.fn(async (tenantId: string, settingKey: string) => {
        if (tenantId === OWNER_TENANT && settingKey === managedSystemRegistryKey('salesforce')) {
          return JSON.stringify([OWNED_SYSTEM_ID]);
        }
        if (tenantId === OWNER_TENANT && settingKey === managedSystemRegistryKey('netsuite')) {
          return JSON.stringify(['tenant-a-ns-prod']);
        }
        return null;
      });
      const registry = new TenantSettingSystemCredentialRegistry(
        async () => ({ getStringStrict }) as TenantSystemSettingReader,
      );

      // Tag the resolved credential with the systemId it came from, so the
      // assertions below can prove the SALESFORCE connector was never
      // initialized with anything.
      const getCredentials = jest.fn(async (systemType: string, systemId: string) => ({
        type: 'oauth2',
        credentials: { systemType, systemId, clientSecret: 's', instanceUrl: 'https://owner.my.salesforce.com' },
      }));
      const resolver = new DefaultConnectorCredentialResolver(
        async () => ({ getCredentials }) as unknown as SecureCredentialManager,
        registry,
      );

      const initialize = jest.fn(async () => undefined);
      const describeSObject = jest.fn(async (entityType: 'Product2' | 'Asset') =>
        entityType === 'Asset' ? makeAssetDescribe() : makeProductDescribe(),
      );
      const connector = { initialize, describeSObject, findProduct2ByExternalId: jest.fn(async () => []) };

      // Mirrors ConnectorManager.initializeConnectorsForConfig: resolve, then
      // initialize ONLY when the resolver returned credentials.
      const provisioner = {
        initializeConnectorsForConfig: jest.fn(async (config: IntegrationConfig) => {
          const sourceAuth = await resolver.resolve(config, 'source');
          if (sourceAuth) await initialize(sourceAuth);
          const targetAuth = await resolver.resolve(config, 'target');
          if (targetAuth) await initialize(targetAuth);
        }),
        getConnector: jest.fn(async () => connector as unknown as IConnector),
      };

      const service = new SerializedAssetReadinessService(
        async () => ({ getBooleanStrict: jest.fn(async () => true) }) as SerializedAssetTenantSettingReader,
        provisioner as unknown as SerializedAssetConnectorProvisioner,
      );

      return { service, getCredentials, initialize, describeSObject };
    }

    function configWithSystemIds(salesforceSystemId: string): IntegrationConfig {
      return makeConfig({
        tenantId: OWNER_TENANT,
        sourceSystem: { type: 'netsuite', systemId: 'tenant-a-ns-prod', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: salesforceSystemId, credentialSource: 'secret_manager' },
      } as Partial<IntegrationConfig>);
    }

    it("FAILS CLOSED on another tenant's systemId: no credential read, no connector init, no describe, no org metadata", async () => {
      const wiring = makeWiring();

      const result = await wiring.service.evaluate(configWithSystemIds(FOREIGN_SYSTEM_ID));

      expect(result.ready).toBe(false);
      expect(codes(result)).toContain('managed_credentials_required');
      // The tenant's OWN source system still resolves (that is correct); what
      // must never happen is resolving or using the FOREIGN reference.
      expect(wiring.getCredentials).not.toHaveBeenCalledWith('salesforce', FOREIGN_SYSTEM_ID);
      expect(wiring.getCredentials).not.toHaveBeenCalledWith(
        expect.stringMatching(/salesforce/i),
        expect.anything(),
      );
      expect(wiring.initialize).not.toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.objectContaining({ systemId: FOREIGN_SYSTEM_ID }) }),
      );
      expect(wiring.describeSObject).not.toHaveBeenCalled();
      // No discovered org metadata may leak back to the caller.
      expect(result.productExternalIdFields).toEqual([]);
      expect(result.assetExternalIdFields).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(PRODUCT_EXTERNAL_ID);
      expect(JSON.stringify(result)).not.toContain(ASSET_EXTERNAL_ID);
    });

    it("still works end-to-end for the tenant's OWN registered systemId", async () => {
      const wiring = makeWiring();

      const result = await wiring.service.evaluate(configWithSystemIds(OWNED_SYSTEM_ID));

      expect(result.ready).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(wiring.getCredentials).toHaveBeenCalledWith('salesforce', OWNED_SYSTEM_ID);
      expect(wiring.initialize).toHaveBeenCalled();
      expect(wiring.describeSObject).toHaveBeenCalledTimes(2);
      expect(result.productExternalIdFields).toEqual([PRODUCT_EXTERNAL_ID]);
    });

    // NOTE: this asserts the READINESS surface reports both cases identically.
    // It does NOT by itself prove the non-oracle property - it passes even with
    // the ownership check removed, because both configs then fail the same way.
    // The real proof of the non-oracle property is the registry-level test
    // "never echoes the requested systemId or the registered set".
    it('reports a foreign systemId and a nonexistent one with identical blockers (surface uniformity)', async () => {
      const wiring = makeWiring();

      const foreign = await wiring.service.evaluate(configWithSystemIds(FOREIGN_SYSTEM_ID));
      const nonexistent = await makeWiring().service.evaluate(configWithSystemIds('no-such-system-anywhere'));

      expect(codes(foreign)).toEqual(codes(nonexistent));
      expect(foreign.blockers.map((b) => b.message)).toEqual(nonexistent.blockers.map((b) => b.message));
    });
  });
});

/**
 * Decision 8, enforced at this module's own log sites.
 *
 * The header of `SerializedAssetReadinessService` claims the privacy guarantee
 * the whole profile rests on, but two of its log calls emitted `error.message`
 * verbatim. That matters most exactly where it is hardest to reason about: the
 * discovery error comes from a CALLER-OVERRIDABLE connector, so its text is not
 * this codebase's to vouch for, and a Salesforce error body can quote the
 * payload it rejected.
 */
describe('SerializedAssetReadinessService — error text never reaches the logger', () => {
  const SERIAL = 'SN-SECRET-12345';
  const originalFlag = process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;

  // This describe sits outside the suite-level beforeEach, so it owns the flag
  // itself — without it `evaluate` short-circuits and discovery never runs.
  beforeEach(() => {
    process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = 'true';
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;
    else process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = originalFlag;
  });

  function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  }

  function loggedPayloads(logger: ReturnType<typeof makeLogger>): string {
    return JSON.stringify(
      [...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls],
    );
  }

  it('logs only the error CLASS when Salesforce discovery fails', async () => {
    const logger = makeLogger();
    // Sets `name`, as every custom error in this codebase does (AppError
    // assigns `this.name = this.constructor.name`). `errorNameOf` reports
    // `error.name`, so a subclass that never sets it is reported as plain
    // 'Error' — safe, just less useful, and not what production errors look like.
    class SalesforceApiError extends Error {
      override name = 'SalesforceApiError';
    }
    const describeSObject = jest.fn(async () => {
      throw new SalesforceApiError(`Bad request processing unit ${SERIAL}`);
    });

    const service = new SerializedAssetReadinessService(
      async () => ({ getBooleanStrict: jest.fn(async () => true) }) as SerializedAssetTenantSettingReader,
      {
        initializeConnectorsForConfig: jest.fn(async () => undefined),
        getConnector: jest.fn(async () => ({
          describeSObject,
          findProduct2ByExternalId: jest.fn(async () => []),
        }) as unknown as IConnector),
      } as unknown as SerializedAssetConnectorProvisioner,
      logger as unknown as ConstructorParameters<typeof SerializedAssetReadinessService>[2],
    );

    await service.evaluate(makeConfig());

    const logged = loggedPayloads(logger);
    expect(logged).not.toContain(SERIAL);
    expect(logged).toContain('SalesforceApiError');
  });

  it('logs only the error CLASS when the tenant capability read fails', async () => {
    const logger = makeLogger();
    class SettingStoreError extends Error {
      override name = 'SettingStoreError';
    }

    const service = new SerializedAssetReadinessService(
      async () => ({
        getBooleanStrict: jest.fn(async () => {
          throw new SettingStoreError(`row rejected: normalized_payload contains ${SERIAL}`);
        }),
      }) as SerializedAssetTenantSettingReader,
      {
        initializeConnectorsForConfig: jest.fn(async () => undefined),
        getConnector: jest.fn(async () => ({}) as unknown as IConnector),
      } as unknown as SerializedAssetConnectorProvisioner,
      logger as unknown as ConstructorParameters<typeof SerializedAssetReadinessService>[2],
    );

    await expect(service.evaluate(makeConfig())).rejects.toThrow();

    const logged = loggedPayloads(logger);
    expect(logged).not.toContain(SERIAL);
    expect(logged).toContain('SettingStoreError');
  });
});
