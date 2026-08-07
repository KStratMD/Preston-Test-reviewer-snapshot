import { injectable } from 'inversify';
import { Counter, Histogram, register } from 'prom-client';
import type { ProcessedStatus } from './types';

type CycleOutcome = 'enabled' | 'disabled' | 'no_provider' | 'aborted';

export type WebhookValidationFailureReason =
  | 'missing_header'
  | 'malformed_timestamp'
  | 'replay_window_exceeded'
  | 'signature_mismatch'
  | 'malformed_signature'
  | 'unknown_tenant'
  | 'tenant_mismatch'
  | 'invalid_payload'
  | 'rate_limited'
  | 'content_type_invalid'
  | 'body_invalid';

@injectable()
export class SyncErrorAssistMetrics {
  private cyclesTotal!: Counter<string>;
  private errorsScannedTotal!: Counter<string>;
  private suggestionsWrittenTotal!: Counter<string>;
  private processedStatusTotal!: Counter<string>;
  private cycleDurationSeconds!: Histogram<string>;
  private costUsdCentsTotal!: Counter<string>;
  private webhookReceivedRawTotal!: Counter<string>;
  private webhookAuthenticatedTotal!: Counter<string>;
  private webhookValidationFailedTotal!: Counter<string>;
  private webhookProcessedTotal!: Counter<string>;
  private webhookFireAndForgetErrorsTotal!: Counter<string>;
  private webhookE2eLatencySeconds!: Histogram<string>;
  private dlpScanOutcomeTotal!: Counter<string>;
  private promptInjectionReplacedTotal!: Counter<string>;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    this.cyclesTotal = new Counter({
      name: 'sync_error_assist_cycles_total',
      help: 'Total Sync Error AI Assist cycles per tenant + outcome',
      labelNames: ['tenant_id', 'outcome'],
      registers: [register],
    });
    this.errorsScannedTotal = new Counter({
      name: 'sync_error_assist_errors_scanned_total',
      help: 'Total NetSuite error records scanned',
      labelNames: ['tenant_id'],
      registers: [register],
    });
    this.suggestionsWrittenTotal = new Counter({
      name: 'sync_error_assist_suggestions_written_total',
      help: 'Total fix suggestions written to NetSuite',
      labelNames: ['tenant_id', 'provider_id'],
      registers: [register],
    });
    this.processedStatusTotal = new Counter({
      name: 'sync_error_assist_processed_status_total',
      help: 'Per-error processed-status outcomes',
      labelNames: ['tenant_id', 'status'],
      registers: [register],
    });
    this.cycleDurationSeconds = new Histogram({
      name: 'sync_error_assist_cycle_duration_seconds',
      help: 'Wall-clock cycle duration per tenant',
      labelNames: ['tenant_id'],
      registers: [register],
    });
    this.costUsdCentsTotal = new Counter({
      name: 'sync_error_assist_cost_usd_cents_total',
      help: 'Total AI cost in cents per tenant + provider',
      labelNames: ['tenant_id', 'provider_id'],
      registers: [register],
    });
    this.webhookReceivedRawTotal = new Counter({
      name: 'sync_error_assist_webhook_received_raw_total',
      help: 'Inbound webhooks past pre-handler guards but before HMAC validation',
      registers: [register],
    });
    this.webhookAuthenticatedTotal = new Counter({
      name: 'sync_error_assist_webhook_authenticated_total',
      help: 'Webhooks that passed HMAC validation',
      labelNames: ['tenant_id'],
      registers: [register],
    });
    this.webhookValidationFailedTotal = new Counter({
      name: 'sync_error_assist_webhook_validation_failed_total',
      help: 'Webhooks rejected before processing (HMAC, schema, rate limit, etc.)',
      labelNames: ['tenant_id', 'reason'],
      registers: [register],
    });
    this.webhookProcessedTotal = new Counter({
      name: 'sync_error_assist_webhook_processed_total',
      help: 'Terminal webhook outcomes (accepted | duplicate | disabled)',
      labelNames: ['tenant_id', 'outcome'],
      registers: [register],
    });
    this.webhookFireAndForgetErrorsTotal = new Counter({
      name: 'sync_error_assist_webhook_fire_and_forget_errors_total',
      help: 'Async post-202 fire-and-forget failures (distinct from processed.outcome)',
      labelNames: ['tenant_id'],
      registers: [register],
    });
    this.webhookE2eLatencySeconds = new Histogram({
      name: 'sync_error_assist_webhook_e2e_latency_seconds',
      help: 'Signature-verified-to-claim-acked latency',
      labelNames: ['tenant_id'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [register],
    });
    this.dlpScanOutcomeTotal = new Counter({
      name: 'sync_error_assist_dlp_scan_outcome_total',
      help: 'Outcome of DLPService.scanForPII on sourcePayload (clean | redacted | failed)',
      labelNames: ['tenant_id', 'outcome'],
      registers: [register],
    });
    this.promptInjectionReplacedTotal = new Counter({
      name: 'sync_error_assist_prompt_injection_replaced_total',
      help: 'Per-leaf string replaced by [content removed: prompt-injection signature]',
      labelNames: ['tenant_id'],
      registers: [register],
    });
  }

  recordCycleOutcome(tenantId: string, outcome: CycleOutcome): void {
    this.cyclesTotal.labels({ tenant_id: tenantId, outcome }).inc();
  }

  recordErrorsScanned(tenantId: string, count: number): void {
    if (count > 0) this.errorsScannedTotal.labels({ tenant_id: tenantId }).inc(count);
  }

  recordSuggestionWritten(tenantId: string, providerId: string): void {
    this.suggestionsWrittenTotal.labels({ tenant_id: tenantId, provider_id: providerId }).inc();
  }

  recordProcessedStatus(tenantId: string, status: ProcessedStatus): void {
    this.processedStatusTotal.labels({ tenant_id: tenantId, status }).inc();
  }

  observeCycleDuration(tenantId: string, durationSeconds: number): void {
    this.cycleDurationSeconds.labels({ tenant_id: tenantId }).observe(durationSeconds);
  }

  recordCostCents(tenantId: string, providerId: string, cents: number): void {
    if (cents > 0) this.costUsdCentsTotal.labels({ tenant_id: tenantId, provider_id: providerId }).inc(cents);
  }

  recordWebhookReceivedRaw(): void {
    this.webhookReceivedRawTotal.inc();
  }

  recordWebhookAuthenticated(tenantId: string): void {
    this.webhookAuthenticatedTotal.labels({ tenant_id: tenantId }).inc();
  }

  recordWebhookValidationFailed(tenantId: string, reason: WebhookValidationFailureReason): void {
    this.webhookValidationFailedTotal.labels({ tenant_id: tenantId, reason }).inc();
  }

  recordWebhookProcessed(tenantId: string, outcome: 'accepted' | 'duplicate' | 'disabled'): void {
    this.webhookProcessedTotal.labels({ tenant_id: tenantId, outcome }).inc();
  }

  recordWebhookFireAndForgetError(tenantId: string): void {
    this.webhookFireAndForgetErrorsTotal.labels({ tenant_id: tenantId }).inc();
  }

  recordWebhookE2eLatency(tenantId: string, seconds: number): void {
    this.webhookE2eLatencySeconds.labels({ tenant_id: tenantId }).observe(seconds);
  }

  recordDlpScanOutcome(tenantId: string, outcome: 'clean' | 'redacted' | 'failed'): void {
    this.dlpScanOutcomeTotal.labels({ tenant_id: tenantId, outcome }).inc();
  }

  recordPromptInjectionReplaced(tenantId: string): void {
    this.promptInjectionReplacedTotal.labels({ tenant_id: tenantId }).inc();
  }
}
