# Proof Card: OAuth 1.0a HMAC-SHA256 Helper

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`oauth1Helper.ts` is the OAuth 1.0a primitive that proves the NetSuite connector isn't faking authentication. It implements the spec correctly: builds the parameter string from the URL query plus the OAuth params (and any extra params), constructs the signature base string `METHOD&encoded_base_url&encoded_parameter_string`, builds the signing key `encoded_consumer_secret&encoded_token_secret`, and computes the signature via Node's `crypto.createHmac(hashAlgorithm, signingKey).update(signatureBaseString).digest('base64')`. Defaults to **HMAC-SHA256** (NetSuite's required algorithm); falls back to HMAC-SHA1 only if the caller explicitly passes `signatureMethod: 'HMAC-SHA1'`.

## Source

- Implementation: `src/utils/oauth1Helper.ts:1-128` (the entire file — small enough to read end-to-end)
- Signature builder: `src/utils/oauth1Helper.ts:59-97` (`generateOAuth1Signature()`)
- HMAC computation: `src/utils/oauth1Helper.ts:90-96` — `crypto.createHmac(hashAlgorithm, signingKey).update(signatureBaseString).digest('base64')`
- Header builder: `src/utils/oauth1Helper.ts:99-128` (`getOAuth1AuthorizationHeader()`)

## Tests

- Unit: `tests/unit/utils/oauth1Helper.test.ts` (17 tests, 28 expects)
- Live consumer (NetSuite sandbox CRUD via signed requests): `tests/integration/netsuite.connector.live.crud.test.ts` — credential-gated; the suite's 8 jest cases each issue at least one signed HTTP request through `getOAuth1AuthorizationHeader()` (testConnection + list + create + read + update + search + delete + read-after-delete). Auth happens lazily on the first wire call via `ensureAuthenticated()` (or explicitly inside `BaseConnector.testConnection()`) — the suite no longer issues a standalone token-exchange step in setup. A green run is end-to-end proof that the HMAC primitive accepts production-shaped credentials and produces NetSuite-accepted signatures.

## Live vs Fixture

- Real HMAC computation wired? **Yes** · uses Node's built-in `crypto` module (`import crypto from "crypto"` at line 1; `crypto.createHmac(...)` at line 90). No third-party signing library, no fixture.
- Used by a real connector? **Yes** · `NetSuiteConnector.ts:369` calls `getOAuth1AuthorizationHeader()` for every CRUD operation against the live SuiteTalk REST API.
- Demo-mode toggle? **No** — the helper is a pure cryptographic primitive with no demo path.

## Known Gaps

- The helper does not support the `oauth_body_hash` extension (line 91-94 has a placeholder branch noting "NetSuite does not require the body to be part of the signature"). If a future caller needs `oauth_body_hash` for a different OAuth1-using API, the helper would need to be extended.
- HMAC-SHA1 is supported as a non-default fallback (line 26: `return signatureMethod.toUpperCase() === "HMAC-SHA1" ? "sha1" : "sha256"`). NetSuite explicitly forbids HMAC-SHA1 since 2022; consumers should not pass `signatureMethod: 'HMAC-SHA1'` for NetSuite traffic, and there is no unit test specifically forbidding the HMAC-SHA1 path being used against NetSuite endpoints.
- Realm parameter (line 113-115) is included in the header but not in the signature base string — correct per OAuth1 spec but worth verifying if a non-NetSuite OAuth1 service requires realm-in-signature semantics.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/utils/oauth1Helper.test.ts
grep -n "crypto.createHmac\|HMAC-SHA256" src/utils/oauth1Helper.ts
grep -n "getOAuth1AuthorizationHeader" src/connectors/NetSuiteConnector.ts src/utils/oauth1Helper.ts
```

The first grep proves the signing key is fed into Node's real HMAC primitive. The second grep proves the helper is consumed by `NetSuiteConnector` for live request signing — i.e., this isn't a utility module sitting on the shelf.

For the live-credential proof (requires NetSuite sandbox secrets, gated by `NETSUITE_LIVE_TESTS=1`): `npm run test:netsuite:live` or `gh workflow run netsuite-live.yml`. A green run is end-to-end evidence that this helper's signatures are NetSuite-accepted, not just internally self-consistent.
