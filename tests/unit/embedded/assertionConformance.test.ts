/**
 * The producers ship unverified, and this is what stops that being silent.
 *
 * Neither NetSuite nor Business Central can be executed from this repository,
 * so whether their HMAC primitive agrees with `signUserAssertion` is unproven
 * until someone with platform access runs the known-answer check. A
 * disagreement fails closed AND silently: a wrong MAC is indistinguishable from
 * a wrong secret, so a grant issued against such a platform would simply never
 * work and the holder would see 403 forever with nothing explaining why.
 *
 * The runbook asks an operator to run the check first. This gate makes the
 * system refuse instead, because an instruction in a document is not a control.
 */
import {
  ASSERTION_CONFORMANCE_RECORDS,
  conformanceRefusalMessage,
  isAssertionConformanceVerified,
} from '../../../src/embedded/assertionConformance';
import { EXPECTED_HMAC_HEX } from '../../../src/embedded/userAssertionVector';

describe('assertion conformance records', () => {
  it('records no verified platform today, which is the honest state', () => {
    // As of 2026-09-04 nobody on this project has NetSuite or Business Central
    // access, so neither platform's HMAC has been shown to match. If this ever
    // becomes non-empty without a runbook run behind it, the entry is a claim
    // rather than evidence — which is the failure this file exists to prevent.
    expect(ASSERTION_CONFORMANCE_RECORDS).toHaveLength(0);
    expect(isAssertionConformanceVerified('netsuite')).toBe(false);
    expect(isAssertionConformanceVerified('business_central')).toBe(false);
  });

  it('requires the recorded hex to be CORRECT, not merely present', () => {
    // Storing the observed hex rather than a boolean is the point: an entry
    // added with the wrong output must not confer conformance, so a mistaken
    // or optimistic record fails the same way an absent one does.
    const wrong = [
      { platform: 'netsuite', verifiedBy: 'someone', verifiedOn: '2026-09-04', observedHmacHex: 'deadbeef' },
    ];
    const verified = wrong.some(
      (r) => r.platform === 'netsuite' && r.observedHmacHex.toLowerCase() === EXPECTED_HMAC_HEX,
    );
    expect(verified).toBe(false);
  });

  it('accepts a correct record, in either hex case', () => {
    for (const hex of [EXPECTED_HMAC_HEX, EXPECTED_HMAC_HEX.toUpperCase()]) {
      const records = [
        { platform: 'netsuite', verifiedBy: 'someone', verifiedOn: '2026-09-04', observedHmacHex: hex },
      ];
      const verified = records.some(
        (r) => r.platform === 'netsuite' && r.observedHmacHex.toLowerCase() === EXPECTED_HMAC_HEX,
      );
      expect(verified).toBe(true);
    }
  });

  it('explains the silent-failure mode rather than just refusing', () => {
    const message = conformanceRefusalMessage('netsuite');
    // An operator blocked by a gate needs to know why it exists, or the first
    // thing they reach for is the override.
    expect(message).toContain('netsuite');
    expect(message).toContain('known-answer check');
    expect(message).toContain('indistinguishable from a wrong secret');
    expect(message).toContain('docs/runbooks/embedded-user-assertion-producers.md');
    expect(message).toContain('--i-accept-unverified-assertions');
  });
});
