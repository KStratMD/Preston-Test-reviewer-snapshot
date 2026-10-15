/**
 * The known-answer vector every user-assertion producer must reproduce.
 *
 * Two producers sign these assertions on platforms this repository cannot
 * execute: a NetSuite SuiteScript Suitelet (`N/crypto` + `N/encode`) and a
 * Business Central AL extension (`CryptographyManagement.GenerateHash`). Their
 * HMAC output has to match `src/embedded/userAssertion.ts` exactly, or every
 * assertion fails verification — and it fails SILENTLY, because a wrong MAC is
 * indistinguishable from a wrong secret: the operator just keeps seeing 403
 * with nothing to say the two implementations disagree.
 *
 * This vector turns that from a derivation someone has to reason about into a
 * string comparison. A platform engineer signs THIS material with THIS secret
 * and checks the result equals `EXPECTED_HMAC_HEX`. Nothing else about the
 * platform needs to be understood to know whether the primitive agrees.
 *
 * `EXPECTED_HMAC_HEX` is a hard-coded literal on purpose. Deriving it from
 * `signUserAssertion` at runtime would make the check vacuous — it would pass
 * however the server's own implementation drifted. `userAssertion.test.ts`
 * asserts the server still reproduces this literal, so a change to the material
 * format breaks the server suite instead of silently invalidating every
 * already-deployed producer.
 *
 * The secret is not sensitive: it exists only to make this arithmetic
 * reproducible, and it names itself accordingly.
 */

export const ASSERTION_CONFORMANCE_VECTOR = {
  secret: 'sc_test_secret_do_not_use_in_production',
  grantId: 'erg_000102030405060708090a0b',
  tenantId: 't_vector',
  platform: 'netsuite',
  platformAccountId: 'ACCT_VECTOR_1',
  /** A NetSuite internal id and a BC UserSecurityId are both plain strings here. */
  userId: '12345',
  ts: 1788350400,
  nonce: 'bm9uY2VfdmVjdG9yXzAwMDE',
} as const;

/** The pipe-joined material, spelled out so a producer can be compared against it directly. */
export const EXPECTED_MATERIAL =
  'erg_000102030405060708090a0b|t_vector|netsuite|ACCT_VECTOR_1|12345|1788350400|bm9uY2VfdmVjdG9yXzAwMDE';

/** HMAC-SHA256(secret, EXPECTED_MATERIAL), lowercase hex. */
export const EXPECTED_HMAC_HEX = '555837ae59a8b3652722b4374493d08f6b27823907b400f1d74c8ff4271f39e1';

/** The complete header a producer must emit for this vector. */
export const EXPECTED_HEADER =
  `v1.${ASSERTION_CONFORMANCE_VECTOR.grantId}.${ASSERTION_CONFORMANCE_VECTOR.ts}` +
  `.${ASSERTION_CONFORMANCE_VECTOR.nonce}.${EXPECTED_HMAC_HEX}`;
