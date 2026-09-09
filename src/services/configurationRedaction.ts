import type { IntegrationConfig } from '../types';

export type ExternalIntegrationConfig = Omit<
  IntegrationConfig,
  'sourceAuthentication' | 'targetAuthentication' | 'authentication'
>;

export function toExternalIntegrationConfig(
  config: IntegrationConfig,
): ExternalIntegrationConfig {
  const clone = structuredClone(config);
  delete clone.sourceAuthentication;
  delete clone.targetAuthentication;
  delete clone.authentication;
  return clone;
}
