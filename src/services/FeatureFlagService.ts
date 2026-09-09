/**
 * Feature Flag Service
 * Manages feature flags for controlled rollouts and deprecations
 */

import { logger } from '../utils/Logger';

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: 'ui' | 'api' | 'experimental' | 'deprecation';
  rolloutPercentage?: number;
  expiresAt?: string;
}

export class FeatureFlagService {
  private flags = new Map<string, FeatureFlag>();

  constructor() {
    this.initializeDefaultFlags();
  }

  private initializeDefaultFlags() {
    // UI Feature Flags
    this.setFlag({
      key: 'studioDeprecated',
      enabled: false, // DISABLED BY DEFAULT - Studio remains available
      description: 'Controls AI Studio deprecation notice and redirect behavior',
      category: 'deprecation'
    });

    this.setFlag({
      key: 'enhancedFieldEditor',
      enabled: true,
      description: 'Enhanced field mapping editor with AI Analysis tabs',
      category: 'ui'
    });

    this.setFlag({
      key: 'unifiedTemplateLibrary',
      enabled: true,
      description: 'Unified Template Service integration',
      category: 'api'
    });

    // Experimental flags (future Week features)
    this.setFlag({
      key: 'visualMapper',
      enabled: false,
      description: 'Visual drag-and-drop field mapping interface',
      category: 'experimental'
    });

    this.setFlag({
      key: 'realTimeLLMIntegration',
      enabled: false,
      description: 'Real-time LLM provider integration (OpenAI/Claude)',
      category: 'experimental'
    });
  }

  setFlag(flag: FeatureFlag) {
    this.flags.set(flag.key, flag);
  }

  isEnabled(key: string): boolean {
    const flag = this.flags.get(key);
    if (!flag) {
      logger.warn(`Feature flag '${key}' not found, defaulting to false`);
      return false;
    }

    // Check if flag has expired
    if (flag.expiresAt && new Date() > new Date(flag.expiresAt)) {
      logger.info(`Feature flag '${key}' has expired, defaulting to false`);
      return false;
    }

    // Handle rollout percentage (for gradual rollouts)
    if (flag.rolloutPercentage !== undefined) {
      const userHash = this.getUserHash();
      return (userHash % 100) < flag.rolloutPercentage && flag.enabled;
    }

    return flag.enabled;
  }

  getFlag(key: string): FeatureFlag | undefined {
    return this.flags.get(key);
  }

  getAllFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  getFlagsByCategory(category: FeatureFlag['category']): FeatureFlag[] {
    return Array.from(this.flags.values()).filter(flag => flag.category === category);
  }

  // Environment-based overrides
  setEnvironmentOverrides(env: 'development' | 'staging' | 'production') {
    switch (env) {
      case 'development':
        // Enable experimental features in development
        this.updateFlag('visualMapper', { enabled: true });
        this.updateFlag('realTimeLLMIntegration', { enabled: true });
        break;
      case 'staging':
        // More conservative in staging
        break;
      case 'production':
        // Very conservative in production
        this.updateFlag('visualMapper', { enabled: false });
        this.updateFlag('realTimeLLMIntegration', { enabled: false });
        break;
    }
  }

  updateFlag(key: string, updates: Partial<FeatureFlag>) {
    const existingFlag = this.flags.get(key);
    if (existingFlag) {
      this.flags.set(key, { ...existingFlag, ...updates });
    }
  }

  // Toggle flag for admin interfaces
  toggleFlag(key: string): boolean {
    const flag = this.flags.get(key);
    if (flag) {
      flag.enabled = !flag.enabled;
      return flag.enabled;
    }
    return false;
  }

  private getUserHash(): number {
    // Simple hash for consistent user experience (server-side safe)
    // In a real implementation, this would use request IP, user ID, or session
    const userId = 'anonymous-user';
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // Studio deprecation specific methods
  shouldShowStudioDeprecationWarning(): boolean {
    return this.isEnabled('studioDeprecated');
  }

  shouldRedirectStudioToEditor(): boolean {
    // Only redirect if fully deprecated AND enhanced editor is available
    return this.isEnabled('studioDeprecated') && this.isEnabled('enhancedFieldEditor');
  }

  getStudioDeprecationMessage(): string {
    if (!this.isEnabled('studioDeprecated')) return '';

    return `
      <div class="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
        <div class="flex">
          <div class="flex-shrink-0">
            <i class="fas fa-exclamation-triangle text-orange-400"></i>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-orange-800">
              AI Studio Migration Notice
            </h3>
            <div class="mt-2 text-sm text-orange-700">
              <p>The AI Studio is being consolidated into the enhanced Field Mapping Editor.
              All Studio features are now available in the improved interface with better performance.</p>
            </div>
            <div class="mt-4">
              <div class="flex space-x-2">
                <a href="/ai-field-mapping-editor.html"
                   class="bg-orange-100 px-3 py-2 rounded-md text-sm font-medium text-orange-800 hover:bg-orange-200">
                  Switch to Enhanced Editor
                </a>
                <button onclick="this.parentElement.parentElement.parentElement.parentElement.style.display='none'"
                        class="bg-white px-3 py-2 rounded-md text-sm font-medium text-orange-800 hover:bg-gray-50">
                  Continue with Studio
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

// Singleton instance
export const featureFlagService = new FeatureFlagService();

// Initialize environment overrides
const environment = process.env.NODE_ENV as 'development' | 'staging' | 'production';
featureFlagService.setEnvironmentOverrides(environment || 'development');