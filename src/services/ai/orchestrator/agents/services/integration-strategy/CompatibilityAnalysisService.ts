/**
 * CompatibilityAnalysisService
 *
 * Analyzes compatibility between source and target systems.
 * Identifies incompatibilities and recommends mitigation strategies.
 *
 * @description Part of IntegrationStrategyAgent refactoring (Phase 3, Batch 1)
 * @module CompatibilityAnalysisService
 */

import type {
  CompatibilityAnalysis,
  Incompatibility,
  CompatibilityMitigation
} from '../../types/integration-strategy/analysis.types';

export class CompatibilityAnalysisService {
  constructor() {}

  /**
   * Analyze compatibility between source and target systems
   * @public - Main entry point
   */
  public analyzeCompatibility(
    source: { name: string; capabilities?: unknown },
    target: { name: string; capabilities?: unknown }
  ): CompatibilityAnalysis {
    // API compatibility analysis
    const apiCompatibility = this.calculateAPICompatibility(source, target);

    // Data format compatibility
    const dataFormatCompatibility = this.calculateDataFormatCompatibility(source, target);

    // Protocol compatibility
    const protocolCompatibility = this.calculateProtocolCompatibility(source, target);

    // Version compatibility
    const versionCompatibility = this.calculateVersionCompatibility(source, target);

    const overallScore = (apiCompatibility + dataFormatCompatibility + protocolCompatibility + versionCompatibility) / 4;

    // Identify incompatibilities
    const incompatibilities = this.identifyIncompatibilities(source, target);

    // Generate mitigations
    const mitigations = this.generateCompatibilityMitigations(incompatibilities);

    return {
      overallScore,
      apiCompatibility,
      dataFormatCompatibility,
      protocolCompatibility,
      versionCompatibility,
      incompatibilities,
      mitigations
    };
  }

  /**
   * Calculate API compatibility score
   * @private
   */
  private calculateAPICompatibility(source: { capabilities?: unknown }, target: { capabilities?: unknown }): number {
    const sourceAPIs = (source as any).apiSupport?.length || 0;
    const targetAPIs = (target as any).apiSupport?.length || 0;

    if (sourceAPIs === 0 || targetAPIs === 0) return 0.3; // File-based fallback

    // Check for common API types
    const commonTypes = (source as any).apiSupport.filter((sourceAPI: unknown) =>
      (target as any).apiSupport.some((targetAPI: unknown) => (sourceAPI as any).type === (targetAPI as any).type)
    );

    return commonTypes.length > 0 ? 0.9 : 0.5;
  }

  /**
   * Calculate data format compatibility score
   * @private
   */
  private calculateDataFormatCompatibility(source: { capabilities?: unknown }, target: { capabilities?: unknown }): number {
    // Simplified: assume good compatibility for modern systems
    const modernTypes = ['api', 'crm', 'erp'];
    const sourceModern = modernTypes.includes((source as any).type);
    const targetModern = modernTypes.includes((target as any).type);

    if (sourceModern && targetModern) return 0.9;
    if (sourceModern || targetModern) return 0.7;
    return 0.5;
  }

  /**
   * Calculate protocol compatibility score
   * @private
   */
  private calculateProtocolCompatibility(source: { capabilities?: unknown }, target: { capabilities?: unknown }): number {
    // Simplified protocol compatibility check
    return 0.8; // Default good compatibility
  }

  /**
   * Calculate version compatibility score
   * @private
   */
  private calculateVersionCompatibility(source: { capabilities?: unknown }, target: { capabilities?: unknown }): number {
    // Simplified version compatibility check
    return 0.85; // Default good compatibility
  }

  /**
   * Identify incompatibilities between systems
   * @private
   */
  private identifyIncompatibilities(source: { capabilities?: unknown }, target: { capabilities?: unknown }): Incompatibility[] {
    const incompatibilities: Incompatibility[] = [];

    // Security level mismatch
    const securityLevels = ['basic', 'standard', 'high', 'enterprise'];
    const sourceLevel = securityLevels.indexOf((source as any).securityLevel);
    const targetLevel = securityLevels.indexOf((target as any).securityLevel);

    if (Math.abs(sourceLevel - targetLevel) > 1) {
      incompatibilities.push({
        type: 'security',
        description: `Security level mismatch: ${(source as any).securityLevel} vs ${(target as any).securityLevel}`,
        severity: 'medium',
        impact: 'May require security upgrades or additional controls',
        workaround: 'Implement security adapters or upgrade lower-security system'
      });
    }

    return incompatibilities;
  }

  /**
   * Generate mitigation strategies for incompatibilities
   * @private
   */
  private generateCompatibilityMitigations(incompatibilities: Incompatibility[]): CompatibilityMitigation[] {
    return incompatibilities.map(incompatibility => ({
      incompatibility: incompatibility.description,
      strategy: this.selectMitigationStrategy(incompatibility),
      description: `Mitigation for ${incompatibility.type} incompatibility`,
      effort: incompatibility.severity === 'high' ? 'high' : 'medium',
      cost: incompatibility.severity === 'high' ? 15000 : 5000,
      timeline: incompatibility.severity === 'high' ? 60 : 30
    }));
  }

  /**
   * Select appropriate mitigation strategy
   * @private
   */
  private selectMitigationStrategy(incompatibility: Incompatibility): 'adapter' | 'wrapper' | 'translation' | 'upgrade' | 'replacement' {
    switch (incompatibility.type) {
      case 'api': return 'adapter';
      case 'data': return 'translation';
      case 'protocol': return 'wrapper';
      case 'version': return 'upgrade';
      case 'security': return 'upgrade';
      default: return 'adapter';
    }
  }
}
