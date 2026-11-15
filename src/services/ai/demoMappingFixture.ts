/**
 * F2: pure anonymous-demo field mapper. No providers, DI, repositories,
 * telemetry, learned feedback, or runtime service imports belong here.
 */
export interface DemoFieldRef { name: string }

export interface DemoMappingSuggestion {
  sourceField: string;
  targetField: string;
  confidence: number;
  transformationType: 'direct';
  reasoning: string;
}

export function buildRuleBasedDemoMappings(
  sourceFields: readonly DemoFieldRef[],
  targetFields: readonly DemoFieldRef[],
): DemoMappingSuggestion[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return sourceFields.flatMap((sourceField) => {
    const sourceName = normalize(sourceField.name);
    const target = targetFields.find((targetField) => {
      const targetName = normalize(targetField.name);
      return sourceName.length > 0 && targetName.length > 0 && (
        sourceName === targetName || sourceName.includes(targetName) || targetName.includes(sourceName)
      );
    });

    return target
      ? [{
          sourceField: sourceField.name,
          targetField: target.name,
          confidence: 0.6,
          transformationType: 'direct' as const,
          reasoning: 'anonymous demo: rule-based name similarity (no provider or learned adjustment)',
        }]
      : [];
  });
}
