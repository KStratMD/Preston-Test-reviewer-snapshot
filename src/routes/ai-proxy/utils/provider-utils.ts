/**
 * AI Proxy Provider Utilities
 * Helper functions for provider display names and demo mode detection
 */

/**
 * UI CLARITY HELPER: Get human-readable provider display name
 * Used in frontend to show which AI provider handled the request
 */
export function getProviderDisplayName(providerId: string): string {
  const names: Record<string, string> = {
    'openai': 'OpenAI GPT-4o',
    'claude': 'Claude 3.5 Sonnet',
    'lmstudio': 'LM Studio (Local AI)',
    'gemini': 'Google Gemini',
    'grok': 'xAI Grok',
    'openrouter': 'OpenRouter',
    'mock-openai': '🧪 Demo: OpenAI Simulation',
    'mock-claude': '🧪 Demo: Claude Simulation',
    'rule-based': '📋 Rule-Based Engine'
  };
  return names[providerId] || providerId;
}

/**
 * UI CLARITY HELPER: Check if provider is demo/mock
 * Used to show demo mode warnings in UI
 */
export function isProviderDemo(providerId: string): boolean {
  return providerId?.startsWith('mock-') || providerId === 'rule-based';
}
