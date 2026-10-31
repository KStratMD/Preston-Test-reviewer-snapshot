import { AppError } from './AppError';
import type {
  CardinalityFinding,
  CardinalityFindingSeverity,
  CardinalityFindingType,
  CardinalityResolutionKind,
  CardinalityReport,
  CardinalitySimulation,
  MappingDirection,
  PreflightRunResult,
} from '../types/cardinality';

/**
 * The exact, allow-listed shape a finding takes in the 422 response body.
 * Built field-by-field in `sanitizeFinding` below (never a spread of the
 * source finding) so a property that must never leave the server — a sample
 * value, a raw key, a credential — cannot ride along even if some future
 * caller mistakenly attaches one to the in-memory `CardinalityFinding`.
 */
export interface SanitizedCardinalityFinding {
  key: string;
  type: CardinalityFindingType;
  severity: CardinalityFindingSeverity;
  overrideable: boolean;
  direction: MappingDirection;
  mappingIndexes: number[];
  relationshipPath?: string[];
  message: string;
  resolutionOptions: CardinalityResolutionKind[];
}

export type SanitizedCardinalitySimulation = CardinalitySimulation;

export interface SanitizedCardinalityReport {
  analyzerVersion: string;
  direction: MappingDirection;
  findings: SanitizedCardinalityFinding[];
  simulation?: SanitizedCardinalitySimulation;
  fingerprint: string;
  unavailableChecks: string[];
}

/** The full JSON body the error boundary sends for a 422 cardinality violation. */
export interface CardinalityViolationBody {
  error: string;
  message: string;
  code: 'CARDINALITY_VIOLATION';
  reportFingerprint: string;
  findings: SanitizedCardinalityFinding[];
  unavailableChecks: string[];
}

/**
 * Thrown when activation-time cardinality preflight leaves unresolved
 * blocking findings after any valid override is applied. See
 * docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * ("Error contract", "Activation semantics").
 *
 * Maps to HTTP 422 via an explicit branch in `src/middleware/errorBoundary.ts`
 * placed before the boundary's generic fallback — without that branch this
 * subtype (it extends `AppError` directly, not any of the boundary's other
 * named subclasses) would fall through to a generic 500.
 *
 * Owns its own sanitized serialization (`toResponseBody`) so the "never leak
 * samples, raw values, or credentials" invariant lives in exactly one place
 * rather than being re-derived at the call site.
 */
export class CardinalityViolationError extends AppError {
  public readonly reportFingerprint: string;
  public readonly findings: readonly SanitizedCardinalityFinding[];
  public readonly unavailableChecks: readonly string[];

  /**
   * @param result The full coordinator run (activation always requests a
   *   fresh one). `result.combinedFingerprint` is the single fingerprint an
   *   override binds to across every direction.
   * @param remaining The blocking findings still unresolved after applying
   *   any current, valid override — exactly what activation must refuse on.
   */
  constructor(result: PreflightRunResult, remaining: CardinalityFinding[]) {
    super(
      `${remaining.length} blocking cardinality finding(s) require resolution or an audited override`,
      422,
      'CARDINALITY_VIOLATION',
    );
    this.reportFingerprint = result.combinedFingerprint;
    this.findings = Object.freeze(remaining.map(sanitizeFinding));
    this.unavailableChecks = Object.freeze(
      Array.from(new Set(result.reports.flatMap((report) => report.unavailableChecks))),
    );
  }

  public toResponseBody(): CardinalityViolationBody {
    return {
      error: 'Cardinality Violation',
      message: this.message,
      code: 'CARDINALITY_VIOLATION',
      findings: this.findings.slice(),
      reportFingerprint: this.reportFingerprint,
      unavailableChecks: this.unavailableChecks.slice(),
    };
  }
}

/**
 * Picks exactly the allow-listed fields off a finding. Deliberately does not
 * spread `finding` first — any extra property on the source object (a bug
 * upstream, a corrupted object) is dropped rather than passed through.
 */
export function sanitizeFinding(finding: CardinalityFinding): SanitizedCardinalityFinding {
  const sanitized: SanitizedCardinalityFinding = {
    key: finding.key,
    type: finding.type,
    severity: finding.severity,
    overrideable: finding.overrideable,
    direction: finding.direction,
    mappingIndexes: [...finding.mappingIndexes],
    message: finding.message,
    resolutionOptions: [...finding.resolutionOptions],
  };
  if (finding.relationshipPath !== undefined) {
    sanitized.relationshipPath = [...finding.relationshipPath];
  }
  return sanitized;
}

export function sanitizeCardinalitySimulation(
  simulation: CardinalitySimulation,
): SanitizedCardinalitySimulation {
  return {
    direction: simulation.direction,
    inputRowCount: simulation.inputRowCount,
    distinctParentCount: simulation.distinctParentCount,
    childrenPerParent: {
      min: simulation.childrenPerParent.min,
      median: simulation.childrenPerParent.median,
      p95: simulation.childrenPerParent.p95,
      max: simulation.childrenPerParent.max,
    },
    expectedTargetRecordCount: simulation.expectedTargetRecordCount,
    collisionCount: simulation.collisionCount,
    collisionRowIndexes: [...simulation.collisionRowIndexes],
    rejectedRecordCount: simulation.rejectedRecordCount,
    droppedChildCount: simulation.droppedChildCount,
    compressedChildCount: simulation.compressedChildCount,
    assumptions: [...simulation.assumptions],
    unavailableChecks: [...simulation.unavailableChecks],
  };
}

export function sanitizeCardinalityReport(
  report: CardinalityReport,
): SanitizedCardinalityReport {
  const sanitized: SanitizedCardinalityReport = {
    analyzerVersion: report.analyzerVersion,
    direction: report.direction,
    findings: report.findings.map(sanitizeFinding),
    fingerprint: report.fingerprint,
    unavailableChecks: [...report.unavailableChecks],
  };
  if (report.simulation !== undefined) {
    sanitized.simulation = sanitizeCardinalitySimulation(report.simulation);
  }
  return sanitized;
}
