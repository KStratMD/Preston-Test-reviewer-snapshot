import '../../setupEnv'; // Must be first to configure environment
/**
 * SuiteCentral → NetSuite demo sync — demo-tenant override, REAL governance
 * chain (no guardedWrite stub).
 *
 * The sibling suite (SuiteCentralNetSuiteSync.test.ts) stubs guardedWrite as
 * a pass-through to pin mapping/CRUD mechanics. This suite is the product
 * proof for the 2026-06-11 unblock decision: with the canonical manifest
 * (`customer` owned-by-netsuite, reject_with_alert) and the real
 * OwnershipResolver + AuditService wired through inversify,
 *   1. OWNERSHIP_DEMO_TENANT_ID set → the flow's guarded writes run under the
 *      demo tenant, the resolver's demo-tenant override allows them, and the
 *      sync SUCCEEDS — with the 'ownership_demo_tenant_override' flag
 *      persisted on the real audit rows.
 *   2. env unset → every record still rejects with OwnershipViolation
 *      (fail-closed default unchanged).
 *
 * Only the connectors are mocked (no live NetSuite); governance services,
 * manifest, and audit persistence are real.
 */
import { sql } from 'kysely';
import { runSuiteCentralNetSuiteSync } from '../../../../src/integrations/SuiteCentralNetSuiteSync';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';
import { DatabaseService } from '../../../../src/database/DatabaseService';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../helpers/syncErrorAssistTestHelpers';
import type { IntegrationService } from '../../../../src/services/IntegrationService';
import type { DataRecord } from '../../../../src/types';

const DEMO_TENANT = 'demo-tenant-sync-1';

jest.mock('../../../../src/connectors/SuiteCentralConnector', () => ({
  SuiteCentralConnector: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockImplementation(async () => [
      { id: 'sc-1', fields: { name: 'Central Supplies', email: 'info@central.com', phone: '+1-555-1000' } },
      { id: 'sc-2', fields: { name: 'Global Industries', email: 'sales@global.com', phone: '+1-555-2000' } },
    ]),
  })),
}));

jest.mock('../../../../src/connectors/NetSuiteConnector', () => ({
  NetSuiteConnector: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockImplementation(async (_entity: string, record: DataRecord) =>
      ({ ...record, id: `NS_${record.id}` } as DataRecord)),
    read: jest.fn().mockImplementation(async (_entity: string, id: string) => ({ id, fields: {} })),
    update: jest.fn().mockImplementation(async (_entity: string, _id: string, rec: DataRecord) => rec),
    delete: jest.fn().mockResolvedValue(true),
  })),
}));

describe('SuiteCentralNetSuiteSync — demo-tenant override (real governance chain)', () => {
  let dbService: DatabaseService;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    await setupTestDatabase();
    dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    savedEnv = process.env.OWNERSHIP_DEMO_TENANT_ID;
    await sql`DELETE FROM audit_logs`.execute(dbService.getDatabase());
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.OWNERSHIP_DEMO_TENANT_ID;
    } else {
      process.env.OWNERSHIP_DEMO_TENANT_ID = savedEnv;
    }
  });

  it('OWNERSHIP_DEMO_TENANT_ID set → sync succeeds and audit rows carry the override flag', async () => {
    process.env.OWNERSHIP_DEMO_TENANT_ID = DEMO_TENANT;
    const integrationService = { recordSyncResult: jest.fn() } as unknown as IntegrationService;

    const result = await runSuiteCentralNetSuiteSync(integrationService);

    expect(result).toMatchObject({
      status: 'success',
      success: true,
      recordsProcessed: 2,
      recordsSuccessful: 2,
      recordsFailed: 0,
      errors: [],
    });

    // The real AuditService persisted the override decision rows under the
    // demo tenant with the distinct flag (AuditPersistenceMapper envelope:
    // flags land on outcome.governanceFlags).
    const rows = await dbService
      .getDatabase()
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', 'like', 'suitecentral-netsuite-%')
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const flagged = rows.filter((row) => {
      // sqlite returns the details JSON envelope as TEXT despite the
      // schema-side object typing.
      const details = JSON.parse(String(row.details));
      return details.outcome?.governanceFlags?.includes('ownership_demo_tenant_override');
    });
    // 2 records × (create + update + delete) = 6 overridden decisions, each
    // with a decision row AND a write_succeeded outcome row carrying the flag.
    expect(flagged.length).toBeGreaterThanOrEqual(6);
  });

  it('env unset → flow stays blocked: every record rejects with OwnershipViolation', async () => {
    delete process.env.OWNERSHIP_DEMO_TENANT_ID;
    const integrationService = { recordSyncResult: jest.fn() } as unknown as IntegrationService;

    const result = await runSuiteCentralNetSuiteSync(integrationService);

    expect(result.status).toBe('failed');
    expect(result.success).toBe(false);
    expect(result.recordsSuccessful).toBe(0);
    expect(result.recordsFailed).toBe(2);
    for (const message of result.errors) {
      expect(message).toMatch(/ownership|reject_with_alert|netsuite/i);
    }
  });
});
