/**
 * SchemaRegistryService Tests
 * PR B: Schema Drift Wiring
 */

import { SchemaRegistryService } from '../../../../src/services/sync/SchemaRegistryService';
import type { SchemaDefinition, SchemaField } from '../../../../src/services/sync/SchemaRegistryService';
import type { Logger } from '../../../../src/utils/Logger';

function createMockLogger(): jest.Mocked<Logger> {
    return {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    } as any;
}

function makeSchema(fields: SchemaField[], system = 'netsuite', objectType = 'contacts'): SchemaDefinition {
    return { system, objectType, version: '1.0.0', fields, lastUpdated: new Date() };
}

describe('SchemaRegistryService', () => {
    let service: SchemaRegistryService;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger = createMockLogger();
        service = new SchemaRegistryService(mockLogger);
    });

    describe('registerSchema', () => {
        it('should store and return a hash', () => {
            const fields: SchemaField[] = [
                { name: 'email', type: 'string', required: true },
                { name: 'age', type: 'integer', required: false },
            ];
            const hash = service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            expect(typeof hash).toBe('string');
            expect(hash.length).toBe(64); // SHA-256 hex
        });

        it('should overwrite on re-register', () => {
            const fieldsA: SchemaField[] = [{ name: 'email', type: 'string', required: true }];
            const fieldsB: SchemaField[] = [{ name: 'email', type: 'string', required: true }, { name: 'name', type: 'string', required: false }];
            service.registerSchema('netsuite', 'contacts', makeSchema(fieldsA));
            service.registerSchema('netsuite', 'contacts', makeSchema(fieldsB));
            const schemas = service.getRegisteredSchemas();
            expect(schemas.length).toBe(1);
            expect(schemas[0].fieldCount).toBe(2);
        });

        it('should produce different hashes for different schemas', () => {
            const fieldsA: SchemaField[] = [{ name: 'email', type: 'string', required: true }];
            const fieldsB: SchemaField[] = [{ name: 'phone', type: 'string', required: false }];
            const hashA = service.registerSchema('netsuite', 'contacts', makeSchema(fieldsA));
            const hashB = service.registerSchema('netsuite', 'orders', makeSchema(fieldsB, 'netsuite', 'orders'));
            expect(hashA).not.toBe(hashB);
        });
    });

    describe('validateSchema', () => {
        it('should return isValid when no schema registered', () => {
            const fields: SchemaField[] = [{ name: 'email', type: 'string', required: true }];
            const result = service.validateSchema('netsuite', 'contacts', fields);
            expect(result.isValid).toBe(true);
            expect(result.shouldBlockSync).toBe(false);
            expect(result.drifts).toHaveLength(0);
        });

        it('should return isValid when schema matches', () => {
            const fields: SchemaField[] = [
                { name: 'email', type: 'string', required: true },
                { name: 'age', type: 'integer', required: false },
            ];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', fields);
            expect(result.isValid).toBe(true);
            expect(result.shouldBlockSync).toBe(false);
        });

        it('should detect removed fields', () => {
            const fields: SchemaField[] = [
                { name: 'email', type: 'string', required: true },
                { name: 'age', type: 'integer', required: false },
            ];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', [
                { name: 'email', type: 'string', required: true },
            ]);
            expect(result.isValid).toBe(false);
            expect(result.drifts.some(d => d.field === 'age' && d.changeType === 'removed')).toBe(true);
        });

        it('should detect added fields with low severity', () => {
            const fields: SchemaField[] = [{ name: 'email', type: 'string', required: true }];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', [
                { name: 'email', type: 'string', required: true },
                { name: 'phone', type: 'string', required: false },
            ]);
            expect(result.isValid).toBe(false);
            const addedDrift = result.drifts.find(d => d.field === 'phone');
            expect(addedDrift).toBeDefined();
            expect(addedDrift!.changeType).toBe('added');
            expect(addedDrift!.severity).toBe('low');
        });

        it('should detect type changes as critical', () => {
            const fields: SchemaField[] = [{ name: 'age', type: 'integer', required: true }];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', [
                { name: 'age', type: 'string', required: true },
            ]);
            expect(result.isValid).toBe(false);
            const typeDrift = result.drifts.find(d => d.field === 'age');
            expect(typeDrift).toBeDefined();
            expect(typeDrift!.severity).toBe('critical');
        });

        it('should block sync on critical drift', () => {
            const fields: SchemaField[] = [{ name: 'amount', type: 'number', required: true }];
            service.registerSchema('netsuite', 'orders', makeSchema(fields, 'netsuite', 'orders'));
            const result = service.validateSchema('netsuite', 'orders', [
                { name: 'amount', type: 'string', required: true },
            ]);
            expect(result.shouldBlockSync).toBe(true);
            expect(result.alertMessage).toContain('CRITICAL');
        });

        it('should not block sync on low/medium drift', () => {
            const fields: SchemaField[] = [{ name: 'email', type: 'string', required: true }];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', [
                { name: 'email', type: 'string', required: true },
                { name: 'phone', type: 'string', required: false },
            ]);
            expect(result.shouldBlockSync).toBe(false);
        });

        it('should block sync when required field becomes optional', () => {
            const fields: SchemaField[] = [
                { name: 'email', type: 'string', required: true },
                { name: 'name', type: 'string', required: true },
            ];
            service.registerSchema('netsuite', 'contacts', makeSchema(fields));
            const result = service.validateSchema('netsuite', 'contacts', [
                { name: 'email', type: 'string', required: true },
                { name: 'name', type: 'string', required: false },
            ]);
            expect(result.shouldBlockSync).toBe(true);
            const drift = result.drifts.find(d => d.field === 'name');
            expect(drift).toBeDefined();
            expect(drift!.severity).toBe('critical');
        });
    });

    describe('getRegisteredSchemas', () => {
        it('should return empty array initially', () => {
            expect(service.getRegisteredSchemas()).toHaveLength(0);
        });

        it('should list all registered schemas', () => {
            service.registerSchema('netsuite', 'contacts', makeSchema([{ name: 'email', type: 'string', required: true }]));
            service.registerSchema('hubspot', 'deals', makeSchema([{ name: 'amount', type: 'number', required: true }], 'hubspot', 'deals'));
            const schemas = service.getRegisteredSchemas();
            expect(schemas.length).toBe(2);
            expect(schemas.map(s => s.key).sort()).toEqual(['hubspot:deals', 'netsuite:contacts']);
        });
    });

    describe('clearSchema', () => {
        it('should return true and remove the schema', () => {
            service.registerSchema('netsuite', 'contacts', makeSchema([{ name: 'email', type: 'string', required: true }]));
            expect(service.clearSchema('netsuite', 'contacts')).toBe(true);
            expect(service.getRegisteredSchemas()).toHaveLength(0);
        });

        it('should return false for nonexistent schema', () => {
            expect(service.clearSchema('netsuite', 'contacts')).toBe(false);
        });
    });
});
