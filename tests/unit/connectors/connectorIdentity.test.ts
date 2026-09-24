// connectorIdentity — Prerequisite PR A (2026-07-27 NetSuite serialized-asset
// sync plan). Shared home for getSystemType/connectorKeyForSystem, used by
// guardedWrite, ConnectorManager, and OwnershipResumeHandler so all three
// project system-identity values through the same logic.

import { getSystemType, connectorKeyForSystem } from '../../../src/connectors/connectorIdentity';

describe('connectorIdentity', () => {
  describe('getSystemType', () => {
    it('returns the string as-is when system is already a string', () => {
      expect(getSystemType('Salesforce')).toBe('Salesforce');
    });

    it('extracts .type when system is a SystemConfig object', () => {
      expect(getSystemType({ type: 'hubspot' })).toBe('hubspot');
    });
  });

  describe('connectorKeyForSystem', () => {
    it('resolves an arbitrarily-cased SourceSystem to its connector-registry key (Salesforce -> salesforce)', () => {
      expect(connectorKeyForSystem('Salesforce')).toBe('salesforce');
    });

    it('resolves the snake_case manifest form to the run-together registry key (business_central -> businesscentral)', () => {
      expect(connectorKeyForSystem('business_central')).toBe('businesscentral');
    });

    it('passes through an already-correct registry key unchanged (businesscentral -> businesscentral)', () => {
      expect(connectorKeyForSystem('businesscentral')).toBe('businesscentral');
    });

    it('passes through identically-spelled systems unchanged (hubspot, netsuite, shopify, stripe, shipstation, squire)', () => {
      for (const s of ['hubspot', 'netsuite', 'shopify', 'stripe', 'shipstation', 'squire']) {
        expect(connectorKeyForSystem(s)).toBe(s);
      }
    });

    it('trims whitespace and lowercases before matching', () => {
      expect(connectorKeyForSystem('  Business_Central  ')).toBe('businesscentral');
    });

    it('accepts the SystemConfig object shape', () => {
      expect(connectorKeyForSystem({ type: 'Salesforce' })).toBe('salesforce');
    });

    it('resolves a registry-only key that is not a SourceSystem (oracle)', () => {
      expect(connectorKeyForSystem('oracle')).toBe('oracle');
    });

    it('fails closed on an unrecognized alias — no punctuation stripping or fuzzy matching', () => {
      expect(() => connectorKeyForSystem('business-central')).toThrow(
        /unrecognized system 'business-central'/,
      );
      expect(() => connectorKeyForSystem('not-a-real-system')).toThrow(
        /unrecognized system 'not-a-real-system'/,
      );
    });

    // Codex review finding 1 on the Prerequisite PR A commit: the manifest
    // (SOURCE_SYSTEM_TO_CONNECTOR_KEY) must be consulted BEFORE the registry.
    // Every real SourceSystem happens to agree between the two orderings
    // today, so this is pinned explicitly rather than relying on incidental
    // agreement.
    it('every current SourceSystem resolves to exactly its SOURCE_SYSTEM_TO_CONNECTOR_KEY mapping', () => {
      const expected: Record<string, string> = {
        netsuite: 'netsuite',
        business_central: 'businesscentral',
        salesforce: 'salesforce',
        hubspot: 'hubspot',
        shipstation: 'shipstation',
        squire: 'squire',
        stripe: 'stripe',
        shopify: 'shopify',
      };
      for (const [sourceSystem, registryKey] of Object.entries(expected)) {
        expect(connectorKeyForSystem(sourceSystem)).toBe(registryKey);
      }
    });
  });

  describe('connectorKeyForSystem — manifest-vs-registry precedence', () => {
    afterEach(() => {
      jest.dontMock('../../../src/connectors/connectorRegistry');
      jest.resetModules();
    });

    // Codex review finding 1: proves the manifest wins even when the
    // registry ALSO recognizes the raw (pre-mapping) spelling — a collision
    // that does not exist in the real registry today (no registry key is
    // spelled 'business_central'), but would silently stamp the WRONG
    // connector key — defeating guardedWrite's fail-closed
    // `resume.targetSystemId` check — if the registry were consulted first.
    it('pins that the manifest wins over the registry on a simulated collision', () => {
      jest.doMock('../../../src/connectors/connectorRegistry', () => ({
        getConnectorRegistration: (key: string) =>
          key === 'business_central' ? { key: 'business_central' } : undefined,
      }));

      let freshConnectorKeyForSystem!: typeof connectorKeyForSystem;
      jest.isolateModules(() => {
        freshConnectorKeyForSystem =
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('../../../src/connectors/connectorIdentity').connectorKeyForSystem;
      });

      // Manifest wins: resolves through SOURCE_SYSTEM_TO_CONNECTOR_KEY to
      // 'businesscentral', NOT the colliding fake registry entry's own key.
      expect(freshConnectorKeyForSystem('business_central')).toBe('businesscentral');
    });
  });
});
