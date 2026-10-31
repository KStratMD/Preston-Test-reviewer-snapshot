/**
 * Codex round 2 on PR #1253 (finding 1, High): SyncCentralOrchestrator carries
 * its own legacy FieldMapping (baselined by the mapping-contract gate) whose
 * `transformation` union includes 'custom', but transformRecord()'s switch had
 * no case for it — the source value passed through, the connector write ran,
 * and the record counted as a success. Until the legacy shape is retired it
 * must at least fail closed: an unimplemented transformation is a per-record
 * failure and nothing is written.
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

function createMockLogger(): jest.Mocked<Logger> {
    return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } as any;
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

function operationWith(fieldMappings: SyncOperation['fieldMappings']): Omit<SyncOperation, 'id' | 'status' | 'metadata'> {
    return {
        name: 'fail-closed',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        entityType: 'customer',
        direction: 'source-to-target',
        fieldMappings,
        conflictResolution: 'source-wins',
    };
}

describe('SyncCentralOrchestrator fails closed on an unimplemented transformation', () => {
    let orchestrator: SyncCentralOrchestrator;
    let sourceConnector: ReturnType<typeof createMockConnector>;
    let targetConnector: ReturnType<typeof createMockConnector>;

    beforeEach(() => {
        const connectorManager = { getConnector: jest.fn(), listConnectors: jest.fn(), registerConnector: jest.fn() } as unknown as jest.Mocked<ConnectorManager>;
        sourceConnector = createMockConnector([{ id: 's1', fields: { name: 'Acme' } }]);
        targetConnector = createMockConnector();
        connectorManager.getConnector.mockResolvedValueOnce(sourceConnector as any).mockResolvedValueOnce(targetConnector as any);
        orchestrator = new SyncCentralOrchestrator(
            createMockLogger(),
            connectorManager,
            undefined,
            createMockOwnershipResolver() as any,
            createMockAuditService() as any,
            createMockApprovalQueueService() as any,
        );
    });

    it("counts a 'custom' transformation as a failed record and writes nothing", async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'name', targetField: 'companyname', transformation: 'custom', customTransform: 'throw new Error()', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(result.status).toBe('failed');
        expect(result.errors[0]?.message ?? JSON.stringify(result.errors[0])).toMatch(/'custom' is declared but not executable/);
        expect(targetConnector.create).not.toHaveBeenCalled();
        expect(targetConnector.update).not.toHaveBeenCalled();
    });

    it("rejects 'custom' even when the source field AND default are absent (Codex round 3: the check used to sit inside the value condition)", async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'ghost', targetField: 'companyname', transformation: 'custom', customTransform: 'x', required: false }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });
    it.each([['NaN', 'Acme'], ['Infinity', 'Infinity'], ['-Infinity', '-Infinity']])("counts a 'number' transformation that produces %s as failed and writes nothing (Codex rounds 4-5)", async (_label, raw) => {
        sourceConnector.list.mockResolvedValue([{ id: 's1', fields: { name: raw } }]);
        sourceConnector.search.mockResolvedValue([{ id: 's1', fields: { name: raw } }]);
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'name', targetField: 'amount', transformation: 'number', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it('counts a record missing a REQUIRED source field as failed and writes nothing (Codex round 8)', async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'ghost', targetField: 'companyname', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(result.errors[0]?.message ?? JSON.stringify(result.errors[0])).toMatch(/required source field 'ghost' is missing/);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it('an OPTIONAL missing source is not a failure — the control for the required check', async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'ghost', targetField: 'companyname', required: false }, { sourceField: 'name', targetField: 'name', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(0);
        expect(targetConnector.create).toHaveBeenCalledTimes(1);
        // ...and the optional target is ABSENT, not an own property set to undefined.
        const written = targetConnector.create.mock.calls[0]?.[1]?.fields ?? targetConnector.create.mock.calls[0]?.[1];
        expect(written).not.toHaveProperty('companyname');
        expect(written).toHaveProperty('name', 'Acme');
    });
    it("refuses a targetField of '__proto__' instead of writing the output object's prototype (Codex round 10)", async () => {
        sourceConnector.list.mockResolvedValue([{ id: 's1', fields: { name: { polluted: true } } }]);
        sourceConnector.search.mockResolvedValue([{ id: 's1', fields: { name: { polluted: true } } }]);
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'name', targetField: '__proto__', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(result.errors[0]?.message ?? JSON.stringify(result.errors[0])).toMatch(/__proto__/);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it.each(['constructor', 'prototype', 'a.__proto__'])("refuses a sourceField of '%s' instead of reading it off Object.prototype (Codex round 10)", async (sourceField) => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField, targetField: 'name', required: false }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it.each([['', 'name'], ['name', ''], ['  ', 'name']])("refuses an empty field name (source '%s' -> target '%s') instead of writing its defaultValue (Codex round 11)", async (sourceField, targetField) => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField, targetField, required: true, defaultValue: 'FALLBACK' }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.recordsCreated).toBe(0);
        expect(result.errors[0]?.message ?? JSON.stringify(result.errors[0])).toMatch(/field name/);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it("a required sourceField of 'toString' the record does not own is missing, not Object.prototype's function (Codex round 13)", async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'toString', targetField: 'leaked', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(1);
        expect(result.errors[0]?.message ?? JSON.stringify(result.errors[0])).toMatch(/required source field 'toString' is missing/);
        expect(targetConnector.create).not.toHaveBeenCalled();
    });

    it("still executes the transformations it implements ('uppercase') — the control", async () => {
        const op = await orchestrator.createOperation(
            operationWith([{ sourceField: 'name', targetField: 'companyname', transformation: 'uppercase', required: true }]),
        );
        const result = await orchestrator.executeSync(op.id, 'admin-42');

        expect(result.recordsFailed).toBe(0);
        expect(targetConnector.create).toHaveBeenCalledTimes(1);
        expect(targetConnector.create.mock.calls[0]?.[1]?.fields ?? targetConnector.create.mock.calls[0]?.[1]).toMatchObject({ companyname: 'ACME' });
    });
});
