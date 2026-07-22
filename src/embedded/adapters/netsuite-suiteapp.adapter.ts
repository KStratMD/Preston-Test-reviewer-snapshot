import type { EmbeddedPlatformAdapter } from './EmbeddedPlatformAdapter';

export const netsuiteSuiteAppAdapter: EmbeddedPlatformAdapter = {
  id: 'netsuite-suiteapp',
  platform: 'netsuite',
  displayName: 'NetSuite SuiteApp',
  artifactPaths: [
    'platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js',
    'platform/netsuite-suiteapp/manifest.xml',
  ],
  hostBootstrap: {
    method: 'server_to_server',
    browserBearerExposed: false,
    platformApi: 'N/https',
  },
  supportedModules: [
    'reconciliation',
    'lineage',
    'approvals',
    'sync_health',
    'compliance',
    'flow_templates',
    'sync_error_triage',
  ],
  requiredConfigKeys: [
    'SUITECENTRAL_BASE_URL',
    'SUITECENTRAL_EMBEDDED_SERVICE_TOKEN',
    'SUITECENTRAL_TENANT_ID',
  ],
};
