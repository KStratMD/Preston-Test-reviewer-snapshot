import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../src/database/types';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { SecretManager } from '../../src/services/SecretManager';
import type { Logger } from '../../src/utils/Logger';
import { migration as createTenantConfigs } from '../../src/database/migrations/008-create-tenant-configurations-table';
import { migration as addTenantConfigIndex } from '../../src/database/migrations/034-add-tenant-configurations-key-value-index';
import { migration as createRuns } from '../../src/database/migrations/035-create-sync-error-assist-runs-table';
import { migration as createProcessed } from '../../src/database/migrations/036-create-sync-error-assist-processed-table';
import { migration as extendProcessed } from '../../src/database/migrations/037-extend-sync-error-assist-processed';
import { migration as addErrorLastModified } from '../../src/database/migrations/038-add-sync-error-assist-processed-error-last-modified';
import { TenantConfigurationRepository } from '../../src/database/repositories/TenantConfigurationRepository';
import { SyncErrorAssistRepository } from '../../src/services/syncErrorAssist/SyncErrorAssistRepository';
import { SyncErrorAssistService } from '../../src/services/syncErrorAssist/SyncErrorAssistService';
import { makeSyncErrorAssistGovernanceArgs } from '../unit/services/syncErrorAssist/testHelpers';
import { SyncErrorAssistMetrics } from '../../src/services/syncErrorAssist/SyncErrorAssistMetrics';
import { DLPService } from '../../src/services/security/DLPService';
import { SCENARIOS } from '../../src/services/syncErrorAssist/fixtures';
import type { FixtureRow } from '../../src/services/syncErrorAssist/types';
import { register } from 'prom-client';

function makeMockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), withCorrelationId: jest.fn().mockReturnThis() };
}

function buildExpectedAIResponse(scenario: FixtureRow): { content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } } {
  const content = JSON.stringify({
    confidence: scenario.expectedConfidence,
    suggestion_type: scenario.expectedShapeAssertions.suggestionType,
    suggestion_text: `${scenario.expectedShapeAssertions.mentionsTerms?.join(' ') ?? ''} — fix details for ${scenario.id}`,
    references_field: scenario.expectedShapeAssertions.referencesField ?? null,
  });
  return { content, usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 } };
}

describe('Sync error AI assist — 10-scenario fixture', () => {
  let db: Kysely<Database>;
  let service: SyncErrorAssistService;
  let mockCreate: jest.Mock;
  let mockSearch: jest.Mock;
  let mockChat: jest.Mock;

  beforeEach(async () => {
    register.clear();
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    await createTenantConfigs.run(db, 'sqlite');
    await addTenantConfigIndex.run(db, 'sqlite');
    await createRuns.run(db, 'sqlite');
    await createProcessed.run(db, 'sqlite');
    // PR 17b added migration 037 (confidence + suggestion_type + suggestion_text +
    // references_field + operator_disposition columns); the fixture's migration list
    // was not updated at the time. updateSucceeded silently fails on the missing
    // columns and the swallow/log catch around the `updateSucceeded` call in
    // SyncErrorAssistService (see the `updateSucceeded failed AFTER NetSuite create
    // succeeded — local state stale` log) absorbs it, so on main the cycle returned
    // 'succeeded' but the row stayed in 'processing'. The atomic tryAdvanceWatermark
    // gate surfaces this — the watermark never advances because the gate's NOT EXISTS
    // subquery sees the still-'processing' row. (Line number intentionally omitted
    // to stay accurate as the file evolves.)
    await extendProcessed.run(db, 'sqlite');
    // PR 17c-followup migration 038 adds error_last_modified_at, populated
    // by claim() from the polling-record/webhook lastModified at claim time.
    // The reaper's watermark-recovery sweep (recoverWatermarkAfterReap) reads
    // MIN of this column across surviving failed_retryable rows to roll the
    // watermark back if it ever over-advanced via the READ COMMITTED race.
    await addErrorLastModified.run(db, 'sqlite');

    await db.insertInto('tenant_configurations').values({
      id: 'tc-1', tenant_id: 'test-tenant',
      setting_key: 'sync_error_assist.enabled', setting_value: 'true',
      is_encrypted: 0 as unknown as boolean,
      created_at: new Date().toISOString() as unknown as Date,
      updated_at: new Date().toISOString() as unknown as Date,
    }).execute();

    const databaseService = { getDatabase: () => db, getDbType: () => 'sqlite' } as unknown as DatabaseService;
    // SecretManager is unused on the not-encrypted path tested here (is_encrypted=false above).
    // Type via `Pick<SecretManager, 'getSecret' | 'setSecret'>` so a signature
    // change to either method breaks this test loudly rather than silently
    // passing under `as never`. Both methods throw if reached so an
    // accidental encrypted-path invocation surfaces as a clear assertion
    // rather than `cannot read properties of undefined`.
    const unreachable = (name: string) => jest.fn().mockImplementation(() => {
      throw new Error(`SecretManager.${name} unexpectedly invoked — fixture exercises only the is_encrypted=false path`);
    });
    const mockSecretManager: Pick<SecretManager, 'getSecret' | 'setSecret'> = {
      getSecret: unreachable('getSecret'),
      setSecret: unreachable('setSecret'),
    };
    const tenantConfig = new TenantConfigurationRepository(
      databaseService,
      mockSecretManager as unknown as SecretManager,
      makeMockLogger() as unknown as Logger,
    );
    const repo = new SyncErrorAssistRepository(databaseService, tenantConfig);
    const metrics = new SyncErrorAssistMetrics();
    const dlp = new DLPService(makeMockLogger() as never);

    mockCreate = jest.fn().mockResolvedValue({ id: 'mock-ns-id' });
    mockSearch = jest.fn();
    mockChat = jest.fn();

    const mockNS = { search: mockSearch, create: mockCreate };
    const mockConnectorManager = { getConnector: jest.fn().mockResolvedValue(mockNS) };
    const mockProvider = { mode: 'cloud-api', chat: mockChat, getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0.05, totalTokens: 250 }) };

    service = new SyncErrorAssistService(
      makeMockLogger() as never,
      tenantConfig, repo,
      mockConnectorManager as never,
      {} as never,
      { startTrace: jest.fn().mockResolvedValue(undefined), recordStep: jest.fn().mockResolvedValue(undefined), completeTrace: jest.fn().mockResolvedValue(undefined) } as never,
      { recordCost: jest.fn().mockResolvedValue(undefined) } as never,
      { create: jest.fn().mockResolvedValue(undefined) } as never,
      dlp,
      metrics,
      // PR-C3.1a — GovernanceService stub returning DEFAULT_POSTURE (this
      // integration test exercises the production scenarios without per-tenant
      // posture configured; equivalent to pre-C3.1 behavior).
      {
        getPostureForTenant: jest.fn().mockResolvedValue({
          allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: [],
        }),
      } as never,
      ...makeSyncErrorAssistGovernanceArgs(),
    );

    (service as unknown as { __testProviderInfo: unknown }).__testProviderInfo = { provider: mockProvider, providerId: 'claude' };
  });

  afterEach(async () => { await db.destroy(); register.clear(); });

  for (const scenario of SCENARIOS) {
    describe(`${scenario.id}: ${scenario.category}`, () => {
      it('classifies into expected category and produces fix-suggestion of expected confidence', async () => {
        mockSearch.mockResolvedValueOnce([scenario.errorRecord]).mockResolvedValueOnce([]);
        const expected = buildExpectedAIResponse(scenario);
        mockChat.mockResolvedValueOnce(expected);

        await service.runCycle(
          'test-tenant',
          { tenantId: 'test-tenant', userId: 'system' },
          (service as unknown as { __testProviderInfo: never }).__testProviderInfo,
        );

        expect(mockCreate).toHaveBeenCalledTimes(1);
        const [recordType, recordData] = mockCreate.mock.calls[0];
        expect(recordType).toBe('customrecord_suitecentral_fix_suggestion');
        expect(recordData.confidence).toBe(scenario.expectedConfidence);
        expect(recordData.suggestion_type).toBe(scenario.expectedShapeAssertions.suggestionType);
        if (scenario.expectedShapeAssertions.mentionsTerms) {
          for (const term of scenario.expectedShapeAssertions.mentionsTerms) {
            expect(recordData.suggestion_text).toContain(term);
          }
        }
      });
    });
  }

  describe('cross-cutting', () => {
    it('claim() returns null on UNIQUE conflict (concurrent owner)', async () => {
      const scenario = SCENARIOS[0];
      await db.insertInto('sync_error_assist_processed').values({
        id: 'r-pre', tenant_id: 'test-tenant', error_record_id: scenario.errorRecord.id,
        status: 'processing', attempts: 1, reserved_at: new Date().toISOString(),
        suggestion_record_id: null, trace_id: null, provider: null, cost_estimate_usd_cents: null,
        failure_reason: null, completed_at: null,
      }).execute();

      mockSearch.mockResolvedValueOnce([scenario.errorRecord]).mockResolvedValueOnce([]);
      const result = await service.runCycle(
        'test-tenant',
        { tenantId: 'test-tenant', userId: 'system' },
        (service as unknown as { __testProviderInfo: never }).__testProviderInfo,
      );

      expect(result.skipped).toBe(1);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('watermark advances to max(lastModified) across pages', async () => {
      const records = SCENARIOS.slice(0, 3).map(s => s.errorRecord);
      mockSearch.mockResolvedValueOnce(records).mockResolvedValueOnce([]);
      mockChat.mockResolvedValue(buildExpectedAIResponse(SCENARIOS[0]));

      await service.runCycle(
        'test-tenant',
        { tenantId: 'test-tenant', userId: 'system' },
        (service as unknown as { __testProviderInfo: never }).__testProviderInfo,
      );

      const watermark = await db.selectFrom('sync_error_assist_runs').select('last_modified_at')
        .where('tenant_id', '=', 'test-tenant').executeTakeFirstOrThrow();
      const expected = new Date(records[records.length - 1].lastModified).getTime();
      expect(watermark.last_modified_at).toBeGreaterThanOrEqual(expected);
    });

    it('disabled tenant short-circuits (zero NS calls)', async () => {
      await db.updateTable('tenant_configurations')
        .set({ setting_value: 'false' })
        .where('tenant_id', '=', 'test-tenant')
        .where('setting_key', '=', 'sync_error_assist.enabled')
        .execute();
      const result = await service.runCycle(
        'test-tenant',
        { tenantId: 'test-tenant', userId: 'system' },
        (service as unknown as { __testProviderInfo: never }).__testProviderInfo,
      );
      expect(result.errorsScanned).toBe(0);
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('reaper sweep updates stuck rows globally', async () => {
      const stale = new Date(Date.now() - 90 * 60_000).toISOString();
      await db.insertInto('sync_error_assist_processed').values({
        id: 'r-stale', tenant_id: 'test-tenant', error_record_id: 'stale-err',
        status: 'processing', attempts: 1, reserved_at: stale,
        suggestion_record_id: null, trace_id: null, provider: null, cost_estimate_usd_cents: null,
        failure_reason: null, completed_at: null,
      }).execute();
      mockSearch.mockResolvedValue([]);

      const cutoff = new Date(Date.now() - 60 * 60_000);
      const repo = (service as unknown as { repo: SyncErrorAssistRepository }).repo;
      const outcome = await repo.reapStuckProcessing(cutoff);
      expect(outcome.reaped).toBe(1);
      const row = await db.selectFrom('sync_error_assist_processed').selectAll().where('id', '=', 'r-stale').executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_retryable');
    });

    it('NS write error → failed_retryable status update', async () => {
      const scenario = SCENARIOS[0];
      mockSearch.mockResolvedValueOnce([scenario.errorRecord]).mockResolvedValueOnce([]);
      mockChat.mockResolvedValueOnce(buildExpectedAIResponse(scenario));
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('NS 502'), { statusCode: 502 }));

      await service.runCycle(
        'test-tenant',
        { tenantId: 'test-tenant', userId: 'system' },
        (service as unknown as { __testProviderInfo: never }).__testProviderInfo,
      );

      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('error_record_id', '=', scenario.errorRecord.id).executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_retryable');
    });
  });
});
