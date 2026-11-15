import { AutonomousDecisionEngine, DecisionContext } from '../../../src/services/AutonomousDecisionEngine';
import { Logger } from '../../../src/utils/Logger';
import { jest } from '@jest/globals';

describe('AutonomousDecisionEngine', () => {
    let engine: AutonomousDecisionEngine;
    let mockLogger: Logger;

    beforeEach(() => {
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
        } as unknown as Logger;

        engine = new AutonomousDecisionEngine(mockLogger);
    });

    it('should approve high confidence actions', async () => {
        const context: DecisionContext = {
            action: 'create_mapping',
            entityType: 'customer',
            confidence: 0.95,
            source: 'ai_model',
        };

        const result = await engine.evaluate(context);

        expect(result.approved).toBe(true);
        expect(result.requiresHumanReview).toBe(false);
        expect(result.reason).toBe('High confidence score');
    });

    it('should require review for medium confidence actions', async () => {
        const context: DecisionContext = {
            action: 'create_mapping',
            entityType: 'customer',
            confidence: 0.75,
            source: 'ai_model',
        };

        const result = await engine.evaluate(context);

        expect(result.approved).toBe(false);
        expect(result.requiresHumanReview).toBe(true);
        expect(result.reason).toBe('Medium confidence - requires verification');
    });

    it('should reject low confidence actions', async () => {
        const context: DecisionContext = {
            action: 'create_mapping',
            entityType: 'customer',
            confidence: 0.5,
            source: 'ai_model',
        };

        const result = await engine.evaluate(context);

        expect(result.approved).toBe(false);
        expect(result.requiresHumanReview).toBe(true);
        expect(result.reason).toBe('Low confidence score');
    });
});
