/**
 * NetSuite Governance Pacer
 * Simulates and tracks NetSuite governance unit usage and throttling
 */

import type { Logger } from '../../utils/Logger';
import type {
  GovernanceProfile,
  GovernanceState,
  GovernanceConsumption
} from './types';

export interface GovernancePacerConfig {
  demoMode: boolean;
  profileName?: string;
  customProfile?: GovernanceProfile;
}

export class GovernancePacer {
  private currentState: GovernanceState;
  private profile: GovernanceProfile;
  private resetTimeout?: NodeJS.Timeout;

  constructor(
    private config: GovernancePacerConfig,
    private logger: Logger
  ) {
    this.profile = this.loadProfile(config.profileName || 'standard');
    this.currentState = this.initializeState();

    // Set up auto-reset timer
    this.scheduleReset();

    this.logger.info('NetSuite Governance Pacer initialized', {
      demoMode: config.demoMode,
      profile: this.profile.name
    });
  }

  /**
   * Load governance profile
   */
  private loadProfile(name: string): GovernanceProfile {
    if (this.config.customProfile) {
      return this.config.customProfile;
    }

    const profiles: Record<string, GovernanceProfile> = {
      standard: {
        name: 'Standard',
        maxUnitsPerHour: 1000,
        maxUnitsPerRequest: 10,
        warningThreshold: 70, // 70%
        throttleThreshold: 85, // 85%
        resetIntervalMs: 60 * 60 * 1000 // 1 hour
      },
      premium: {
        name: 'Premium',
        maxUnitsPerHour: 5000,
        maxUnitsPerRequest: 50,
        warningThreshold: 75,
        throttleThreshold: 90,
        resetIntervalMs: 60 * 60 * 1000
      },
      enterprise: {
        name: 'Enterprise',
        maxUnitsPerHour: 10000,
        maxUnitsPerRequest: 100,
        warningThreshold: 80,
        throttleThreshold: 95,
        resetIntervalMs: 60 * 60 * 1000
      }
    };

    return profiles[name] || profiles.standard;
  }

  /**
   * Initialize governance state
   */
  private initializeState(): GovernanceState {
    return {
      currentUnits: 0,
      remainingUnits: this.profile.maxUnitsPerHour,
      resetTime: Date.now() + this.profile.resetIntervalMs,
      throttleMs: 0,
      status: 'green',
      profile: this.profile.name
    };
  }

  /**
   * Consume governance units for an operation
   */
  async consumeUnits(requestUnits: number): Promise<GovernanceConsumption> {
    if (this.config.demoMode) {
      return this.simulateConsumption(requestUnits);
    }

    // In live mode, this would track actual NetSuite usage
    return this.trackLiveConsumption(requestUnits);
  }

  /**
   * Simulate governance unit consumption (demo mode)
   */
  private simulateConsumption(units: number): GovernanceConsumption {
    // Check if request exceeds single request limit
    if (units > this.profile.maxUnitsPerRequest) {
      return {
        allowed: false,
        throttleMs: 0,
        units,
        remainingUnits: this.currentState.remainingUnits,
        status: 'red',
        message: `Request exceeds max units per request (${this.profile.maxUnitsPerRequest})`
      };
    }

    // Increment current units
    this.currentState.currentUnits += units;
    this.currentState.remainingUnits = this.profile.maxUnitsPerHour - this.currentState.currentUnits;

    // Calculate percentage used
    const percentUsed = (this.currentState.currentUnits / this.profile.maxUnitsPerHour) * 100;

    // Determine status and throttling
    let status: 'green' | 'yellow' | 'red';
    let throttleMs: number;
    let allowed = true;
    let message: string | undefined;

    if (percentUsed >= 100) {
      status = 'red';
      throttleMs = this.getTimeUntilReset();
      allowed = false;
      message = `Governance limit exceeded. Reset in ${Math.round(throttleMs / 1000)}s`;
    } else if (percentUsed >= this.profile.throttleThreshold) {
      status = 'red';
      throttleMs = 5000; // 5 second throttle
      message = `Approaching limit (${Math.round(percentUsed)}%). Throttling by ${throttleMs}ms`;
    } else if (percentUsed >= this.profile.warningThreshold) {
      status = 'yellow';
      throttleMs = 1000; // 1 second throttle
      message = `Warning: ${Math.round(percentUsed)}% of governance units used`;
    } else {
      status = 'green';
      throttleMs = 0;
    }

    this.currentState.status = status;
    this.currentState.throttleMs = throttleMs;

    this.logger.debug('Governance units consumed', {
      units,
      currentUnits: this.currentState.currentUnits,
      remainingUnits: this.currentState.remainingUnits,
      percentUsed: Math.round(percentUsed),
      status,
      throttleMs
    });

    return {
      allowed,
      throttleMs,
      units,
      remainingUnits: this.currentState.remainingUnits,
      status,
      message
    };
  }

  /**
   * Track live governance consumption (production mode)
   */
  private trackLiveConsumption(units: number): GovernanceConsumption {
    // In production, this would:
    // 1. Query NetSuite API for current governance usage
    // 2. Track units consumed in this session
    // 3. Calculate remaining units from API response
    // 4. Determine throttling based on actual limits

    // For now, fall back to simulation
    this.logger.warn('Live governance tracking not yet implemented, using simulation');
    return this.simulateConsumption(units);
  }

  /**
   * Get current governance state
   */
  getState(): GovernanceState {
    return { ...this.currentState };
  }

  /**
   * Get time until governance reset (ms)
   */
  private getTimeUntilReset(): number {
    return Math.max(0, this.currentState.resetTime - Date.now());
  }

  /**
   * Reset governance counters
   */
  private reset(): void {
    this.currentState = this.initializeState();

    this.logger.info('Governance counters reset', {
      profile: this.profile.name,
      nextReset: new Date(this.currentState.resetTime).toISOString()
    });

    // Schedule next reset
    this.scheduleReset();
  }

  /**
   * Schedule automatic reset
   */
  private scheduleReset(): void {
    if (this.resetTimeout) {
      clearTimeout(this.resetTimeout);
    }

    this.resetTimeout = setTimeout(() => {
      this.reset();
    }, this.profile.resetIntervalMs);
  }

  /**
   * Manual reset (for testing)
   */
  manualReset(): void {
    this.reset();
  }

  /**
   * Change profile
   */
  changeProfile(profileName: string): void {
    this.profile = this.loadProfile(profileName);
    this.reset();

    this.logger.info('Governance profile changed', {
      newProfile: this.profile.name
    });
  }

  /**
   * Get available profiles
   */
  getAvailableProfiles(): string[] {
    return ['standard', 'premium', 'enterprise'];
  }

  /**
   * Cleanup timers
   */
  destroy(): void {
    if (this.resetTimeout) {
      clearTimeout(this.resetTimeout);
    }
  }
}
