/**
 * SyncCentralOrchestrator Attribution Tests
 * PR3 (F6 sub-project B): the verified admin, not the sentinel, must be the
 * actor recorded on durable audit_logs rows behind connector writes.
 */

import { SyncCentralOrchestrator } from '../../../../src/services/sync/SyncCentralOrchestrator';
import type { SyncOperation, SyncDataRecord } from '../../../../src/services/sync/SyncCentralOrchestrator';
import type { Logger } from '../../../../src/utils/Logger';
import type { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';
import {
    createMockOwnershipResolver,
    createMockAuditService,
    createMockApprovalQueueService,
} from '../../../governanceTestUtils';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

function createMockLogger(): jest.Mocked<Logger> {
    return {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    } as any;
}

function createMockConnectorManager(): jest.Mocked<ConnectorManager> {
    return {
        getConnector: jest.fn(),
        listConnectors: jest.fn(),
        registerConnector: jest.fn(),
    } as any;
}

function createMockConnector(listData: SyncDataRecord[] = []) {
    return {
        list: jest.fn().mockResolvedValue(listData),
        search: jest.fn().mockResolvedValue(listData),
        read: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new_1' }),
        update: jest.fn().mockResolvedValue({ id: 'upd_1' }),
        delete: jest.fn().mockResolvedValue(true),
    };
}

const auditService = createMockAuditService();
const logGovernanceCheck = auditService.logGovernanceCheck as jest.Mock;

// The mock is module-scoped, so without this the second test can pass by
// reading the FIRST test's recorded row. Clear it per test.
beforeEach(() => logGovernanceCheck.mockClear());

// createOperation's exact parameter type (SyncCentralOrchestrator.ts:232) —
// `status` is omitted too, not just id/metadata. All three are set by the
// method, not the caller.
const baseOperation: Omit<SyncOperation, 'id' | 'status' | 'metadata'> = {
    name: 'attr',
    sourceSystem: 'salesforce',
    targetSystem: 'netsuite',
    entityType: 'customer',
    direction: 'source-to-target',
    fieldMappings: [{ sourceField: 'name', targetField: 'name', required: true }],
    conflictResolution: 'source-wins',
};

describe('SyncCentralOrchestrator - attribution', () => {
    let logger: jest.Mocked<Logger>;
    let connectorManager: jest.Mocked<ConnectorManager>;
    let orchestrator: SyncCentralOrchestrator;
    let sourceConnector: ReturnType<typeof createMockConnector>;
    let targetConnector: ReturnType<typeof createMockConnector>;

    beforeEach(() => {
        logger = createMockLogger();
        connectorManager = createMockConnectorManager();

        sourceConnector = createMockConnector([{ id: 's1', fields: { name: 'A' } }]);
        targetConnector = createMockConnector();
        connectorManager.getConnector
            .mockResolvedValueOnce(sourceConnector as any)
            .mockResolvedValueOnce(targetConnector as any);

        orchestrator = new SyncCentralOrchestrator(
            logger,
            connectorManager,
            undefined,
            createMockOwnershipResolver() as any,
            auditService as any,
            createMockApprovalQueueService() as any,
        );
    });

    it('stamps the verified admin as requesterUserId, not the sentinel', async () => {
        const op = await orchestrator.createOperation(baseOperation);
        await orchestrator.executeSync(op.id, 'admin-42');

        // guardedWrite logs the same requesterUserId on both its rejection
        // and success paths, so asserting only on the audit row's userId
        // would pass even if the connector write never happened. Assert the
        // write itself landed so this is proof of the sync, not just of
        // attribution.
        expect(targetConnector.create).toHaveBeenCalled();

        expect(logGovernanceCheck).toHaveBeenCalled();
        const row = logGovernanceCheck.mock.calls[0][0];
        expect(row.userId).toBe('admin-42');
        expect(row.userId).not.toBe(SYSTEM_IDENTITY.userId);
    });

    it('keeps the operation system-scoped — tenantId is unchanged', async () => {
        const op = await orchestrator.createOperation(baseOperation);
        await orchestrator.executeSync(op.id, 'admin-42');

        const row = logGovernanceCheck.mock.calls[0][0];
        expect(row.tenantId).toBe(SYSTEM_IDENTITY.tenantId);
    });
});
