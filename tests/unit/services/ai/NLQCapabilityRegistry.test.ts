/**
 * Unit tests for NLQCapabilityRegistry
 * Phase 1: AI-Enhanced SuiteCentral 2.0
 */

import { NLQCapabilityRegistry } from '../../../../src/services/ai/NLQCapabilityRegistry';

// Mock logger
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as any;

describe('NLQCapabilityRegistry', () => {
    let registry: NLQCapabilityRegistry;

    beforeEach(() => {
        jest.clearAllMocks();
        registry = new NLQCapabilityRegistry(mockLogger);
    });

    describe('initialization', () => {
        it('should initialize with default capabilities', () => {
            expect(registry).toBeDefined();
            expect(mockLogger.info).toHaveBeenCalledWith('NLQCapabilityRegistry initialized');
        });

        it('should register default capabilities', () => {
            const capabilities = registry.getAllCapabilities();
            expect(capabilities.length).toBeGreaterThan(0);
        });
    });

    describe('getAllCapabilities', () => {
        it('should return all registered capabilities', () => {
            const capabilities = registry.getAllCapabilities();

            expect(capabilities).toBeInstanceOf(Array);
            expect(capabilities.length).toBeGreaterThanOrEqual(10);

            const capability = capabilities[0];
            expect(capability.id).toBeDefined();
            expect(capability.name).toBeDefined();
            expect(capability.module).toBeDefined();
            expect(capability.queryPatterns).toBeInstanceOf(Array);
        });
    });

    describe('getModuleCapabilities', () => {
        it('should return capabilities for specific module', () => {
            const supplierCapabilities = registry.getModuleCapabilities('SupplierCentral');

            expect(supplierCapabilities).toBeInstanceOf(Array);
            expect(supplierCapabilities.length).toBeGreaterThan(0);

            for (const cap of supplierCapabilities) {
                expect(cap.module).toBe('SupplierCentral');
            }
        });
    });

    describe('resolveQuery', () => {
        const userPermissions = ['supplier:read', 'payment:read', 'sync:read', 'admin:read'];

        it('should resolve supplier-related queries', () => {
            const result = registry.resolveQuery('show me supplier metrics', userPermissions);

            expect(result).not.toBeNull();
            expect(result?.capability.module).toBe('SupplierCentral');
            expect(result?.confidence).toBeGreaterThan(0.3);
        });

        it('should resolve payment-related queries', () => {
            const result = registry.resolveQuery('what is our payment success rate', userPermissions);

            expect(result).not.toBeNull();
            expect(result?.capability.id).toContain('payment');
        });

        it('should resolve sync health queries', () => {
            const result = registry.resolveQuery('how healthy are our syncs', userPermissions);

            expect(result).not.toBeNull();
            expect(result?.capability.id).toBe('sync-health');
        });

        it('should resolve anomaly queries', () => {
            const result = registry.resolveQuery('what is wrong', userPermissions);

            expect(result).not.toBeNull();
            expect(result?.capability.id).toBe('anomaly-detection');
        });

        it('should return null for unrecognized queries', () => {
            const result = registry.resolveQuery('xyzzy foobar nonsense', userPermissions);

            expect(result).toBeNull();
        });

        it('should include alternative capabilities', () => {
            const result = registry.resolveQuery('supplier metrics', userPermissions);

            expect(result).not.toBeNull();
            expect(result?.alternativeCapabilities).toBeInstanceOf(Array);
        });

        it('should extract parameters from query', () => {
            const result = registry.resolveQuery('supplier risk for vendor ABC123', userPermissions);

            expect(result).not.toBeNull();
            if (result?.extractedParameters.vendorId) {
                expect(result.extractedParameters.vendorId).toBe('ABC123');
            }
        });
    });

    describe('checkPermissions', () => {
        it('should allow access with correct permissions', () => {
            const capability = registry.getAllCapabilities().find(c => c.id === 'supplier-dashboard');
            expect(capability).toBeDefined();

            const result = registry.checkPermissions(capability!, ['supplier:read']);

            expect(result.allowed).toBe(true);
            expect(result.missingPermissions).toHaveLength(0);
        });

        it('should deny access without required permissions', () => {
            const capability = registry.getAllCapabilities().find(c => c.id === 'supplier-dashboard');
            expect(capability).toBeDefined();

            const result = registry.checkPermissions(capability!, ['payment:read']);

            expect(result.allowed).toBe(false);
            expect(result.missingPermissions).toContain('supplier:read');
        });

        it('should allow admin wildcard permission', () => {
            const capability = registry.getAllCapabilities().find(c => c.id === 'supplier-dashboard');
            expect(capability).toBeDefined();

            const result = registry.checkPermissions(capability!, ['admin:*']);

            expect(result.allowed).toBe(true);
        });
    });

    describe('register', () => {
        it('should register a new capability', () => {
            const newCapability = {
                id: 'test-capability',
                name: 'Test Capability',
                module: 'SupplierCentral' as const,
                apiEndpoint: '/api/test',
                httpMethod: 'GET' as const,
                description: 'Test capability',
                queryPatterns: ['test query'],
                requiredPermissions: ['test:read'],
                examples: [],
            };

            registry.register(newCapability);

            const capabilities = registry.getAllCapabilities();
            const found = capabilities.find(c => c.id === 'test-capability');

            expect(found).toBeDefined();
            expect(found?.name).toBe('Test Capability');
        });
    });
});
