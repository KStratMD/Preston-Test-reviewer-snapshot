/**
 * Integration Strategy Generator Service - Strategy Generation and AI Enhancement
 * Extracted from IntegrationStrategyAgent
 * This is the core decision engine for integration strategy recommendations
 */

import type {
  IntegrationApproach,
  IntegrationStrategyInput,
  IntegrationRisk,
  ArchitectureOption
} from '../../../interfaces';

import type {
  ArchitectureAssessment
} from '../../types/integration-strategy/analysis.types';

import type {
  IntegrationPatternAnalysis,
  IntegrationPattern
} from '../../types/integration-strategy/patterns.types';

import type { Logger } from '../../../../../../utils/Logger';

export class IntegrationStrategyGeneratorService {
  constructor(
    private logger: Logger,
    private providerRegistry: unknown,
    private semanticEngine: unknown
  ) {}

  /**
   * Generate architecture options based on patterns
   */
  async generateArchitectureOptions(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment,
    patternAnalysis: IntegrationPatternAnalysis,
    createOptionCallback: (pattern: IntegrationPattern) => ArchitectureOption,
    calculateScoreCallback: (option: ArchitectureOption) => number
  ): Promise<ArchitectureOption[]> {
    const options: ArchitectureOption[] = [];

    // Generate options based on patterns
    for (const pattern of patternAnalysis.recommendedPatterns) {
      const option = createOptionCallback(pattern);
      options.push(option);
    }

    // Sort by score
    options.sort((a, b) => calculateScoreCallback(b) - calculateScoreCallback(a));

    return options.slice(0, 5); // Return top 5 options
  }

  /**
   * Recommend integration approach (with AI enhancement)
   */
  async recommendIntegrationApproach(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment,
    patternAnalysis: IntegrationPatternAnalysis,
    risks: IntegrationRisk[],
    selectBestPatternCallback: (patterns: IntegrationPattern[], assessment: ArchitectureAssessment, risks: IntegrationRisk[]) => IntegrationPattern
  ): Promise<IntegrationApproach> {
    // AI-FIRST APPROACH: Try AI-enhanced integration strategy recommendation
    try {
      const aiApproach = await this.recommendIntegrationApproachWithAI(
        input,
        assessment,
        patternAnalysis,
        risks
      );
      if (aiApproach) {
        this.logger.info('Using AI-enhanced integration strategy recommendation', {
          pattern: aiApproach.pattern,
          complexity: aiApproach.complexity,
          aiConfidence: 0.85
        });
        return aiApproach;
      }
    } catch (error) {
      this.logger.warn('AI integration strategy recommendation unavailable, using heuristic fallback', {
        error: String(error)
      });
    }

    // FALLBACK: Use heuristic pattern selection
    const bestPattern = selectBestPatternCallback(
      patternAnalysis.recommendedPatterns,
      assessment,
      risks
    );

    const approach: IntegrationApproach = {
      name: `${bestPattern.name.replace('_', ' ').toUpperCase()} Integration`,
      description: `${bestPattern.description} optimized for ${input.sourceSystemProfile.name} to ${input.targetSystemProfile.name} integration`,
      pattern: this.mapPatternTypeToApproach(bestPattern.type),
      complexity: this.determineApproachComplexity(bestPattern, assessment),
      recommendationReason: this.generateRecommendationReason(bestPattern, input, assessment, risks)
    };

    return approach;
  }

  /**
   * AI-enhanced integration strategy recommendation
   * Uses LLM to analyze systems, requirements, and architecture to recommend optimal integration approach
   */
  private async recommendIntegrationApproachWithAI(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment,
    patternAnalysis: IntegrationPatternAnalysis,
    risks: IntegrationRisk[]
  ): Promise<IntegrationApproach | null> {
    try {
      // Check if AI providers are available
      if (!this.providerRegistry || !this.semanticEngine) {
        this.logger.info('AI providers not available for integration strategy recommendation');
        return null;
      }

      // Get available provider
      const providers = await (this.providerRegistry as any).getAvailableProviders();
      if (!providers || providers.length === 0) {
        this.logger.info('No AI providers available');
        return null;
      }

      // Build prompt with integration context
      const prompt = this.buildIntegrationStrategyPrompt(input, assessment, patternAnalysis, risks);

      // Call AI provider
      const provider = providers[0];
      const response = await (this.semanticEngine as any).analyzeWithLLM(prompt, {
        provider: provider.name,
        maxTokens: 1500,
        temperature: 0.4 // Balanced between creativity and consistency
      });

      if (!response || !response.content) {
        this.logger.warn('No response from AI provider');
        return null;
      }

      // Parse AI response
      const aiStrategy = this.parseAIIntegrationStrategyResponse(response.content);
      if (!aiStrategy) {
        this.logger.warn('Failed to parse AI integration strategy response');
        return null;
      }

      // Validate AI strategy with heuristics
      const validatedStrategy = this.validateAIStrategyWithHeuristics(
        aiStrategy,
        patternAnalysis,
        assessment
      );

      this.logger.info('AI-enhanced integration strategy recommendation completed', {
        pattern: validatedStrategy.pattern,
        complexity: validatedStrategy.complexity,
        aiProvider: provider.name
      });

      return validatedStrategy;

    } catch (error) {
      this.logger.error('AI integration strategy recommendation failed', {
        error: String(error)
      });
      return null;
    }
  }

  /**
   * Build prompt for AI integration strategy recommendation
   * Includes system profiles, requirements, architecture assessment, and available patterns
   */
  private buildIntegrationStrategyPrompt(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment,
    patternAnalysis: IntegrationPatternAnalysis,
    risks: IntegrationRisk[]
  ): string {
    const source = input.sourceSystemProfile;
    const target = input.targetSystemProfile;
    const requirements = input.businessRequirements;

    const prompt = `You are an integration architecture expert recommending the optimal integration approach for two systems.

**Source System:**
- Name: ${source.name}
- Type: ${source.type}
- Capabilities: ${source.capabilities.join(', ')}
- Limitations: ${source.limitations.join(', ')}
- Security Level: ${source.securityLevel}
- Data Volume: ${source.dataVolume?.recordCount || 'Unknown'} records

**Target System:**
- Name: ${target.name}
- Type: ${target.type}
- Capabilities: ${target.capabilities.join(', ')}
- Limitations: ${target.limitations.join(', ')}
- Security Level: ${target.securityLevel}

**Business Requirements:** (${requirements.length} total)
${requirements.slice(0, 5).map(req => `- [${req.priority.toUpperCase()}] ${req.description}`).join('\n')}

**Architecture Assessment:**
- Compatibility Score: ${Math.round(assessment.compatibility.overallScore * 100)}%
- Overall Complexity: ${assessment.complexity.overallComplexity}
- Security Risk Level: ${assessment.security.overallRiskLevel}
- Integration Risks: ${risks.length} identified

**Available Integration Patterns:**
${patternAnalysis.recommendedPatterns.slice(0, 4).map(p =>
  `- ${p.name} (${p.complexity} complexity, ${p.maturity} maturity): ${p.description}`
).join('\n')}

**Task:** Recommend the optimal integration approach considering:
1. System compatibility and capabilities
2. Business requirements and priorities
3. Complexity and risk factors
4. Pattern maturity and proven success

**Format your response as JSON:**
{
  "name": "Recommended Integration Approach Name",
  "description": "Clear description of the integration approach and why it fits",
  "pattern": "api_first|batch|event_driven|hybrid|real_time",
  "complexity": "low|medium|high",
  "recommendationReason": "Detailed reasoning for this recommendation including tradeoffs"
}

Respond ONLY with the JSON object. No additional text.`;

    return prompt;
  }

  /**
   * Parse AI response for integration strategy recommendation
   * Extracts structured integration approach from LLM JSON response
   */
  private parseAIIntegrationStrategyResponse(responseContent: string): IntegrationApproach | null {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = responseContent.trim();

      // Remove markdown code fences if present
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.substring(7);
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.substring(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.substring(0, jsonText.length - 3);
      }

      jsonText = jsonText.trim();

      const parsed = JSON.parse(jsonText);

      // Validate required fields
      if (!parsed.name || !parsed.description || !parsed.pattern || !parsed.complexity) {
        this.logger.warn('AI response missing required fields');
        return null;
      }

      // Validate pattern is valid
      const validPatterns = ['api_first', 'batch', 'event_driven', 'hybrid', 'real_time'];
      if (!validPatterns.includes(parsed.pattern)) {
        this.logger.warn('AI response contains invalid pattern', { pattern: parsed.pattern });
        parsed.pattern = 'api_first'; // Default fallback
      }

      // Validate complexity is valid
      const validComplexity = ['low', 'medium', 'high'];
      if (!validComplexity.includes(parsed.complexity)) {
        this.logger.warn('AI response contains invalid complexity', { complexity: parsed.complexity });
        parsed.complexity = 'medium'; // Default fallback
      }

      return {
        name: parsed.name,
        description: parsed.description,
        pattern: parsed.pattern,
        complexity: parsed.complexity,
        recommendationReason: parsed.recommendationReason || 'AI-generated recommendation based on system analysis'
      };

    } catch (error) {
      this.logger.error('Failed to parse AI integration strategy response', {
        error: String(error),
        responsePreview: responseContent.substring(0, 200)
      });
      return null;
    }
  }

  /**
   * Validate AI integration strategy with heuristic checks
   * Ensures AI recommendations align with pattern analysis and architecture assessment
   */
  private validateAIStrategyWithHeuristics(
    aiStrategy: IntegrationApproach,
    patternAnalysis: IntegrationPatternAnalysis,
    assessment: ArchitectureAssessment
  ): IntegrationApproach {
    // Validate complexity against architecture assessment
    const systemComplexity = assessment.complexity.overallComplexity;
    if (systemComplexity === 'very_high' && aiStrategy.complexity === 'low') {
      this.logger.warn('AI recommended low complexity for very high complexity system, adjusting');
      aiStrategy.complexity = 'high';
    }

    // Ensure high-risk systems don't get marked as low complexity
    if (assessment.security.overallRiskLevel === 'critical' && aiStrategy.complexity === 'low') {
      this.logger.warn('AI underestimated complexity for critical security risk, adjusting');
      aiStrategy.complexity = 'high';
    }

    // Validate pattern exists in recommended patterns
    const patternNames = patternAnalysis.recommendedPatterns.map(p => p.name);
    const patternMatch = patternNames.some(name =>
      name.toLowerCase().includes(aiStrategy.pattern.replace('_', ' '))
    );

    if (!patternMatch) {
      this.logger.warn('AI recommended pattern not in analysis, may need verification', {
        aiPattern: aiStrategy.pattern,
        availablePatterns: patternNames
      });
    }

    // Enhance recommendation reason with architecture context if missing key details
    if (!aiStrategy.recommendationReason.includes('compatibility')) {
      aiStrategy.recommendationReason += ` System compatibility score is ${Math.round(assessment.compatibility.overallScore * 100)}%.`;
    }

    this.logger.info('AI integration strategy validated with heuristics', {
      pattern: aiStrategy.pattern,
      complexity: aiStrategy.complexity,
      adjustmentsMade: false // Would be true if we made changes above
    });

    return aiStrategy;
  }

  /**
   * Generate recommendation reason
   */
  generateRecommendationReason(
    pattern: IntegrationPattern,
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment,
    risks: IntegrationRisk[]
  ): string {
    const reasons = [
      `${pattern.name} pattern selected for its ${pattern.benefits[0]?.toLowerCase() || 'benefits'}`,
      `Compatible with ${input.sourceSystemProfile.type} to ${input.targetSystemProfile.type} integration`,
      `${assessment.complexity.overallComplexity} complexity level manageable with this approach`
    ];

    if (risks.length > 0) {
      reasons.push(`Addresses ${risks.length} identified integration risks`);
    }

    return reasons.join('. ') + '.';
  }

  /**
   * Determine approach complexity based on pattern and assessment
   */
  private determineApproachComplexity(
    pattern: IntegrationPattern,
    assessment: ArchitectureAssessment
  ): 'low' | 'medium' | 'high' {
    const patternComplexity = pattern.complexity;
    const systemComplexity = assessment.complexity.overallComplexity;

    if (patternComplexity === 'high' || systemComplexity === 'high' || systemComplexity === 'very_high') {
      return 'high';
    }
    if (patternComplexity === 'medium' || systemComplexity === 'medium') {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Map pattern type to approach
   */
  private mapPatternTypeToApproach(
    patternType: 'messaging' | 'data' | 'api' | 'event' | 'batch'
  ): 'batch' | 'real_time' | 'hybrid' | 'event_driven' | 'api_first' {
    const patternMapping = {
      'messaging': 'event_driven' as const,
      'data': 'batch' as const,
      'api': 'api_first' as const,
      'event': 'event_driven' as const,
      'batch': 'batch' as const
    };

    return patternMapping[patternType];
  }
}
