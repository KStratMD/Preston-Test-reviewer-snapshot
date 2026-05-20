/**
 * ConnectorOutboundGovernance.test.ts
 *
 * Tests that all 5 production connectors correctly wire the outbound DLP guard:
 *  - validateConnectorWrite is called on create/update/delete
 *  - Redacted payload replaces original payload sent to makeRequest
 *  - GovernanceBlockedError is thrown and makeRequest is NOT called when blocked
 *  - PendingApprovalError is thrown and makeRequest is NOT called when pending approval
 *  - BusinessCentral guard fires BEFORE ETag GET
 *  - Bulk operations call guard once per record
 *  - Constructor throws when OutboundGovernanceService is missing
 *  - ConnectorManager wires governance into created connectors
 */

import { NetSuiteConnector } from 'src/connectors/NetSuiteConnector';
import { SalesforceConnector } from 'src/connectors/SalesforceConnector';
import { BusinessCentralConnector } from 'src/connectors/BusinessCentralConnector';
import { HubSpotConnector } from 'src/connectors/HubSpotConnector';
import { ShipStationConnector } from 'src/connectors/ShipStationConnector';
import { ConnectorManager } from 'src/services/integration/ConnectorManager';
import { GovernanceBlockedError, PendingApprovalError } from 'src/services/governance/OutboundGovernanceErrors';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';
import type { Logger } from 'src/utils/Logger';
import type { AuthService } from 'src/services/AuthService';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

function makeAuthService(): jest.Mocked<AuthService> {
  return {
    authenticateOAuth1: jest.fn(),
    authenticateOAuth2: jest.fn(),
    getAccessToken: jest.fn(),
  } as unknown as jest.Mocked<AuthService>;
}

/** Returns a minimal Axios-like client whose request() resolves with a generic DataRecord shape. */
function makeHttpClient() {
  return {
    request: jest.fn().mockResolvedValue({ data: { id: 'r1', fields: {}, externalId: 'e1' } }),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
}

// ---------------------------------------------------------------------------
// Connector factory helpers
// ---------------------------------------------------------------------------

function makeNetSuite(governance = createMockOutboundGovernanceService()) {
  const c = new NetSuiteConnector('ns', makeLogger(), makeAuthService(), governance);
  (c as any).httpClient = makeHttpClient();
  (c as any).isAuthenticated = true;
  (c as any).accountId = 'ACCT';
  (c as any).baseUrl = 'https://acct.api.netsuite.com';
  return { c, governance };
}

function makeSalesforce(governance = createMockOutboundGovernanceService()) {
  const c = new SalesforceConnector('sf', makeLogger(), makeAuthService(), governance);
  const client = makeHttpClient();
  // Salesforce create: 1st call POST → {id, success, errors[]}, 2nd call GET read-back
  client.request
    .mockResolvedValueOnce({ data: { id: 'r1', success: true, errors: [] } })
    .mockResolvedValue({ data: { Id: 'r1', Name: 'Acme', externalId: 'e1', fields: {} } });
  (c as any).httpClient = client;
  (c as any).isAuthenticated = true;
  (c as any).demoMode = false;
  (c as any).accessToken = 'tok';
  (c as any).instanceUrl = 'https://sf.example.com';
  return { c, governance };
}

function makeBusinessCentral(governance = createMockOutboundGovernanceService()) {
  const c = new BusinessCentralConnector('bc', makeLogger(), makeAuthService(), governance);
  const client = makeHttpClient();
  // update() and delete() do an ETag GET first → return a record with @odata.etag
  client.request.mockResolvedValue({
    data: { id: 'r1', '@odata.etag': 'W/"etag123"', fields: {}, externalId: 'e1' },
  });
  (c as any).httpClient = client;
  (c as any).isAuthenticated = true;
  (c as any).companyId = 'COMPANY1';
  return { c, governance };
}

function makeHubSpot(governance = createMockOutboundGovernanceService()) {
  const c = new HubSpotConnector(makeLogger(), governance);
  (c as any).httpClient = makeHttpClient();
  (c as any).isAuthenticated = true;
  return { c, governance };
}

function makeShipStation(governance = createMockOutboundGovernanceService()) {
  const c = new ShipStationConnector(makeLogger(), governance);
  (c as any).httpClient = makeHttpClient();
  (c as any).isAuthenticated = true;
  (c as any).apiKey = 'key';
  (c as any).apiSecret = 'secret';
  return { c, governance };
}

// ---------------------------------------------------------------------------
// Block decision helper
// ---------------------------------------------------------------------------

function makeBlockedDecision() {
  return {
    approved: false,
    approvalRequired: false,
    findings: ['ssn'],
    riskLevel: 'high' as const,
    auditMetadata: { scanDurationMs: 0, findingsCount: 1, redacted: false, blocked: true },
  };
}

function makePendingDecision() {
  return {
    approved: false,
    approvalRequired: true,
    findings: ['ssn'],
    riskLevel: 'high' as const,
    auditMetadata: { scanDurationMs: 0, findingsCount: 1, redacted: false, blocked: false },
  };
}

// ---------------------------------------------------------------------------
// 1. validateConnectorWrite() is called for each operation
// ---------------------------------------------------------------------------

describe('validateConnectorWrite() is called for each operation', () => {
  describe('NetSuiteConnector', () => {
    it('calls validateConnectorWrite on create', async () => {
      const { c, governance } = makeNetSuite();
      await c.create('customer', { id: '1', externalId: 'e1', fields: { name: 'Acme' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on update', async () => {
      const { c, governance } = makeNetSuite();
      await c.update('customer', '1', { fields: { name: 'NewName' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on delete', async () => {
      const { c, governance } = makeNetSuite();
      await c.delete('customer', '1');
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('SalesforceConnector', () => {
    it('calls validateConnectorWrite on create', async () => {
      const { c, governance } = makeSalesforce();
      await c.create('Account', { id: '1', externalId: 'e1', fields: { Name: 'Acme' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on update', async () => {
      const { c, governance } = makeSalesforce();
      await c.update('Account', '1', { fields: { Name: 'NewName' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on delete', async () => {
      const { c, governance } = makeSalesforce();
      await c.delete('Account', '1');
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('BusinessCentralConnector', () => {
    it('calls validateConnectorWrite on create', async () => {
      const { c, governance } = makeBusinessCentral();
      await c.create('customer', { id: '1', externalId: 'e1', fields: { name: 'Acme' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on update', async () => {
      const { c, governance } = makeBusinessCentral();
      await c.update('customer', '1', { fields: { name: 'NewName' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on delete', async () => {
      const { c, governance } = makeBusinessCentral();
      await c.delete('customer', '1');
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('HubSpotConnector', () => {
    it('calls validateConnectorWrite on create', async () => {
      const { c, governance } = makeHubSpot();
      await c.create('contacts', { id: '1', externalId: 'e1', fields: { firstname: 'Jane' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on update', async () => {
      const { c, governance } = makeHubSpot();
      await c.update('contacts', '1', { fields: { firstname: 'Jane' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on delete', async () => {
      const { c, governance } = makeHubSpot();
      await c.delete('contacts', '1');
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('ShipStationConnector', () => {
    it('calls validateConnectorWrite on create', async () => {
      const { c, governance } = makeShipStation();
      await c.create('orders', { id: '1', externalId: 'e1', fields: { orderNumber: 'ORD-1' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on update', async () => {
      const { c, governance } = makeShipStation();
      await c.update('orders', '1', { fields: { orderNumber: 'ORD-1' } });
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });

    it('calls validateConnectorWrite on delete', async () => {
      const { c, governance } = makeShipStation();
      await c.delete('orders', '1');
      expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Approved redacted payload is sent to makeRequest
// ---------------------------------------------------------------------------

describe('Approved redacted payload is sent to makeRequest when guard redacts', () => {
  it('sends redacted payload to makeRequest on NetSuite create', async () => {
    const governance = createMockOutboundGovernanceService();
    const redacted = { id: '1', name: 'REDACTED' };
    governance.validateConnectorWrite.mockResolvedValueOnce({
      approved: true,
      approvalRequired: false,
      redactedPayload: redacted,
      findings: ['name'],
      riskLevel: 'low' as const,
      auditMetadata: { scanDurationMs: 0, findingsCount: 1, redacted: true, blocked: false },
    });
    const { c } = makeNetSuite(governance);
    await c.create('customer', { id: '1', externalId: 'e1', fields: { name: 'John Smith' } });
    const requestCall = (c as any).httpClient.request.mock.calls[0][0];
    expect(requestCall.data).toEqual(redacted);
  });
});

// ---------------------------------------------------------------------------
// 3. Block path — GovernanceBlockedError thrown, makeRequest not called
// ---------------------------------------------------------------------------

describe('Block path — GovernanceBlockedError thrown, makeRequest not called', () => {
  it('throws GovernanceBlockedError on NetSuite create when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeNetSuite(governance);
    await expect(
      c.create('customer', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on NetSuite update when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeNetSuite(governance);
    await expect(c.update('customer', '1', { fields: { ssn: '123-45-6789' } })).rejects.toBeInstanceOf(
      GovernanceBlockedError,
    );
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on NetSuite delete when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeNetSuite(governance);
    await expect(c.delete('customer', '1')).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on Salesforce create when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeSalesforce(governance);
    await expect(
      c.create('Account', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on update when blocked (Salesforce)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeSalesforce(governance);
    await expect(c.update('account', '1', { fields: { ssn: '123-45-6789' } }))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on delete when blocked (Salesforce)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeSalesforce(governance);
    await expect(c.delete('account', '1'))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on BusinessCentral create when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeBusinessCentral(governance);
    await expect(
      c.create('customer', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on HubSpot create when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeHubSpot(governance);
    await expect(
      c.create('contacts', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on update when blocked (HubSpot)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeHubSpot(governance);
    await expect(c.update('contacts', '1', { fields: { ssn: '123-45-6789' } }))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on delete when blocked (HubSpot)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeHubSpot(governance);
    await expect(c.delete('contacts', '1'))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on ShipStation create when blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeShipStation(governance);
    await expect(
      c.create('orders', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on update when blocked (ShipStation)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeShipStation(governance);
    await expect(c.update('orders', '1', { fields: { ssn: '123-45-6789' } }))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws GovernanceBlockedError on delete when blocked (ShipStation)', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeShipStation(governance);
    await expect(c.delete('orders', '1'))
      .rejects.toBeInstanceOf(GovernanceBlockedError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Pending approval path — PendingApprovalError thrown, makeRequest not called
// ---------------------------------------------------------------------------

describe('Pending approval path — PendingApprovalError thrown, makeRequest not called', () => {
  it('throws PendingApprovalError on NetSuite create when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeNetSuite(governance);
    await expect(
      c.create('customer', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on NetSuite update when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeNetSuite(governance);
    await expect(c.update('customer', '1', { fields: { ssn: '123-45-6789' } })).rejects.toBeInstanceOf(
      PendingApprovalError,
    );
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on NetSuite delete when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeNetSuite(governance);
    await expect(c.delete('customer', '1')).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on Salesforce create when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeSalesforce(governance);
    await expect(
      c.create('Account', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on BusinessCentral create when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeBusinessCentral(governance);
    await expect(
      c.create('customer', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on HubSpot create when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeHubSpot(governance);
    await expect(
      c.create('contacts', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('throws PendingApprovalError on ShipStation create when approval required', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makePendingDecision());
    const { c } = makeShipStation(governance);
    await expect(
      c.create('orders', { id: '1', externalId: 'e1', fields: { ssn: '123-45-6789' } }),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. BusinessCentral — blocked guard prevents ETag GET
// ---------------------------------------------------------------------------

describe('BusinessCentral — blocked guard prevents ETag GET', () => {
  it('does not perform ETag GET when update is blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeBusinessCentral(governance);
    await expect(c.update('customer', '1', { fields: { ssn: '123-45-6789' } })).rejects.toBeInstanceOf(
      GovernanceBlockedError,
    );
    // No ETag GET, no PATCH
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });

  it('does not perform ETag GET when delete is blocked', async () => {
    const governance = createMockOutboundGovernanceService();
    governance.validateConnectorWrite.mockResolvedValueOnce(makeBlockedDecision());
    const { c } = makeBusinessCentral(governance);
    await expect(c.delete('customer', '1')).rejects.toBeInstanceOf(GovernanceBlockedError);
    // No ETag GET, no DELETE
    expect((c as any).httpClient.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Bulk paths call guard once per record
// ---------------------------------------------------------------------------

describe('Bulk paths call guard once per record', () => {
  it('bulkCreate calls validateConnectorWrite once per record', async () => {
    const { c, governance } = makeNetSuite();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkCreate('customer', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkDelete calls validateConnectorWrite once per id', async () => {
    const { c, governance } = makeShipStation();
    await c.bulkDelete('orders', ['id1', 'id2', 'id3']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(3);
  });

  it('bulkUpdate calls validateConnectorWrite once per record', async () => {
    const { c, governance } = makeNetSuite();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkUpdate('customer', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkCreate calls validateConnectorWrite once per record (Salesforce)', async () => {
    const { c, governance } = makeSalesforce();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkCreate('Account', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkCreate calls validateConnectorWrite once per record (BusinessCentral)', async () => {
    const { c, governance } = makeBusinessCentral();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkCreate('customer', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkCreate calls validateConnectorWrite once per record (HubSpot)', async () => {
    const { c, governance } = makeHubSpot();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkCreate('contacts', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkCreate calls validateConnectorWrite once per record (ShipStation)', async () => {
    const { c, governance } = makeShipStation();
    const records = [
      { id: '1', externalId: 'e1', fields: { name: 'A' } },
      { id: '2', externalId: 'e2', fields: { name: 'B' } },
    ];
    await c.bulkCreate('orders', records);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkDelete calls validateConnectorWrite once per id (NetSuite)', async () => {
    const { c, governance } = makeNetSuite();
    await c.bulkDelete('customer', ['id1', 'id2', 'id3']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(3);
  });

  it('bulkDelete calls validateConnectorWrite once per id (Salesforce)', async () => {
    const { c, governance } = makeSalesforce();
    await c.bulkDelete('Account', ['id1', 'id2']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkDelete calls validateConnectorWrite once per id (BusinessCentral)', async () => {
    const { c, governance } = makeBusinessCentral();
    await c.bulkDelete('customer', ['id1', 'id2']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkDelete calls validateConnectorWrite once per id (HubSpot)', async () => {
    const { c, governance } = makeHubSpot();
    await c.bulkDelete('contacts', ['id1', 'id2']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(2);
  });

  it('bulkDelete calls validateConnectorWrite once per id (ShipStation)', async () => {
    const { c, governance } = makeShipStation();
    await c.bulkDelete('orders', ['id1', 'id2', 'id3']);
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Constructor guard — throws when OutboundGovernanceService is missing
// ---------------------------------------------------------------------------

describe('Constructor guard — throws when OutboundGovernanceService is missing', () => {
  it.each([
    [
      'NetSuiteConnector',
      () => new NetSuiteConnector('ns', makeLogger(), makeAuthService(), undefined as any),
    ],
    [
      'SalesforceConnector',
      () => new SalesforceConnector('sf', makeLogger(), makeAuthService(), undefined as any),
    ],
    [
      'BusinessCentralConnector',
      () => new BusinessCentralConnector('bc', makeLogger(), makeAuthService(), undefined as any),
    ],
    ['HubSpotConnector', () => new HubSpotConnector(makeLogger(), undefined as any)],
    ['ShipStationConnector', () => new ShipStationConnector(makeLogger(), undefined as any)],
  ])('%s throws when outboundGovernance is missing', (_name, factory) => {
    expect(factory).toThrow('OutboundGovernanceService is required');
  });
});

// ---------------------------------------------------------------------------
// 8. ConnectorManager produces protected connectors
// ---------------------------------------------------------------------------

describe('ConnectorManager produces protected connectors', () => {
  it('ConnectorManager passes governance to NetSuiteConnector', async () => {
    const governance = createMockOutboundGovernanceService();
    const manager = new ConnectorManager(makeLogger(), makeAuthService(), governance);
    const connector = await manager.getConnector('netsuite', 'ns1');
    // Inject http client so we can call create
    (connector as any).httpClient = makeHttpClient();
    (connector as any).isAuthenticated = true;
    (connector as any).accountId = 'ACCT';
    (connector as any).baseUrl = 'https://acct.api.netsuite.com';
    await connector.create('customer', { id: '1', externalId: 'e1', fields: {} });
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9. IntegrationService factory path wires governance into connectors
// ---------------------------------------------------------------------------

import { IntegrationService } from 'src/services/IntegrationService';

describe('IntegrationService factory path', () => {
  it('passes governance to connectors created via getConnector (NetSuite)', async () => {
    const governance = createMockOutboundGovernanceService();
    const mockLogger = makeLogger();
    const mockTransformation = { transform: jest.fn() } as any;
    const mockConfig = {
      loadConfigurations: jest.fn().mockResolvedValue(undefined),
      getConfiguration: jest.fn(),
      getAllConfigurations: jest.fn().mockReturnValue([]),
    } as any;
    const mockAuth = makeAuthService();

    // ObservabilityService is optional (5th param); outboundGovernance is 6th
    const service = new IntegrationService(
      mockLogger,
      mockTransformation,
      mockConfig,
      mockAuth,
      undefined,
      governance,
    );

    // getConnector is private — access via any
    const connector = await (service as any).getConnector('NetSuite', 'test-ns');

    // Behavioral assertion: verify governance is actually invoked on create()
    // inject minimal http client so create() can run
    const http = {
      request: jest.fn().mockResolvedValue({ data: { id: 'r1', fields: {}, externalId: 'e1' } }),
      defaults: { baseURL: '', headers: { common: {} } },
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    };
    (connector as any).httpClient = http;
    (connector as any).isAuthenticated = true;
    (connector as any).accountId = 'ACCT';
    (connector as any).baseUrl = 'https://acct.api.netsuite.com';

    await connector.create('customer', { id: '1', externalId: 'e1', fields: {} });
    expect(governance.validateConnectorWrite).toHaveBeenCalledTimes(1);
  });
});
