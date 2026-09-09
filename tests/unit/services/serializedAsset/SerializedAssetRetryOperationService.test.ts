import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { SerializedAssetRetryOperationRepository } from '../../../../src/services/serializedAsset/SerializedAssetRetryOperationRepository';
import {
  SerializedAssetRetryOperationService,
  RESERVED_OPERATION_NOT_ACTIVE,
  type ForcedRetryEligibility,
} from '../../../../src/services/serializedAsset/SerializedAssetRetryOperationService';
import { NotFoundError } from '../../../../src/errors/NotFoundError';
import { BadRequestAppError } from '../../../../src/errors/AppError';

const TENANT = 'tenant-a';
const CONFIG = 'cfg-1';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

describe('SerializedAssetRetryOperationService', () => {
  let db: Kysely<Database>;
  let repo: SerializedAssetRetryOperationRepository;
  let eligibility: jest.Mocked<ForcedRetryEligibility>;
  let svc: SerializedAssetRetryOperationService;

  beforeEach(async () => {
    db = makeDb();
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    repo = new SerializedAssetRetryOperationRepository({ getDatabase: () => db } as never);
    eligibility = { assertForcedRetryEligible: jest.fn() };
    svc = new SerializedAssetRetryOperationService(repo, eligibility);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const reserve = (tenantId = TENANT, configurationId = CONFIG) =>
    svc.reserve({ tenantId, configurationId, requesterUserId: 'user-1', correlationId: 'corr-1' });

  it('validates eligibility BEFORE writing anything durable', async () => {
    // An ineligible configuration must not leave an operation row behind —
    // otherwise a bad request would occupy the single-active slot and block
    // the real retry that follows it.
    eligibility.assertForcedRetryEligible.mockImplementation(() => {
      throw new NotFoundError('Configuration cfg-x not found');
    });

    await expect(reserve()).rejects.toBeInstanceOf(NotFoundError);
    expect(await repo.getById(TENANT, 'any')).toBeNull();
    const rows = await db.selectFrom('serialized_asset_retry_operations').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('propagates the bounded 400 vocabulary unchanged', async () => {
    eligibility.assertForcedRetryEligible.mockImplementation(() => {
      throw new BadRequestAppError('Configuration cfg-1 is not active');
    });
    await expect(reserve()).rejects.toBeInstanceOf(BadRequestAppError);
  });

  it('reserves a durable accepted operation and reports it as new', async () => {
    const result = await reserve();
    expect(result.status).toBe('accepted');
    expect(result.deduplicated).toBe(false);
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await repo.getById(TENANT, result.operationId);
    expect(stored).toMatchObject({
      tenantId: TENANT,
      configurationId: CONFIG,
      requesterUserId: 'user-1',
      correlationId: 'corr-1',
      status: 'accepted',
    });
  });

  it('converges a repeated request onto the live operation instead of starting a second', async () => {
    const first = await reserve();
    const second = await reserve();

    expect(second.operationId).toBe(first.operationId);
    expect(second.deduplicated).toBe(true);

    const rows = await db.selectFrom('serialized_asset_retry_operations').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('keeps reservations independent per tenant and per configuration', async () => {
    const a = await reserve(TENANT, CONFIG);
    const b = await reserve('tenant-b', CONFIG);
    const c = await reserve(TENANT, 'cfg-2');
    expect(new Set([a.operationId, b.operationId, c.operationId]).size).toBe(3);
  });

  it('never accepts a caller-supplied operation id', async () => {
    // The id is server-generated. A caller that could choose it could collide
    // with, or probe for, another operation.
    const first = await reserve();
    const second = await reserve(TENANT, 'cfg-2');
    expect(second.operationId).not.toBe(first.operationId);
  });

  describe('getStatus', () => {
    it('returns the operation for its own tenant and configuration', async () => {
      const reserved = await reserve();
      const status = await svc.getStatus(TENANT, CONFIG, reserved.operationId);
      expect(status).toMatchObject({ id: reserved.operationId, status: 'accepted' });
    });

    it('returns null indistinguishably for another tenant, another configuration, and an unknown id', async () => {
      // The route maps all three to the same 404. Configuration scoping was
      // added on Copilot's review of #1132: the status URL carries an
      // integration id, and without it an operation could be read through ANY
      // integration id belonging to the tenant, making the URL a weaker
      // statement than it appears.
      const reserved = await reserve();
      expect(await svc.getStatus('tenant-b', CONFIG, reserved.operationId)).toBeNull();
      expect(await svc.getStatus(TENANT, 'cfg-other', reserved.operationId)).toBeNull();
      expect(await svc.getStatus(TENANT, CONFIG, 'does-not-exist')).toBeNull();
    });
  });

  it('refuses to report a terminal status from a reservation', async () => {
    // Copilot round 8: reserve() can only yield `accepted` or `running`, and
    // the port's type now says so. This is the runtime half — the narrowing is
    // CHECKED rather than cast, so a broken invariant surfaces as a 500 instead
    // of a 202 carrying a status the route's own contract says cannot appear.
    jest.spyOn(repo, 'reserve').mockResolvedValue({
      outcome: 'created',
      operation: { id: 'op-x', status: 'succeeded' } as never,
    });

    await expect(reserve()).rejects.toThrow(RESERVED_OPERATION_NOT_ACTIVE);
  });
});
