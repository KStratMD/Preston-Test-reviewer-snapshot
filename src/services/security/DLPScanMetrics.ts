import { injectable } from 'inversify';
import { Counter, register } from 'prom-client';

export type DLPScanKind = 'structured' | 'text';
export type DLPScanOutcome = 'clean' | 'findings' | 'failed';

export interface DLPScanMetricsRecorder {
  recordScanOutcome(kind: DLPScanKind, outcome: DLPScanOutcome): void;
}

/**
 * Bounded DLP scan outcome telemetry. The closed label unions prevent scan
 * input, finding types, and error text from becoming metric cardinality.
 */
@injectable()
export class DLPScanMetrics implements DLPScanMetricsRecorder {
  private readonly scanOutcomes: Counter<string>;

  constructor() {
    // Duplicate-registration-safe: route tests snapshot()/restore() the
    // Inversify container around every test, so this singleton is
    // constructed repeatedly within one Jest module registry. A bare
    // `new Counter` throws on the second construction ("A metric with the
    // name ... has already been registered"), which surfaced as 500s in
    // unrelated route suites (hubSpot ownership tests, found during the B2
    // transplant validation). Reuse the registered instance when present.
    const existing = register.getSingleMetric('dlp_scan_outcomes_total');
    this.scanOutcomes =
      existing instanceof Counter
        ? (existing as Counter<string>)
        : new Counter({
            name: 'dlp_scan_outcomes_total',
            help: 'DLP scan outcomes by scan kind and safe outcome',
            labelNames: ['kind', 'outcome'],
            registers: [register],
          });
  }

  recordScanOutcome(kind: DLPScanKind, outcome: DLPScanOutcome): void {
    this.scanOutcomes.labels({ kind, outcome }).inc();
  }
}

export const NOOP_DLP_SCAN_METRICS: DLPScanMetricsRecorder = {
  recordScanOutcome: () => undefined,
};
