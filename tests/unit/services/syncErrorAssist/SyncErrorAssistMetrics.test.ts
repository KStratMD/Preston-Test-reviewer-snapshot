import 'reflect-metadata';
import { register } from 'prom-client';
import { SyncErrorAssistMetrics } from '../../../../src/services/syncErrorAssist/SyncErrorAssistMetrics';

describe('SyncErrorAssistMetrics', () => {
  let metrics: SyncErrorAssistMetrics;

  beforeEach(() => {
    register.clear();
    metrics = new SyncErrorAssistMetrics();
  });

  afterEach(() => {
    register.clear();
  });

  it('registers all expected counters and histogram', async () => {
    const all = await register.getMetricsAsJSON();
    const names = all.map((m: any) => m.name);
    expect(names).toContain('sync_error_assist_cycles_total');
    expect(names).toContain('sync_error_assist_errors_scanned_total');
    expect(names).toContain('sync_error_assist_suggestions_written_total');
    expect(names).toContain('sync_error_assist_processed_status_total');
    expect(names).toContain('sync_error_assist_cycle_duration_seconds');
    expect(names).toContain('sync_error_assist_cost_usd_cents_total');
  });

  it('recordCycleOutcome increments the labeled counter', async () => {
    metrics.recordCycleOutcome('t1', 'enabled');
    metrics.recordCycleOutcome('t1', 'enabled');
    metrics.recordCycleOutcome('t1', 'disabled');
    const cycles = (await register.getMetricsAsJSON()).find((m: any) => m.name === 'sync_error_assist_cycles_total');
    const enabled = (cycles as any).values.find((v: any) => v.labels.tenant_id === 't1' && v.labels.outcome === 'enabled');
    const disabled = (cycles as any).values.find((v: any) => v.labels.tenant_id === 't1' && v.labels.outcome === 'disabled');
    expect(enabled?.value).toBe(2);
    expect(disabled?.value).toBe(1);
  });

  it('observeCycleDuration records into the histogram', async () => {
    metrics.observeCycleDuration('t1', 12.5);
    const hist = (await register.getMetricsAsJSON()).find((m: any) => m.name === 'sync_error_assist_cycle_duration_seconds');
    const count = (hist as any).values.find((v: any) => v.metricName === 'sync_error_assist_cycle_duration_seconds_count' && v.labels.tenant_id === 't1');
    expect(count?.value).toBe(1);
  });

  it('recordCostCents accumulates cents per provider', async () => {
    metrics.recordCostCents('t1', 'cloud-api', 5);
    metrics.recordCostCents('t1', 'cloud-api', 12);
    metrics.recordCostCents('t1', 'local-llm', 0);
    const cost = (await register.getMetricsAsJSON()).find((m: any) => m.name === 'sync_error_assist_cost_usd_cents_total');
    const cloudApi = (cost as any).values.find((v: any) => v.labels.tenant_id === 't1' && v.labels.provider_id === 'cloud-api');
    expect(cloudApi?.value).toBe(17);
  });

  it('recordProcessedStatus increments per-status', async () => {
    metrics.recordProcessedStatus('t1', 'succeeded');
    metrics.recordProcessedStatus('t1', 'failed_retryable');
    metrics.recordProcessedStatus('t1', 'succeeded');
    const proc = (await register.getMetricsAsJSON()).find((m: any) => m.name === 'sync_error_assist_processed_status_total');
    const succ = (proc as any).values.find((v: any) => v.labels.tenant_id === 't1' && v.labels.status === 'succeeded');
    expect(succ?.value).toBe(2);
  });

  describe('webhook metrics (PR 17c)', () => {
    it('webhookReceivedRaw is a no-label counter (cardinality bound: 1)', async () => {
      metrics.recordWebhookReceivedRaw();
      metrics.recordWebhookReceivedRaw();
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_received_raw_total');
      expect(sample).toContain('sync_error_assist_webhook_received_raw_total 2');
    });

    it('webhookAuthenticated is labeled by tenantId', async () => {
      metrics.recordWebhookAuthenticated('acme');
      metrics.recordWebhookAuthenticated('beta');
      metrics.recordWebhookAuthenticated('acme');
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_authenticated_total');
      expect(sample).toMatch(/tenant_id="acme"\} 2/);
      expect(sample).toMatch(/tenant_id="beta"\} 1/);
    });

    it('webhookValidationFailed labels with tenantId + reason', async () => {
      metrics.recordWebhookValidationFailed('unknown', 'missing_header');
      metrics.recordWebhookValidationFailed('acme', 'tenant_mismatch');
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_validation_failed_total');
      expect(sample).toMatch(/tenant_id="unknown".*reason="missing_header"\} 1/);
      expect(sample).toMatch(/tenant_id="acme".*reason="tenant_mismatch"\} 1/);
    });

    it('webhookProcessed labels with tenantId + outcome enum', async () => {
      metrics.recordWebhookProcessed('acme', 'accepted');
      metrics.recordWebhookProcessed('acme', 'duplicate');
      metrics.recordWebhookProcessed('acme', 'disabled');
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_processed_total');
      expect(sample).toMatch(/outcome="accepted"\} 1/);
      expect(sample).toMatch(/outcome="duplicate"\} 1/);
      expect(sample).toMatch(/outcome="disabled"\} 1/);
    });

    it('webhookFireAndForgetError is labeled by tenantId (R4-4 split)', async () => {
      metrics.recordWebhookFireAndForgetError('acme');
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_fire_and_forget_errors_total');
      expect(sample).toMatch(/tenant_id="acme"\} 1/);
    });

    it('webhookE2eLatency is a histogram labeled by tenantId', async () => {
      metrics.recordWebhookE2eLatency('acme', 0.5);
      const sample = await register.getSingleMetricAsString('sync_error_assist_webhook_e2e_latency_seconds');
      expect(sample).toContain('tenant_id="acme"');
      expect(sample).toContain('_count');
      expect(sample).toContain('_sum');
    });

    it('dlpScanOutcome labels with tenantId + outcome enum (clean | redacted | failed)', async () => {
      metrics.recordDlpScanOutcome('acme', 'clean');
      metrics.recordDlpScanOutcome('acme', 'redacted');
      metrics.recordDlpScanOutcome('acme', 'failed');
      const sample = await register.getSingleMetricAsString('sync_error_assist_dlp_scan_outcome_total');
      expect(sample).toMatch(/outcome="clean"\} 1/);
      expect(sample).toMatch(/outcome="redacted"\} 1/);
      expect(sample).toMatch(/outcome="failed"\} 1/);
    });

    it('promptInjectionReplaced labels with tenantId', async () => {
      metrics.recordPromptInjectionReplaced('acme');
      const sample = await register.getSingleMetricAsString('sync_error_assist_prompt_injection_replaced_total');
      expect(sample).toMatch(/tenant_id="acme"\} 1/);
    });
  });
});
