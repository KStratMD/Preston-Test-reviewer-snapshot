export interface HubRecord {
  id: string;
  fields: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

export interface SquireRecord {
  id: string;
  givenName: string;
  familyName: string;
  email: string;
}

export interface SuiteCentralRecord {
  customerId: string;
  name: string;
  emailAddress: string;
}

export const squireSample: SquireRecord = {
  id: 's1',
  givenName: 'Alice',
  familyName: 'Johnson',
  email: 'alice@example.com'
};

export const suiteCentralSample: SuiteCentralRecord = {
  customerId: 'sc1',
  name: 'Bob Smith',
  emailAddress: 'bob@example.com'
};

export class MockSquireConnector {
  formatDataForHub(record: SquireRecord): HubRecord {
    return {
      id: record.id,
      fields: {
        firstName: record.givenName,
        lastName: record.familyName,
        email: record.email
      }
    };
  }

  formatDataFromHub(hub: HubRecord): SquireRecord {
    return {
      id: hub.id,
      givenName: hub.fields.firstName ?? '',
      familyName: hub.fields.lastName ?? '',
      email: hub.fields.email ?? ''
    };
  }
}

export class MockSuiteCentralConnector {
  formatDataForHub(record: SuiteCentralRecord): HubRecord {
    const [firstName, ...rest] = record.name.split(' ');
    return {
      id: record.customerId,
      fields: {
        firstName,
        lastName: rest.join(' '),
        email: record.emailAddress
      }
    };
  }

  formatDataFromHub(hub: HubRecord): SuiteCentralRecord {
    return {
      customerId: hub.id,
      name: `${hub.fields.firstName ?? ''} ${hub.fields.lastName ?? ''}`.trim(),
      emailAddress: hub.fields.email ?? ''
    };
  }
}

