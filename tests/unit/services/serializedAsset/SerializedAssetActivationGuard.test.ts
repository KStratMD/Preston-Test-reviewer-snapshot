/**
 * Task 6 (2026-07-27 NetSuite serialized-asset sync plan) — the specialized
 * `ConfigurationActivationGuard` bound to prerequisite C's extension point.
 *
 * Source rules are exact (plan decision 6):
 *   - `direct_save`: an ACTIVE specialized create/update is refused with the
 *     typed code `stored_activation_required`. Drafts stay saveable and
 *     STANDARD configurations are entirely unchanged.
 *   - `import`: any ACTIVE specialized member is refused with the same typed
 *     code BEFORE memory, disk, cardinality preflight, readiness network I/O,
 *     or partial outcome mutation — the restore stays all-or-nothing.
 *   - `stored_id`: readiness runs BEFORE the cardinality preflight and before
 *     atomic persistence, and no generic override can bypass a blocker
 *     (decision 7: readiness is non-overrideable).
 *
 * The second half of this file drives the guard through the REAL
 * `ConfigurationService` so the ordering claims are proven against the actual
 * save/activate/import pipeline, not a hand-rolled stand-in.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  SerializedAssetActivationGuard,
  SerializedAssetActivationBlockedError,
} from '../../../../src/services/serializedAsset/SerializedAssetActivationGuard';
import type { SerializedAssetReadinessResult } from '../../../../src/services/serializedAsset/SerializedAssetReadinessService';
import { ConfigurationService, type CardinalityActivationGate } from '../../../../src/services/ConfigurationService';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import { SerializedAssetReadinessService } from '../../../../src/services/serializedAsset/SerializedAssetReadinessService';
import { DefaultConnectorCredentialResolver } from '../../../../src/services/integration/ConnectorCredentialResolver';
import {
  TenantSettingSystemCredentialRegistry,
  managedSystemRegistryKey,
} from '../../../../src/services/integration/TenantSystemCredentialRegistry';
import { CardinalityViolationError } from '../../../../src/errors/CardinalityViolationError';
import type { ConfigurationCommandContext, PreflightRunResult } from '../../../../src/types/cardinality';
import {
  makeFinding,
  makePreflightRunResult,
  makeReport,
} from '../../../helpers/cardinalityTestDoubles';
import type { IntegrationConfig } from '../../../../src/types';
import { Logger } from '../../../../src/utils/Logger';

const ASSET_EXTERNAL_ID = 'Serial_External_Id__c';
const PRODUCT_EXTERNAL_ID = 'SKU__c';

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

function makeReadyResult(overrides: Partial<SerializedAssetReadinessResult> = {}): SerializedAssetReadinessResult {
  return {
    ready: true,
    checkedAt: new Date().toISOString(),
    blockers: [],
    productExternalIdFields: [PRODUCT_EXTERNAL_ID],
    assetExternalIdFields: [ASSET_EXTERNAL_ID],
    ...overrides,
  };
}

function makeSpecializedConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
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
    isActive: true,
    fieldMappings: [
      { sourceField: 'id', targetField: ASSET_EXTERNAL_ID, transformationType: 'direct', isRequired: false },
      { sourceField: 'inventoryNumber', targetField: 'SerialNumber', transformationType: 'direct', isRequired: false },
      { sourceField: 'item.id', targetField: 'Product2Id', transformationType: 'direct', isRequired: false },
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

function makeStandardConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'std-1',
    tenantId: 'tenant-a',
    name: 'Standard sync',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    sourceEntity: 'Account',
    targetEntity: 'customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [{ sourceField: 'Name', targetField: 'companyName', transformationType: 'direct', isRequired: false }],
    transformationRules: [],
    sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
    ...overrides,
  } as IntegrationConfig;
}

const ctx: ConfigurationCommandContext = {
  tenantId: 'tenant-a',
  actorId: 'operator-1',
  operation: 'admin_activation',
  correlationId: 'corr-1',
};

describe('SerializedAssetActivationGuard', () => {
  describe('source rules', () => {
    it('refuses an ACTIVE specialized direct_save with stored_activation_required and never runs readiness', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const guard = new SerializedAssetActivationGuard(readiness);

      await expect(guard.assertReady(makeSpecializedConfig(), ctx, 'direct_save')).rejects.toMatchObject({
        code: 'stored_activation_required',
      });
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    it('refuses an ACTIVE specialized import member with the same typed code, before any readiness network I/O', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const guard = new SerializedAssetActivationGuard(readiness);

      await expect(guard.assertReady(makeSpecializedConfig(), ctx, 'import')).rejects.toBeInstanceOf(
        SerializedAssetActivationBlockedError,
      );
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    it('leaves specialized DRAFTS saveable from every source (no live calls)', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const guard = new SerializedAssetActivationGuard(readiness);
      const draft = makeSpecializedConfig({ isActive: false });

      await expect(guard.assertReady(draft, ctx, 'direct_save')).resolves.toBeUndefined();
      await expect(guard.assertReady(draft, ctx, 'import')).resolves.toBeUndefined();
      await expect(guard.assertReady(draft, ctx, 'stored_id')).resolves.toBeUndefined();
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    it('leaves STANDARD configurations unchanged on every source', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const guard = new SerializedAssetActivationGuard(readiness);

      await expect(guard.assertReady(makeStandardConfig(), ctx, 'direct_save')).resolves.toBeUndefined();
      await expect(guard.assertReady(makeStandardConfig(), ctx, 'import')).resolves.toBeUndefined();
      await expect(guard.assertReady(makeStandardConfig(), ctx, 'stored_id')).resolves.toBeUndefined();
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    it('runs readiness for an ACTIVE specialized stored_id activation and admits a clean result', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const guard = new SerializedAssetActivationGuard(readiness);
      const config = makeSpecializedConfig();

      await expect(guard.assertReady(config, ctx, 'stored_id')).resolves.toBeUndefined();
      expect(readiness.evaluate).toHaveBeenCalledWith(config);
    });

    it('refuses a stored_id activation whose readiness result carries blockers', async () => {
      const readiness = {
        evaluate: jest.fn(async () =>
          makeReadyResult({
            ready: false,
            blockers: [{ code: 'field_not_unique' as const, message: 'Serial_External_Id__c is not unique' }],
          }),
        ),
      };
      const guard = new SerializedAssetActivationGuard(readiness);

      const error = await guard
        .assertReady(makeSpecializedConfig(), ctx, 'stored_id')
        .then(() => undefined)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(SerializedAssetActivationBlockedError);
      expect(error).toMatchObject({
        code: 'readiness_blocked',
        blockers: [{ code: 'field_not_unique' }],
      });
    });

    it('fails CLOSED with ServiceUnavailableAppError when the readiness dependency is missing', async () => {
      const guard = new SerializedAssetActivationGuard(undefined);

      await expect(guard.assertReady(makeSpecializedConfig(), ctx, 'stored_id')).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );
    });

    it('propagates a readiness ServiceUnavailableAppError rather than converting it to an allow', async () => {
      const readiness = {
        evaluate: jest.fn(async () => {
          throw new ServiceUnavailableAppError('readiness could not be determined');
        }),
      };
      const guard = new SerializedAssetActivationGuard(readiness);

      await expect(guard.assertReady(makeSpecializedConfig(), ctx, 'stored_id')).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );
    });
  });

  describe('wired into the real ConfigurationService', () => {
    let dir: string;

    function makeCleanPreflight(): PreflightRunResult {
      return makePreflightRunResult();
    }

    function makeGate(result: PreflightRunResult): CardinalityActivationGate {
      return {
        preflight: { runForConfig: jest.fn(async () => result), runForPlan: jest.fn() },
        audit: {
          logCardinalityDecision: jest.fn(async () => 'decision-1'),
          logCardinalityOutcome: jest.fn(async () => 'outcome-1'),
        },
      } as unknown as CardinalityActivationGate;
    }

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'serialized-asset-guard-'));
      jest.clearAllMocks();
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('refuses a direct active specialized save with ZERO memory or disk mutation', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(readiness),
      );

      await expect(svc.saveConfiguration(makeSpecializedConfig(), ctx)).rejects.toMatchObject({
        code: 'stored_activation_required',
      });

      expect(svc.getAllConfigurations()).toHaveLength(0);
      expect((await fs.readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
    });

    it('saves the same configuration as an INACTIVE draft, then activates it by stored id', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const gate = makeGate(makeCleanPreflight());
      const svc = new ConfigurationService(silentLogger, dir, gate, new SerializedAssetActivationGuard(readiness));

      await svc.saveConfiguration(makeSpecializedConfig({ isActive: false }), ctx);
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
      expect(readiness.evaluate).not.toHaveBeenCalled();

      await svc.activateConfigurationForTenant('tenant-a', 'cfg-1', ctx);

      expect(readiness.evaluate).toHaveBeenCalledTimes(1);
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(true);
    });

    it('runs readiness BEFORE the cardinality preflight and BEFORE persistence on stored_id activation', async () => {
      const order: string[] = [];
      const readiness = {
        evaluate: jest.fn(async () => {
          order.push('readiness');
          return makeReadyResult({ ready: false, blockers: [{ code: 'field_missing', message: 'missing' }] });
        }),
      };
      const gate = makeGate(makeCleanPreflight());
      (gate.preflight.runForConfig as jest.Mock).mockImplementation(async () => {
        order.push('preflight');
        return makeCleanPreflight();
      });
      const svc = new ConfigurationService(silentLogger, dir, gate, new SerializedAssetActivationGuard(readiness));
      await svc.saveConfiguration(makeSpecializedConfig({ isActive: false }), ctx);

      await expect(svc.activateConfigurationForTenant('tenant-a', 'cfg-1', ctx)).rejects.toBeInstanceOf(
        SerializedAssetActivationBlockedError,
      );

      expect(order).toEqual(['readiness']);
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
      // Stored draft untouched, on disk and in memory.
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cfg-1.json'), 'utf-8'));
      expect(onDisk.isActive).toBe(false);
    });

    it('cannot be bypassed by a generic cardinality override', async () => {
      const readiness = {
        evaluate: jest.fn(async () =>
          makeReadyResult({ ready: false, blockers: [{ code: 'object_not_writable', message: 'Asset is read-only' }] }),
        ),
      };
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(readiness),
      );
      await svc.saveConfiguration(makeSpecializedConfig({ isActive: false }), ctx);

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'cfg-1', ctx, {
          override: {
            reason: 'operator accepted the record-grain risk for this run',
            findingIds: ['any'],
            reportFingerprint: 'fp-clean',
          },
        } as never),
      ).rejects.toBeInstanceOf(SerializedAssetActivationBlockedError);

      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
    });

    it('leaves a STANDARD active save working exactly as before the guard was bound', async () => {
      const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(readiness),
      );

      await svc.saveConfiguration(makeStandardConfig(), ctx);

      expect(svc.getConfigurationForTenant('tenant-a', 'std-1')?.isActive).toBe(true);
      expect(readiness.evaluate).not.toHaveBeenCalled();
    });

    describe('import (all-or-nothing)', () => {
      it('aborts the whole restore before ANY preflight, memory, or disk mutation when a specialized member is active', async () => {
        const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
        const gate = makeGate(makeCleanPreflight());
        const svc = new ConfigurationService(silentLogger, dir, gate, new SerializedAssetActivationGuard(readiness));

        await expect(
          svc.importAll(
            {
              configurations: [
                makeStandardConfig({ id: 'std-1' }),
                makeSpecializedConfig({ id: 'cfg-1', isActive: true }),
              ],
            },
            { ...ctx, operation: 'bulk_restore' },
          ),
        ).rejects.toMatchObject({ code: 'stored_activation_required' });

        expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
        expect(gate.audit.logCardinalityDecision).not.toHaveBeenCalled();
        expect(readiness.evaluate).not.toHaveBeenCalled();
        expect(svc.getAllConfigurations()).toHaveLength(0);
        expect((await fs.readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
      });

      it('imports the SAME member inactive as a draft, which can then be activated by stored id', async () => {
        const readiness = { evaluate: jest.fn(async () => makeReadyResult()) };
        const svc = new ConfigurationService(
          silentLogger,
          dir,
          makeGate(makeCleanPreflight()),
          new SerializedAssetActivationGuard(readiness),
        );

        await svc.importAll(
          { configurations: [makeSpecializedConfig({ id: 'cfg-1', isActive: false })] },
          { ...ctx, operation: 'bulk_restore' },
        );

        expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
        expect(readiness.evaluate).not.toHaveBeenCalled();

        await svc.activateConfigurationForTenant('tenant-a', 'cfg-1', ctx);

        expect(readiness.evaluate).toHaveBeenCalledTimes(1);
        expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(true);
      });

      it('still enforces the cardinality gate for standard active members', async () => {
        const blocking = makePreflightRunResult({
          blocking: true,
          reports: [makeReport({ findings: [makeFinding()] })],
        });
        const svc = new ConfigurationService(
          silentLogger,
          dir,
          makeGate(blocking),
          new SerializedAssetActivationGuard({ evaluate: jest.fn(async () => makeReadyResult()) }),
        );

        await expect(
          svc.importAll({ configurations: [makeStandardConfig({ id: 'std-1' })] }, { ...ctx, operation: 'bulk_restore' }),
        ).rejects.toBeInstanceOf(CardinalityViolationError);
      });
    });
  });

  /**
   * Prerequisite C left `TYPES.ConfigurationActivationGuard` UNBOUND, so
   * `ConfigurationService`'s `@optional()` injection resolved to `undefined`
   * and the gate was a no-op. Binding it is the whole point of this task —
   * and both bindings must be SYNCHRONOUSLY resolvable, because
   * `ConfigurationService` is resolved with a plain `container.get`. An
   * async-bound guard would inject a Promise, whose `assertReady` is
   * undefined, silently disabling the gate in production while every test
   * that constructs the service by hand keeps passing.
   */
  describe('production DI binding', () => {
    it('binds the specialized guard synchronously and attaches it to ConfigurationService', async () => {
      const { container } = await import('../../../../src/inversify/inversify.config');
      const { TYPES } = await import('../../../../src/inversify/types');

      expect(container.isBound(TYPES.ConfigurationActivationGuard)).toBe(true);
      expect(container.isBound(TYPES.SerializedAssetReadinessService)).toBe(true);

      const guard = container.get(TYPES.ConfigurationActivationGuard);
      expect(guard).toBeInstanceOf(SerializedAssetActivationGuard);
      expect(guard).not.toBeInstanceOf(Promise);

      const readiness = container.get(TYPES.SerializedAssetReadinessService);
      expect(readiness).not.toBeInstanceOf(Promise);
      expect(typeof (readiness as { evaluate?: unknown }).evaluate).toBe('function');

      // `instanceof ConfigurationService` proves nothing about the guard being
      // ATTACHED. Drive the container-resolved service through a specialized
      // ACTIVE save: only a service that actually received the guard refuses it.
      const service = container.get<ConfigurationService>(TYPES.ConfigurationService);
      expect(service).toBeInstanceOf(ConfigurationService);

      await expect(
        service.saveConfiguration(makeSpecializedConfig({ id: 'di-probe' }), { ...ctx, tenantId: 'tenant-a' }),
      ).rejects.toMatchObject({ code: 'stored_activation_required' });
      expect(service.getConfigurationForTenant('tenant-a', 'di-probe')).toBeUndefined();
    });
  });

  /**
   * SECURITY - cross-tenant credential USE at ACTIVATION.
   *
   * Readiness has its own proof of this (SerializedAssetReadinessService.test.ts);
   * this drives the SAME real registry + real resolver through the guard and the
   * real ConfigurationService, because activation is the path that would turn a
   * foreign-credential connection into a persisted ACTIVE configuration.
   */
  describe('cross-tenant systemId at activation (real registry + real resolver)', () => {
    const OWNER_TENANT = 'tenant-a';
    const OWNED_SYSTEM_ID = 'tenant-a-sf-prod';
    const FOREIGN_SYSTEM_ID = 'tenant-b-sf-prod';
    let dir: string;

    function makeCleanPreflight(): PreflightRunResult {
      return makePreflightRunResult();
    }

    function makeGate(result: PreflightRunResult): CardinalityActivationGate {
      return {
        preflight: { runForConfig: jest.fn(async () => result), runForPlan: jest.fn() },
        audit: {
          logCardinalityDecision: jest.fn(async () => 'decision-1'),
          logCardinalityOutcome: jest.fn(async () => 'outcome-1'),
        },
      } as unknown as CardinalityActivationGate;
    }

    function makeWiring() {
      const getStringStrict = jest.fn(async (tenantId: string, settingKey: string) => {
        if (tenantId !== OWNER_TENANT) return null;
        if (settingKey === managedSystemRegistryKey('salesforce')) return JSON.stringify([OWNED_SYSTEM_ID]);
        if (settingKey === managedSystemRegistryKey('netsuite')) return JSON.stringify(['tenant-a-ns-prod']);
        return null;
      });
      const registry = new TenantSettingSystemCredentialRegistry(async () => ({ getStringStrict }));

      const getCredentials = jest.fn(async (systemType: string, systemId: string) => ({
        type: 'oauth2',
        credentials: { systemType, systemId, clientSecret: 's', instanceUrl: 'https://owner.my.salesforce.com' },
      }));
      const resolver = new DefaultConnectorCredentialResolver(
        async () => ({ getCredentials }) as never,
        registry,
      );

      const initialize = jest.fn(async () => undefined);
      const describeSObject = jest.fn(async (entityType: 'Product2' | 'Asset') => ({
        name: entityType,
        createable: true,
        updateable: true,
        queryable: true,
        fields: entityType === 'Asset'
          ? [
            { name: ASSET_EXTERNAL_ID, type: 'string', createable: true, updateable: true, queryable: true, externalId: true, unique: true, referenceTo: [] },
            { name: 'SerialNumber', type: 'string', createable: true, updateable: true, queryable: true, externalId: false, unique: false, referenceTo: [] },
            { name: 'Product2Id', type: 'reference', createable: true, updateable: true, queryable: true, externalId: false, unique: false, referenceTo: ['Product2'] },
          ]
          : [
            { name: PRODUCT_EXTERNAL_ID, type: 'string', createable: true, updateable: true, queryable: true, externalId: true, unique: true, referenceTo: [] },
          ],
      }));

      const provisioner = {
        initializeConnectorsForConfig: jest.fn(async (config: IntegrationConfig) => {
          const sourceAuth = await resolver.resolve(config, 'source');
          if (sourceAuth) await initialize(sourceAuth);
          const targetAuth = await resolver.resolve(config, 'target');
          if (targetAuth) await initialize(targetAuth);
        }),
        getConnector: jest.fn(async () => ({ initialize, describeSObject, findProduct2ByExternalId: jest.fn(async () => []) })),
      };

      const readiness = new SerializedAssetReadinessService(
        async () => ({ getBooleanStrict: jest.fn(async () => true) }),
        provisioner as never,
      );

      return { readiness, getCredentials, initialize, describeSObject };
    }

    function draftWithSystemIds(salesforceSystemId: string): IntegrationConfig {
      return makeSpecializedConfig({
        isActive: false,
        tenantId: OWNER_TENANT,
        sourceSystem: { type: 'netsuite', systemId: 'tenant-a-ns-prod', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: salesforceSystemId, credentialSource: 'secret_manager' },
      } as Partial<IntegrationConfig>);
    }

    const originalFlag = process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;

    beforeEach(async () => {
      process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = 'true';
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'serialized-asset-xtenant-'));
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
      if (originalFlag === undefined) {
        delete process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED;
      } else {
        process.env.NETSUITE_SERIALIZED_ASSET_SYNC_ENABLED = originalFlag;
      }
    });

    it("REFUSES activation of a draft naming another tenant's systemId, with no credential read and no outbound describe", async () => {
      const wiring = makeWiring();
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(wiring.readiness),
      );
      await svc.saveConfiguration(draftWithSystemIds(FOREIGN_SYSTEM_ID), { ...ctx, tenantId: OWNER_TENANT });

      await expect(
        svc.activateConfigurationForTenant(OWNER_TENANT, 'cfg-1', { ...ctx, tenantId: OWNER_TENANT }),
      ).rejects.toBeInstanceOf(SerializedAssetActivationBlockedError);

      // The tenant's own NetSuite reference legitimately resolves; the FOREIGN
      // Salesforce reference must never be resolved or used.
      expect(wiring.getCredentials).not.toHaveBeenCalledWith('salesforce', FOREIGN_SYSTEM_ID);
      expect(wiring.getCredentials).not.toHaveBeenCalledWith(
        expect.stringMatching(/salesforce/i),
        expect.anything(),
      );
      expect(wiring.initialize).not.toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.objectContaining({ systemId: FOREIGN_SYSTEM_ID }) }),
      );
      expect(wiring.describeSObject).not.toHaveBeenCalled();
      // The draft is still inactive, in memory and on disk.
      expect(svc.getConfigurationForTenant(OWNER_TENANT, 'cfg-1')?.isActive).toBe(false);
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cfg-1.json'), 'utf-8'));
      expect(onDisk.isActive).toBe(false);
    });

    it('surfaces an UNDETERMINABLE ownership check as 503 at activation, never as a 409 refusal', async () => {
      // A tenant-settings outage during the ownership read must not look like
      // "this tenant does not own that system". 409 tells the operator to fix
      // their configuration; 503 tells them to fix (or wait out) the outage.
      const readiness = new SerializedAssetReadinessService(
        async () => ({ getBooleanStrict: jest.fn(async () => true) }),
        {
          initializeConnectorsForConfig: jest.fn(async () => {
            throw new ServiceUnavailableAppError('ownership could not be determined');
          }),
          getConnector: jest.fn(),
        } as never,
      );
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(readiness),
      );
      await svc.saveConfiguration(draftWithSystemIds(OWNED_SYSTEM_ID), { ...ctx, tenantId: OWNER_TENANT });

      const error = await svc
        .activateConfigurationForTenant(OWNER_TENANT, 'cfg-1', { ...ctx, tenantId: OWNER_TENANT })
        .then(() => undefined)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ServiceUnavailableAppError);
      expect(error).not.toBeInstanceOf(SerializedAssetActivationBlockedError);
      expect((error as ServiceUnavailableAppError).statusCode).toBe(503);
      expect(svc.getConfigurationForTenant(OWNER_TENANT, 'cfg-1')?.isActive).toBe(false);
    });

    it("ACTIVATES a draft naming the tenant's OWN registered systemId", async () => {
      const wiring = makeWiring();
      const svc = new ConfigurationService(
        silentLogger,
        dir,
        makeGate(makeCleanPreflight()),
        new SerializedAssetActivationGuard(wiring.readiness),
      );
      await svc.saveConfiguration(draftWithSystemIds(OWNED_SYSTEM_ID), { ...ctx, tenantId: OWNER_TENANT });

      await svc.activateConfigurationForTenant(OWNER_TENANT, 'cfg-1', { ...ctx, tenantId: OWNER_TENANT });

      expect(wiring.getCredentials).toHaveBeenCalledWith('salesforce', OWNED_SYSTEM_ID);
      expect(wiring.describeSObject).toHaveBeenCalledTimes(2);
      expect(svc.getConfigurationForTenant(OWNER_TENANT, 'cfg-1')?.isActive).toBe(true);
    });
  });
});
