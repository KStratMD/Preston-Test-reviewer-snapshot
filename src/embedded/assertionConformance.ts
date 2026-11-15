import { EXPECTED_HMAC_HEX } from './userAssertionVector';

/**
 * Which platforms have PROVED their HMAC primitive matches this server's.
 *
 * Neither NetSuite nor Business Central can be executed from this repository,
 * and a disagreeing HMAC fails silently: a wrong MAC is indistinguishable from
 * a wrong secret, so an operator would see `403 insufficient_role` forever with
 * nothing anywhere saying the two implementations disagree. Grants issued
 * against such a platform would simply never work, and the reason would not be
 * discoverable from the outside.
 *
 * A runbook saying "run the known-answer check first" is an instruction, and
 * instructions get skipped. This file is the same requirement expressed as
 * something the system enforces: the operator CLI refuses to issue a grant for
 * a platform that is not recorded here, so an unverified platform cannot
 * quietly accumulate grants that were never going to work.
 *
 * ## How to add a platform
 *
 * Run the known-answer check from
 * `docs/runbooks/embedded-user-assertion-producers.md`, confirm the platform's
 * output equals `EXPECTED_HMAC_HEX`, then add an entry recording WHO ran it and
 * WHEN. The date and operator are the point — an entry with no provenance is a
 * claim, not evidence, and this file exists to stop claims standing in for
 * evidence.
 *
 * Deliberately empty today. As of 2026-09-04 no one on this project has access
 * to a NetSuite account or a Business Central environment, so the check has not
 * been run on either. That is a fact about the project, not a defect in the
 * producers, and recording it here keeps it from being forgotten or assumed
 * away later.
 */
export interface AssertionConformanceRecord {
  /** The `platform` value used in grants and in the signed material. */
  platform: string;
  /** Who ran the check. A name, so the record can be questioned. */
  verifiedBy: string;
  /** ISO date the check was run. */
  verifiedOn: string;
  /**
   * The hex the platform produced. It must equal EXPECTED_HMAC_HEX; storing it
   * rather than a boolean means a wrong value is visible in review instead of
   * hidden behind a `true`.
   */
  observedHmacHex: string;
}

export const ASSERTION_CONFORMANCE_RECORDS: readonly AssertionConformanceRecord[] = [
  // Intentionally empty. See the file comment: no NetSuite or Business Central
  // access exists on this project as of 2026-09-04, so neither platform's HMAC
  // primitive has been shown to agree with this server's.
];

/**
 * Has this platform proved its HMAC matches?
 *
 * The recorded hex is compared against the expected value rather than trusted,
 * so an entry added with the wrong output does not grant conformance — the
 * record has to be right, not merely present.
 */
export function isAssertionConformanceVerified(platform: string): boolean {
  return ASSERTION_CONFORMANCE_RECORDS.some(
    (r) => r.platform === platform && r.observedHmacHex.toLowerCase() === EXPECTED_HMAC_HEX,
  );
}

/** The message the CLI shows when a platform has not been verified. */
export function conformanceRefusalMessage(platform: string): string {
  return [
    `Refusing to issue a grant: platform '${platform}' has not passed the`,
    'user-assertion known-answer check, so an assertion signed there is not known',
    'to verify against this server. A grant issued now would silently never work —',
    'a mismatched HMAC is indistinguishable from a wrong secret, and the holder',
    'would see 403 with nothing explaining why.',
    '',
    'Run the check in docs/runbooks/embedded-user-assertion-producers.md, then add',
    `a record for '${platform}' to src/embedded/assertionConformance.ts.`,
    '',
    'Override with --i-accept-unverified-assertions only for a platform where you',
    'do not intend the assertion path to be used at all.',
  ].join('\n');
}
