import type { ReconciliationExceptionSeverity } from './ReconciliationCenterTypes';

export type ReconciliationDiscrepancyType =
  | 'missing_in_source'
  | 'missing_in_target'
  | 'amount_mismatch'
  | 'duplicate_key';

/** A single invoice normalized to a comparable shape by a reconciler. */
export interface NormalizedInvoice {
  /** Shared invoice identifier used to match across systems. */
  key: string;
  /** Integer minor units (e.g. cents) for tolerance-safe comparison. */
  amountMinorUnits: number;
  /** Original major-unit amount, preserved for human-readable delta reporting. */
  amountMajor: number;
  /** ISO-4217 currency code, uppercased by the reconciler. */
  currency: string;
}

export interface ReconciliationDiscrepancy {
  sourceSystem: string;
  targetSystem: string;
  /** The invoice key; lands in reconciliation_exceptions.source_record_id. */
  sourceRecordId: string;
  exceptionType: ReconciliationDiscrepancyType;
  severity: ReconciliationExceptionSeverity;
  /** Major-unit delta for amount mismatches; null for missing/currency cases. */
  amountDelta: number | null;
  currency: string | null;
  description: string;
  suggestedAction: string;
}

export interface CompareInvoicesOptions {
  sourceSystem: string;
  targetSystem: string;
  /** Absolute tolerance in minor units; deltas at or below are not flagged. */
  toleranceMinorUnits: number;
}

function roundMajor(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function keyCounts(invoices: NormalizedInvoice[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const inv of invoices) counts.set(inv.key, (counts.get(inv.key) ?? 0) + 1);
  return counts;
}

/**
 * Pure comparison: matches invoices by `key`, compares currency then amount.
 * Deterministic order — duplicate-key findings first (first-seen across source
 * then target), then source-side findings, then target-only findings.
 *
 * A key that appears more than once on the SAME side is a data-quality problem
 * that would otherwise be silently collapsed by a key→invoice map (one record
 * dropped, no exception emitted — a false negative). Such keys are surfaced as
 * an explicit `duplicate_key` discrepancy and EXCLUDED from the missing/amount
 * comparison (an ambiguous key can't be matched honestly).
 *
 * v1 matches on a shared invoice identifier; if the two systems don't share an
 * identifier every invoice surfaces as missing on both sides (a documented v1
 * limitation, honest rather than silently dropped).
 */
export function compareInvoices(
  source: NormalizedInvoice[],
  target: NormalizedInvoice[],
  opts: CompareInvoicesOptions,
): ReconciliationDiscrepancy[] {
  const { sourceSystem, targetSystem, toleranceMinorUnits } = opts;
  const sourceCounts = keyCounts(source);
  const targetCounts = keyCounts(target);
  const duplicateKeys = new Set<string>();
  for (const [key, count] of sourceCounts) if (count > 1) duplicateKeys.add(key);
  for (const [key, count] of targetCounts) if (count > 1) duplicateKeys.add(key);

  const out: ReconciliationDiscrepancy[] = [];

  // Emit one duplicate_key discrepancy per offending key, in first-seen order
  // (source scan then target scan), before any match-based finding.
  const emittedDup = new Set<string>();
  for (const inv of [...source, ...target]) {
    if (!duplicateKeys.has(inv.key) || emittedDup.has(inv.key)) continue;
    emittedDup.add(inv.key);
    const sc = sourceCounts.get(inv.key) ?? 0;
    const tc = targetCounts.get(inv.key) ?? 0;
    const where =
      sc > 1 && tc > 1
        ? `${sourceSystem} (${sc}x) and ${targetSystem} (${tc}x)`
        : sc > 1
          ? `${sourceSystem} (${sc}x)`
          : `${targetSystem} (${tc}x)`;
    out.push({
      sourceSystem,
      targetSystem,
      sourceRecordId: inv.key,
      exceptionType: 'duplicate_key',
      severity: 'high',
      amountDelta: null,
      currency: null,
      description: `Invoice key ${inv.key} is duplicated in ${where}; excluded from amount comparison`,
      suggestedAction: 'Resolve the duplicate invoice records before reconciling amounts',
    });
  }

  const targetByKey = new Map(target.map((t) => [t.key, t]));
  const sourceKeys = new Set(source.map((s) => s.key));

  for (const s of source) {
    if (duplicateKeys.has(s.key)) continue; // ambiguous; already surfaced above
    const t = targetByKey.get(s.key);
    if (!t) {
      out.push({
        sourceSystem, targetSystem, sourceRecordId: s.key,
        exceptionType: 'missing_in_target', severity: 'high',
        amountDelta: null, currency: s.currency,
        description: `Invoice ${s.key} present in ${sourceSystem} but missing in ${targetSystem}`,
        suggestedAction: `Locate or create the matching ${targetSystem} invoice`,
      });
      continue;
    }
    if (s.currency !== t.currency) {
      // Currency divergence is reported as `amount_mismatch` (the discrepancy
      // type union has no dedicated currency variant by design) — the amounts
      // are incomparable until the currency mismatch is resolved, so amountDelta
      // is null and severity is escalated to 'high'.
      out.push({
        sourceSystem, targetSystem, sourceRecordId: s.key,
        exceptionType: 'amount_mismatch', severity: 'high',
        amountDelta: null, currency: s.currency,
        description: `Invoice ${s.key} currency differs: ${sourceSystem}=${s.currency} vs ${targetSystem}=${t.currency}`,
        suggestedAction: 'Reconcile the currency mismatch before comparing amounts',
      });
      continue;
    }
    if (Math.abs(s.amountMinorUnits - t.amountMinorUnits) > toleranceMinorUnits) {
      out.push({
        sourceSystem, targetSystem, sourceRecordId: s.key,
        exceptionType: 'amount_mismatch', severity: 'medium',
        amountDelta: roundMajor(s.amountMajor - t.amountMajor), currency: s.currency,
        description: `Invoice ${s.key} amount differs: ${sourceSystem}=${s.amountMajor} ${s.currency} vs ${targetSystem}=${t.amountMajor} ${s.currency}`,
        suggestedAction: 'Reconcile the amount discrepancy',
      });
    }
  }

  for (const t of target) {
    if (duplicateKeys.has(t.key)) continue; // ambiguous; already surfaced above
    if (!sourceKeys.has(t.key)) {
      out.push({
        sourceSystem, targetSystem, sourceRecordId: t.key,
        exceptionType: 'missing_in_source', severity: 'high',
        amountDelta: null, currency: t.currency,
        description: `Invoice ${t.key} present in ${targetSystem} but missing in ${sourceSystem}`,
        suggestedAction: `Locate or create the matching ${sourceSystem} invoice`,
      });
    }
  }

  return out;
}
