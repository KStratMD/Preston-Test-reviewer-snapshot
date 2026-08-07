import { createHash } from 'node:crypto';
import type { MappingDirection } from '../../types/cardinality';

/**
 * Sample-bound fingerprints for the cardinality preflight and activation gate.
 *
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Analysis inputs and fingerprint": the report fingerprint is a SHA-256 digest
 * over canonical JSON of the analyzer version, direction, plan, and evidence,
 * plus a digest of the canonical bounded sample set. This is what makes
 * overrides sample-bound — an override of an observed collision cannot
 * silently authorize a different sample set, because changing the samples
 * changes the digest, which changes the fingerprint, which invalidates the
 * stored override.
 *
 * This module is pure: no logging, persistence, clock reads, or environment
 * access. It never receives or returns raw sample values — only whatever the
 * caller passes in and the digests/hashes computed from it.
 */

/**
 * Recursively sorts object keys so semantically-equal payloads produce
 * byte-identical serialization, regardless of property-insertion order. Array
 * element order is preserved — order is semantically meaningful for arrays
 * (e.g. sample row order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Plain SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * A SHA-256 digest of the canonical bounded sample set. `undefined` and `[]`
 * digest identically (both mean "no samples"); any other change to row count,
 * field values, or field-key casing/order-within-a-row changes the digest.
 * The digest never leaves this module paired with the raw rows — callers only
 * ever see the hex string.
 */
export function computeSampleDigest(samples: Record<string, unknown>[] | undefined): string {
  return sha256Hex(canonicalJson(samples ?? []));
}

/**
 * The canonical input to the report fingerprint. Only fields that can change
 * what the analyzer might find are included here. Raw sample values,
 * timestamps, credentials, actor identity, and override text are deliberately
 * excluded from the fingerprint input (per the design spec) — `plan` and
 * `evidence` are the caller's own normalized, server-trusted projections, and
 * `sampleDigest` stands in for the samples themselves.
 */
export interface ReportFingerprintInput {
  analyzerVersion: string;
  direction: MappingDirection;
  plan: unknown;
  evidence: unknown;
  sampleDigest: string;
}

export function computeReportFingerprint(input: ReportFingerprintInput): string {
  return sha256Hex(canonicalJson(input));
}

/** One directional report's contribution to the combined fingerprint. */
export interface DirectionFingerprint {
  direction: MappingDirection;
  fingerprint: string;
}

/**
 * Combines per-direction report fingerprints into one fingerprint for the
 * whole preflight run. Computed from directions sorted by name, not from
 * report array order, so `[forward, backward]` and `[backward, forward]`
 * produce the same combined fingerprint.
 */
export function computeCombinedFingerprint(reports: DirectionFingerprint[]): string {
  const sorted = [...reports].sort((a, b) => a.direction.localeCompare(b.direction));
  return sha256Hex(canonicalJson(sorted));
}
