import { IntegrationService } from '../services/IntegrationService';
import {
  createMockOutboundGovernanceService,
  createMockOwnershipResolver,
  createMockAuditService,
  createMockApprovalQueueService,
} from '../../governanceTestUtils';
import type { DataRecord, IntegrationConfig } from '../types';
import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { AuthService } from '../services/AuthService';

/**
 * PR 13c-5 wedge4 — C1 regression net. Connectors like Dynamics365 / SAP /
 * Oracle / SuiteCentral are registered (getConnector accepts them) but are
 * NOT members of the SourceSystem union, so they have no ownership policy in
 * the manifest. The squire-fallback removal must fail fast ONLY when such an
 * unmapped system writes a CANONICAL entity (where attributing the write to
 * 'squire' would corrupt a real ownership decision). For non-canonical
 * entities the OwnershipResolver short-circuits to no_policy_declared
 * (allowed), so those syncs must keep working — they did before the wedge and
 * a shipped sample config (Dynamics365 → Salesforce, entity Account) depends
 * on it.
 */
describe('IntegrationService — squire-fallback canonical-entity gating (C1)', () => {
  const makeConfig = (over: Partial<IntegrationConfig>): IntegrationConfig => ({
    id: 'cfg',
    name: 'cfg',
    sourceSystem: 'Dynamics365',
    targetSystem: 'Salesforce',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    sourceEntity: 'Account',
    targetEntity: 'Account',
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceAuthentication: { type: 'api_key', credentials: {} },
    targetAuthentication: { type: 'api_key', credentials: {} },
    fieldMappings: [],
    transformationRules: [],
    ...over,
  });

  const makeConnector = (systemType: string, sourceRecord?: DataRecord): IConnector => ({
    systemType,
    systemId: `${systemType}-id`,
    initialize: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn(),
    getSystemInfo: jest.fn(),
    authenticate: jest.fn(),
    create: jest.fn(async (_e, data: DataRecord) => ({ ...data, id: 'created-1' })),
    read: jest.fn(async () => sourceRecord ?? null),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn().mockResolvedValue(sourceRecord ? [sourceRecord] : []),
    search: jest.fn(),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
  });

  const makeService = (config: IntegrationConfig) => {
    const logger = {
      info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
      child: jest.fn().mockReturnThis(), setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as Logger;

    const transformationEngine = {
      transform: jest.fn(async ({ sourceData }: { sourceData: DataRecord }) => ({
        success: true, transformedData: sourceData, errors: [], warnings: [],
      })),
    } as unknown as TransformationEngine;

    const configService = {
      getConfiguration: jest.fn().mockReturnValue(config),
      getConfigurationForTenant: jest.fn().mockReturnValue(config),
    } as unknown as ConfigurationService;

    const service = new IntegrationService(
      logger,
      transformationEngine,
      configService,
      {} as AuthService,
      undefined,
      createMockOutboundGovernanceService() as any,
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any,
    );

    // Source record exists so read() returns it; target read() returns null
    // (no existing record) so the create path runs.
    const sourceConnector = makeConnector(config.sourceSystem as string, { id: 'rec-1', fields: {} });
    const targetConnector = makeConnector(config.targetSystem as string);
    (service as any).getConnector = jest.fn(async (systemType: string) =>
      systemType === config.sourceSystem ? sourceConnector : targetConnector,
    );

    return { service, targetConnector };
  };

  it('allows an unmapped source system writing a NON-canonical entity (Dynamics365 → Salesforce, Account)', async () => {
    const config = makeConfig({ sourceSystem: 'Dynamics365', targetSystem: 'Salesforce', sourceEntity: 'Account', targetEntity: 'Account' });
    const { service, targetConnector } = makeService(config);

    const result = await service.syncSingleRecord('cfg', 'rec-1');

    expect(result.success).toBe(true);
    expect(result.recordsSuccessful).toBe(1);
    expect(result.recordsFailed).toBe(0);
    // The create actually ran — proving toSourceSystem('Dynamics365') resolved
    // to the benign 'squire' attribution instead of throwing.
    expect(targetConnector.create).toHaveBeenCalledTimes(1);
  });

  it('fails fast when an unmapped source system writes a CANONICAL entity (Dynamics365 → NetSuite, customer)', async () => {
    const config = makeConfig({ sourceSystem: 'Dynamics365', targetSystem: 'NetSuite', sourceEntity: 'customer', targetEntity: 'customer' });
    const { service, targetConnector } = makeService(config);

    const result = await service.syncSingleRecord('cfg', 'rec-1');

    expect(result.success).toBe(false);
    expect(result.recordsFailed).toBe(1);
    expect(result.errors[0]).toMatch(/unmapped system type 'Dynamics365'/);
    expect(result.errors[0]).toContain('customer');
    // The create was never reached — the throw happened during guardedWrite
    // context construction.
    expect(targetConnector.create).not.toHaveBeenCalled();
  });
});
