/**
 * GovernancePacer Unit Tests
 * Tests for NetSuite governance unit tracking and throttling
 */

import { GovernancePacer } from '../../../../src/services/netsuite/GovernancePacer';
import type { Logger } from '../../../../src/utils/Logger';
import type { GovernanceProfile } from '../../../../src/services/netsuite/types';

describe('GovernancePacer', () => {
  let pacer: GovernancePacer;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
  });

  afterEach(() => {
    if (pacer) {
      pacer.destroy();
    }
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with default standard profile', () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith('NetSuite Governance Pacer initialized', {
        demoMode: true,
        profile: 'Standard',
      });

      const state = pacer.getState();
      expect(state.profile).toBe('Standard');
      expect(state.remainingUnits).toBe(1000);
      expect(state.status).toBe('green');
    });

    it('should initialize with premium profile', () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'premium' }, mockLogger);

      const state = pacer.getState();
      expect(state.profile).toBe('Premium');
      expect(state.remainingUnits).toBe(5000);
    });

    it('should initialize with enterprise profile', () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'enterprise' }, mockLogger);

      const state = pacer.getState();
      expect(state.profile).toBe('Enterprise');
      expect(state.remainingUnits).toBe(10000);
    });

    it('should initialize with custom profile', () => {
      const customProfile: GovernanceProfile = {
        name: 'Custom',
        maxUnitsPerHour: 2000,
        maxUnitsPerRequest: 20,
        warningThreshold: 60,
        throttleThreshold: 80,
        resetIntervalMs: 30 * 60 * 1000, // 30 minutes
      };

      pacer = new GovernancePacer(
        { demoMode: true, customProfile },
        mockLogger
      );

      const state = pacer.getState();
      expect(state.profile).toBe('Custom');
      expect(state.remainingUnits).toBe(2000);
    });

    it('should fall back to standard for unknown profile name', () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'unknown' }, mockLogger);

      const state = pacer.getState();
      expect(state.profile).toBe('Standard');
    });
  });

  describe('consumeUnits()', () => {
    describe('demo mode', () => {
      beforeEach(() => {
        pacer = new GovernancePacer({ demoMode: true }, mockLogger);
      });

      it('should allow consumption within limits (green status)', async () => {
        const result = await pacer.consumeUnits(5);

        expect(result.allowed).toBe(true);
        expect(result.status).toBe('green');
        expect(result.throttleMs).toBe(0);
        expect(result.units).toBe(5);
        expect(result.remainingUnits).toBe(995);
        expect(result.message).toBeUndefined();
      });

      it('should warn at warning threshold (yellow status)', async () => {
        // Consume 700 units to reach 70% (warning threshold for standard)
        // Must consume in increments of 10 or less (maxUnitsPerRequest)
        for (let i = 0; i < 70; i++) {
          await pacer.consumeUnits(10);
        }
        const result = await pacer.consumeUnits(5);

        expect(result.allowed).toBe(true);
        expect(result.status).toBe('yellow');
        expect(result.throttleMs).toBe(1000);
        expect(result.message).toContain('Warning:');
      });

      it('should throttle at throttle threshold (red status)', async () => {
        // Consume 860 units to reach 86% (above throttle threshold of 85% for standard)
        for (let i = 0; i < 86; i++) {
          await pacer.consumeUnits(10);
        }
        const result = await pacer.consumeUnits(5);

        expect(result.allowed).toBe(true);
        expect(result.status).toBe('red');
        expect(result.throttleMs).toBe(5000);
        expect(result.message).toContain('Approaching limit');
      });

      it('should reject when limit exceeded (red status)', async () => {
        // Consume 1000 units to reach 100%
        for (let i = 0; i < 100; i++) {
          await pacer.consumeUnits(10);
        }
        const result = await pacer.consumeUnits(5);

        expect(result.allowed).toBe(false);
        expect(result.status).toBe('red');
        expect(result.message).toContain('Governance limit exceeded');
      });

      it('should reject when single request exceeds max units per request', async () => {
        // Standard profile has maxUnitsPerRequest of 10
        const result = await pacer.consumeUnits(15);

        expect(result.allowed).toBe(false);
        expect(result.status).toBe('red');
        expect(result.message).toContain('Request exceeds max units per request');
      });

      it('should track cumulative consumption correctly', async () => {
        await pacer.consumeUnits(5);
        await pacer.consumeUnits(3);
        const result = await pacer.consumeUnits(2);

        expect(result.remainingUnits).toBe(990);
        expect(pacer.getState().currentUnits).toBe(10);
      });

      it('should log debug message on consumption', async () => {
        await pacer.consumeUnits(5);

        expect(mockLogger.debug).toHaveBeenCalledWith('Governance units consumed', expect.objectContaining({
          units: 5,
          currentUnits: 5,
          remainingUnits: 995,
          status: 'green',
          throttleMs: 0,
        }));
      });
    });

    describe('live mode', () => {
      it('should warn and fall back to simulation', async () => {
        pacer = new GovernancePacer({ demoMode: false }, mockLogger);

        const result = await pacer.consumeUnits(5);

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Live governance tracking not yet implemented, using simulation'
        );
        expect(result.allowed).toBe(true);
      });
    });
  });

  describe('getState()', () => {
    it('should return a copy of the current state', () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      const state1 = pacer.getState();
      const state2 = pacer.getState();

      expect(state1).not.toBe(state2); // Different object references
      expect(state1).toEqual(state2); // Same values
    });

    it('should reflect current consumption', async () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      const initialState = pacer.getState();
      expect(initialState.currentUnits).toBe(0);

      await pacer.consumeUnits(5);

      const afterState = pacer.getState();
      expect(afterState.currentUnits).toBe(5);
      expect(afterState.remainingUnits).toBe(995);
    });
  });

  describe('manualReset()', () => {
    it('should reset all counters to initial state', async () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      // Consume some units (in valid increments)
      for (let i = 0; i < 50; i++) {
        await pacer.consumeUnits(10);
      }
      expect(pacer.getState().currentUnits).toBe(500);

      // Manual reset
      pacer.manualReset();

      const state = pacer.getState();
      expect(state.currentUnits).toBe(0);
      expect(state.remainingUnits).toBe(1000);
      expect(state.status).toBe('green');

      expect(mockLogger.info).toHaveBeenCalledWith('Governance counters reset', expect.any(Object));
    });
  });

  describe('changeProfile()', () => {
    it('should change to a different profile and reset', async () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      // Consume some units
      await pacer.consumeUnits(500);

      // Change to premium profile
      pacer.changeProfile('premium');

      const state = pacer.getState();
      expect(state.profile).toBe('Premium');
      expect(state.remainingUnits).toBe(5000);
      expect(state.currentUnits).toBe(0);

      expect(mockLogger.info).toHaveBeenCalledWith('Governance profile changed', {
        newProfile: 'Premium',
      });
    });

    it('should fall back to standard for unknown profile', () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'premium' }, mockLogger);

      pacer.changeProfile('nonexistent');

      const state = pacer.getState();
      expect(state.profile).toBe('Standard');
    });
  });

  describe('getAvailableProfiles()', () => {
    it('should return list of available profile names', () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      const profiles = pacer.getAvailableProfiles();

      expect(profiles).toEqual(['standard', 'premium', 'enterprise']);
    });
  });

  describe('destroy()', () => {
    it('should clean up reset timer', () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      pacer.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('auto-reset timer', () => {
    it('should automatically reset after reset interval', async () => {
      pacer = new GovernancePacer({ demoMode: true }, mockLogger);

      // Consume some units (in valid increments)
      for (let i = 0; i < 50; i++) {
        await pacer.consumeUnits(10);
      }
      expect(pacer.getState().currentUnits).toBe(500);

      // Fast-forward time by 1 hour (standard profile reset interval)
      jest.advanceTimersByTime(60 * 60 * 1000);

      // State should be reset
      const state = pacer.getState();
      expect(state.currentUnits).toBe(0);
      expect(state.remainingUnits).toBe(1000);
    });
  });

  describe('profile thresholds', () => {
    it('should use premium profile thresholds correctly', async () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'premium' }, mockLogger);

      // Premium: warning at 75%, throttle at 90%, max 5000 units/hour, 50 units/request

      // Consume 3750 units (75%) - should be yellow
      await pacer.consumeUnits(50); // Use max per request multiple times
      for (let i = 0; i < 74; i++) {
        await pacer.consumeUnits(50);
      }
      const resultAtWarning = await pacer.consumeUnits(50);
      expect(resultAtWarning.status).toBe('yellow');
    });

    it('should use enterprise profile thresholds correctly', async () => {
      pacer = new GovernancePacer({ demoMode: true, profileName: 'enterprise' }, mockLogger);

      // Enterprise: warning at 80%, throttle at 95%, max 10000 units/hour, 100 units/request

      // Consume 80 units (0.8% of 10000) - should still be green
      const result = await pacer.consumeUnits(80);
      expect(result.status).toBe('green');
      expect(result.remainingUnits).toBe(9920);
    });
  });
});
