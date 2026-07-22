import { MockSuiteCentralConnector, suiteCentralSample } from '../__mocks__/squireSuiteCentral';

describe('SuiteCentralConnector', () => {
  const connector = new MockSuiteCentralConnector();

  it('maps SuiteCentral record to hub format', () => {
    const hub = connector.formatDataForHub(suiteCentralSample);
    expect(hub).toEqual({
      id: 'sc1',
      fields: {
        firstName: 'Bob',
        lastName: 'Smith',
        email: 'bob@example.com'
      }
    });
  });

  it('maps hub data back to SuiteCentral format', () => {
    const hub = connector.formatDataForHub(suiteCentralSample);
    const record = connector.formatDataFromHub(hub);
    expect(record).toEqual(suiteCentralSample);
  });
});

