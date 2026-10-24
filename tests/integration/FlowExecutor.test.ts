/**
 * FlowExecutor — Integration Test (PR 14 narrowed).
 *
 * Walks the real OutboundGovernanceService + ApprovalQueueService +
 * approval queue table against an in-memory sqlite database. The connector
 * is stubbed (no real HTTP) and passed via `FlowContext.connector` — the
 * same surface production callers will use after resolving + initializing
 * the real connector via `ConnectorManager`. The executor itself never
 * touches `ConnectorManager` post-Codex-5.5 (the caller owns connector
 * resolution + initialization; the executor only verifies systemType).
 *
 * Three scenarios:
 *   1. Happy path — PII-free payload completes end-to-end; connector.create
 *      called with the redacted payload (no redaction needed); FlowResult
 *      reports succeeded with the connector-assigned id.
 *   2. HITL queue — payload carrying high-risk PII drives approvalRequired,
 *      executor enqueues into the real governance_approvals table, returns
 *      pending_approval with the persisted approval id. Connector is NOT
 *      called.
 *   3. Blocked path — oversized payload hard-blocks via the
 *      OutboundGovernanceService size guard; executor returns blocked,
 *      connector untouched, no approval enqueued.
 */

import 'reflect-metadata';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { FlowExecutor } from '../../src/flows/templates/FlowExecutor';
import type { FlowTemplate, FlowContext } from '../../src/flows/templates/FlowTemplate';
import type { IConnector } from '../../src/interfaces/IConnector';
import { ApprovalQueueRepository } from '../../src/services/governance/ApprovalQueueRepository';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';

interface ContactEvent {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface ContactRecord extends Record<string, unknown> {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

function makeTemplate(): FlowTemplate<ContactEvent, ContactRecord> {
  return {
    id: 'integration-test-contact-v1',
    category: 'master_data_sync',
    version: '1.0.0',
    source: { system: 'hubspot', eventType: 'contact.created' },
    target: { system: 'netsuite', recordType: 'Contact', canonicalEntity: 'contact', operation: 'create' },
    description: 'integration test template',
    governanceCallouts: [],
    transform: async (e) => ({
      id: e.id,
      email: e.email,
      firstName: e.firstName,
      lastName: e.lastName,
    }),
    riskClassification: () => 'medium',
    retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotencyKey: (e) => (e as ContactEvent).id },
  };
}

function makeCtx(
  connector: IConnector,
  overrides: Partial<FlowContext> = {},
): FlowContext {
  return {
    tenantId: 'tenant-A',
    userId: 'operator-1',
    correlationId: 'corr-int-1',
    connector,
    ...overrides,
  };
}

/**
 * Build a stub connector with `systemType` set to the value the test template
 * targets ('tgt'). FlowExecutor's connector contract check asserts the match
 * before any dispatch (Codex 5.5 HIGH on PR #825).
 */
function stubConnector(systemType: string = 'NetSuite'): jest.Mocked<IConnector> {
  const conn = {
    systemType,
    initialize: jest.fn(),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn(),
    getSystemInfo: jest.fn(),
    create: jest.fn(),
    read: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn(),
    search: jest.fn(),
    syncRecord: jest.fn(),
    syncBatch: jest.fn(),
  };
  return conn as unknown as jest.Mocked<IConnector>;
}

describe('FlowExecutor — integration', () => {
  let executor: FlowExecutor;
  let connector: jest.Mocked<IConnector>;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    // The caller is responsible for supplying a pre-initialized connector
    // via FlowContext (Codex 5.5 HIGH on PR #825). The integration test
    // passes a stub connector through ctx.connector — same surface
    // production routes will use after resolving via ConnectorManager.
    connector = stubConnector();
    executor = await container.getAsync<FlowExecutor>(TYPES.FlowExecutor);
  });

  it('happy path: PII-free payload completes end-to-end with succeeded result', async () => {
    connector.create.mockResolvedValue({ id: 'ns-created-001', firstName: 'Bob' });
    const result = await executor.execute(
      makeTemplate(),
      { id: 'e-clean', email: '', firstName: 'Bob', lastName: 'Roberts' },
      makeCtx(connector),
    );
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.targetRecordId).toBe('ns-created-001');
      expect(result.governance.approved).toBe(true);
      expect(result.governance.approvalRequired).toBe(false);
    }
    expect(connector.create).toHaveBeenCalledTimes(1);
    expect(connector.create.mock.calls[0][0]).toBe('Contact');
  });

  it('HITL path: high-risk PII triggers approvalRequired → enqueue → pending_approval', async () => {
    const result = await executor.execute(
      makeTemplate(),
      {
        id: 'e-pii',
        // Real SSN shape that DLP recognises as high-risk PII.
        email: '123-45-6789 hi we love your work, contact me at 415-555-1234',
        firstName: 'Alice',
        lastName: 'Doe',
      },
      makeCtx(connector),
    );
    // OutboundGovernanceService defaults to `approvalMode: 'queue'` (PR 3B —
    // see the comment in src/services/governance/OutboundGovernanceService.ts
    // right after DEFAULT_CONFIG). So a high-risk PII payload MUST land on the
    // approvalRequired → enqueue path here. Asserting `pending_approval`
    // explicitly catches a regression to 'block' or a broken enqueue that the
    // looser `['pending_approval','blocked']` membership test would mask.
    // Copilot R1 on PR #825 flagged the earlier looser assertion.
    expect(result.status).toBe('pending_approval');
    expect(connector.create).not.toHaveBeenCalled();
    if (result.status !== 'pending_approval') {
      throw new Error('unreachable; assertion above proved status === pending_approval');
    }

    // Verify the approval row really landed in the database.
    const repo = await container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);
    const row = await repo.getById('tenant-A', result.approvalId);
    expect(row).not.toBeNull();
    expect(row!.tenantId).toBe('tenant-A');
    expect(row!.status).toBe('pending');
    expect(row!.operationType).toBe('connector_write');
    expect(row!.resourceType).toBe('Contact');
    expect(row!.resourceId).toBe('new');
    // PII-bearing payloads MUST be persisted in redacted form only.
    expect(row!.redactedPayload).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });

  it('blocked path: oversize payload returns blocked with reason=governance', async () => {
    // OutboundGovernanceService defaults to 1 MB; build a fixture that
    // comfortably exceeds it. (1.5 MB string.)
    const huge = 'x'.repeat(1_500_000);
    const result = await executor.execute(
      makeTemplate(),
      { id: 'e-big', email: '', firstName: huge, lastName: '' },
      makeCtx(connector),
    );
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked' && result.reason === 'governance') {
      expect(result.governance?.auditMetadata.blocked).toBe(true);
    }
    expect(connector.create).not.toHaveBeenCalled();
  });
});
