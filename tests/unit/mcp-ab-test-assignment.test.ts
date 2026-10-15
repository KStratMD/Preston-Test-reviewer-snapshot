/**
 * MCP A/B Test Assignment Logic Tests
 *
 * Tests the fix for P1 bug where A/B test assignment was bypassed for users
 * without explicit settings (using environment defaults instead).
 *
 * Solution: Added `is_explicit` flag to MCPUserSettings interface.
 * - is_explicit: true = user has database row (explicit preferences)
 * - is_explicit: false = using environment defaults (should use A/B hashing)
 *
 * This approach is more efficient than checking database existence separately
 * (1 query vs 2 queries).
 *
 * Based on Copilot's solution in PR 407 (copilot/sub-pr-407).
 */

import { MCPABTestService } from '../../src/services/ai/mcp/MCPABTestService';
import type { MCPUserSettingsService } from '../../src/services/settings/MCPUserSettingsService';
import type { Logger } from '../../src/utils/Logger';

describe('MCPABTestService - A/B Test Assignment Logic (P1 Bug Fix)', () => {
  let abTestService: MCPABTestService;
  let mockLogger: Logger;
  let mockUserSettingsService: MCPUserSettingsService;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    } as any;

    // Mock user settings service
    mockUserSettingsService = {
      getUserSettings: jest.fn()
    } as any;

    // Create service instance
    abTestService = new MCPABTestService(mockLogger);
    (abTestService as any).userSettingsService = mockUserSettingsService;

    // Initialize with test config
    abTestService.initialize({
      testId: 'test-1',
      enabled: true,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2026-12-31'),
      controlGroupPercent: 50,
      treatmentGroupPercent: 50,
      minSampleSize: 100,
      confidenceLevel: 0.95
    });
  });

  describe('User without explicit settings (environment defaults)', () => {
    it('should use hash-based A/B assignment when user has no explicit settings', async () => {
      // Mock: User has NO explicit settings (using environment defaults)
      (mockUserSettingsService.getUserSettings as jest.Mock).mockResolvedValue({
        id: 0,
        user_id: 'user-456',
        mcp_schema_enabled: false,
        mcp_ai_context_enabled: false,
        mcp_validation_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_explicit: false // Using environment defaults
      });

      const sessionId = 'session-123';
      const userId = 'user-456';

      const group = await abTestService.assignGroup(sessionId, userId);

      // Verify getUserSettings was called
      expect(mockUserSettingsService.getUserSettings).toHaveBeenCalledWith(userId);

      // Verify assignment is based on hash (control or treatment, not excluded)
      expect(['control', 'treatment']).toContain(group);
    });

    it('should assign different users to different groups via hashing', async () => {
      // Mock: Users have NO explicit settings (environment defaults)
      (mockUserSettingsService.getUserSettings as jest.Mock).mockImplementation((userId: string) =>
        Promise.resolve({
          id: 0,
          user_id: userId,
          mcp_schema_enabled: false,
          mcp_ai_context_enabled: false,
          mcp_validation_enabled: false,
          created_at: new Date(),
          updated_at: new Date(),
          is_explicit: false // Using environment defaults
        })
      );

      const assignments = new Set<string>();

      // Test multiple session IDs - should get mix of control/treatment
      for (let i = 0; i < 100; i++) {
        const group = await abTestService.assignGroup(`session-${i}`, `user-${i}`);
        assignments.add(group);
      }

      // Should have both control and treatment groups (hash-based distribution)
      expect(assignments.has('control')).toBe(true);
      expect(assignments.has('treatment')).toBe(true);
    });
  });

  describe('User with explicit settings (database row exists)', () => {
    it('should assign to treatment group when user explicitly enabled MCP', async () => {
      // Mock: User HAS explicit settings
      (mockUserSettingsService.getUserSettings as jest.Mock).mockResolvedValue({
        id: 1,
        user_id: 'user-789',
        mcp_schema_enabled: true,
        mcp_ai_context_enabled: false,
        mcp_validation_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_explicit: true // User has explicit DB settings
      });

      const group = await abTestService.assignGroup('session-xyz', 'user-789');

      // Verify getUserSettings was called
      expect(mockUserSettingsService.getUserSettings).toHaveBeenCalledWith('user-789');

      // Verify treatment group assignment
      expect(group).toBe('treatment');
    });

    it('should assign to control group when user explicitly disabled MCP', async () => {
      // Mock: User HAS explicit settings (both disabled)
      (mockUserSettingsService.getUserSettings as jest.Mock).mockResolvedValue({
        id: 2,
        user_id: 'user-999',
        mcp_schema_enabled: false,
        mcp_ai_context_enabled: false,
        mcp_validation_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_explicit: true // User has explicit DB settings
      });

      const group = await abTestService.assignGroup('session-abc', 'user-999');

      // Verify getUserSettings was called
      expect(mockUserSettingsService.getUserSettings).toHaveBeenCalledWith('user-999');

      // Verify control group assignment
      expect(group).toBe('control');
    });

    it('should assign to treatment when either schema or AI context is enabled', async () => {
      // Mock: User enabled AI context only
      (mockUserSettingsService.getUserSettings as jest.Mock).mockResolvedValue({
        id: 3,
        user_id: 'user-111',
        mcp_schema_enabled: false,
        mcp_ai_context_enabled: true, // AI context enabled
        mcp_validation_enabled: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_explicit: true // User has explicit DB settings
      });

      const group = await abTestService.assignGroup('session-def', 'user-111');

      // Verify treatment group assignment
      expect(group).toBe('treatment');
    });
  });

  describe('User settings service unavailable', () => {
    it('should fall back to hash-based assignment when settings service fails', async () => {
      // Mock: Settings lookup throws error
      (mockUserSettingsService.getUserSettings as jest.Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      const group = await abTestService.assignGroup('session-error', 'user-error');

      // Verify warning was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to load user settings for A/B test assignment',
        expect.objectContaining({
          userId: 'user-error',
          error: 'Database connection failed'
        })
      );

      // Verify hash-based assignment was used
      expect(['control', 'treatment']).toContain(group);
    });

    it('should use hash-based assignment when user ID not provided', async () => {
      const group = await abTestService.assignGroup('session-no-user');

      // Verify getUserSettings was NOT called (no userId provided)
      expect(mockUserSettingsService.getUserSettings).not.toHaveBeenCalled();

      // Verify hash-based assignment
      expect(['control', 'treatment']).toContain(group);
    });
  });

  describe('Consistent hashing behavior', () => {
    it('should assign same sessionId to same group consistently', async () => {
      const sessionId = 'session-consistent';
      const group1 = await abTestService.assignGroup(sessionId);
      const group2 = await abTestService.assignGroup(sessionId);
      const group3 = await abTestService.assignGroup(sessionId);

      // All assignments should be identical
      expect(group1).toBe(group2);
      expect(group2).toBe(group3);
    });
  });

  describe('Test enabled/disabled and date range', () => {
    it('should return excluded when test is disabled', async () => {
      // Create new service instance with disabled config
      const disabledService = new MCPABTestService(mockLogger);
      (disabledService as any).userSettingsService = mockUserSettingsService;
      disabledService.initialize({
        testId: 'test-disabled',
        enabled: false, // Disabled
        startDate: new Date('2025-01-01'),
        endDate: new Date('2026-12-31'),
        controlGroupPercent: 50,
        treatmentGroupPercent: 50,
        minSampleSize: 100,
        confidenceLevel: 0.95
      });

      const group = await disabledService.assignGroup('session-disabled');
      expect(group).toBe('excluded');
    });

    it('should return excluded when current date is before start date', async () => {
      // Create new service instance with future dates
      const futureService = new MCPABTestService(mockLogger);
      (futureService as any).userSettingsService = mockUserSettingsService;
      futureService.initialize({
        testId: 'test-future',
        enabled: true,
        startDate: new Date('2099-01-01'), // Future date
        endDate: new Date('2099-12-31'),
        controlGroupPercent: 50,
        treatmentGroupPercent: 50,
        minSampleSize: 100,
        confidenceLevel: 0.95
      });

      const group = await futureService.assignGroup('session-future');
      expect(group).toBe('excluded');
    });

    it('should return excluded when current date is after end date', async () => {
      // Create new service instance with past dates
      const pastService = new MCPABTestService(mockLogger);
      (pastService as any).userSettingsService = mockUserSettingsService;
      pastService.initialize({
        testId: 'test-past',
        enabled: true,
        startDate: new Date('2000-01-01'),
        endDate: new Date('2000-12-31'), // Past date
        controlGroupPercent: 50,
        treatmentGroupPercent: 50,
        minSampleSize: 100,
        confidenceLevel: 0.95
      });

      const group = await pastService.assignGroup('session-past');
      expect(group).toBe('excluded');
    });
  });
});
