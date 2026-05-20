import { ActiveLearningService, UserFeedback } from '../../../../../src/services/ai/learning/ActiveLearningService';
import { GoldenDatasetService } from '../../../../../src/services/ai/learning/GoldenDatasetService';
import { AutonomousDecisionEngine } from '../../../../../src/services/AutonomousDecisionEngine';
import { jest } from '@jest/globals';

describe('ActiveLearningService', () => {
    let service: ActiveLearningService;
    let mockGoldenDataset: GoldenDatasetService;
    let mockAutonomousDecisionEngine: AutonomousDecisionEngine;

    beforeEach(() => {
        mockGoldenDataset = {
            addExample: jest.fn(),
        } as unknown as GoldenDatasetService;

        mockAutonomousDecisionEngine = {
            evaluate: jest.fn<any>().mockResolvedValue({
                approved: true,
                reason: 'Test approval',
                requiresHumanReview: false,
                confidenceThreshold: 0.9
            }),
        } as unknown as AutonomousDecisionEngine;

        service = new ActiveLearningService(
            mockGoldenDataset,
            mockAutonomousDecisionEngine,
            { minFeedbackForGoldenSet: 1, minApprovalRateForGoldenSet: 50 }
        );
    });

    it('should use AutonomousDecisionEngine to evaluate golden set promotion', async () => {
        const feedback: Omit<UserFeedback, 'id' | 'timestamp'> = {
            userId: 'user1',
            sessionId: 'session1',
            originalSuggestion: {
                sourceField: 'email',
                targetField: 'email',
                confidence: 0.9,
                transformationType: 'direct',
                reasoning: 'test'
            },
            feedbackType: 'approved',
            sourceSystem: 'Salesforce',
            targetSystem: 'NetSuite',
            sourceFieldMetadata: { name: 'Email', type: 'email' }
        };

        // We need to record feedback twice to trigger the check (since we filter for similar feedback)
        // Actually, recordFeedback adds to store first, then checks.
        // So one call should be enough if minFeedbackForGoldenSet is 1.

        // However, checkGoldenSetPromotion filters feedbackStore.
        // So when we call recordFeedback, it adds to store, then calls checkGoldenSetPromotion.
        // checkGoldenSetPromotion sees the just-added feedback.

        await service.recordFeedback(feedback);

        expect(mockAutonomousDecisionEngine.evaluate).toHaveBeenCalled();
        expect(mockGoldenDataset.addExample).toHaveBeenCalled();
    });

    it('should not promote if AutonomousDecisionEngine rejects', async () => {
        (mockAutonomousDecisionEngine.evaluate as jest.Mock<any>).mockResolvedValueOnce({
            approved: false,
            reason: 'Test rejection',
            requiresHumanReview: true,
            confidenceThreshold: 0.9
        });

        const feedback: Omit<UserFeedback, 'id' | 'timestamp'> = {
            userId: 'user1',
            sessionId: 'session1',
            originalSuggestion: {
                sourceField: 'phone',
                targetField: 'phone',
                confidence: 0.8,
                transformationType: 'direct',
                reasoning: 'test'
            },
            feedbackType: 'approved',
            sourceSystem: 'Salesforce',
            targetSystem: 'NetSuite',
            sourceFieldMetadata: { name: 'Phone', type: 'phone' }
        };

        await service.recordFeedback(feedback);

        expect(mockAutonomousDecisionEngine.evaluate).toHaveBeenCalled();
        expect(mockGoldenDataset.addExample).not.toHaveBeenCalled();
    });
});
