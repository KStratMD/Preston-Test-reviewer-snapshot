import { MockSquireConnector, MockSuiteCentralConnector, squireSample } from '../__mocks__/squireSuiteCentral';

describe('Squire ↔ SuiteCentral synchronization', () => {
  it('transforms Squire record to SuiteCentral and back', () => {
    const squire = new MockSquireConnector();
    const suiteCentral = new MockSuiteCentralConnector();

    const hub = squire.formatDataForHub(squireSample);
    const suiteRecord = suiteCentral.formatDataFromHub(hub);
    expect(suiteRecord).toEqual({
      customerId: squireSample.id,
      name: `${squireSample.givenName} ${squireSample.familyName}`,
      emailAddress: squireSample.email
    });

    const hubBack = suiteCentral.formatDataForHub(suiteRecord);
    const roundTrip = squire.formatDataFromHub(hubBack);
    expect(roundTrip).toEqual(squireSample);
  });
});

