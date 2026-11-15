import { MCPPolicyService } from '../../../../../src/services/mcp/MCPPolicyService';
import type { Logger } from '../../../../../src/utils/Logger';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Database } from '../../../../../src/database/types';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

describe('MCPPolicyService', () => {
  let logger: jest.Mocked<Logger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('supports wildcard allow patterns', async () => {
    const service = new MCPPolicyService(logger, undefined, {
      allowlist: 'netsuite.*,bc.bc_actions_search',
      denylist: '',
      disabledTenants: '',
    });

    await expect(service.isToolAllowed('tenant-a', 'netsuite', 'ns_getRecord')).resolves.toBe(true);
    await expect(service.isToolAllowed('tenant-a', 'bc', 'bc_actions_search')).resolves.toBe(true);
    await expect(service.isToolAllowed('tenant-a', 'bc', 'bc_actions_invoke')).resolves.toBe(false);
  });

  it('enforces deny precedence over allowlist', async () => {
    const service = new MCPPolicyService(logger, undefined, {
      allowlist: 'netsuite.*',
      denylist: 'netsuite.ns_deleteRecord',
      disabledTenants: '',
    });

    const allowed = await service.evaluateToolAccess('tenant-a', 'netsuite', 'ns_getRecord');
    const denied = await service.evaluateToolAccess('tenant-a', 'netsuite', 'ns_deleteRecord');

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('denylist_match');
  });

  it('defaults to suitecentral-allowed and external-blocked policy', async () => {
    const service = new MCPPolicyService(logger, undefined, {
      allowlist: '',
      denylist: '',
      disabledTenants: '',
    });

    await expect(service.isToolAllowed('tenant-a', 'suitecentral', 'field_mapping_suggest')).resolves.toBe(true);
    await expect(service.isToolAllowed('tenant-a', 'netsuite', 'ns_getRecord')).resolves.toBe(false);
  });

  it('applies tenant kill switch', async () => {
    const service = new MCPPolicyService(logger, undefined, {
      allowlist: 'netsuite.*',
      denylist: '',
      disabledTenants: 'tenant-blocked,tenant-other',
    });

    const decision = await service.evaluateToolAccess('tenant-blocked', 'netsuite', 'ns_getRecord');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('tenant_disabled');
  });

  it('returns policy snapshot for API/reporting use', async () => {
    const service = new MCPPolicyService(logger, undefined, {
      allowlist: 'netsuite.ns_getRecord',
      denylist: 'bc.*',
      disabledTenants: 'tenant-x',
    });

    const policy = await service.getPolicy('tenant-any');

    expect(policy.allowlist).toEqual(['netsuite.ns_getRecord']);
    expect(policy.denylist).toEqual(['bc.*']);
    expect(policy.disabledTenants).toEqual(['tenant-x']);
    expect(policy.defaultBehavior).toBe('suitecentral_allow_external_explicit');
    expect(policy.dbPolicies).toEqual([]);
  });

  it('supports DB-backed tenant rules for external tools', async () => {
    const sqlite = new BetterSqlite3(':memory:');
    const db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: sqlite }),
    });

    await sql`
      CREATE TABLE mcp_tool_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        system_name TEXT NOT NULL,
        tool_pattern TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, system_name, tool_pattern)
      )
    `.execute(db);

    const fakeDatabaseService = { getDatabase: () => db } as any;
    const service = new MCPPolicyService(logger, fakeDatabaseService, {
      allowlist: '',
      denylist: '',
      disabledTenants: '',
      dbCacheTtlMs: 1,
    });

    await service.upsertToolPolicy({
      tenantId: 'tenant-db',
      systemName: 'netsuite',
      toolPattern: 'ns_createRecord',
      action: 'allow',
    });

    const decision = await service.evaluateToolAccess('tenant-db', 'netsuite', 'ns_createRecord');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('db_allow');

    await service.upsertToolPolicy({
      tenantId: 'tenant-db',
      systemName: 'netsuite',
      toolPattern: 'ns_createRecord',
      action: 'deny',
    });

    const denied = await service.evaluateToolAccess('tenant-db', 'netsuite', 'ns_createRecord');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('db_deny');

    const snapshot = await service.getPolicy('tenant-db');
    expect(snapshot.dbPolicies).toHaveLength(1);
    expect(snapshot.dbPolicies?.[0]).toMatchObject({
      tenantId: 'tenant-db',
      systemName: 'netsuite',
      toolPattern: 'ns_createRecord',
      action: 'deny',
    });

    const deleted = await service.deleteToolPolicy(snapshot.dbPolicies![0].id, 'tenant-db');
    expect(deleted).toBe(true);
    await expect(service.isToolAllowed('tenant-db', 'netsuite', 'ns_createRecord')).resolves.toBe(false);

    await db.destroy();
  });
});
