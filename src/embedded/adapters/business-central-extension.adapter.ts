import type { EmbeddedPlatformAdapter } from './EmbeddedPlatformAdapter';

export const businessCentralExtensionAdapter: EmbeddedPlatformAdapter = {
  id: 'business-central-extension',
  platform: 'business_central',
  displayName: 'Business Central Extension',
  artifactPaths: [
    'platform/business-central-extension/app.json',
    'platform/business-central-extension/src/SuiteCentralEmbeddedHost.PageExt.al',
    'platform/business-central-extension/src/SuiteCentralIframeControl.ControlAddIn.al',
    'platform/business-central-extension/Resources/SuiteCentralIframe.js',
  ],
  hostBootstrap: {
    method: 'server_to_server',
    browserBearerExposed: false,
    platformApi: 'AL HttpClient',
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
  // Keys MUST match the placeholder Error()s in the AL page extension —
  // tests/unit/embedded/businessCentralExtensionAdapter.test.ts asserts
  // every key here has a corresponding 'Configure <key> before deployment'
  // call in the AL source, so adapter descriptor drift fails CI.
  requiredConfigKeys: [
    'SuiteCentralBaseUrl',
    'SuiteCentralEmbeddedServiceToken',
    'SuiteCentralPlatformAccountId',
  ],
};
