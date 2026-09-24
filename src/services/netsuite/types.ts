/**
 * NetSuite Governance Types
 */

export interface GovernanceProfile {
  name: string;
  maxUnitsPerHour: number;
  maxUnitsPerRequest: number;
  warningThreshold: number; // Percentage (0-100)
  throttleThreshold: number; // Percentage (0-100)
  resetIntervalMs: number;
}

export interface GovernanceState {
  currentUnits: number;
  remainingUnits: number;
  resetTime: number;
  throttleMs: number;
  status: 'green' | 'yellow' | 'red';
  profile: string;
}

export interface GovernanceConsumption {
  allowed: boolean;
  throttleMs: number;
  units: number;
  remainingUnits: number;
  status: 'green' | 'yellow' | 'red';
  message?: string;
}
