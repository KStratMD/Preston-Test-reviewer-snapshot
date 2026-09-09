import { MockSquireConnector, squireSample } from '../__mocks__/squireSuiteCentral';

describe('SquireConnector', () => {
  const connector = new MockSquireConnector();

  it('maps Squire record to hub format', () => {
    const hub = connector.formatDataForHub(squireSample);
    expect(hub).toEqual({
      id: 's1',
      fields: {
        firstName: 'Alice',
        lastName: 'Johnson',
        email: 'alice@example.com'
      }
    });
  });

  it('maps hub data back to Squire format', () => {
    const hub = connector.formatDataForHub(squireSample);
    const record = connector.formatDataFromHub(hub);
    expect(record).toEqual(squireSample);
  });
});

