import {
  SalesforceProductResolver,
  type Product2LookupConnector,
} from '../../../../src/services/serializedAsset/SalesforceProductResolver';

/**
 * Task 4 (2026-07-27 NetSuite serialized-asset sync plan). Thin adapter over
 * `SalesforceConnector.findProduct2ByExternalId`: classifies rows into
 * resolved/missing/ambiguous. No mutation, no logging.
 */
describe('SalesforceProductResolver', () => {
  function makeConnector(rows: readonly { Id: string }[]): jest.Mocked<Product2LookupConnector> {
    return {
      findProduct2ByExternalId: jest.fn().mockResolvedValue(rows),
    };
  }

  it('resolves a single valid row', async () => {
    const connector = makeConnector([{ Id: '01t000000000001AAA' }]);
    const resolver = new SalesforceProductResolver(connector);

    const result = await resolver.resolve('ITEM-001', 'SKU__c');

    expect(result).toEqual({ status: 'resolved', product2Id: '01t000000000001AAA' });
    expect(connector.findProduct2ByExternalId).toHaveBeenCalledWith('SKU__c', 'ITEM-001');
  });

  it('reports missing for zero rows', async () => {
    const connector = makeConnector([]);
    const resolver = new SalesforceProductResolver(connector);

    const result = await resolver.resolve('ITEM-404', 'SKU__c');

    expect(result).toEqual({ status: 'missing' });
  });

  it('reports ambiguous for more than one row', async () => {
    const connector = makeConnector([{ Id: '01t000000000001AAA' }, { Id: '01t000000000002AAA' }]);
    const resolver = new SalesforceProductResolver(connector);

    const result = await resolver.resolve('ITEM-DUP', 'SKU__c');

    expect(result).toEqual({ status: 'ambiguous' });
  });

  it('reports ambiguous for a malformed row (missing Id)', async () => {
    const connector = makeConnector([{ Id: '' }] as unknown as { Id: string }[]);
    const resolver = new SalesforceProductResolver(connector);

    const result = await resolver.resolve('ITEM-BAD', 'SKU__c');

    expect(result).toEqual({ status: 'ambiguous' });
  });

  it('reports ambiguous when a malformed row accompanies an otherwise-valid row', async () => {
    const connector = makeConnector([
      { Id: '01t000000000001AAA' },
      {} as unknown as { Id: string },
    ]);
    const resolver = new SalesforceProductResolver(connector);

    const result = await resolver.resolve('ITEM-MIXED', 'SKU__c');

    expect(result).toEqual({ status: 'ambiguous' });
  });
});
