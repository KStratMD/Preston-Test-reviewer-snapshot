import 'reflect-metadata';
import { RelationshipEvidenceProvider } from '../../../../src/services/cardinality/RelationshipEvidenceProvider';
import { SchemaDiscoveryService } from '../../../../src/services/ai/validation/SchemaDiscoveryService';
import { NetSuiteSchemaIntelligence } from '../../../../src/services/ai/NetSuiteSchemaIntelligence';
import type { Logger } from '../../../../src/utils/Logger';

/**
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Canonical relationship evidence" for the binding semantics this provider
 * normalizes toward. NetSuiteSchemaIntelligence performs no I/O (its catalog
 * is hardcoded), so every NetSuite-path test constructs a REAL instance with
 * an injected logger — never a bare `new NetSuiteSchemaIntelligence()`.
 */

function makeMockLogger(): Logger {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
}

function makeProvider(schemaDiscoveryService?: SchemaDiscoveryService): RelationshipEvidenceProvider {
  return new RelationshipEvidenceProvider({
    schemaDiscoveryService: schemaDiscoveryService ?? new SchemaDiscoveryService(),
    netSuiteSchemaIntelligence: new NetSuiteSchemaIntelligence(makeMockLogger()),
  });
}

describe('RelationshipEvidenceProvider', () => {
  describe('NetSuite', () => {
    it('sources customer child edges from the static catalog as one_to_many', async () => {
      const provider = makeProvider();

      const evidence = await provider.getEvidence('netsuite', 'customer');

      expect(evidence.status).toBe('available');
      expect(evidence.provenance.source).toBe('manual_server');
      // The real child FK ('company') is derivable because 'contact' is
      // itself catalogued and documents the matching reverse parent edge
      // (contact.company -> customer).
      const contactsEdge = evidence.edges.find((edge) => edge.fromField === 'contacts');
      expect(contactsEdge).toEqual({
        fromEntity: 'customer',
        fromField: 'contacts',
        toEntity: 'contact',
        toField: 'company',
        cardinality: 'one_to_many',
        direction: 'source_to_target',
        required: false,
      });

      // 'customeraddress' is NOT itself a catalogued entity, so the catalog
      // carries no reverse edge to derive the real child FK from — the
      // sentinel must be an obviously-absent '' rather than a guess (e.g.
      // never 'internalid', which is the child's own unrelated PK).
      const addressesEdge = evidence.edges.find((edge) => edge.fromField === 'addresses');
      expect(addressesEdge).toEqual({
        fromEntity: 'customer',
        fromField: 'addresses',
        toEntity: 'customeraddress',
        toField: '',
        cardinality: 'one_to_many',
        direction: 'source_to_target',
        required: false,
      });
    });

    it('normalizes lookup and parent edges to many_to_one', async () => {
      const provider = makeProvider();

      const customerEvidence = await provider.getEvidence('netsuite', 'customer');
      const subsidiaryEdge = customerEvidence.edges.find((edge) => edge.fromField === 'subsidiary');
      expect(subsidiaryEdge?.cardinality).toBe('many_to_one');
      expect(subsidiaryEdge?.toEntity).toBe('subsidiary');

      const contactEvidence = await provider.getEvidence('netsuite', 'contact');
      const companyEdge = contactEvidence.edges.find((edge) => edge.fromField === 'company');
      expect(companyEdge).toEqual({
        fromEntity: 'contact',
        fromField: 'company',
        toEntity: 'customer',
        toField: 'internalid',
        cardinality: 'many_to_one',
        direction: 'source_to_target',
        required: false,
      });
    });

    it('treats every catalogued entity as available', async () => {
      const provider = makeProvider();

      for (const entity of ['customer', 'vendor', 'item', 'contact', 'inventorynumber']) {
        const evidence = await provider.getEvidence('netsuite', entity);
        expect(evidence.status).toBe('available');
      }
    });

    it('catalogs the required inventorynumber.item -> item.internalid parent edge (Task 3, 2026-07-27 NetSuite serialized-asset sync plan)', async () => {
      const provider = makeProvider();

      const evidence = await provider.getEvidence('netsuite', 'inventorynumber');

      expect(evidence.status).toBe('available');
      expect(evidence.edges).toEqual([
        {
          fromEntity: 'inventorynumber',
          fromField: 'item',
          toEntity: 'item',
          toField: 'internalid',
          cardinality: 'many_to_one',
          direction: 'source_to_target',
          required: true,
        },
      ]);
    });

    it('still reports required: false for every pre-existing catalogued edge now that the flag is read from the catalog instead of hardcoded', async () => {
      const provider = makeProvider();

      for (const entity of ['customer', 'vendor', 'item', 'contact']) {
        const evidence = await provider.getEvidence('netsuite', entity);
        expect(evidence.edges.length).toBeGreaterThan(0);
        for (const edge of evidence.edges) {
          expect(edge.required).toBe(false);
        }
      }
    });

    it('marks entities outside the explicit catalogued set as unavailable', async () => {
      const provider = makeProvider();

      const evidence = await provider.getEvidence('netsuite', 'invoice');

      expect(evidence.status).toBe('unavailable');
      expect(evidence.edges).toEqual([]);
      expect(evidence.unavailableReason).toBeDefined();
    });

    it('is case- and whitespace-insensitive when matching the catalogued entity', async () => {
      const provider = makeProvider();

      const evidence = await provider.getEvidence('NetSuite', '  Customer  ');

      expect(evidence.status).toBe('available');
    });
  });

  describe('Salesforce', () => {
    it('treats a manual (real discovery disabled) schema as unavailable, never available with empty edges', async () => {
      const schemaDiscoveryService = new SchemaDiscoveryService({ enableSalesforce: false });
      const provider = makeProvider(schemaDiscoveryService);

      const evidence = await provider.getEvidence('salesforce', 'Account');

      expect(evidence.status).toBe('unavailable');
      expect(evidence.edges).toEqual([]);
      expect(evidence.unavailableReason).toBeDefined();
    });

    it('orients an API-discovered child relationship from the parent relationship name to the child foreign key', async () => {
      const originalFetch = global.fetch;
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          fields: [],
          childRelationships: [
            { field: 'AccountId', childSObject: 'Contact', relationshipName: 'Contacts' },
          ],
        }),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        const schemaDiscoveryService = new SchemaDiscoveryService({ enableSalesforce: true });
        const provider = makeProvider(schemaDiscoveryService);

        const evidence = await provider.getEvidence('salesforce', 'Account');

        expect(evidence.status).toBe('available');
        expect(evidence.provenance.source).toBe('api');
        expect(evidence.edges).toEqual([
          {
            fromEntity: 'Account',
            fromField: 'Contacts',
            toEntity: 'Contact',
            toField: 'AccountId',
            cardinality: 'one_to_many',
            direction: 'source_to_target',
            required: false,
          },
        ]);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('preserves API-discovered many-to-one edges', async () => {
      const schemaDiscoveryService = new SchemaDiscoveryService({ enableSalesforce: true });
      jest.spyOn(schemaDiscoveryService, 'discoverSalesforceRelationshipSchema').mockResolvedValue({
        system: 'Salesforce',
        entity: 'Contact',
        fields: [],
        relationships: [
          {
            sourceField: 'AccountId',
            targetEntity: 'Account',
            targetField: 'Account',
            type: 'many-to-one',
          },
        ],
        metadata: { source: 'api' },
      });
      const provider = makeProvider(schemaDiscoveryService);

      await expect(provider.getEvidence('salesforce', 'Contact')).resolves.toMatchObject({
        status: 'available',
        edges: [
          expect.objectContaining({
            fromEntity: 'Contact',
            fromField: 'Account',
            toEntity: 'Account',
            toField: 'AccountId',
            cardinality: 'many_to_one',
          }),
        ],
      });
    });

    it('throws on a transport failure instead of returning unavailable evidence', async () => {
      const originalFetch = global.fetch;
      const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        const schemaDiscoveryService = new SchemaDiscoveryService({ enableSalesforce: true });
        const provider = makeProvider(schemaDiscoveryService);

        await expect(provider.getEvidence('salesforce', 'Account')).rejects.toThrow('ECONNREFUSED');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws on a non-ok API response instead of returning unavailable evidence', async () => {
      const originalFetch = global.fetch;
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        const schemaDiscoveryService = new SchemaDiscoveryService({ enableSalesforce: true });
        const provider = makeProvider(schemaDiscoveryService);

        await expect(provider.getEvidence('salesforce', 'Account')).rejects.toThrow();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('Business Central and unsupported systems', () => {
    it('marks Business Central as unavailable without throwing (unsupported capability, not a transport failure)', async () => {
      const provider = makeProvider();

      await expect(provider.getEvidence('businesscentral', 'Customer')).resolves.toMatchObject({
        status: 'unavailable',
        edges: [],
      });
    });

    it('marks any other system as unavailable', async () => {
      const provider = makeProvider();

      const evidence = await provider.getEvidence('oracle', 'Customer');

      expect(evidence.status).toBe('unavailable');
      expect(evidence.unavailableReason).toBeDefined();
    });
  });
});
