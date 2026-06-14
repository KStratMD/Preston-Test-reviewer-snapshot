/**
 * Feature Flags Service
 *
 * Centralized service for managing feature flags across the application.
 * Supports environment variable-based flags with type-safe access.
 *
 * Usage:
 * ```typescript
 * import { FeatureFlags } from '../utils/FeatureFlags';
 *
 * if (FeatureFlags.isEnabled('NEW_INTEGRATION_STRATEGY')) {
 *   // Use new refactored integration strategy agent
 * } else {
 *   // Use existing monolithic integration strategy agent
 * }
 * ```
 */

import { env } from "../config/env";
import { logger } from "./Logger";

export type FeatureFlagName =
  | "NEW_INTEGRATION_STRATEGY"  // Refactored IntegrationStrategyAgent services
  // Add more feature flags here as needed
  ;

interface FeatureFlagMetadata {
  name: FeatureFlagName;
  description: string;
  defaultValue: boolean;
  envVar: string;
}

/**
 * Feature flag definitions with metadata
 */
const FEATURE_FLAGS: Record<FeatureFlagName, FeatureFlagMetadata> = {
  NEW_INTEGRATION_STRATEGY: {
    name: "NEW_INTEGRATION_STRATEGY",
    description: "Enable refactored IntegrationStrategyAgent with extracted services",
    defaultValue: false,
    envVar: "FEATURE_NEW_INTEGRATION_STRATEGY",
  },
};

/**
 * Feature Flags Service
 *
 * Provides centralized access to feature flags with logging and monitoring.
 */
export class FeatureFlags {
  /**
   * Check if a feature flag is enabled
   *
   * @param flagName - Name of the feature flag
   * @returns true if the flag is enabled, false otherwise
   */
  static isEnabled(flagName: FeatureFlagName): boolean {
    const flag = FEATURE_FLAGS[flagName];

    if (!flag) {
      logger.warn("Unknown feature flag requested", { flagName });
      return false;
    }

    // Get value from environment configuration
    const envValue = env.FEATURE_NEW_INTEGRATION_STRATEGY;
    const isEnabled = envValue ?? flag.defaultValue;

    logger.debug("Feature flag checked", {
      flag: flagName,
      enabled: isEnabled,
      source: envValue !== undefined ? "environment" : "default",
    });

    return isEnabled;
  }

  /**
   * Get all feature flags and their current state
   *
   * @returns Record of all feature flags with their enabled state
   */
  static getAllFlags(): Record<FeatureFlagName, boolean> {
    const flags: Record<string, boolean> = {};

    for (const flagName of Object.keys(FEATURE_FLAGS) as FeatureFlagName[]) {
      flags[flagName] = this.isEnabled(flagName);
    }

    return flags as Record<FeatureFlagName, boolean>;
  }

  /**
   * Get metadata for a specific feature flag
   *
   * @param flagName - Name of the feature flag
   * @returns Metadata for the flag, or undefined if not found
   */
  static getMetadata(flagName: FeatureFlagName): FeatureFlagMetadata | undefined {
    return FEATURE_FLAGS[flagName];
  }

  /**
   * Get metadata for all feature flags
   *
   * @returns Array of all feature flag metadata
   */
  static getAllMetadata(): FeatureFlagMetadata[] {
    return Object.values(FEATURE_FLAGS);
  }

  /**
   * Log current feature flag state (useful for debugging)
   */
  static logCurrentState(): void {
    const allFlags = this.getAllFlags();
    const enabledFlags = Object.entries(allFlags)
      .filter(([_, enabled]) => enabled)
      .map(([name]) => name);

    logger.info("Feature flags state", {
      enabled: enabledFlags,
      total: Object.keys(FEATURE_FLAGS).length,
    });
  }
}

/**
 * Helper function for conditional logic based on feature flags
 *
 * @param flagName - Name of the feature flag
 * @param whenEnabled - Function to execute when flag is enabled
 * @param whenDisabled - Function to execute when flag is disabled
 * @returns Result of the executed function
 */
export function withFeatureFlag<T>(
  flagName: FeatureFlagName,
  whenEnabled: () => T,
  whenDisabled: () => T,
): T {
  if (FeatureFlags.isEnabled(flagName)) {
    logger.debug("Executing with feature flag enabled", { flagName });
    return whenEnabled();
  } else {
    logger.debug("Executing with feature flag disabled", { flagName });
    return whenDisabled();
  }
}

/**
 * Async version of withFeatureFlag
 */
export async function withFeatureFlagAsync<T>(
  flagName: FeatureFlagName,
  whenEnabled: () => Promise<T>,
  whenDisabled: () => Promise<T>,
): Promise<T> {
  if (FeatureFlags.isEnabled(flagName)) {
    logger.debug("Executing async with feature flag enabled", { flagName });
    return await whenEnabled();
  } else {
    logger.debug("Executing async with feature flag disabled", { flagName });
    return await whenDisabled();
  }
}
