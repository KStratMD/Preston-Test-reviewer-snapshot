import 'reflect-metadata';
import { EntityMatchingService, EntityRecord } from '../../../../src/services/mdm/EntityMatchingService';
import { Logger } from '../../../../src/utils/Logger';

describe('EntityMatchingService', () => {
    let service: EntityMatchingService;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        } as any;

        service = new EntityMatchingService(mockLogger, undefined, undefined);
    });

    describe('calculateMatchScore', () => {
        it('should return score of 1 for exact match', () => {
            const entityA: EntityRecord = {
                id: '1',
                sourceSystem: 'netsuite',
                entityType: 'vendor',
                data: {
                    name: 'Acme Corp',
                    email: 'contact@acme.com',
                    phone: '555-0100',
                    address: '123 Main St',
                    taxId: 'US-12345'
                }
            };

            const entityB: EntityRecord = {
                id: '2',
                sourceSystem: 'shopify',
                entityType: 'vendor',
                data: {
                    name: 'Acme Corp',
                    email: 'contact@acme.com',
                    phone: '555-0100',
                    address: '123 Main St',
                    taxId: 'US-12345'
                }
            };

            const result = service.calculateMatchScore(entityA, entityB);
            expect(result.score).toBe(1);
        });

        it('should return lower score for fuzzy match', () => {
            const entityA: EntityRecord = {
                id: '1',
                sourceSystem: 'netsuite',
                entityType: 'vendor',
                data: {
                    name: 'Acme Corp',
                    email: 'contact@acme.com'
                }
            };

            const entityB: EntityRecord = {
                id: '2',
                sourceSystem: 'shopify',
                entityType: 'vendor',
                data: {
                    name: 'Acme Corporation', // Slight difference
                    email: 'info@acme.com' // Different email
                }
            };

            const result = service.calculateMatchScore(entityA, entityB);
            expect(result.score).toBeLessThan(1);
            expect(result.score).toBeGreaterThan(0);
        });

        it('should return 0 for different entity types', () => {
            const entityA: EntityRecord = {
                id: '1',
                sourceSystem: 'netsuite',
                entityType: 'vendor',
                data: {}
            };

            const entityB: EntityRecord = {
                id: '2',
                sourceSystem: 'shopify',
                entityType: 'customer',
                data: {}
            };

            const result = service.calculateMatchScore(entityA, entityB);
            expect(result.score).toBe(0);
        });
    });

    describe('findMatches', () => {
        it('should return candidates above threshold', async () => {
            const entity: EntityRecord = {
                id: '1',
                sourceSystem: 'netsuite',
                entityType: 'vendor',
                data: { name: 'Acme Corp' }
            };

            const candidates: EntityRecord[] = [
                { id: '2', sourceSystem: 'shopify', entityType: 'vendor', data: { name: 'Acme Corp' } }, // High match
                { id: '3', sourceSystem: 'salesforce', entityType: 'vendor', data: { name: 'Different' } } // Low match
            ];

            const matches = await service.findMatches(entity, candidates, 0.5);
            expect(matches).toHaveLength(1);
            expect(matches[0].entityB.id).toBe('2');
        });
    });
});
