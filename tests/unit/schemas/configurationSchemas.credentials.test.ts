import { IntegrationConfigSchema, validateIntegrationConfig } from '../../../src/schemas/configurationSchemas';
import { connectorKeyForSystem } from '../../../src/connectors/connectorIdentity';


/**
 * Managed credential reference schema tests (Prerequisite PR B, 2026-07-27
 * NetSuite serialized-asset sync plan — decision 15: managed credentials are
 * a platform capability). Covers Step B1's checklist: string compatibility,
 * strict SystemConfig, missing secret-manager systemId, secret-manager plus
 * inline-auth rejection, unknown-key rejection, lowercase registry-key
 * projection, and unchanged save/import persistence of validated system
 * references.
 */

type ConfigInput = Record<string, unknown>;

function baseConfig(overrides: ConfigInput = {}): ConfigInput {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Test Config',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [
      { sourceField: 'Name', targetField: 'companyname', transformationType: 'direct', isRequired: true },
    ],
    sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
    ...overrides,
  };
}

describe('IntegrationConfigSchema — managed credential references', () => {
  describe('string compatibility (legacy plain-string system references)', () => {
    it('accepts a plain-string sourceSystem/targetSystem with sourceAuthentication supplied', () => {
      const result = IntegrationConfigSchema.safeParse(baseConfig());
      expect(result.success).toBe(true);
    });

    it('rejects a plain-string sourceSystem with sourceAuthentication OMITTED (unconditional requirement unchanged)', () => {
      const config = baseConfig();
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('accepts a plain-string targetSystem with targetAuthentication OMITTED for a non-bidirectional sync (unchanged existing behavior)', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ syncDirection: 'source_to_target' }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects a plain-string targetSystem with targetAuthentication OMITTED for a BIDIRECTIONAL sync (unchanged existing behavior)', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ syncDirection: 'bidirectional' }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('strict SystemConfig object shape', () => {
    it('accepts a SystemConfig object with type/systemId/credentialSource', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('unknown-key rejection: a SystemConfig object with an unrecognized extra field is rejected (.strict())', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          sourceSystem: {
            type: 'Salesforce',
            systemId: 'sf-1',
            credentialSource: 'secret_manager',
            unexpectedField: 'nope',
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects an empty-string type on a SystemConfig object', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ sourceSystem: { type: '' } }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('secret_manager credentialSource', () => {
    it('missing secret-manager systemId is rejected', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          sourceSystem: { type: 'Salesforce', credentialSource: 'secret_manager' },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('secret-manager plus inline-auth rejection: sourceAuthentication present alongside credentialSource=secret_manager is rejected', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
          sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'inline-secret' } },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('accepts secret_manager with a valid systemId and NO inline sourceAuthentication', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('target secret_manager satisfies the bidirectional target-authentication requirement without an inline secret', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          syncDirection: 'bidirectional',
          targetSystem: { type: 'NetSuite', systemId: 'ns-1', credentialSource: 'secret_manager' },
        }),
      );
      expect(result.success).toBe(true);
    });

    // Copilot/review finding on the initial Prereq B commit: the absence
    // check only inspected `sourceAuthentication`/`targetAuthentication`
    // directly, never the legacy `authentication.source`/`.target` fallback
    // shape — which ConnectorCredentialResolver treats as equivalent inline
    // auth. A secret_manager reference paired with the legacy shape sailed
    // through clean, persisting a plaintext secret at rest beside a managed
    // reference (validateIntegrationConfig discards result.data, so the raw
    // input persists verbatim).
    it('secret-manager plus legacy authentication.source rejection (source side)', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
        authentication: { source: { type: 'api_key', credentials: { apiKey: 'inline-secret' } } },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('secret-manager plus legacy authentication.target rejection (target side)', () => {
      const config = baseConfig({
        targetSystem: { type: 'NetSuite', systemId: 'ns-1', credentialSource: 'secret_manager' },
        authentication: { target: { type: 'oauth1', credentials: { consumerKey: 'inline-secret' } } },
      });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('accepts secret_manager with a valid systemId and NO legacy authentication.source present', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
        authentication: { target: { type: 'oauth1', credentials: { consumerKey: 'unrelated' } } },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  describe('environment credentialSource', () => {
    it('accepts an environment-sourced system reference with no inline authentication and no systemId', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', credentialSource: 'environment' },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('target environment credentialSource satisfies the bidirectional requirement (no secret persisted)', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          syncDirection: 'bidirectional',
          targetSystem: { type: 'NetSuite', credentialSource: 'environment' },
        }),
      );
      expect(result.success).toBe(true);
    });

    // Copilot R4: the resolver returns `undefined` for 'environment' and never
    // reads inline auth, so tolerating an inline object would persist a
    // plaintext secret at rest that is silently never used. Refused, same
    // posture as 'secret_manager'.
    it('REJECTS an inline authentication object alongside credentialSource "environment"', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ sourceSystem: { type: 'Salesforce', credentialSource: 'environment' } }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.join('.') === 'sourceAuthentication')).toBe(true);
      }
    });

    it('REJECTS an inline target authentication object alongside target credentialSource "environment"', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({
          targetSystem: { type: 'NetSuite', credentialSource: 'environment' },
          targetAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  // Copilot R4. `.trim()` is a transform, and `validateIntegrationConfig()`
  // discards `result.data` — so a padded value used to validate against its
  // trimmed form and then persist RAW. From that point the runtime disagrees
  // with the validator: `connectorKeyForSystem` trims before projecting, but
  // `SecureCredentialManager.getCredentialKey` lowercases WITHOUT trimming, so
  // the padded record addresses a different secret than the operator configured.
  describe('surrounding whitespace is REJECTED, not silently trimmed', () => {
    // Each case is constructed so the ONLY rule it can violate is the whitespace
    // one — otherwise the auth-pairing rules for 'secret_manager'/'environment'
    // reject the config first and the test passes without exercising anything.
    // (Mutation testing caught exactly that: two earlier drafts of these still
    // passed with `.trim()` restored.) The asserted issue path pins the cause.
    it('rejects a padded SystemConfig.systemId', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: ' sf-prod ', credentialSource: 'secret_manager' },
      });
      delete config.sourceAuthentication; // required absent for 'secret_manager'
      const result = IntegrationConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.join('.') === 'sourceSystem.systemId')).toBe(true);
      }
    });

    it('rejects a padded SystemConfig.type', () => {
      const config = baseConfig({ sourceSystem: { type: ' Salesforce ', credentialSource: 'environment' } });
      delete config.sourceAuthentication; // required absent for 'environment'
      const result = IntegrationConfigSchema.safeParse(config);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.join('.') === 'sourceSystem.type')).toBe(true);
      }
    });

    // The LEGACY plain-string branch is refused too (Codex R6). A round-5
    // revision exempted it on the theory that `connectorKeyForSystem` (which
    // trims) was its only projection — false: `IntegrationService` projects with
    // RAW `getSystemType()` and `ConnectorManager.createConnector` looks that up
    // with `.toLowerCase()` and no trim, so a padded legacy reference throws
    // `Unsupported system type` at runtime. Refusing it is not a back-compat
    // break; the config could never have run.
    it('rejects a padded legacy plain-string system reference', () => {
      // baseConfig supplies sourceAuthentication, which a legacy string
      // reference REQUIRES — so whitespace is the only rule left to break.
      const result = IntegrationConfigSchema.safeParse(baseConfig({ sourceSystem: ' Salesforce ' }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.join('.') === 'sourceSystem')).toBe(true);
      }
    });

    // Control: blank stays rejected in BOTH forms, which is what the removed
    // `.trim().min(1)` used to guarantee. Both now go through the same rule —
    // '' fails `.min(1)`, and any other whitespace-only string fails the
    // trim-equality refine.
    it('still rejects a whitespace-only legacy system reference', () => {
      const result = IntegrationConfigSchema.safeParse(baseConfig({ sourceSystem: '   ' }));
      expect(result.success).toBe(false);
    });

    // Half of the justification, pinned here: the TRIMMING projection accepts
    // padding, so a padded record looks fine through `connectorKeyForSystem`.
    // The other half — that the projection `IntegrationService` actually uses
    // does NOT trim, and the record therefore cannot resolve a connector at all
    // — is pinned against the real service in
    // `tests/unit/services/IntegrationService.core.test.ts`
    // ("a padded system reference cannot resolve a connector at all"). It is
    // asserted there rather than here because an assertion in this file could
    // only restate the registry's behavior, which is not the mechanism that
    // fails (Codex R7).
    it('the trimming projection accepts padding, which is why the schema must not', () => {
      expect(connectorKeyForSystem(' Salesforce ')).toBe('salesforce');
    });

    it('still rejects a whitespace-only SystemConfig.type', () => {
      const config = baseConfig({ sourceSystem: { type: '   ', credentialSource: 'environment' } });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    // The whole point: what DOES validate is persisted byte-for-byte, so the
    // validator and every runtime key derivation describe the same string.
    it('accepts an unpadded value and leaves it byte-identical', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
      });
      delete config.sourceAuthentication; // required absent for 'secret_manager'
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sourceSystem).toEqual({
          type: 'Salesforce',
          systemId: 'sf-prod',
          credentialSource: 'secret_manager',
        });
      }
    });
  });

  describe('inline credentialSource (explicit)', () => {
    it('requires sourceAuthentication when credentialSource is explicitly "inline"', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', credentialSource: 'inline' },
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('accepts credentialSource "inline" with sourceAuthentication present', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ sourceSystem: { type: 'Salesforce', credentialSource: 'inline' } }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('lowercase registry-key projection', () => {
    // The schema deliberately does NOT transform/lowercase the persisted
    // system reference (no z.transform()) — normalization is a runtime
    // projection via connectorKeyForSystem()/getSystemType(), applied by
    // callers (ConnectorManager, the credential resolver) at read time.
    it('a validated legacy string system reference of arbitrary casing projects correctly through connectorKeyForSystem()', () => {
      const config = baseConfig({ sourceSystem: 'NETSUITE', targetSystem: 'Salesforce' });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(connectorKeyForSystem(result.data.sourceSystem)).toBe('netsuite');
        expect(connectorKeyForSystem(result.data.targetSystem)).toBe('salesforce');
      }
    });

    it('a validated manifest-spelled SystemConfig object (business_central) projects to the registry key (businesscentral)', () => {
      const config = baseConfig({
        targetSystem: { type: 'business_central', systemId: 'bc-1', credentialSource: 'secret_manager' },
      });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(connectorKeyForSystem(result.data.targetSystem)).toBe('businesscentral');
      }
    });
  });

  describe('same-system rejection (getSystemType projection)', () => {
    it('rejects identical plain-string source/target (unchanged existing behavior)', () => {
      const result = IntegrationConfigSchema.safeParse(
        baseConfig({ sourceSystem: 'Salesforce', targetSystem: 'Salesforce' }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a SystemConfig object source and a plain-string target that project to the same system type', () => {
      // sourceAuthentication deleted so the ONLY violation exercised here is
      // the same-system rule, not the secret_manager/inline-auth conflict.
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
        targetSystem: 'Salesforce',
      });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('unchanged save/import persistence of validated system references', () => {
    it('validateIntegrationConfig() discards result.data — it does not expose or mutate the parsed shape', () => {
      const config = baseConfig({
        sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
      });
      delete config.sourceAuthentication;
      const validation = validateIntegrationConfig(config);
      expect(validation.isValid).toBe(true);
      expect(validation).not.toHaveProperty('data');
    });

    it('safeParse does not rewrite a server-authored SystemConfig object (no transform — exact round-trip)', () => {
      const systemRef = { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' as const };
      const config = baseConfig({ sourceSystem: systemRef });
      delete config.sourceAuthentication;
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sourceSystem).toEqual(systemRef);
      }
    });

    it('safeParse does not rewrite a legacy plain-string system reference', () => {
      const config = baseConfig({ sourceSystem: 'Salesforce' });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sourceSystem).toBe('Salesforce');
      }
    });
  });
});
