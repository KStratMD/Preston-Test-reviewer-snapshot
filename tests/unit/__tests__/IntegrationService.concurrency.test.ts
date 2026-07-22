import { IntegrationService } from '../services/IntegrationService';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../governanceTestUtils';
import type { DataRecord, IntegrationConfig } from '../types';
import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { AuthService } from '../services/AuthService';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

describe('IntegrationService concurrency', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  const createConfig = (): IntegrationConfig => ({
    id: 'test-config',
    name: 'Test Config',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    sourceEntity: 'Record',
    targetEntity: 'Record',
    createdAt: new Date(),
    updatedAt: new Date(),
    sourceAuthentication: { type: 'api_key', credentials: {} },
    targetAuthentication: { type: 'api_key', credentials: {} },
    fieldMappings: [],
    transformationRules: [],
  });

  const createService = (sourceConnector: IConnector, targetConnector: IConnector) => {
    const logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as Logger;

    const transformationEngine = {
      transform: jest.fn(async ({ sourceData }: { sourceData: DataRecord }) => ({
        success: true,
        transformedData: sourceData,
        errors: [],
        warnings: [],
      })),
    } as unknown as TransformationEngine;

    const configService = {} as ConfigurationService;
    const authService = {} as AuthService;

    const service = new IntegrationService(
      logger,
      transformationEngine,
      configService,
      authService,
      undefined,
      createMockOutboundGovernanceService() as any,
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any, // 9th: ApprovalQueueService (PR 13b A2.5)
    );


    (service as any).getConnector = jest.fn(async (systemType: string) =>
      systemType === 'salesforce' ? sourceConnector : targetConnector,
    );

    return service;
  };

  const createSourceConnector = (records: DataRecord[]): IConnector => ({
    systemType: 'salesforce',
    systemId: 'source',
    initialize: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn(),
    getSystemInfo: jest.fn(),
    authenticate: jest.fn(),
    create: jest.fn(),
    read: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn().mockResolvedValue(records),
    search: jest.fn(),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
  });

  const createTargetConnector = (
    delayMs: number,
    failIds: Set<string> = new Set(),
  ) => {
    let current = 0;
    const tracker = { maxConcurrent: 0 };
    const connector: IConnector = {
      systemType: 'netsuite',
      systemId: 'target',
      initialize: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn(),
      getSystemInfo: jest.fn(),
      authenticate: jest.fn(),
      create: jest.fn(async (_entity, data: DataRecord) => {
        current++;
        tracker.maxConcurrent = Math.max(tracker.maxConcurrent, current);
        await delay(delayMs);
        current--;
        if (failIds.has(data.id!)) {
          throw new Error('create failed');
        }
        return { ...data };
      }),
      read: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      search: jest.fn(),
      bulkCreate: jest.fn(),
      bulkUpdate: jest.fn(),
      bulkDelete: jest.fn(),
    };
    return { connector, tracker };
  };

  it('processes records with limited concurrency', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, fields: {} }));
    const sourceConnector = createSourceConnector(records);
    const { connector: targetConnector, tracker } = createTargetConnector(30);

    const service = createService(sourceConnector, targetConnector);
    const config = createConfig();

    const startSeq = Date.now();
    await service['executeSync'](config, { concurrency: 1 });
    const seqDuration = Date.now() - startSeq;

    const sourceConnector2 = createSourceConnector(records);
    const { connector: targetConnector2, tracker: tracker2 } = createTargetConnector(30);
    const service2 = createService(sourceConnector2, targetConnector2);

    const startCon = Date.now();
    await service2['executeSync'](config, { concurrency: 2 });
    const conDuration = Date.now() - startCon;

    expect(tracker.maxConcurrent).toBeLessThanOrEqual(1);
    expect(tracker2.maxConcurrent).toBeLessThanOrEqual(2);
    expect(conDuration).toBeLessThan(seqDuration - 50);
  });

  it('aggregates errors without exceeding concurrency limit', async () => {
    const records = [
      { id: '1', fields: {} },
      { id: 'fail', fields: {} },
      { id: '2', fields: {} },
    ];
    const sourceConnector = createSourceConnector(records);
    const { connector: targetConnector, tracker } = createTargetConnector(10, new Set(['fail']));

    const service = createService(sourceConnector, targetConnector);
    const config = createConfig();

    const result = await service['executeSync'](config, { concurrency: 2 });

    expect(result.recordsProcessed).toBe(3);
    expect(result.recordsSuccessful).toBe(2);
    expect(result.recordsFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(tracker.maxConcurrent).toBeLessThanOrEqual(2);
  });
});
