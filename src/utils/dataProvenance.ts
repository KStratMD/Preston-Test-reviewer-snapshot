/**
 * Explicit fixture-data provenance marker.
 *
 * PR2 removed every credential-less loopback call from the ai-proxy Phase 2
 * and Metrics/NLQ routers, along with the NLQ capability-execution path —
 * responses from these surfaces are fixture-only, with no live upstream
 * call. The defect this closes was a silent fallback whose output was
 * indistinguishable from a live response: any response that carries fixture
 * data must say so explicitly via this marker.
 */
export const FIXTURE_DATA_SOURCE = 'fixture' as const;
