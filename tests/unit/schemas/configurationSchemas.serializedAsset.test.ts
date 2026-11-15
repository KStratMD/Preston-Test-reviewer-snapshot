import { IntegrationConfigSchema } from '../../../src/schemas/configurationSchemas';
import type {
  SerializedAssetProfileDraftConfig,
  SerializedAssetProfileValidationSubject,
} from '../../../src/types';
import {
  evaluateSerializedAssetProfile,
  normalizeEntityIdentifier,
  requireReadySerializedAssetProfile,
  SerializedAssetProfileNotReadyError,
} from '../../../src/services/serializedAsset/SerializedAssetProfileValidator';

/**
 * Task 1 (2026-07-27 NetSuite serialized-asset sync plan): execution-profile
 * contract + pure validator. Covers Step 1's checklist — standard-config
 * compatibility, an incomplete inactive specialized draft, the complete
 * ready profile, refusal of an incomplete active profile, wrong
 * systems/entities/direction/mode, missing required mappings, mismatched
 * discriminator, duplicate required targets, and hostile Salesforce field
 * identifiers. Entity variants and both bare-string/SystemConfig system
 * shapes are covered. The registry-key projection accepts supported casing
 * and rejects unknown aliases WITHOUT throwing through safeParse.
 */

type ConfigInput = Record<string, unknown>;

function baseConfig(overrides: ConfigInput = {}): ConfigInput {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Serialized Asset Sync',
    sourceSystem: 'NetSuite',
    targetSystem: 'Salesforce',
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    sourceAuthentication: { type: 'oauth1', credentials: { consumerKey: 'k' } },
    ...overrides,
  };
}

function readyDraft(
  overrides: Partial<SerializedAssetProfileDraftConfig> = {},
): SerializedAssetProfileDraftConfig {
  return {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: 'NetSuite_Product_External_Id__c',
    assetExternalIdField: 'NetSuite_Inventory_Number__c',
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
    ...overrides,
  };
}

function readyMappings(profile: SerializedAssetProfileDraftConfig): ConfigInput[] {
  return [
    { sourceField: 'inventoryNumber', targetField: profile.assetExternalIdField, transformationType: 'direct', isRequired: true },
    { sourceField: 'serialNumber', targetField: 'SerialNumber', transformationType: 'direct', isRequired: true },
    { sourceField: 'itemInternalId', targetField: 'Product2Id', transformationType: 'direct', isRequired: true },
  ];
}

describe('IntegrationConfigSchema — netsuite_serialized_asset execution profile', () => {
  describe('standard-config compatibility', () => {
    it('accepts a config with executionProfile undefined (current behavior preserved)', () => {
      const config = baseConfig({
        sourceSystem: 'Salesforce',
        targetSystem: 'HubSpot',
        sourceEntity: 'Account',
        targetEntity: 'Contact',
        syncDirection: 'unidirectional',
        isActive: true,
        fieldMappings: [{ sourceField: 'Name', targetField: 'name', transformationType: 'direct', isRequired: true }],
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });

    it('accepts a config with executionProfile explicitly "standard"', () => {
      const config = baseConfig({
        executionProfile: 'standard',
        sourceSystem: 'Salesforce',
        targetSystem: 'HubSpot',
        sourceEntity: 'Account',
        targetEntity: 'Contact',
        syncDirection: 'unidirectional',
        isActive: true,
        fieldMappings: [{ sourceField: 'Name', targetField: 'name', transformationType: 'direct', isRequired: true }],
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });
  });

  describe('inactive specialized draft', () => {
    it('accepts an incomplete inactive netsuite_serialized_asset draft (fields/mappings may be omitted)', () => {
      const config = baseConfig({
        isActive: false,
        fieldMappings: [],
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: { executionProfile: 'netsuite_serialized_asset' },
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });
  });

  describe('complete ready profile', () => {
    it('accepts a fully ready, active netsuite_serialized_asset profile', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });

    it('accepts a SystemConfig object for both sourceSystem and targetSystem', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        sourceSystem: { type: 'netsuite', systemId: 'ns-1', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      delete config.sourceAuthentication;
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });
  });

  describe('refusal of an incomplete active profile', () => {
    // Non-empty fieldMappings (readyMappings-style, built from a COMPLETE
    // reference draft — not the incomplete profile under test) is
    // deliberate: with `fieldMappings: []`, the pre-existing "active
    // configurations must have at least one field mapping" rule (a separate
    // `.refine()` on IntegrationConfigSchema, unrelated to this profile)
    // would already reject the config on its own, making this test pass for
    // the wrong reason regardless of whether the serialized-asset superRefine
    // block runs at all. Asserting the SPECIFIC issue below proves this test
    // is sensitive to the profile-readiness check, not the unrelated rule.
    it('rejects an active profile missing required profile fields', () => {
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: { executionProfile: 'netsuite_serialized_asset' },
        fieldMappings: readyMappings(readyDraft()),
      });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['executionProfileConfig', 'productExternalIdField'],
            message: 'productExternalIdField is required to activate the netsuite_serialized_asset profile',
          }),
        );
      }
    });
  });

  describe('wrong systems/entities/direction/mode', () => {
    it('rejects when sourceSystem does not resolve to netsuite', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        sourceSystem: 'HubSpot',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when targetSystem does not resolve to salesforce', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        targetSystem: 'business_central',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when sourceEntity is not inventorynumber', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        sourceEntity: 'SalesOrder',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when targetEntity is not Asset', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        targetEntity: 'Contact',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when syncDirection is not source_to_target', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        syncDirection: 'target_to_source',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when syncMode is not batch or manual', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        syncMode: 'realtime',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('missing / ambiguous required mappings', () => {
    it('rejects when a required mapping target has zero matching field mappings', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile).filter(m => m.targetField !== profile.assetExternalIdField),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects when a required mapping target has more than one matching field mapping', () => {
      const profile = readyDraft();
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'altSerial', targetField: 'SerialNumber', transformationType: 'direct', isRequired: true },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a required mapping whose sourceField is whitespace-only', () => {
      const profile = readyDraft();
      const mappings = readyMappings(profile).map(m =>
        m.targetField === profile.assetExternalIdField ? { ...m, sourceField: '   ' } : m,
      );
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('mismatched discriminator', () => {
    it('rejects executionProfileConfig present while top-level executionProfile is undefined', () => {
      const config = baseConfig({ executionProfileConfig: readyDraft() });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects executionProfileConfig present while top-level executionProfile is "standard"', () => {
      const config = baseConfig({ executionProfile: 'standard', executionProfileConfig: readyDraft() });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects top-level executionProfile "netsuite_serialized_asset" with executionProfileConfig omitted', () => {
      const config = baseConfig({ executionProfile: 'netsuite_serialized_asset' });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('duplicate required targets', () => {
    it('rejects when two profile target fields collide on the same Salesforce field name', () => {
      const profile = readyDraft({ assetExternalIdField: 'Product2Id' });
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('hostile Salesforce field identifiers', () => {
    it('rejects a malformed assetExternalIdField even in an inactive draft', () => {
      const config = baseConfig({
        isActive: false,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: {
          executionProfile: 'netsuite_serialized_asset',
          assetExternalIdField: '123-bad field!',
        },
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects an executionProfileConfig object with an unrecognized extra key', () => {
      const config = baseConfig({
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: {
          executionProfile: 'netsuite_serialized_asset',
          unexpectedField: 'nope',
        },
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects serialNumberTargetField set to anything other than the fixed literal "SerialNumber"', () => {
      const config = baseConfig({
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: {
          executionProfile: 'netsuite_serialized_asset',
          serialNumberTargetField: 'Serial_Number__c',
        },
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects an active ready-shaped profile with productExternalIdField missing', () => {
      const profile = readyDraft();
      delete profile.productExternalIdField;
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      const result = IntegrationConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['executionProfileConfig', 'productExternalIdField'],
            message: 'productExternalIdField is required to activate the netsuite_serialized_asset profile',
          }),
        );
      }
    });

    it('rejects a malformed productExternalIdField even in an inactive draft', () => {
      const config = baseConfig({
        isActive: false,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: {
          executionProfile: 'netsuite_serialized_asset',
          productExternalIdField: 'bad field name',
        },
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('entity variants normalize via trim + toLocaleLowerCase', () => {
    it.each(['inventorynumber', 'inventoryNumber', '  InventoryNumber  ', 'INVENTORYNUMBER'])(
      'accepts sourceEntity variant %p',
      (variant) => {
        const profile = readyDraft();
        const config = baseConfig({
          isActive: true,
          sourceEntity: variant,
          executionProfile: 'netsuite_serialized_asset',
          executionProfileConfig: profile,
          fieldMappings: readyMappings(profile),
        });
        expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
      },
    );

    it.each(['asset', ' Asset ', 'ASSET'])('accepts targetEntity variant %p', (variant) => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        targetEntity: variant,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });
  });

  describe('registry-key projection casing and unknown aliases', () => {
    it('accepts supported casing variants that project to netsuite/salesforce', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        sourceSystem: 'NETSUITE',
        targetSystem: 'SALESFORCE',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });

    it('rejects an unrecognized system alias without throwing', () => {
      const profile = readyDraft();
      const config = baseConfig({
        isActive: true,
        sourceSystem: 'totally-unknown-system-xyz',
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(() => IntegrationConfigSchema.safeParse(config)).not.toThrow();
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('optional statusTargetField / locationTargetField', () => {
    it('accepts a ready profile with statusTargetField configured and exactly one matching mapping', () => {
      const profile = readyDraft({ statusTargetField: 'Status' });
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'status', targetField: 'Status', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });

    it('rejects a ready profile with statusTargetField configured but zero matching mappings', () => {
      const profile = readyDraft({ statusTargetField: 'Status' });
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a ready profile with statusTargetField configured but two matching mappings', () => {
      const profile = readyDraft({ statusTargetField: 'Status' });
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'status', targetField: 'Status', transformationType: 'direct', isRequired: false },
        { sourceField: 'statusAlt', targetField: 'Status', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a mapping that targets a field outside the profile whitelist (statusTargetField unconfigured)', () => {
      const profile = readyDraft();
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'status', targetField: 'Status', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  // Mirrors the statusTargetField block above — locationTargetField shares
  // the same optional-target contract and had no dedicated coverage.
  describe('optional locationTargetField', () => {
    it('accepts a ready profile with locationTargetField configured and exactly one matching mapping', () => {
      const profile = readyDraft({ locationTargetField: 'Location__c' });
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'location', targetField: 'Location__c', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(true);
    });

    it('rejects a ready profile with locationTargetField configured but zero matching mappings', () => {
      const profile = readyDraft({ locationTargetField: 'Location__c' });
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: readyMappings(profile),
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a ready profile with locationTargetField configured but two matching mappings', () => {
      const profile = readyDraft({ locationTargetField: 'Location__c' });
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'location', targetField: 'Location__c', transformationType: 'direct', isRequired: false },
        { sourceField: 'locationAlt', targetField: 'Location__c', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects a mapping that targets a field outside the profile whitelist (locationTargetField unconfigured)', () => {
      const profile = readyDraft();
      const mappings = [
        ...readyMappings(profile),
        { sourceField: 'location', targetField: 'Location__c', transformationType: 'direct', isRequired: false },
      ];
      const config = baseConfig({
        isActive: true,
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        fieldMappings: mappings,
      });
      expect(IntegrationConfigSchema.safeParse(config).success).toBe(false);
    });
  });
});

describe('SerializedAssetProfileValidator (pure functions)', () => {
  describe('normalizeEntityIdentifier', () => {
    it('trims and lowercases using the shared en-US locale rule', () => {
      expect(normalizeEntityIdentifier('  InventoryNumber ')).toBe('inventorynumber');
      expect(normalizeEntityIdentifier('ASSET')).toBe('asset');
    });
  });

  describe('requireReadySerializedAssetProfile', () => {
    it('returns the ready profile for a complete, correctly-wired config', () => {
      const profile = readyDraft();
      const subject = {
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        fieldMappings: readyMappings(profile),
        executionProfile: 'netsuite_serialized_asset' as const,
        executionProfileConfig: profile,
      };
      const ready = requireReadySerializedAssetProfile(subject);
      expect(ready.assetExternalIdField).toBe(profile.assetExternalIdField);
      expect(ready.serialNumberTargetField).toBe('SerialNumber');
      expect(ready.productReferenceTargetField).toBe('Product2Id');
    });

    it('throws SerializedAssetProfileNotReadyError for an unresolvable system without crashing', () => {
      const subject = {
        sourceSystem: 'unknown-system',
        targetSystem: 'Salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        fieldMappings: [],
        executionProfile: 'netsuite_serialized_asset' as const,
        executionProfileConfig: { executionProfile: 'netsuite_serialized_asset' as const },
      };
      expect(() => requireReadySerializedAssetProfile(subject)).toThrow(SerializedAssetProfileNotReadyError);
    });

    it('throws for a config whose executionProfile is not netsuite_serialized_asset', () => {
      const subject = {
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        fieldMappings: [],
      };
      expect(() => requireReadySerializedAssetProfile(subject)).toThrow(SerializedAssetProfileNotReadyError);
    });
  });

  describe('evaluateSerializedAssetProfile — malformed/absent runtime values never throw', () => {
    // Models a config loaded from raw, unvalidated on-disk JSON
    // (ConfigurationService.loadConfigurations reads `${id}.json` directly)
    // where a field the TS type claims is a required `string` is actually
    // missing at runtime — `as unknown as` mirrors how such a value would
    // reach the validator without re-running the Zod schema.
    function readySubject(): SerializedAssetProfileValidationSubject {
      const profile = readyDraft();
      return {
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        fieldMappings: readyMappings(profile),
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
      };
    }

    it('produces an issue, not a thrown TypeError, when sourceEntity is absent', () => {
      const subject = readySubject() as Record<string, unknown>;
      delete subject.sourceEntity;
      let evaluation: ReturnType<typeof evaluateSerializedAssetProfile> | undefined;
      expect(() => {
        evaluation = evaluateSerializedAssetProfile(subject as unknown as SerializedAssetProfileValidationSubject);
      }).not.toThrow();
      expect(evaluation?.ok).toBe(false);
      if (evaluation && evaluation.ok === false) {
        expect(evaluation.issues).toContainEqual(
          expect.objectContaining({ path: ['sourceEntity'] }),
        );
      }
    });

    it('produces an issue, not a thrown TypeError, when targetEntity is absent', () => {
      const subject = readySubject() as Record<string, unknown>;
      delete subject.targetEntity;
      let evaluation: ReturnType<typeof evaluateSerializedAssetProfile> | undefined;
      expect(() => {
        evaluation = evaluateSerializedAssetProfile(subject as unknown as SerializedAssetProfileValidationSubject);
      }).not.toThrow();
      expect(evaluation?.ok).toBe(false);
      if (evaluation && evaluation.ok === false) {
        expect(evaluation.issues).toContainEqual(
          expect.objectContaining({ path: ['targetEntity'] }),
        );
      }
    });

    it('produces an issue, not a thrown TypeError, when a required mapping has no sourceField', () => {
      const subject = readySubject();
      const mappings = (subject.fieldMappings ?? []).map(m => ({ ...m } as Record<string, unknown>));
      const assetMapping = mappings.find(m => m.targetField === subject.executionProfileConfig?.assetExternalIdField);
      delete assetMapping?.sourceField;
      subject.fieldMappings = mappings as unknown as SerializedAssetProfileValidationSubject['fieldMappings'];
      let evaluation: ReturnType<typeof evaluateSerializedAssetProfile> | undefined;
      expect(() => {
        evaluation = evaluateSerializedAssetProfile(subject);
      }).not.toThrow();
      expect(evaluation?.ok).toBe(false);
      if (evaluation && evaluation.ok === false) {
        expect(evaluation.issues).toContainEqual(
          expect.objectContaining({ path: ['fieldMappings'] }),
        );
      }
    });
  });

  describe('activation refuses what the reader could never resolve', () => {
    function readySubject(
      overrides: Partial<SerializedAssetProfileValidationSubject> = {},
    ): SerializedAssetProfileValidationSubject {
      const profile = readyDraft();
      return {
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'inventorynumber',
        targetEntity: 'Asset',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        fieldMappings: readyMappings(profile) as unknown as SerializedAssetProfileValidationSubject['fieldMappings'],
        executionProfile: 'netsuite_serialized_asset',
        executionProfileConfig: profile,
        ...overrides,
      };
    }

    /**
     * Replaces ONLY the Product2Id mapping's sourceField, so the rule under
     * test is the only one the subject can violate — every other slot stays
     * exactly as `readySubject` built it.
     */
    function withProductSourceField(sourceField: unknown): SerializedAssetProfileValidationSubject {
      const subject = readySubject();
      const mappings = (subject.fieldMappings ?? []).map(m => ({ ...m } as Record<string, unknown>));
      const target = mappings.find(m => m.targetField === 'Product2Id');
      if (target) {
        target.sourceField = sourceField;
      }
      subject.fieldMappings = mappings as unknown as SerializedAssetProfileValidationSubject['fieldMappings'];
      return subject;
    }

    // Baseline: without this the "rejects" cases below could pass for the
    // wrong reason (e.g. a subject that was never ready to begin with).
    it('accepts the ready subject unchanged', () => {
      expect(evaluateSerializedAssetProfile(readySubject()).ok).toBe(true);
    });

    it('accepts a dotted reference path the reader pierces (item.id)', () => {
      expect(evaluateSerializedAssetProfile(withProductSourceField('item.id')).ok).toBe(true);
    });

    // The whole point of the fix: this used to evaluate as READY, and then
    // every record failed `missing_required_field` in normalizeBatch and
    // landed in `invalid` (never deferred) after the sweep cursor had already
    // moved past the window.
    it.each([
      ['a fields.-rooted path the reader resolves as record.fields.fields.*', 'fields.id'],
      ['a padded segment that can never match an exact fields key', 'item . id'],
      ['an empty segment from a doubled dot', 'item..id'],
      ['a leading dot', '.id'],
      ['a prototype-pollution segment', '__proto__'],
      ['a whitespace-only path', '   '],
    ])('rejects %s', (_label, sourceField) => {
      const evaluation = evaluateSerializedAssetProfile(withProductSourceField(sourceField));
      expect(evaluation.ok).toBe(false);
      if (evaluation.ok === false) {
        // Assert the MESSAGE too: path ['fieldMappings'] is shared by the
        // missing/ambiguous-mapping rules, so path alone would not prove
        // which rule fired.
        expect(evaluation.issues).toContainEqual({
          path: ['fieldMappings'],
          message: 'sourceField for productReferenceTargetField must be a non-empty scalar path the reader can resolve',
        });
      }
    });

    it('refuses a nested executionProfile discriminator that contradicts the outer one', () => {
      const subject = readySubject();
      subject.executionProfileConfig = {
        ...readyDraft(),
        executionProfile: 'standard',
      } as unknown as SerializedAssetProfileDraftConfig;

      const evaluation = evaluateSerializedAssetProfile(subject);
      expect(evaluation.ok).toBe(false);
      if (evaluation.ok === false) {
        expect(evaluation.issues).toContainEqual({
          path: ['executionProfileConfig', 'executionProfile'],
          message: "executionProfileConfig.executionProfile must be 'netsuite_serialized_asset'",
        });
      }
    });

    it('produces an issue, not a thrown TypeError, when fieldMappings is not an array', () => {
      const subject = readySubject();
      subject.fieldMappings = { bad: true } as unknown as SerializedAssetProfileValidationSubject['fieldMappings'];

      let evaluation: ReturnType<typeof evaluateSerializedAssetProfile> | undefined;
      expect(() => {
        evaluation = evaluateSerializedAssetProfile(subject);
      }).not.toThrow();
      expect(evaluation?.ok).toBe(false);
      if (evaluation && evaluation.ok === false) {
        expect(evaluation.issues).toContainEqual({
          path: ['fieldMappings'],
          message: 'fieldMappings must be an array',
        });
      }
    });
  });
});
