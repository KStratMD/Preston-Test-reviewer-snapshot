import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { TenantConfigurationRepository } from '../../database/repositories/TenantConfigurationRepository';
import type { SyncErrorAssistRepository } from './SyncErrorAssistRepository';
import type { ConnectorManager } from '../integration/ConnectorManager';
import type { ProviderRegistry } from '../ai/ProviderRegistry';
import type { ReasoningTraceEngine } from '../ai/orchestrator/ReasoningTraceEngine';
import type { CostTrackingService } from '../ai/CostTrackingService';
import type { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import type { DLPService } from '../security/DLPService';
import type { GovernanceService } from '../ai/orchestrator/GovernanceService';
import type { SyncErrorAssistMetrics } from './SyncErrorAssistMetrics';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../governance/ApprovalQueueService';
import type { CanonicalEntity } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import type {
  CycleResult,
  ProcessClaimedRecordOutcome,
  ProcessedClaim,
  ResolvedProvider,
  WebhookPayload,
} from './types';
import type { IdentityContext } from '../governance/identityContext';
import type { DataRecord } from '../../types/index';
import type { AIProvider } from '../ai/providers/types';
import type { IConnector } from '../../interfaces/IConnector';
import { withTimeout } from './errors';
import { z } from 'zod';
import { buildPrompt, sanitizeSourcePayloadForPrompt, sanitizeErrorMessageForPrompt } from './promptBuilder';
import { buildNetSuiteEnvAuthConfigForTenant } from './netsuiteEnvAuth';

// Codex R1 #3 — Zod schema for the AI provider's JSON response. The model is instructed
// to return this exact shape (see buildPrompt), but a malformed or hallucinated response
// must NOT be persisted to NetSuite verbatim. Schema rejection throws inside the inner
// try/catch, where classify() routes the failure to retryable/non-retryable.
//
// Codex R2 — `references_field` is contractually "field name or null". The model
// occasionally returns `""` (empty string) when it has nothing to reference; persisting
// the empty string instead of null produces ambiguous data downstream. Normalize via
// transform: undefined | null | "" → null; otherwise keep the trimmed string.
const AI_RESPONSE_SCHEMA = z.object({
  confidence: z.enum(['high', 'mid', 'low']),
  suggestion_type: z.enum(['create_missing_record', 'fix_field_value', 'manual_review']),
  suggestion_text: z.string().min(1).max(2048),
  references_field: z.string().max(128).nullable().optional()
    .transform((v) => {
      // Codex R3 — trim leading/trailing whitespace on NON-empty values so a model
      // response like " item_id " doesn't break NetSuite field-name matching downstream.
      // Codex R4 — ECMAScript `.trim()` does NOT strip Unicode "format" characters
      // (U+200B ZWS, U+200C ZWNJ, U+200D ZWJ — invisible width-zero glyphs). A model
      // response consisting only of those would otherwise pass through as non-null and
      // produce an invisible-empty field in NetSuite. Strip them post-trim.
      if (v == null) return null;
      const trimmed = v.trim().replace(/^[\u200B\u200C\u200D]+|[\u200B\u200C\u200D]+$/g, '');
      return trimmed === '' ? null : trimmed;
    }),
});
import { classify } from './classify';
import { ServiceUnavailableAppError } from '../../errors/AppError';
import type { GuardedWriteDeps } from '../../governance/sourceOfTruth/guardedWrite';

interface MinimalTokenUsage { estimatedCost?: number; totalTokens?: number }
interface ProviderWithLastUsage { getLastTokenUsage(): MinimalTokenUsage | undefined }
function hasLastTokenUsage(p: unknown): p is ProviderWithLastUsage {
  return typeof p === 'object' && p !== null && 'getLastTokenUsage' in p &&
         typeof (p as ProviderWithLastUsage).getLastTokenUsage === 'function';
}

/**
 * Distinguish fatal infrastructure errors (DB outage, network unavailable) from
 * per-tenant logical errors. Fatal errors propagate from runAllEnabledTenants so
 * the daily job sees the tick as failed; logical errors are isolated as 'aborted'
 * CycleResults and the fan-out continues.
 *
 * Codex R3-2: detection is keyed off the structured `code` property that Node.js
 * system errors and the Postgres `pg` driver always set on actual infrastructure
 * failures. Vendor errors (e.g., a NetSuite firewall response containing the
 * literal string "Connection refused") do NOT set `code` — those stay
 * tenant-local. Message-substring matching was removed to eliminate that
 * false-positive class.
 */
function isFatalInfrastructureError(err: unknown): boolean {
  if (err instanceof ServiceUnavailableAppError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  // Node.js OS-level system error codes.
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EADDRNOTAVAIL' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  // Postgres connection-class SQLSTATEs (08xxx):
  //   08000 connection_exception
  //   08001 sqlclient_unable_to_establish_sqlconnection
  //   08003 connection_does_not_exist
  //   08004 sqlserver_rejected_establishment_of_sqlconnection
  //   08006 connection_failure
  //   08007 transaction_resolution_unknown
  //   08P01 protocol_violation
  if (
    code === '08000' || code === '08001' || code === '08003' ||
    code === '08004' || code === '08006' || code === '08007' ||
    code === '08P01'
  ) {
    return true;
  }
  return false;
}

/**
 * Defensive Error normalization for catches. String(err) calls err.toString()
 * which can throw for hostile values (e.g., an object with a throwing toString).
 * Wrapping the conversion guarantees the catch itself never propagates an
 * unhandled rejection.
 *
 * Used by:
 *   - ingestWebhook setImmediate(...).catch(...)
 *   - processClaimedRecord outer catch
 *
 * Logger.error contract is (message, error?, metadata?). Passing a non-Error
 * second arg silently drops the metadata fields — toError ensures we always
 * have a real Error.
 *
 * Module-local; NOT exported (spec gotcha #46). Behavior covered indirectly by
 * Task 7 + Task 8 catch-path tests; no dedicated unit-test file by design.
 */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  try {
    return new Error(String(err));
  } catch {
    return new Error('[unstringifiable error]');
  }
}

interface NormalizedErrorRecord {
  id: string;
  error_message: string;
  error_context: Record<string, unknown>;
  attempt_count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts a polling-record's lastModified timestamp as a UTC ISO-8601 string,
 * resilient to the four shapes a `DataRecord` can carry it in:
 *   - record.lastModified as string (test-mock shape; webhook payload)
 *   - record.lastModified as Date (rare; some connectors hoist it)
 *   - record.metadata.lastModified as Date (NetSuiteConnector.formatDataFromNetSuite path)
 *   - record.metadata.lastModified as string (older snapshot)
 *
 * Why this matters: NetSuiteConnector.search() routes results through
 * `formatDataFromNetSuite`, which lifts `lastmodifieddate` into
 * `metadata.lastModified` as a `Date` object. Test mocks bypass this
 * transformation and put lastModified at the record root as a string, so a
 * narrow `typeof error.lastModified === 'string'` check passes tests but
 * always reads null in production. The watermark-recovery sweep in
 * SyncErrorAssistRepository.recoverWatermarkAfterReap depends on the
 * polling-path claim() snapshot being populated, so we need a resilient
 * extractor here.
 *
 * Returns null if no parseable lastModified is found (legacy/pre-migration-038
 * rows tolerate null by design — recovery via webhook re-delivery only).
 *
 * **Strict timezone requirement on string inputs** (Codex PR #777 R2 — see
 * SHOULD-FIX finding): `new Date('2026-05-12T10:00:00')` (no `Z`, no `±HH:MM`)
 * is interpreted as host-local time per the JS spec, producing a different
 * epoch than the snapshotter intended. NetSuite REST output and the webhook
 * Zod schema both produce TZ-bearing ISO strings in practice, but a test
 * fixture or future connector returning a bare-wall-clock string would
 * silently write a wrong `error_last_modified_at` snapshot, feeding an
 * incorrect target into recoverWatermarkAfterReap. So: string inputs must
 * contain either `Z`, `+HH:MM`, or `-HH:MM` at the end; anything else
 * returns null and falls through to the next candidate (or ultimately the
 * "no parseable lastModified" null result, treated as a legacy row).
 * Date inputs are always already UTC-anchored by JS semantics, so no check
 * needed there.
 */
const TZ_BEARING_ISO_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Single-value variant of the strict-TZ ISO coercion used by
 * extractRecordLastModifiedIso below. Module-local; shared by the polling-path
 * extractor and by ingestWebhook's snapshot site so both seam-points
 * (polling DataRecord and webhook payload) apply the same validation. Even
 * though the webhook Zod schema (`syncErrorAssistWebhookSchema.ts:90`)
 * already requires `z.string().datetime()` (which mandates the `Z` suffix per
 * Zod's default), routing the webhook payload through this helper makes the
 * strict-TZ guarantee survive future schema loosening (e.g., enabling
 * `{offset: true}`) without silently breaking the watermark-recovery math.
 * Date inputs are UTC-anchored by JS semantics so no check is needed;
 * bare-wall-clock strings or malformed-TZ strings return null.
 */
function coerceToIsoIfTzBearing(value: unknown): string | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    if (!TZ_BEARING_ISO_SUFFIX.test(value)) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

function extractRecordLastModifiedIso(record: DataRecord): string | null {
  const fromRoot = coerceToIsoIfTzBearing((record as { lastModified?: unknown }).lastModified);
  if (fromRoot) return fromRoot;

  const metadata = (record as { metadata?: unknown }).metadata;
  if (isRecord(metadata)) {
    const fromMeta = coerceToIsoIfTzBearing(metadata.lastModified);
    if (fromMeta) return fromMeta;
  }
  return null;
}

/**
 * Maps webhook camelCase OR polling snake_case input shape to the canonical
 * prompt shape consumed by runSingleErrorCycle.
 */
function normalizeErrorRecordForPrompt(input: WebhookPayload | DataRecord): NormalizedErrorRecord {
  if ('errorRecordId' in input && typeof input.errorRecordId === 'string') {
    const webhook = input as WebhookPayload;
    return {
      id: webhook.errorRecordId,
      error_message: typeof webhook.errorMessage === 'string' ? webhook.errorMessage : '',
      error_context: isRecord(webhook.sourcePayload) ? webhook.sourcePayload : {},
      attempt_count: typeof webhook.attemptCount === 'number' ? webhook.attemptCount : 0,
    };
  }

  const polling = input as DataRecord;
  return {
    id: typeof polling.id === 'string' ? polling.id : String(polling.id ?? ''),
    error_message: typeof polling.error_message === 'string' ? polling.error_message : '',
    error_context: isRecord(polling.error_context) ? polling.error_context : {},
    attempt_count: typeof polling.attempt_count === 'number' ? polling.attempt_count : 0,
  };
}

type SyncErrorAssistSource = 'webhook' | 'polling';
type ConfidenceThreshold = 'high' | 'mid' | 'low';

interface RunSingleErrorCycleArgs {
  tenantId: string;
  claim: ProcessedClaim;
  errorRecord: NormalizedErrorRecord;
  ctx: IdentityContext;
  providerInfo: ResolvedProvider;
  nsConnector: IConnector;
  log: Logger;
  correlationId: string;
  source: SyncErrorAssistSource;
  threshold: ConfidenceThreshold;
}

interface ProcessClaimedRecordArgs {
  claim: ProcessedClaim;
  tenantId: string;
  errorRecord: WebhookPayload | DataRecord;
  ctx: IdentityContext;
  correlationId: string;
  providerInfo?: ResolvedProvider;
  nsConnector?: IConnector;
  source: SyncErrorAssistSource;
  threshold?: ConfidenceThreshold;
}

interface IngestWebhookArgs {
  tenantId: string;
  errorRecord: WebhookPayload;
  ctx: IdentityContext;
  correlationId: string;
}

interface IngestWebhookResult {
  status: 'accepted' | 'duplicate';
  claimId?: string;
}

@injectable()
export class SyncErrorAssistService {
  static readonly MAX_ERRORS_PER_CYCLE = 500;
  static readonly PAGE_SIZE = 100;
  static readonly PER_RECORD_TIMEOUT_MS = 5 * 60_000;
  static readonly REAPER_CUTOFF_MS = 60 * 60_000;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TenantConfigurationRepository) private tenantConfig: TenantConfigurationRepository,
    @inject(TYPES.SyncErrorAssistRepository) private repo: SyncErrorAssistRepository,
    @inject(TYPES.ConnectorManager) private connectorManager: ConnectorManager,
    @inject(TYPES.ProviderRegistry) private providerRegistry: ProviderRegistry,
    @inject(TYPES.ReasoningTraceEngine) private traceEngine: ReasoningTraceEngine,
    @inject(TYPES.CostTrackingService) private costTracking: CostTrackingService,
    @inject(TYPES.AuditLogRepository) private auditLog: AuditLogRepository,
    @inject(TYPES.DLPService) private dlpService: DLPService,
    @inject(TYPES.SyncErrorAssistMetrics) private metrics: SyncErrorAssistMetrics,
    // PR-C3.1a — per-tenant DLP posture is consumed at the DECISION layer of
    // the 4 syncErrorAssist DLP callsites (2 in promptBuilder helpers, 2 in
    // this service). Threaded via DI so production wires the live cached
    // GovernanceService and tests inject a stub returning the case-under-test's
    // posture. The 60s posture cache (GovernanceService internals) absorbs the
    // per-record cost; `getPostureForTenant` short-circuits to `DEFAULT_POSTURE`
    // for SYSTEM_IDENTITY / undefined tenantId / repository errors.
    @inject(TYPES.GovernanceService) private governanceService: GovernanceService,
    private readonly ownershipResolver: OwnershipResolver,
    private readonly auditService: AuditService,
    private readonly approvalQueueService: ApprovalQueueService,
  ) {}

  async runAllEnabledTenants(systemCtx: IdentityContext): Promise<CycleResult[]> {
    const cutoff = new Date(Date.now() - SyncErrorAssistService.REAPER_CUTOFF_MS);
    const reaperOutcome = await this.repo.reapStuckProcessing(cutoff);
    if (reaperOutcome.reaped > 0) {
      this.logger.warn('reaped stuck processing rows globally', { count: reaperOutcome.reaped });
    }
    // Codex PR #777 R2 NIT: emit a structured log entry per actual watermark
    // recovery so operators can observe the READ-COMMITTED-race backstop firing
    // in production. Recoveries are real race-resolution events, not routine
    // reaping; surfacing them in the daily-job log lets us audit how often
    // the watermark over-advances under concurrent webhook+polling load.
    for (const recovery of reaperOutcome.recoveries) {
      this.logger.warn('sync_error_assist watermark recovered after reap', {
        tenantId: recovery.tenantId,
        recoveredTo: recovery.recoveredTo,
      });
    }

    // Some registered adapters implement the legacy AIProvider interface (no chat()).
    // Sync Error AI Assist requires a chat-capable provider; iterate the registry's
    // healthy providers until we find one that has chat(), so a non-chat-capable
    // first-fallback (e.g., OpenAIProviderAdapter) doesn't skip the whole cycle.
    const providerInfo = await this.findChatCapableProvider();
    if (!providerInfo) {
      this.logger.warn('No chat-capable AI provider available for sync_error_assist');
      this.metrics.recordCycleOutcome(systemCtx.tenantId, 'no_provider');
      return [];
    }

    const tenants = await this.repo.getActiveTenants();
    if (tenants.length === 0) {
      this.logger.info('No enabled tenants for sync_error_assist');
      return [];
    }

    const results: CycleResult[] = [];
    for (const tenantId of tenants) {
      const ctx: IdentityContext = { tenantId, userId: systemCtx.userId };
      try {
        const result = await this.runCycle(tenantId, ctx, providerInfo);
        results.push(result);
      } catch (err) {
        if (isFatalInfrastructureError(err)) {
          this.logger.error('fatal infrastructure error in runCycle; aborting whole tick', {
            tenantId, error: err instanceof Error ? err.message : String(err),
          });
          throw err;  // propagate to DailyJob; tick should not appear successful
        }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('runCycle failed for tenant; continuing fan-out', { tenantId, error: message });
        this.metrics.recordCycleOutcome(tenantId, 'aborted');
        results.push({
          tenantId,
          errorsScanned: 0, suggestionsWritten: 0, skipped: 0,
          failedRetryable: 0, failedNonRetryable: 0,
          durationMs: 0, aborted: true, abortReason: message,
        });
      }
    }
    return results;
  }

  async runCycle(tenantId: string, ctx: IdentityContext, providerInfo: ResolvedProvider): Promise<CycleResult> {
    const startedAt = Date.now();
    const cycleCorrelationId = `cycle-${tenantId}-${startedAt}`;
    const log = this.logger.withCorrelationId(cycleCorrelationId);

    const enabled = await this.tenantConfig.getBoolean(tenantId, 'sync_error_assist.enabled');
    if (!enabled) {
      log.info('cycle disabled', { tenantId });
      this.metrics.recordCycleOutcome(tenantId, 'disabled');
      return this.zeroResult(tenantId, Date.now() - startedAt);
    }

    const rawThreshold = await this.tenantConfig.getString(tenantId, 'sync_error_assist.confidence_threshold');
    const threshold = (rawThreshold === 'high' || rawThreshold === 'mid' || rawThreshold === 'low')
      ? rawThreshold
      : 'mid';
    const watermark = await this.repo.getWatermark(tenantId);

    const ns = await this.connectorManager.getConnector('netsuite', `netsuite_${tenantId}`);
    if (!ns) {
      throw new Error(`Failed to resolve NetSuite connector for tenant ${tenantId}`);
    }
    // ConnectorManager.getConnector() only constructs+caches a connector — it
    // never calls initialize() (that's a SEPARATE per-integration-config path,
    // initializeConnectorsForConfig(), that Sync Error Assist doesn't go
    // through). Without this call, ensureAuthenticated() throws
    // TokenError: Missing required OAuth1 credentials before any network I/O.
    // Uncaught here by design: a missing-env deployment should abort this
    // tenant's cycle the same way any other connector-resolution failure does
    // (see the per-tenant catch in runAllEnabledTenants). The ForTenant
    // variant (Codex P1, PR #966) additionally fail-closes when this tenant's
    // recorded NetSuite account differs from the deployment-wide env account.
    await ns.initialize(await buildNetSuiteEnvAuthConfigForTenant(tenantId, this.repo));
    const { records: errors, maxModified } = await this.readErrorRecords(ns, watermark);

    let suggestionsWritten = 0;
    let skipped = 0;
    let failedRetryable = 0;
    let failedNonRetryable = 0;

    for (const error of errors) {
      if (typeof error.id !== 'string' || !error.id) {
        skipped++;
        log.warn('sync_error_assist skipping record without id', { tenantId });
        continue;
      }
      const errorId = error.id;
      // Snapshot the polling-record's lastModified at claim time so the
      // reaper's watermark-recovery sweep can ratchet the run watermark
      // backward if this row ever becomes orphaned by the READ COMMITTED
      // race in tryAdvanceWatermark. See SyncErrorAssistRepository.claim
      // docstring + recoverWatermarkAfterReap. Uses extractRecordLastModifiedIso
      // to handle the four DataRecord shapes (root/metadata × string/Date) —
      // critical because NetSuiteConnector.formatDataFromNetSuite lifts
      // lastModified into metadata.lastModified as a Date, but test mocks
      // bypass that transformation and put it at the root as a string.
      const errorLastModifiedAt = extractRecordLastModifiedIso(error);
      const claim = await this.repo.claim(tenantId, errorId, errorLastModifiedAt);
      if (!claim) {
        skipped++;
        continue;
      }

      const outcome = await this.processClaimedRecord({
        claim,
        tenantId,
        errorRecord: error,
        ctx,
        correlationId: cycleCorrelationId,
        providerInfo,
        nsConnector: ns,
        source: 'polling',
        threshold,
      });
      if (outcome === 'succeeded') suggestionsWritten++;
      else if (outcome === 'failed_retryable') failedRetryable++;
      else failedNonRetryable++;
    }

    // Atomic watermark advance: tryAdvanceWatermark folds the processing-rows
    // check + the upsert into a single SQL statement, eliminating the prior
    // two-statement race. Skip the SQL when failedRetryable > 0 (in-process
    // state, not in DB). The atomic UPSERT does NOT expose whether processing
    // rows actually existed — it only reports whether the watermark advanced.
    // So the hold-reason log distinguishes "skipped SQL due to in-process
    // failures" from "SQL ran and the gate held it" without asserting facts
    // about DB state we can't cheaply observe.
    if (maxModified) {
      const advanceAttempted = failedRetryable === 0;
      let advanced = false;
      if (advanceAttempted) {
        advanced = await this.repo.tryAdvanceWatermark(tenantId, maxModified);
      }
      if (!advanced) {
        log.info('holding watermark', {
          tenantId,
          failedRetryable,
          advanceAttempted,
          holdReason: advanceAttempted ? 'sql_gate_held' : 'failed_retryable_in_process',
          watermarkCandidate: maxModified.toISOString(),
        });
      }
    }

    this.metrics.recordCycleOutcome(tenantId, 'enabled');
    this.metrics.recordErrorsScanned(tenantId, errors.length);
    const durationMs = Date.now() - startedAt;
    this.metrics.observeCycleDuration(tenantId, durationMs / 1000);

    return {
      tenantId,
      errorsScanned: errors.length,
      suggestionsWritten,
      skipped,
      failedRetryable,
      failedNonRetryable,
      durationMs,
    };
  }

  private async runSingleErrorCycle(args: RunSingleErrorCycleArgs): Promise<ProcessClaimedRecordOutcome> {
    const {
      tenantId,
      claim,
      errorRecord,
      ctx,
      providerInfo,
      nsConnector,
      log,
      correlationId,
      source,
      threshold,
    } = args;
    const errorId = errorRecord.id;
    const sessionId = randomUUID();
    const errorStartedAt = Date.now();
    let created: { id?: string };
    let cents: number | null;
    // Copilot R9 — tighten the local `parsed` type to z.infer<typeof AI_RESPONSE_SCHEMA> so
    // compile-time types stay aligned with the runtime contract. Previously declared with
    // all fields optional, which would silently swallow drift if AI_RESPONSE_SCHEMA renamed
    // a key.
    let parsed: z.infer<typeof AI_RESPONSE_SCHEMA>;

    // R13-3 / AC #22 — Setup ops (trace bootstrap + sanitization + prompt build) live
    // OUTSIDE the inner try so that unexpected failures (e.g., trace engine off-the-rails,
    // hostile-toString value rejecting startTrace) propagate to processClaimedRecord's
    // outer catch — where toError + 'processClaimedRecord: unhandled error' fire. The
    // inner try below is scoped to AI chat + NS create work — the operations whose
    // failures classify.ts knows how to handle.
    await this.traceEngine.startTrace(sessionId, {
      sourceSystem: 'netsuite',
      targetSystem: 'sync_error_assist',
      userId: ctx.userId,
    });

    const sanitizeOpts = {
      dlpService: this.dlpService,
      // PR-C3.1a — thread GovernanceService into the promptBuilder helpers so
      // sites #1 + #2 (sanitizeSourcePayloadForPrompt + sanitizeErrorMessageForPrompt)
      // can consume per-tenant posture at the DECISION layer.
      governanceService: this.governanceService,
      correlationId,
      tenantId,
      logger: log,
      metrics: this.metrics,
    };
    const safeContext = await sanitizeSourcePayloadForPrompt(errorRecord.error_context, sanitizeOpts);
    // Codex R1 #2 — error_message also reaches the prompt and was previously raw. Scrub
    // it the same way (DLP autoRedact + injection-signature replacement) before passing
    // to buildPrompt so signed webhooks can't smuggle PII or instruction text through
    // this field.
    const safeMessage = await sanitizeErrorMessageForPrompt(errorRecord.error_message, sanitizeOpts);
    const messages = buildPrompt({ error_message: safeMessage, error_context: safeContext }, threshold);

    try {
      const chatResponse = await withTimeout(
        providerInfo.provider.chat(messages, { maxTokens: 1024, temperature: 0.2 }, ctx),
        SyncErrorAssistService.PER_RECORD_TIMEOUT_MS,
        'AI provider chat',
      );

      await this.traceEngine.recordStep(sessionId, {
        step: 1,
        agent: 'sync_error_assist',
        action: 'ai_call',
        input: messages,
        output: chatResponse.content,
        confidence: 1,
        reasoning: 'AI provider generated a sync error fix suggestion',
        timestamp: new Date(),
        executionTime: Date.now() - errorStartedAt,
      });

      const lastUsage = hasLastTokenUsage(providerInfo.provider) ? providerInfo.provider.getLastTokenUsage() : undefined;
      const dollars = lastUsage?.estimatedCost ?? 0;
      cents = lastUsage?.estimatedCost ? Math.round(lastUsage.estimatedCost * 100) : null;

      if (chatResponse.usage) {
        await this.costTracking.recordCost({
          sessionId,
          requestId: randomUUID(),
          userId: ctx.userId,
          providerId: providerInfo.providerId,
          operation: 'other',
          tokensUsed: chatResponse.usage.totalTokens ?? 0,
          cost: dollars,
          tenantId,
          // chatResponse.usage is present and cost was derived from getLastTokenUsage()
          costSource: 'measured',
        });
      }

      // Codex R1 #3 — Validate the AI response against the contract schema before
      // writing to NetSuite. A malformed or hallucinated response throws here and the
      // inner catch routes the record to a classified failure status instead of
      // persisting garbage to the ERP.
      parsed = AI_RESPONSE_SCHEMA.parse(JSON.parse(chatResponse.content));

      // Route through guardedWrite for ownership audit. The do: arrow fn is a
      // direct AST descendant of guardedWrite() so check-guarded-writes.mjs's
      // parent-walk confirms the write is guarded.
      const governanceDeps: GuardedWriteDeps = {
        ownershipResolver: this.ownershipResolver,
        auditService: this.auditService,
        approvalQueueService: this.approvalQueueService,
      };
      const nsCreatePayload = {
        error_record_id: errorId,
        confidence: parsed.confidence,
        suggestion_type: parsed.suggestion_type,
        suggestion_text: parsed.suggestion_text,
        references_field: parsed.references_field ?? null,
        reasoning_trace_id: sessionId,
        provider_used: providerInfo.provider.mode,
        cost_estimate_usd_cents: cents,
      };
      created = await withTimeout(
        guardedWrite(
          {
            context: {
              tenantId,
              callerSystem: 'sync_error_remediation',
              targetSystem: 'netsuite',
              entity: 'customrecord_suitecentral_fix_suggestion' as CanonicalEntity,
              correlationId: sessionId,
              requesterUserId: ctx.userId,
              operation: 'create',
            },
            // Connector contract shape: NetSuiteConnector.formatDataForNetSuite reads
            // `data.fields ?? {}` (src/connectors/NetSuiteConnector.ts). Wrap the flat
            // AI-suggestion payload in `{ fields: payload }` so it reaches
            // mapCommonFields with the expected shape — mirrors the operator accept
            // path (SyncErrorAssistOperatorService.ts). Without this wrap, the
            // connector silently writes an empty payload and audits success.
            do: () => nsConnector.create('customrecord_suitecentral_fix_suggestion', { fields: nsCreatePayload }),
          },
          governanceDeps,
        ),
        SyncErrorAssistService.PER_RECORD_TIMEOUT_MS,
        'NetSuite create',
      );
      if (!created.id) throw new Error('NetSuite create returned no id for fix-suggestion record');
    } catch (err) {
      // AC #22 / gotcha #46 — normalize via toError BEFORE any String() coercion. A
      // hostile value whose toString() throws would otherwise leak a new Error out of
      // String(err) and short-circuit the outer catch's toError contract.
      const normalizedErr = toError(err);
      await this.traceEngine.completeTrace(sessionId, `failed: ${normalizedErr.message}`, 'failed').catch((): undefined => undefined);

      const errorMessage = normalizedErr.message;
      // Wrap scanText in try/catch — a DLPService throw here would escape this per-record
      // failure handler and be caught by processClaimedRecord's outer catch, which would
      // overwrite the original failure reason with `unhandled_error` and re-run classify()
      // against the DLP throw instead of the AI/NS error we're trying to record.
      //
      // PR-C3.1a — site #3 migration: consume per-tenant posture at the
      // DECISION layer. `posture.allowPII=true` short-circuits the DLP scan
      // (the failure-message is persisted as-is — explicit tenant opt-in to
      // allow PII in this path; the contract is "never persist raw PII
      // UNLESS the tenant explicitly opted in via posture.allowPII").
      // `posture.piiTypes` narrows the findings that trigger redaction.
      // `posture.autoRedact=false` with findings → placeholder.
      // `posture.blockOnDetection` is N/A — this site has no caller to reject.
      //
      // PR-C3.1a R1 (Codex Medium) — when posture.piiTypes is non-empty, the
      // redaction substitution must cover ONLY allowed-type spans, so we
      // call back into dlpService.redactData with the filtered findings
      // rather than reusing the scan's whole-payload redactedData.
      let redactedMessage: string;
      try {
        const posture = await this.governanceService.getPostureForTenant(tenantId);
        if (posture.allowPII) {
          redactedMessage = errorMessage;
        } else {
          const dlpResult = await this.dlpService.scanText(errorMessage, {
            allowPII: false,
            piiTypes: [],
            autoRedact: true,
            blockOnDetection: false,
          });
          const relevantFindings = posture.piiTypes.length === 0
            ? dlpResult.findings
            : dlpResult.findings.filter((f) => posture.piiTypes.includes(f.type));
          const hasRelevantPII = relevantFindings.length > 0;
          if (hasRelevantPII && !posture.autoRedact) {
            redactedMessage = '[redaction-unavailable]';
          } else if (hasRelevantPII) {
            // PR-C3.1a R1 — narrowed redaction over allowed-type findings
            // only. Fail-safe to placeholder if the redact didn't yield a
            // string (defensive against future behavior changes).
            const narrowed = this.dlpService.redactData(errorMessage, relevantFindings);
            redactedMessage = typeof narrowed === 'string' ? narrowed : '[redaction-unavailable]';
          } else {
            redactedMessage = errorMessage;
          }
        }
      } catch (dlpErr) {
        log.warn('DLP scan threw during failure-path redaction; using placeholder', {
          tenantId, errorId, error: toError(dlpErr),
        });
        redactedMessage = '[redaction-unavailable]';
      }

      const status = classify(err, claim.attempts) as 'failed_retryable' | 'failed_non_retryable';
      await this.repo.updateFailed(claim.id, status, redactedMessage);

      try {
        await this.auditLog.create({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          action: 'sync_error_assist.write_fix_suggestion',
          resource_type: 'sync_error_record',
          resource_id: errorId,
          old_values: null,
          new_values: null,
          details: {
            reasoning_trace_id: sessionId,
            provider: providerInfo.provider.mode,
            attempts: claim.attempts,
            status,
            source,
            correlationId,
          },
          result: 'failure',
          error_message: redactedMessage,
          duration_ms: Date.now() - errorStartedAt,
          ip_address: null,
          user_agent: null,
        });
      } catch (auditErr) {
        this.logger.warn('failure audit log failed for failed suggestion', {
          tenantId,
          errorId,
          sessionId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      this.metrics.recordProcessedStatus(tenantId, status);
      if (status === 'failed_retryable') {
        return 'failed_retryable';
      }
      return 'failed_non_retryable';
    }

    const createdId = created?.id;
    if (!createdId) throw new Error('unreachable: NetSuite create id was validated before success bookkeeping');
    try {
      await this.repo.updateSucceeded(claim.id, {
        suggestionRecordId: createdId,
        traceId: sessionId,
        provider: providerInfo.provider.mode,
        costEstimateUsdCents: cents,
        confidence: parsed.confidence ?? null,
        suggestionType: parsed.suggestion_type ?? null,
        suggestionText: parsed.suggestion_text ?? null,
        referencesField: parsed.references_field ?? null,
      });
    } catch (postErr) {
      this.logger.error(
        'updateSucceeded failed AFTER NetSuite create succeeded — local state stale',
        toError(postErr),
        { tenantId, errorId, suggestionRecordId: createdId },
      );
    }

    try {
      await this.traceEngine.completeTrace(sessionId, 'fix suggestion written', 'completed');
    } catch (postErr) {
      this.logger.warn('completeTrace failed for successful suggestion', {
        tenantId,
        errorId,
        sessionId,
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
    }

    try {
      await this.auditLog.create({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        action: 'sync_error_assist.write_fix_suggestion',
        resource_type: 'sync_error_record',
        resource_id: errorId,
        old_values: null,
        new_values: null,
        details: {
          reasoning_trace_id: sessionId,
          provider: providerInfo.provider.mode,
          cost_estimate_usd_cents: cents,
          suggestion_record_id: createdId,
          source,
          correlationId,
        },
        result: 'success',
        error_message: null,
        duration_ms: Date.now() - errorStartedAt,
        ip_address: null,
        user_agent: null,
      });
    } catch (postErr) {
      this.logger.warn('success audit log failed for successful suggestion', {
        tenantId,
        errorId,
        sessionId,
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
    }

    this.metrics.recordSuggestionWritten(tenantId, providerInfo.provider.mode);
    this.metrics.recordProcessedStatus(tenantId, 'succeeded');
    if (cents) this.metrics.recordCostCents(tenantId, providerInfo.provider.mode, cents);
    return 'succeeded';
  }

  async processClaimedRecord(args: ProcessClaimedRecordArgs): Promise<ProcessClaimedRecordOutcome> {
    const { claim, tenantId, errorRecord, ctx, correlationId, source } = args;
    const log = this.logger.withCorrelationId(correlationId);
    const failedRetryable: ProcessClaimedRecordOutcome = 'failed_retryable';

    let providerInfo = args.providerInfo;
    if (!providerInfo) {
      providerInfo = (await this.findChatCapableProvider()) ?? undefined;
    }
    if (!providerInfo) {
      log.warn('processClaimedRecord: no chat-capable AI provider', { tenantId });
      await this.repo.updateFailed(claim.id, 'failed_retryable', 'no_provider');
      this.metrics.recordCycleOutcome(tenantId, 'no_provider');
      this.metrics.recordProcessedStatus(tenantId, 'failed_retryable');
      return failedRetryable;
    }

    let threshold = args.threshold;
    if (!threshold) {
      const rawThreshold = await this.tenantConfig.getString(tenantId, 'sync_error_assist.confidence_threshold');
      threshold = (rawThreshold === 'high' || rawThreshold === 'mid' || rawThreshold === 'low')
        ? rawThreshold
        : 'mid';
    }

    let nsConnector = args.nsConnector;
    if (!nsConnector) {
      try {
        nsConnector = await this.connectorManager.getConnector('netsuite', `netsuite_${tenantId}`);
        // See the runCycle call site's comment: getConnector() never
        // initializes the connector, so this must happen before first use.
        // Kept inside this try so a missing-env NetSuiteEnvCredentialsMissingError
        // — or a tenant-account mismatch (Codex P1, PR #966) — degrades to the
        // SAME 'connector_unavailable' outcome as a getConnector throw, not a
        // new failure mode.
        await nsConnector.initialize(await buildNetSuiteEnvAuthConfigForTenant(tenantId, this.repo));
      } catch (err) {
        log.warn('processClaimedRecord: NS connector unavailable', { tenantId, error: toError(err) });
        await this.repo.updateFailed(claim.id, 'failed_retryable', 'connector_unavailable');
        this.metrics.recordProcessedStatus(tenantId, 'failed_retryable');
        return failedRetryable;
      }
    }

    const normalized = normalizeErrorRecordForPrompt(errorRecord);

    try {
      return await this.runSingleErrorCycle({
        tenantId,
        claim,
        errorRecord: normalized,
        ctx,
        providerInfo,
        nsConnector,
        log,
        correlationId,
        source,
        threshold,
      });
    } catch (err) {
      log.error('processClaimedRecord: unhandled error', toError(err), { tenantId, claimId: claim.id });
      const status = classify(err, claim.attempts) as 'failed_retryable' | 'failed_non_retryable';
      await this.repo.updateFailed(claim.id, status, 'unhandled_error');
      // Copilot R4 — mirror the recordProcessedStatus emission from the inner failure
      // paths (line 503 in runSingleErrorCycle + the early-return branches above). Without
      // this, unhandled-error rows would become terminal in the DB but invisible in the
      // sync_error_assist_processed_status_total counter.
      this.metrics.recordProcessedStatus(tenantId, status);
      return status;
    }
  }

  /**
   * Iterate the registry's healthy providers until we find one with a chat()
   * method. Some legacy adapters (e.g., OpenAIProviderAdapter) implement only
   * the registry-side AIProvider interface and lack chat(); without iteration,
   * a non-chat-capable first-fallback would skip the whole cycle.
   */
  private async findChatCapableProvider(): Promise<ResolvedProvider | null> {
    // Prefer the registry's default fallback order first (no preferredId).
    const defaultPick = await this.providerRegistry.getAvailableProvider();
    const seen = new Set<string>();
    const tryProvider = (p: { provider: unknown; id: string } | null): ResolvedProvider | null => {
      if (!p) return null;
      if (seen.has(p.id)) return null;
      seen.add(p.id);
      if (typeof (p.provider as { chat?: unknown }).chat !== 'function') return null;
      return { provider: p.provider as unknown as AIProvider, providerId: p.id };
    };
    const first = tryProvider(defaultPick);
    if (first) return first;
    // Iterate registered providers, defensive against a registry that doesn't
    // expose listProviders() (test fakes / older registry shapes).
    const listProviders =
      typeof (this.providerRegistry as { listProviders?: unknown }).listProviders === 'function'
        ? (this.providerRegistry as { listProviders: () => { id: string }[] }).listProviders.bind(this.providerRegistry)
        : null;
    if (!listProviders) return null;
    for (const meta of listProviders()) {
      if (seen.has(meta.id)) continue;
      const result = await this.providerRegistry.getAvailableProvider(meta.id);
      const resolved = tryProvider(result);
      if (resolved) return resolved;
    }
    return null;
  }

  private async readErrorRecords(
    ns: Pick<IConnector, 'search'>,
    watermark: Date | null,
  ): Promise<{ records: DataRecord[]; maxModified: Date | null }> {
    const out: DataRecord[] = [];
    let offset = 0;
    let maxModified: Date | null = null;

    while (out.length < SyncErrorAssistService.MAX_ERRORS_PER_CYCLE) {
      const page = await ns.search('customrecord_suitecentral_sync_error', {
        limit: SyncErrorAssistService.PAGE_SIZE,
        offset,
        filters: watermark
          ? { lastModified: { operator: 'after', value: watermark.toISOString() } }
          : {},
      });
      if (page.length === 0) break;
      for (const r of page) {
        // Use shared extractor so polling correctly handles
        // formatDataFromNetSuite's metadata.lastModified = Date shape in
        // production (root r.lastModified is undefined for records that pass
        // through that transformation). Tests with mock-shape records
        // continue to work because the extractor falls through to root.
        const iso = extractRecordLastModifiedIso(r);
        if (iso) {
          const t = new Date(iso);
          if (!maxModified || t > maxModified) maxModified = t;
        }
      }
      out.push(...page);
      if (page.length < SyncErrorAssistService.PAGE_SIZE) break;
      offset += SyncErrorAssistService.PAGE_SIZE;
    }
    return {
      records: out.slice(0, SyncErrorAssistService.MAX_ERRORS_PER_CYCLE),
      maxModified,
    };
  }

  private zeroResult(tenantId: string, durationMs: number): CycleResult {
    return {
      tenantId,
      errorsScanned: 0,
      suggestionsWritten: 0,
      skipped: 0,
      failedRetryable: 0,
      failedNonRetryable: 0,
      durationMs,
    };
  }

  async ingestWebhook(args: IngestWebhookArgs): Promise<IngestWebhookResult> {
    const { tenantId, errorRecord, ctx, correlationId } = args;
    const log = this.logger.withCorrelationId(correlationId);
    const acceptedStartedAtMs = Date.now();   // R3-4 — pin claim-ack latency for §7.1 accepted log

    // Webhook payload's `lastModified` is validated as ISO 8601 by
    // syncErrorAssistWebhookSchema (`syncErrorAssistWebhookSchema.ts:90`)
    // before reaching this path. We still route it through
    // coerceToIsoIfTzBearing so the strict-TZ guarantee survives future
    // schema loosening (e.g., enabling `{offset: true}` on the Zod
    // datetime check) without silently breaking the watermark-recovery
    // math. Same single source of truth as the polling-path extractor.
    const claim = await this.repo.claim(
      tenantId,
      errorRecord.errorRecordId,
      coerceToIsoIfTzBearing(errorRecord.lastModified),
    );
    if (!claim) {
      // Spec §7.1 — webhook duplicate (debug)
      log.debug('webhook duplicate', { correlationId, tenantId, errorRecordId: errorRecord.errorRecordId });
      return { status: 'duplicate' };
    }

    // Spec §7.1 — webhook accepted (info) with latencyMs (R3-4)
    log.info('webhook accepted', {
      correlationId, tenantId, errorRecordId: errorRecord.errorRecordId, claimId: claim.id,
      latencyMs: Date.now() - acceptedStartedAtMs,
    });

    setImmediate(() => {
      const startedAt = Date.now();
      log.debug('fire-and-forget started', {
        correlationId, tenantId, errorRecordId: errorRecord.errorRecordId, claimId: claim.id,
      });
      this.processClaimedRecord({
        claim,
        tenantId,
        errorRecord,                                            // pass through; normalizer runs inside processClaimedRecord
        ctx,
        correlationId,
        source: 'webhook',
      }).then((outcome) => {
        // Resolved with `outcome` of 'succeeded' | 'failed_retryable' | 'failed_non_retryable'.
        // Earlier wording "fire-and-forget succeeded" was misleading because terminal failures
        // also resolved cleanly — operators reading logs needed the actual outcome to triage.
        log.debug('fire-and-forget completed', {
          correlationId, tenantId, errorRecordId: errorRecord.errorRecordId, claimId: claim.id,
          outcome,
          durationMs: Date.now() - startedAt,
        });
      }).catch((err) => {
        // R3-1 — gotcha #10 contract: a fire-and-forget catch MUST NOT itself leak an unhandled
        // rejection. R2-7 introduced an `async (err)` callback whose body could throw inside
        // log.error / scanText / metrics — those rejections would propagate to the runtime as
        // unhandled. Fix: keep the catch sync, kick off a fenced inner async helper that
        // swallows its own errors with a final .catch(() => undefined).
        void (async () => {
          // R2-7 + R3-5 + spec §7.1 — fire-and-forget log includes DLP-redacted errorMessage + errorClass.
          const rawErr = toError(err);
          let safeMessage = rawErr.message;
          try {
            // PR-C3.1a — site #4 migration: consume per-tenant posture at the
            // DECISION layer. `posture.allowPII=true` short-circuits the DLP
            // scan; the fire-and-forget log records the raw message — explicit
            // tenant opt-in to allow PII in this path (the log MUST NOT leak
            // PII UNLESS the tenant explicitly allowed it via posture.allowPII).
            // Per posture.piiTypes filter, only findings on the allowlist count
            // as relevant. `posture.autoRedact=false` with relevant findings →
            // placeholder (when `posture.allowPII=false` the log can't leak raw
            // PII even if the tenant opted out of auto-redaction).
            // `posture.blockOnDetection` is N/A — fire-and-forget is purely a
            // log-and-metric path.
            //
            // PR-C3.1a R1 (Codex Medium) — when posture.piiTypes is non-empty,
            // the redaction substitution must cover ONLY allowed-type spans,
            // so we call dlpService.redactData with the filtered findings
            // rather than reusing the scan's whole-payload redactedData.
            const posture = await this.governanceService.getPostureForTenant(tenantId);
            if (!posture.allowPII) {
              // R10-2 — DLPPolicy requires the full shape (DLPService.ts:76-82).
              const scan = await this.dlpService.scanText(rawErr.message, {
                allowPII: false, piiTypes: [], autoRedact: true, blockOnDetection: false,
              });
              // R23-1 — Fail-safe when DLP can't deliver a safe redaction. Spec §7.1
              // requires the log to be DLP-redacted; leaking rawErr.message because a
              // detected scan happened to lack `redactedData` is a real PII-egress vector.
              // PR-C3.1a R1 — decision tree updated for narrowed redaction:
              //   - posture.autoRedact=false with relevant findings: placeholder.
              //   - relevant findings: dlpService.redactData over relevantFindings
              //     (only allowed-type spans substituted). Fail-safe to placeholder
              //     if redactData returned a non-string (defensive).
              //   - default (no relevant findings): raw message is safe to keep
              //     (co-present non-allowed-type findings stay raw — tenant policy
              //     did not opt into action on those types).
              //   - scanText() throws on engine failure → caught by surrounding try/catch.
              const relevantFindings = posture.piiTypes.length === 0
                ? scan.findings
                : scan.findings.filter((f) => posture.piiTypes.includes(f.type));
              const hasRelevantPII = relevantFindings.length > 0;
              if (hasRelevantPII && !posture.autoRedact) {
                safeMessage = '[redaction-unavailable]';
              } else if (hasRelevantPII) {
                const narrowed = this.dlpService.redactData(rawErr.message, relevantFindings);
                safeMessage = typeof narrowed === 'string' ? narrowed : '[redaction-unavailable]';
              }
            }
          } catch {
            safeMessage = '[redaction-unavailable]';
          }
          const safeError = new Error(safeMessage);
          safeError.name = rawErr.name;
          log.error(
            'webhook fire-and-forget failed',
            safeError,
            {
              correlationId,
              tenantId,
              errorRecordId: errorRecord.errorRecordId,
              claimId: claim.id,
              errorClass: safeError.name,                    // R3-5 / spec §7.1
              errorMessage: safeMessage,                     // R3-5 / spec §7.1 — DLP-redacted
            },
          );
          this.metrics.recordWebhookFireAndForgetError(tenantId);
        })().catch((): undefined => undefined);   // terminal — gotcha #10
      });
    });
    return { status: 'accepted', claimId: claim.id };
  }
}

/* test-only */
export { normalizeErrorRecordForPrompt, extractRecordLastModifiedIso };
