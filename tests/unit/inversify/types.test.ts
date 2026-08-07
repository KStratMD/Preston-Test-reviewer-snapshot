import { TYPES } from '../../../src/inversify/types';

describe('TYPES', () => {
  it('does not expose the stale SupplierCentralServiceNew token', () => {
    expect(TYPES).not.toHaveProperty('SupplierCentralServiceNew');
  });
});
