import { describe, it, expect } from '@jest/globals';
import {
  assertEmbeddedPlatformAdapter,
  type EmbeddedPlatformAdapter,
} from '../../../src/embedded/adapters/EmbeddedPlatformAdapter';

describe('EmbeddedPlatformAdapter contract', () => {
  it('accepts a complete NetSuite adapter descriptor', () => {
    const adapter: EmbeddedPlatformAdapter = {
      id: 'netsuite-suiteapp',
      platform: 'netsuite',
      displayName: 'NetSuite SuiteApp',
      artifactPaths: ['platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'],
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

    expect(() => assertEmbeddedPlatformAdapter(adapter)).not.toThrow();
  });

  it('rejects descriptors that expose bearer tokens to browser JavaScript (defense-in-depth against type bypass)', () => {
    const adapter = {
      id: 'bad-adapter',
      platform: 'netsuite',
      displayName: 'Bad Adapter',
      artifactPaths: ['platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'],
      hostBootstrap: {
        method: 'browser',
        browserBearerExposed: true,
        platformApi: 'window.fetch',
      },
      supportedModules: ['approvals'],
      requiredConfigKeys: ['SUITECENTRAL_EMBEDDED_SERVICE_TOKEN'],
    } as unknown as EmbeddedPlatformAdapter;

    expect(() => assertEmbeddedPlatformAdapter(adapter)).toThrow(
      /Embedded adapter bad-adapter must call host-bootstrap server-to-server/,
    );
  });

  it('rejects descriptors with no artifact paths', () => {
    const adapter: EmbeddedPlatformAdapter = {
      id: 'no-artifacts',
      platform: 'netsuite',
      displayName: 'No Artifacts',
      artifactPaths: [],
      hostBootstrap: {
        method: 'server_to_server',
        browserBearerExposed: false,
        platformApi: 'N/https',
      },
      supportedModules: ['approvals'],
      requiredConfigKeys: ['SUITECENTRAL_EMBEDDED_SERVICE_TOKEN'],
    };

    expect(() => assertEmbeddedPlatformAdapter(adapter)).toThrow(
      /must declare at least one platform artifact/,
    );
  });

  it('rejects descriptors missing hostBootstrap (TypeError defense)', () => {
    const adapter = {
      id: 'incomplete',
      platform: 'netsuite',
      displayName: 'Incomplete',
      artifactPaths: ['platform/netsuite-suiteapp/SuiteCentralHostSuitelet.js'],
      // hostBootstrap intentionally omitted
      supportedModules: ['approvals'],
      requiredConfigKeys: ['SUITECENTRAL_EMBEDDED_SERVICE_TOKEN'],
    } as unknown as EmbeddedPlatformAdapter;

    expect(() => assertEmbeddedPlatformAdapter(adapter)).toThrow(
      /must declare a hostBootstrap descriptor/,
    );
  });

  it('rejects descriptors where artifactPaths is not an array', () => {
    const adapter = {
      id: 'bad-artifacts',
      platform: 'netsuite',
      displayName: 'Bad Artifacts',
      artifactPaths: null,
      hostBootstrap: {
        method: 'server_to_server',
        browserBearerExposed: false,
        platformApi: 'N/https',
      },
      supportedModules: ['approvals'],
      requiredConfigKeys: ['SUITECENTRAL_EMBEDDED_SERVICE_TOKEN'],
    } as unknown as EmbeddedPlatformAdapter;

    expect(() => assertEmbeddedPlatformAdapter(adapter)).toThrow(
      /must declare at least one platform artifact/,
    );
  });

  it('rejects descriptors with no supported modules', () => {
    const adapter: EmbeddedPlatformAdapter = {
      id: 'no-modules',
      platform: 'business_central',
      displayName: 'No Modules',
      artifactPaths: ['platform/business-central-extension/app.json'],
      hostBootstrap: {
        method: 'server_to_server',
        browserBearerExposed: false,
        platformApi: 'AL HttpClient',
      },
      supportedModules: [],
      requiredConfigKeys: ['SuiteCentralEmbeddedServiceToken'],
    };

    expect(() => assertEmbeddedPlatformAdapter(adapter)).toThrow(
      /must declare at least one supported module/,
    );
  });
});
