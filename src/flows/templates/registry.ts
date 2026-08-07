/**
 * FLOW_TEMPLATE_REGISTRY — canonical list of every governed flow template
 * shipped in this repo.
 *
 * Like `src/connectors/connectorRegistry.ts` (PR 6A), this file collapses
 * "what flow templates do we have?" to one declarative source. Adding
 * template #N+1 means one new import + one new array entry here, plus the
 * template file itself under `src/flows/templates/<category>/`, plus a
 * golden-fixture integration test. The CI gate
 * `scripts/check-flow-template-instrumentation.mjs` enforces those touchpoints.
 *
 * Narrow PR 14 ships ONE sample template. The three production templates
 * called out in the merged remediation plan (OTC, PTP, Payouts) land in
 * PR 14b alongside Lineage (PR 12) and Ownership (PR 13) integration. The
 * sample exists today so the executor has a real consumer the CI gate can
 * walk end-to-end.
 */

import type { FlowTemplate } from './FlowTemplate';
import { sampleHubSpotToNetSuiteContact } from './samples/SampleHubSpotToNetSuiteContact';

/**
 * Every entry here MUST satisfy `FlowTemplate<unknown, Record<string, unknown>>`;
 * concrete template types narrow at declaration site (in the template file)
 * but flatten to the registry's permissive Generic to keep the array
 * uniformly typed.
 */
export const FLOW_TEMPLATE_REGISTRY: readonly FlowTemplate<unknown, Record<string, unknown>>[] = [
  sampleHubSpotToNetSuiteContact as FlowTemplate<unknown, Record<string, unknown>>,
] as const;

export function getFlowTemplate(id: string): FlowTemplate<unknown, Record<string, unknown>> | undefined {
  return FLOW_TEMPLATE_REGISTRY.find((tpl) => tpl.id === id);
}
