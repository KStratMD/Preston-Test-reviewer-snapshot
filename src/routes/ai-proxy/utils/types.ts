/**
 * AI Proxy Shared Types and Interfaces
 * Common type definitions used across the AI proxy routes
 */

/**
 * Cost tracking middleware interface
 */
export interface CostTracker {
  trackRequest(providerId: string, tokens: number, cost: number): void;
  getUsage(timeframe: 'hour' | 'day' | 'month'): Promise<UsageStats>;
}

/**
 * Usage statistics interface
 */
export interface UsageStats {
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  byProvider: Record<string, { requests: number; cost: number; tokens: number }>;
}
