# Embedded ERP Surface Contract

**Status:** PR 10b — adapters shipped (NetSuite SuiteApp + Business Central Extension descriptors with conformance gate)
**Last verified:** 2026-05-23
**ADR:** [ADR-018](../adr/ADR-018-embedded-erp-surface-contract.md)

This document is the canonical specification for the platform-agnostic
embedded surface that hosts SuiteCentral modules (compliance dashboard,
PR 11 reconciliation, PR 12 lineage, PR 3C governance approvals,
PR 17b sync error triage) inside NetSuite and Business Central.

The wedge statement: *"embedded workflows … inside NetSuite or Business
Central."* Today every operator surface is a separate web app at
`https://app.suitecentral.example.com/...`. Finance and ops users live
inside the ERP; asking them to context-switch loses the differentiator.

## Two-phase shape

- **PR 10a (this contract)** — define the platform-agnostic embedded
  contract: iframe-safe surface, postMessage protocol, tenant/context
  bootstrap, ERP record context, auth/session model, navigation entry
  points, CSP requirements. Ship a reference iframe host
  (`public/embedded/host-reference.html`) that any module can mount inside.
- **PR 10b** — ship NetSuite SuiteApp + BC AL Extension adapters in
  parallel (Tier-B decision #9). Each wraps `host-reference.html` in the
  platform's native shell.

## Files in this contract

```
src/embedded/contract/
  EmbeddedSurfaceContract.ts       — typed shapes (EmbeddedContext, EmbeddedNavigationEntry)
  PostMessageProtocol.ts           — envelope shape, validate(), token-rotation state machine
src/middleware/
  embeddedAuthMiddleware.ts        — three NAMED exports (validateHostBootstrap, validateGuestContext, validateSessionTeardown)
  embeddedCspMiddleware.ts         — single source of truth for the CSP header
src/routes/embedded/
  hostBootstrapRouter.ts           — POST /api/embedded/host-bootstrap
  contextBootstrapRouter.ts        — POST /api/embedded/context (incl. context.refresh)
  sessionTeardownRouter.ts         — DELETE /api/embedded/sessions/:id
src/services/embedded/
  EmbeddedSessionRepository.ts     — Kysely CRUD on embedded_sessions
  EmbeddedServiceTokenRepository.ts — wraps SecureCredentialManager + embedded_service_token_versions
  EmbeddedRetentionJob.ts          — hourly setInterval cleanup; canonical Tier-B scheduler shape
src/database/migrations/
  032-create-embedded-sessions-table.ts
  033-create-embedded-service-token-versions-table.ts
public/embedded/
  host-reference.html              — dev-only standalone host
  guest-bootstrap.js               — CSP-hashed; loaded by every embedded module
  session-expired.html             — interstitial; served via embeddedCspMiddleware
scripts/
  generate-embedded-csp.mjs        — prebuild + pre-commit; rewrites EMBEDDED_BOOTSTRAP_SHA256
  check-embedded-csp-hash.mjs      — CI gate; verifies hash sync
  check-adapter-conformance.mjs    — CI gate; locks PR 10b adapter→test pairing
  rotate-embedded-service-token.ts — operator CLI for 24h-overlap rotation
  revoke-embedded-service-token.ts — operator CLI for emergency revocation
```

## Embedded contract — typed shape

See `src/embedded/contract/EmbeddedSurfaceContract.ts`. The
`EmbeddedContext` type is what every embedded module receives via the
guest-bootstrap call:

- **Identity:** `tenantId`, `userId`, `userRoles`
- **Platform:** `platform` (`'netsuite' | 'business_central' | 'standalone'`),
  `platformAccountId`
- **Optional ERP record:** `erpRecord = { type, id, url? }` — populated when
  launched from a record page (e.g., NetSuite invoice 12345)
- **Session:** `sessionId`, `sessionExpiresAt` (ISO 8601)
- **postMessage gating:** `expectedHostOrigin`, `csrfToken`

## postMessage protocol

See `src/embedded/contract/PostMessageProtocol.ts`. Every message is a
typed envelope:

```ts
interface PostMessageEnvelope<P> {
  envelopeVersion: 1;
  sessionId: string;       // pinned to EmbeddedContext.sessionId
  csrfToken: string;       // pinned to active token (current OR within rotation grace)
  nonce: string;           // monotonic decimal-string; receiver does BigInt() compare
  sentAt: string;          // informational
  payload: P;              // HostToGuestPayload | GuestToHostPayload
}
```

`PostMessageReceiver.validate(event, direction)` is the single
authentication chokepoint:

1. **Origin pin** — `event.origin === EmbeddedContext.expectedHostOrigin`
2. **Source pin** — `event.source === registeredSource` (rejects messages
   from any window other than the registered iframe/parent)
3. **Envelope shape sanity** — covers third-party libraries spraying postMessage
4. **Envelope version trip** — `envelopeVersion === 1`
5. **Session pin** — rejects post-reload stale envelopes
6. **Sweep expired tokens** before token check
7. **Token in `activeTokens`** — within validity window
8. **Replay protection** — `BigInt(envelope.nonce) > lastAccepted[direction][sessionId]`
9. **Tag `tokenWindow`** — `'current'` or `'grace'` (audit-logged)

### Token rotation

- `context.refresh` issues a new `csrfToken`. The receiver maintains
  `Map<csrfToken, { issuedAt, expiresAt }>`.
- New token's `expiresAt = sessionExpiresAt`; previous token's `expiresAt`
  trims to `min(prev, now + ROTATION_GRACE_MS)`.
- `MAX_RETAINED_TOKENS = ceil(ROTATION_GRACE_MS / MIN_ROTATION_INTERVAL_MS) + 1 = 4`
  so under healthy throttling no token is evicted before its grace window
  naturally expires.
- Server-side `MIN_ROTATION_INTERVAL_MS = 10s` floor enforced at
  `/api/embedded/context` (returns 429 + `Retry-After` on violation).

### Session lifecycle and nonce epoch

- Each `sessionId` is a nonce epoch. Within an epoch, `lastAcceptedNonce`
  is per `(direction, sessionId)`.
- Reload mints a fresh sessionId — replay across reload boundaries is
  impossible (sessionId mismatch is checked before nonce).
- Hard ceiling `SESSION_MAX_LIFETIME_MS = 8h` is shorter than any plausible
  nonce-exhaustion at 1k msg/sec.

## Bearer token handoff path

**ERP-rendered host pages NEVER hold a raw bearer in browser JS.** PR 10b
provides the platform-specific server-to-server bridge:

- **NetSuite (PR 10b)** — Suitelet SuiteScript 2.x calls
  `POST /api/embedded/host-bootstrap` via `N/https` authenticated with a
  per-tenant SuiteCentral service-token (provisioned by PR 15 onboarding).
  Suitelet returns `{ embedSrc, sessionId }` to the browser; the iframe
  inserts with `src={embedSrc}`. Raw bearer never enters the DOM.
- **Business Central (PR 10b)** — AL Extension page calls
  `POST /api/embedded/host-bootstrap` via `HttpClient` with the same
  per-tenant service-token. Same return shape.
- **Standalone dev (`public/embedded/host-reference.html`)** — host page
  calls `host-bootstrap` directly with a bearer because the standalone
  host runs at `https://app.suitecentral.example.com` (same-origin to
  the API). **Dev-only — gated by `NODE_ENV !== 'production'` only.** No
  `||` env override that could re-enable in production.

## Auth / session model

`embeddedAuthMiddleware` exports THREE named middleware (NOT a single
conditional):

### `validateHostBootstrap` — `POST /api/embedded/host-bootstrap`

- `Authorization: Bearer <sct_...>` + `X-Embedded-Platform` + body
  `platformAccountId`
- Service-token validated via SHA-256 hash lookup against
  `embedded_service_token_versions`
- Platform header AND platformAccountId cross-checked (NetSuite token
  can't be reused as BC token; cross-tenant reuse rejected)
- All rejections return collapsed `401 invalid_service_token` to defend
  against probing

### `validateGuestContext` — `POST /api/embedded/context`

- `X-Embedded-Session-Id` header + same-origin gate
- Looks up sessionId in `embedded_sessions`; returns `404` if forged,
  `410` if `expires_at < now`
- Cross-origin XHR rejected with `403 cross_origin_rejected`
- **Origin-absent GET/HEAD accepted** when `Sec-Fetch-Site: same-origin`
  is present: browsers do not send an Origin header on safe-method
  same-origin fetches, but do attach `Sec-Fetch-Site: same-origin` (a
  forbidden header JS cannot forge). Mutating methods (POST/PUT/PATCH/
  DELETE) still require Origin.

**Same-origin gate is hostname-match (port-agnostic), NOT full origin
match.** This matches SameSite cookie semantics browsers actually enforce
and tolerates legitimate same-host port-differing setups (dev, staging
port-forward, supertest ephemeral ports). It is materially weaker than a
full origin check: a page served from `http://<same-host>:<other-port>`
that knows a sessionId can call these routes. The strong auth boundary
is the deferred SHOULD-FIX #7 same-origin cookie binding (lands with
PR 2C-Auth's cookie issuance work). For PR 10a, the check provides
browser-cross-origin protection (browsers can't forge Origin from inside
a script) but does NOT defend against same-host different-port callers
or non-browser clients that forge the Origin header.

### `validateSessionTeardown` — `DELETE /api/embedded/sessions/:id`

- Same same-origin gate as guest context
- `X-Embedded-Session-Id` header MUST match `:id` path param (returns
  `400 session_id_mismatch` otherwise)
- Forged sessionId 404s (NOT silent 200) — prevents unauthenticated
  attacker from terminating arbitrary sessions for UX disruption

## Service token format and lifecycle

- **Format:** `sct_<43-char-base64url>` from `crypto.randomBytes(32)`
- **Storage:** raw token in SecureCredentialManager
  (`systemType: 'embedded_service_token'`, `systemId: <tenantId>`); SHA-256
  hash + metadata in `embedded_service_token_versions` (one row per
  active+retired version for the multi-version overlap window)
- **Rotation (24h overlap default):** `npm run rotate-embedded-service-token --
  --tenant <id> --platform <netsuite|business_central> --platform-account-id <id>`
  — inserts new active row, marks previous active row's `valid_until = now + 24h`,
  replaces SCM raw token. Validation against the OLD token uses only the
  versions-table row's hash — SCM is never on the validation hot path.
- **Revocation:** `npm run revoke-embedded-service-token -- --tenant <id>` —
  marks every non-retired row `valid_until=now + retired_at=now` AND purges
  raw token from SCM. Subsequent host-bootstrap calls 401.
- **Cross-store sync:** every multi-store mutation runs in a Kysely
  transaction wrapping the SCM call. SCM failure aborts the trx; trx
  commit failure triggers compensating SCM delete in the catch block.

## Server-side `embedded_sessions` cleanup

- Every row carries `expires_at = created_at + SESSION_MAX_LIFETIME_MS`.
- **Pre-validation reject:** `POST /api/embedded/context` checks expiry
  first; expired rows yield 410.
- **Best-effort on-close:** guest fires `DELETE /api/embedded/sessions/:id`
  on `pagehide` via `fetch(..., { method: 'DELETE', keepalive: true,
  headers: { 'X-Embedded-Session-Id': sessionId } })`. Native `sendBeacon`
  is POST-only and cannot set custom headers, so it cannot satisfy the
  `validateSessionTeardown` middleware contract — `fetch` with
  `keepalive: true` is the documented replacement (Safari 13+, all
  modern browsers).
- **Scheduled cleanup:** `EmbeddedRetentionJob` (hourly setInterval)
  runs three queries per tick:
  - DELETE sessions past `expires_at + 1 hour`
  - UPDATE retire token-versions whose `valid_until < now` and
    `retired_at IS NULL`
  - DELETE token-versions whose `retired_at < now - 7 days` (forensic grace)

`EmbeddedRetentionJob` is the **canonical Tier-B scheduled-service shape**
(see AGENTS.md "Tier-B scheduled services" section). PR 11+ schedulers
MUST follow the same start()/stop() contract.

## CSP requirements

`EMBEDDED_CSP_POLICY` lives in `src/middleware/embeddedCspMiddleware.ts`
and is the single source of truth:

```
default-src 'self';
frame-ancestors https://*.netsuite.com https://*.dynamics.com;
script-src 'self' '<sha256-of-guest-bootstrap.js>' '<sha256-of-session-expired-script>';
style-src 'self' 'unsafe-inline';
connect-src 'self'
```

`script-src` carries TWO hashes: the `guest-bootstrap.js` hash (regenerated
by `scripts/generate-embedded-csp.mjs` and verified by
`scripts/check-embedded-csp-hash.mjs`) and the inline session-expired
reload-button handler hash (computed at module load time). Without the
second hash, the browser would block the inline `<script>` in the
session-expired interstitial and the Reload button would never run
(closes Copilot review round-2 BLOCKS-MERGE #3).

- **Hash generation:** `scripts/generate-embedded-csp.mjs` runs as
  `prebuild` and as the pre-commit hook on bootstrap-script changes.
- **Pre-commit hook reads STAGED BLOBS** (`git show :path`) — catches
  pathspec-bypass commits that exclude the middleware file.
- **CI gate:** `scripts/check-embedded-csp-hash.mjs` re-computes against
  the working-tree files. Defense in depth against `--no-verify`.
- `frame-ancestors` is the gate. CSRF via postMessage origin check is
  the secondary layer.
- **Single source of truth:** every embedded route mounts
  `embeddedCspMiddleware`. NEVER serve embedded content via Express's
  default static middleware (would bypass the gate).

## Threat model — explicit out-of-scope

The envelope protects against:
- Cross-origin attackers (origin check + `frame-ancestors`)
- In-flight replay (nonce check)
- Stale-session replay (sessionId check)
- Token-leak via timing (rotation grace)

The envelope does **NOT** protect against same-origin XSS in the host
page. If an attacker executes script in the parent page's origin, they
can read `EmbeddedContext.csrfToken` from `window`, observe the
`sessionId`, and construct valid envelopes. **Same-origin script-execution
attacks (XSS, malicious browser extension with content-script access)
are out of scope for this contract.** Defense at that layer requires CSP
`script-src` discipline on the host page (NetSuite's / BC's
responsibility) and standard browser-extension threat-modeling.

## Adapter conformance gate

`scripts/check-adapter-conformance.mjs` is enforced from PR 10a's merge:

- Exits 0 if `src/embedded/adapters/` is missing or empty (PR 10b not
  started).
- Exits 0 if every `*.adapter.ts` has a matching `test('<basename>:', ...)`
  in `tests/playwright/embedded/adapter-conformance.spec.ts`.
- Exits 1 if any adapter file lacks a paired test.
- Exits 1 if the placeholder spec file is missing (catches the case
  where PR 10b deletes the placeholder before adding real tests).

The placeholder test is a single trivial passing test, NOT
`test.skip` — that would conflict with the `audit-skipped-tests` gate
per CLAUDE.md "Skip Discipline (Phase 5a)".

## Test scenarios

See `tests/unit/embedded/`, `tests/integration/`, and
`tests/playwright/embedded/`. Coverage maps to the 13 scenarios in the
A-grade remediation plan, PR 10 section.
