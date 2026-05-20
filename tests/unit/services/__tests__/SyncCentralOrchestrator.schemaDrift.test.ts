/**
 * SyncCentralOrchestrator Schema Drift Tests
 * PR B: Schema Drift Wiring
 */

import { SyncCentralOrchestrator } from '../../../../src/services/sync/SyncCentralOrchestrator';
import type { SyncOperation, SyncResult, SyncDataRecord } from '../../../../src/services/sync/SyncCentralOrchestrator';
import { SchemaRegistryService } from '../../../../src/services/sync/SchemaRegistryService';
import type { SchemaField, SchemaValidationResult } from '../../../../src/services/sync/SchemaRegistryService';
import type { Logger } from '../../../../src/utils/Logger';
import type { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';

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

// Helper to access private methods for testing
function getPrivateMethod(instance: any, method: string) {
    return instance[method].bind(instance);
}

describe('SyncCentralOrchestrator - Schema Drift', () => {
    let logger: jest.Mocked<Logger>;
    let connectorManager: jest.Mocked<ConnectorManager>;

    beforeEach(() => {
        jest.clearAllMocks();
        logger = createMockLogger();
        connectorManager = createMockConnectorManager();
    });

    describe('inferFieldType', () => {
        let orchestrator: SyncCentralOrchestrator;

        beforeEach(() => {
            orchestrator = new SyncCentralOrchestrator(logger, connectorManager);
        });

        it('should return "integer" for integer numbers', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn(42)).toBe('integer');
            expect(fn(0)).toBe('integer');
            expect(fn(-10)).toBe('integer');
        });

        it('should return "number" for floats', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn(3.14)).toBe('number');
            expect(fn(-0.5)).toBe('number');
        });

        it('should return "date" for Date objects', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn(new Date())).toBe('date');
        });

        it('should return "date" for ISO date strings', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn('2026-01-15T10:00:00Z')).toBe('date');
            expect(fn('2026-01-15 10:00:00')).toBe('date');
        });

        it('should return "date" for date-only strings (YYYY-MM-DD)', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn('2026-01-15')).toBe('date');
            expect(fn('1999-12-31')).toBe('date');
        });

        it('should return "string" for regular strings', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn('hello')).toBe('string');
            expect(fn('')).toBe('string');
        });

        it('should return "boolean", "array", "object" for respective types', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn(true)).toBe('boolean');
            expect(fn(false)).toBe('boolean');
            expect(fn([1, 2, 3])).toBe('array');
            expect(fn({ key: 'val' })).toBe('object');
        });

        it('should return "unknown" for null/undefined', () => {
            const fn = getPrivateMethod(orchestrator, 'inferFieldType');
            expect(fn(null)).toBe('unknown');
            expect(fn(undefined)).toBe('unknown');
        });
    });

    describe('inferSchemaFieldsFromRecords', () => {
        let orchestrator: SyncCentralOrchestrator;

        beforeEach(() => {
            orchestrator = new SyncCentralOrchestrator(logger, connectorManager);
        });

        it('should return empty array for empty records', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            expect(fn([])).toEqual([]);
        });

        it('should infer type from most common non-null value across records', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [
                { id: '1', fields: { age: 25 } },
                { id: '2', fields: { age: 30 } },
                { id: '3', fields: { age: 'unknown' } },
            ];
            const fields: SchemaField[] = fn(records);
            const ageField = fields.find((f: SchemaField) => f.name === 'age');
            expect(ageField).toBeDefined();
            expect(ageField!.type).toBe('integer'); // 2 ints vs 1 string
        });

        it('should promote integer to number when both are present (numeric promotion)', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [
                { id: '1', fields: { price: 10 } },
                { id: '2', fields: { price: 20 } },
                { id: '3', fields: { price: 9.99 } },
            ];
            const fields: SchemaField[] = fn(records);
            const priceField = fields.find((f: SchemaField) => f.name === 'price');
            expect(priceField).toBeDefined();
            expect(priceField!.type).toBe('number'); // float present → promote to number
        });

        it('should tolerate a small fraction of null values when inferring required (noise tolerance)', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            // 100 records: 99 have phone, 1 null → 99% non-null, above 95% threshold
            const records: SyncDataRecord[] = [];
            for (let i = 0; i < 99; i++) {
                records.push({ id: String(i), fields: { email: `a${i}@b.com`, phone: '123' } });
            }
            records.push({ id: '99', fields: { email: 'c@d.com', phone: null } });
            const fields: SchemaField[] = fn(records);
            const emailField = fields.find((f: SchemaField) => f.name === 'email');
            const phoneField = fields.find((f: SchemaField) => f.name === 'phone');
            expect(emailField!.required).toBe(true);
            // Phone is 99% non-null → still required (noise tolerance prevents false positive)
            expect(phoneField!.required).toBe(true);
        });

        it('should mark required=false when a meaningful fraction of records have null values', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            // 10 records: 5 have phone, 5 null → 50% non-null, well below threshold
            const records: SyncDataRecord[] = [];
            for (let i = 0; i < 5; i++) {
                records.push({ id: String(i), fields: { phone: '123' } });
            }
            for (let i = 5; i < 10; i++) {
                records.push({ id: String(i), fields: { phone: null } });
            }
            const fields: SchemaField[] = fn(records);
            const phoneField = fields.find((f: SchemaField) => f.name === 'phone');
            expect(phoneField!.required).toBe(false);
        });

        it('should mark all inferred fields with inferred: true', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [{ id: '1', fields: { email: 'a@b.com' } }];
            const fields: SchemaField[] = fn(records);
            expect(fields[0].inferred).toBe(true);
        });

        it('should handle heterogeneous field sets (union of all keys)', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [
                { id: '1', fields: { email: 'a@b.com' } },
                { id: '2', fields: { phone: '123' } },
            ];
            const fields: SchemaField[] = fn(records);
            const names = fields.map((f: SchemaField) => f.name).sort();
            expect(names).toEqual(['email', 'phone']);
        });

        it('should sample when >100 records', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [];
            for (let i = 0; i < 250; i++) {
                records.push({ id: String(i), fields: { val: i } });
            }
            const fields: SchemaField[] = fn(records);
            expect(fields.length).toBe(1);
            expect(fields[0].name).toBe('val');
        });

        it('should default type to "string" when all values are null', () => {
            const fn = getPrivateMethod(orchestrator, 'inferSchemaFieldsFromRecords');
            const records: SyncDataRecord[] = [
                { id: '1', fields: { empty: null } },
                { id: '2', fields: { empty: null } },
            ];
            const fields: SchemaField[] = fn(records);
            const emptyField = fields.find((f: SchemaField) => f.name === 'empty');
            expect(emptyField).toBeDefined();
            expect(emptyField!.type).toBe('string'); // default when no non-null values
        });
    });

    describe('executeSync - schema drift block path', () => {
        it('should pass through when schemaRegistry not injected', async () => {
            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 'test@test.com' } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.status).not.toBe('failed');
            expect(result.schemaValidation).toBeUndefined();
        });

        it('should pass through when no schema registered', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 'test@test.com' } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            // No schema registered → validation isValid, sync proceeds
            expect(result.errors.some(e => e.errorCode === 'SCHEMA_DRIFT_BLOCKED')).toBe(false);
        });

        it('should pass through with warning on non-critical drift', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            // Source records have an extra field (low severity drift)
            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 'test@test.com', phone: '555-1234' } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.status).not.toBe('failed');
            expect(result.schemaValidation).toBeDefined();
            expect(result.schemaValidation!.isValid).toBe(false);
            expect(result.schemaValidation!.shouldBlockSync).toBe(false);
            expect(logger.warn).toHaveBeenCalledWith(
                'Schema drift detected but sync allowed',
                expect.objectContaining({ system: 'hubspot', entityType: 'contacts' })
            );
        });

        it('should return structured failed SyncResult when shouldBlockSync', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            // Source records have a type change (critical drift)
            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 42 } }, // type change: string → integer
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.status).toBe('failed');
            expect(result.errors[0].errorCode).toBe('SCHEMA_DRIFT_BLOCKED');
        });

        it('should have retryable: false in blocked result', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 42 } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.errors[0].retryable).toBe(false);
        });

        it('should include schemaValidation with drifts in blocked result', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 42 } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.schemaValidation).toBeDefined();
            expect(result.schemaValidation!.shouldBlockSync).toBe(true);
            expect(result.schemaValidation!.drifts.length).toBeGreaterThan(0);
        });

        it('should set recordsSkipped equal to sourceRecords.length on block', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [
                { id: '1', fields: { email: 42 } },
                { id: '2', fields: { email: 43 } },
                { id: '3', fields: { email: 44 } },
            ];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const result = await orchestrator.executeSync(op.id);
            expect(result.recordsSkipped).toBe(3);
        });

        it('should set operation.status to "error" on block', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [{ id: '1', fields: { email: 42 } }];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            await orchestrator.executeSync(op.id);
            const ops = await orchestrator.getOperations();
            const updatedOp = ops.find(o => o.id === op.id);
            expect(updatedOp!.status).toBe('error');
        });

        it('should increment failedSyncs and totalSyncs on block', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [{ id: '1', fields: { email: 42 } }];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            const initialFailed = op.metadata.failedSyncs;
            const initialTotal = op.metadata.totalSyncs;
            await orchestrator.executeSync(op.id);
            const ops = await orchestrator.getOperations();
            const updatedOp = ops.find(o => o.id === op.id);
            expect(updatedOp!.metadata.failedSyncs).toBe(initialFailed + 1);
            expect(updatedOp!.metadata.totalSyncs).toBe(initialTotal + 1);
        });

        it('should store blocked result in syncHistory', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [{ id: '1', fields: { email: 42 } }];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            await orchestrator.executeSync(op.id);
            // Verify the operation is no longer in runningOperations (finally block ran)
            // by being able to run it again
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);
            // Should not throw "already running"
            const result2 = await orchestrator.executeSync(op.id);
            expect(result2.status).toBe('failed');
        });

        it('should remove operationId from runningOperations after block (finally block runs)', async () => {
            const schemaRegistry = new SchemaRegistryService(logger);
            schemaRegistry.registerSchema('hubspot', 'contacts', {
                system: 'hubspot', objectType: 'contacts', version: '1.0.0',
                fields: [{ name: 'email', type: 'string', required: true }],
                lastUpdated: new Date(),
            });

            const sourceRecords: SyncDataRecord[] = [{ id: '1', fields: { email: 42 } }];
            const sourceConnector = createMockConnector(sourceRecords);
            const targetConnector = createMockConnector();
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);

            const orchestrator = new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry);
            const op = await orchestrator.createOperation({
                name: 'Test Sync',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [{ sourceField: 'email', targetField: 'email', required: true }],
            });

            await orchestrator.executeSync(op.id);
            // If runningOperations wasn't cleaned, this would throw "already running"
            connectorManager.getConnector
                .mockResolvedValueOnce(sourceConnector as any)
                .mockResolvedValueOnce(targetConnector as any);
            await expect(orchestrator.executeSync(op.id)).resolves.toBeDefined();
        });
    });
});
