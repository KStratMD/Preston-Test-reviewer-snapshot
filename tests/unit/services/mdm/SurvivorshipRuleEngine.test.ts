import 'reflect-metadata';
import { SurvivorshipRuleEngine, FieldValue } from '../../../../src/services/mdm/SurvivorshipRuleEngine';
import { Logger } from '../../../../src/utils/Logger';

describe('SurvivorshipRuleEngine', () => {
    let service: SurvivorshipRuleEngine;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        } as any;

        service = new SurvivorshipRuleEngine(mockLogger);
    });

    describe('applyRule', () => {
        it('should apply most_recent strategy correctly', () => {
            const values: FieldValue[] = [
                {
                    sourceSystem: 'old',
                    value: 'Old Value',
                    updatedAt: new Date('2023-01-01')
                },
                {
                    sourceSystem: 'new',
                    value: 'New Value',
                    updatedAt: new Date('2024-01-01')
                }
            ];

            const result = service.applyRule('vendor', 'email', values);
            expect(result.selectedValue).toBe('New Value');
            expect(result.selectedSource).toBe('new');
        });

        it('should apply most_complete strategy correctly', () => {
            // Mock rule override for this test if needed, but 'name' for vendor is most_complete by default in DEFAULT_RULES
            const values: FieldValue[] = [
                {
                    sourceSystem: 'short',
                    value: 'Acme',
                    updatedAt: new Date('2024-01-01')
                },
                {
                    sourceSystem: 'long',
                    value: 'Acme Corporation International',
                    updatedAt: new Date('2023-01-01')
                }
            ];

            const result = service.applyRule('vendor', 'name', values);
            expect(result.selectedValue).toBe('Acme Corporation International');
            expect(result.selectedSource).toBe('long');
        });

        it('should apply source_priority strategy correctly', () => {
            // 'taxId' for vendor is source_priority [netsuite, bc]
            const values: FieldValue[] = [
                {
                    sourceSystem: 'bc',
                    value: 'BC-Tax-ID',
                    updatedAt: new Date('2024-01-01')
                },
                {
                    sourceSystem: 'netsuite',
                    value: 'NS-Tax-ID',
                    updatedAt: new Date('2023-01-01')
                }
            ];

            const result = service.applyRule('vendor', 'taxId', values);
            expect(result.selectedValue).toBe('NS-Tax-ID'); // NetSuite is higher priority
            expect(result.selectedSource).toBe('netsuite');
        });
    });

    describe('mergeEntities', () => {
        it('should merge two entities into one', () => {
            const entities = [
                {
                    sourceSystem: 'netsuite',
                    data: { name: 'Acme', email: 'old@example.com' },
                    updatedAt: new Date('2023-01-01')
                },
                {
                    sourceSystem: 'shopify',
                    data: { name: 'Acme Corp', email: 'new@example.com' },
                    updatedAt: new Date('2024-01-01')
                }
            ];

            // name -> most_complete (Acme Corp)
            // email -> most_recent (new@example.com)
            const { mergedData } = service.mergeEntities('vendor', entities);

            expect(mergedData.name).toBe('Acme Corp');
            expect(mergedData.email).toBe('new@example.com');
        });
    });

    describe('getRules (async)', () => {
        it('should return default rules', async () => {
            const rules = await service.getRules();
            expect(rules.length).toBeGreaterThan(0);
        });
    });

    describe('setRule (async)', () => {
        it('should add a rule to in-memory cache', async () => {
            await service.setRule({
                id: 'test-rule',
                entityType: 'vendor',
                fieldName: 'test',
                strategy: 'most_recent',
                priority: 1,
            });

            const rules = await service.getRules();
            expect(rules.find(r => r.id === 'test-rule')).toBeDefined();
        });
    });

    describe('removeRule (async)', () => {
        it('should remove a rule from in-memory cache', async () => {
            await service.setRule({
                id: 'rm-test',
                entityType: 'vendor',
                fieldName: 'rm',
                strategy: 'most_recent',
                priority: 1,
            });

            const result = await service.removeRule('rm-test');
            expect(result).toBe('deleted');
        });

        it('should return not_found for non-existent rule', async () => {
            const result = await service.removeRule('nonexistent');
            expect(result).toBe('not_found');
        });
    });

    describe('rule precedence (deterministic tie-breaking)', () => {
        it('should pick lowest priority number when duplicate (entity_type, field_name) rules exist', async () => {
            // Add two rules for the same (vendor, website) — different strategies, different priorities
            await service.setRule({
                id: 'vw-low-priority',
                entityType: 'vendor',
                fieldName: 'website',
                strategy: 'most_recent',
                priority: 10,
            });
            await service.setRule({
                id: 'vw-high-priority',
                entityType: 'vendor',
                fieldName: 'website',
                strategy: 'most_complete',
                priority: 1,
            });

            const values: FieldValue[] = [
                { sourceSystem: 'ns', value: 'https://example.com', updatedAt: new Date('2026-02-01') },
                { sourceSystem: 'bc', value: 'https://example.com/about-us-full-path', updatedAt: new Date('2025-01-01') },
            ];

            const result = service.applyRule('vendor', 'website', values);

            // Priority 1 rule uses most_complete → picks the longer URL from bc
            expect(result.selectedSource).toBe('bc');
            expect(result.reason).toBe('Most complete value');
        });

        it('should prefer exact match over wildcard even if wildcard has lower priority number', async () => {
            await service.setRule({
                id: 'wildcard-vendor',
                entityType: 'vendor',
                fieldName: '*',
                strategy: 'frequency',
                priority: 0, // Lower number = would win if considered
            });

            // The seeded exact rule v-email (priority 2, most_recent) should still beat the wildcard
            const values: FieldValue[] = [
                { sourceSystem: 'ns', value: 'old@example.com', updatedAt: new Date('2026-02-01') },
                { sourceSystem: 'bc', value: 'new@example.com', updatedAt: new Date('2024-01-01') },
            ];

            const result = service.applyRule('vendor', 'email', values);

            // Exact match tier wins over wildcard tier regardless of priority number
            expect(result.reason).toBe('Most recently updated');
            expect(result.selectedSource).toBe('ns');
        });
    });
});
