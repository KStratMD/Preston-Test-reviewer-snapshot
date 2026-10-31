import 'reflect-metadata';
import { register } from 'prom-client';
import { DLPScanMetrics } from '../../../../src/services/security/DLPScanMetrics';

describe('DLPScanMetrics duplicate registration', () => {
  beforeEach(() => {
    register.clear();
  });

  it('constructs repeatedly without clearing the registry and shares one counter', async () => {
    // Regression pin for the container snapshot()/restore() failure mode:
    // route suites reconstruct this singleton within one Jest registry, and
    // an unguarded `new Counter` throws on the second construction — which
    // surfaced as 500s in hubSpot ownership tests, not here. Without this
    // test, removing the getSingleMetric guard passes this suite (its other
    // tests clear the registry) and only fails distant route suites.
    const first = new DLPScanMetrics();
    first.recordScanOutcome('structured', 'clean');

    let second: DLPScanMetrics;
    expect(() => { second = new DLPScanMetrics(); }).not.toThrow();
    second!.recordScanOutcome('structured', 'clean');

    const metric = await register.getSingleMetric('dlp_scan_outcomes_total')!.get();
    const clean = metric.values.find(
      (v) => v.labels.kind === 'structured' && v.labels.outcome === 'clean'
    );
    // Both constructions must feed ONE counter: reuse, not replace.
    expect(clean?.value).toBe(2);
  });
});

describe('DLPScanMetrics', () => {
  beforeEach(() => {
    register.clear();
  });

  afterEach(() => {
    register.clear();
  });

  it('records one bounded structured/text outcome series', async () => {
    const metrics = new DLPScanMetrics();

    metrics.recordScanOutcome('structured', 'clean');
    metrics.recordScanOutcome('structured', 'findings');
    metrics.recordScanOutcome('text', 'failed');

    const snapshot = await register.getSingleMetric('dlp_scan_outcomes_total')?.get();
    expect(snapshot?.values).toEqual(expect.arrayContaining([
      { labels: { kind: 'structured', outcome: 'clean' }, value: 1 },
      { labels: { kind: 'structured', outcome: 'findings' }, value: 1 },
      { labels: { kind: 'text', outcome: 'failed' }, value: 1 },
    ]));
    expect(snapshot?.values.every(({ labels }) => Object.keys(labels).sort().join(',') === 'kind,outcome')).toBe(true);
  });
});
