/**
 * postMessage protocol for the Embedded ERP Surface Contract.
 *
 * Round-X-survived constraints (do not regress without re-running review):
 *  - Per-token validity window (Map<token, {issuedAt, expiresAt}>) — NOT a
 *    single rotationTimestamp. Required so back-to-back rotations within the
 *    grace window keep two old tokens valid concurrently with the new one,
 *    each with its own expiry.
 *  - Bounded retention: MAX_RETAINED_TOKENS = 4 (current + 3 grace-window
 *    predecessors). Sized as ceil(ROTATION_GRACE_MS / MIN_ROTATION_INTERVAL_MS)
 *    + 1 so that under MIN_ROTATION_INTERVAL_MS server-side throttling, no
 *    token is evicted before its grace window naturally expires.
 *  - Sweep-before-every-validation purges expired entries in O(n bounded).
 *  - Nonce as decimal string parsed to bigint (Safari structured-clone bigint
 *    bug + JSON portability for audit-event echo).
 *  - envelopeVersion === 1 trip catches forward-incompatible mutations.
 *  - lastAcceptedNonce is in-memory per (sessionId, direction); reload mints
 *    a fresh sessionId so replay across reload boundaries is impossible.
 */

import type {
  EmbeddedContext,
  EmbeddedNavigationEntry,
} from './EmbeddedSurfaceContract';

// ---- Constants (part of the contract; not tenant-configurable) ------------

/** Hard ceiling on session lifetime. 8h covers a working day; below
 *  Number.MAX_SAFE_INTEGER nonce exhaustion at any plausible rate. */
export const SESSION_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** How long an old csrfToken stays valid after rotation. Foreground tabs;
 *  backgrounded tabs that pause setInterval longer than this trigger a fresh
 *  request.context.refresh round-trip on resume. */
export const ROTATION_GRACE_MS = 30_000;

/** Server-side floor between consecutive context.refresh issuances for the
 *  same sessionId. Enforced by POST /api/embedded/context (returns 429 with
 *  Retry-After). Bounds the receiver-side activeTokens cap. */
export const MIN_ROTATION_INTERVAL_MS = 10_000;

/** Cap on the receiver-side activeTokens map. Sized as
 *  ceil(ROTATION_GRACE_MS / MIN_ROTATION_INTERVAL_MS) + 1 = 4. */
export const MAX_RETAINED_TOKENS =
  Math.ceil(ROTATION_GRACE_MS / MIN_ROTATION_INTERVAL_MS) + 1;

/** Current envelope shape version. Bump if envelope structure changes. */
export const ENVELOPE_VERSION = 1 as const;

// ---- Payload unions -------------------------------------------------------

export type HostToGuestPayload =
  | { type: 'context.bootstrap'; context: EmbeddedContext }
  | { type: 'context.refresh'; context: EmbeddedContext }
  | { type: 'navigate'; entry: EmbeddedNavigationEntry }
  | { type: 'session.expiring'; secondsRemaining: number }
  | { type: 'session.expired' };

export type GuestToHostPayload =
  | { type: 'ready' }
  | { type: 'request.context.refresh' }
  | { type: 'navigate.request'; entry: EmbeddedNavigationEntry }
  | { type: 'resize'; height: number }
  | {
      type: 'audit.event';
      action: string;
      resourceType: string;
      resourceId: string;
    }
  | { type: 'error'; code: string; message: string };

// ---- Envelope -------------------------------------------------------------

export interface PostMessageEnvelope<P> {
  envelopeVersion: typeof ENVELOPE_VERSION;
  sessionId: string;
  csrfToken: string;
  /** Monotonic counter as decimal string. Receiver does BigInt() and compares
   *  against lastAcceptedNonce[direction][sessionId]. Sender increments by 1n
   *  per outgoing message in (sessionId, direction). */
  nonce: string;
  /** ISO 8601; informational, not security-critical. */
  sentAt: string;
  payload: P;
}

export type HostToGuestMessage = PostMessageEnvelope<HostToGuestPayload>;
export type GuestToHostMessage = PostMessageEnvelope<GuestToHostPayload>;

// ---- Validation result ----------------------------------------------------

export type ValidationRejection =
  | 'invalid_origin'
  | 'invalid_source'
  | 'envelope_version_mismatch'
  | 'session_mismatch'
  | 'token_unknown'
  | 'token_expired'
  | 'token_evicted_pre_expiry'
  | 'token_grace_expired'
  | 'replay_nonce'
  | 'malformed_envelope';

export type ValidationResult<P> =
  | { ok: true; payload: P; tokenWindow: 'current' | 'grace' }
  | { ok: false; reason: ValidationRejection };

// ---- Receiver -------------------------------------------------------------

export type Direction = 'incoming' | 'outgoing';

interface ActiveTokenEntry {
  issuedAt: number;
  expiresAt: number;
}

export interface MessageEventLike<P> {
  origin: string;
  source: unknown;
  data: PostMessageEnvelope<P> | unknown;
}

/**
 * Receiver-side state machine for one peer of the host↔guest channel.
 *
 * The same class is used on host (validating GuestToHostMessage) and guest
 * (validating HostToGuestMessage). Caller supplies the EmbeddedContext (which
 * pins sessionId + expectedHostOrigin) and the registered event.source
 * (the iframe contentWindow on host, or window.parent on guest).
 *
 * Memory characteristics:
 *  - activeTokens.size <= MAX_RETAINED_TOKENS (= 4) at all times.
 *  - lastAcceptedNonces is one bigint entry per session this receiver has
 *    seen; in practice the receiver lives for the duration of one session,
 *    so the map holds 1 entry. Reload mints a new receiver.
 */
export class PostMessageReceiver<TPayload> {
  private context: EmbeddedContext;
  private readonly registeredSource: unknown;
  private readonly activeTokens = new Map<string, ActiveTokenEntry>();
  private readonly lastAcceptedNonces = new Map<string, bigint>();
  private readonly now: () => number;

  constructor(params: {
    context: EmbeddedContext;
    registeredSource: unknown;
    now?: () => number;
  }) {
    this.context = params.context;
    this.registeredSource = params.registeredSource;
    this.now = params.now ?? Date.now;
    // Initial token from bootstrap is current; expires at sessionExpiresAt.
    const sessionExpiresMs = Date.parse(this.context.sessionExpiresAt);
    this.activeTokens.set(this.context.csrfToken, {
      issuedAt: this.now(),
      expiresAt: Number.isFinite(sessionExpiresMs)
        ? sessionExpiresMs
        : this.now() + SESSION_MAX_LIFETIME_MS,
    });
  }

  /** Replace the bound context (e.g. after context.refresh). Inserts the new
   *  token with sessionExpiresAt expiry; grace-windows the previous token at
   *  now + ROTATION_GRACE_MS. Evicts oldest if at MAX_RETAINED_TOKENS cap. */
  rotateToken(newCsrfToken: string, newSessionExpiresAt: string): void {
    const now = this.now();
    const previousToken = this.context.csrfToken;
    const prevEntry = this.activeTokens.get(previousToken);
    if (prevEntry !== undefined) {
      // Trim grace from the existing expiry — never extend a previously
      // shorter expiry. (If sessionExpiresAt < now+ROTATION_GRACE_MS, the
      // old token simply takes its original earlier expiry.)
      prevEntry.expiresAt = Math.min(
        prevEntry.expiresAt,
        now + ROTATION_GRACE_MS,
      );
    }
    const expiresAtMs = Date.parse(newSessionExpiresAt);
    const newExpiresAt = Number.isFinite(expiresAtMs)
      ? expiresAtMs
      : now + SESSION_MAX_LIFETIME_MS;
    this.activeTokens.set(newCsrfToken, {
      issuedAt: now,
      expiresAt: newExpiresAt,
    });
    this.context = {
      ...this.context,
      csrfToken: newCsrfToken,
      sessionExpiresAt: newSessionExpiresAt,
    };
    this.enforceCap();
  }

  /** Update the bound context — replaces sessionId, csrfToken, and other
   *  fields wholesale. If the new csrfToken differs from the current one,
   *  the new token is inserted into activeTokens AND the previous token is
   *  grace-windowed (so an in-flight envelope still using the previous
   *  token is accepted within ROTATION_GRACE_MS). Closes Copilot review
   *  round-2 finding on PostMessageProtocol.ts: the original setContext()
   *  only replaced this.context, so the next message with the new token
   *  would have failed validation as `token_unknown`. */
  setContext(context: EmbeddedContext): void {
    if (context.csrfToken !== this.context.csrfToken) {
      this.rotateToken(context.csrfToken, context.sessionExpiresAt);
    }
    this.context = context;
  }

  /** Drop all token state (called on session.expired or page unload). */
  clear(): void {
    this.activeTokens.clear();
    this.lastAcceptedNonces.clear();
  }

  /** Test/inspection accessor; do not mutate the returned map. */
  get tokenCount(): number {
    return this.activeTokens.size;
  }

  validate(
    event: MessageEventLike<TPayload>,
    direction: Direction = 'incoming',
  ): ValidationResult<TPayload> {
    // 1. Origin pinning — browser-supplied, tamper-evident.
    if (event.origin !== this.context.expectedHostOrigin) {
      return { ok: false, reason: 'invalid_origin' };
    }
    // 2. Source pinning — rejects messages from any window other than the
    //    one we registered (parent on guest, iframe.contentWindow on host).
    if (event.source !== this.registeredSource) {
      return { ok: false, reason: 'invalid_source' };
    }
    // 3. Envelope shape sanity — covers messages that arrived from the right
    //    origin but aren't ours (third-party libraries spraying postMessage).
    const envelope = event.data as Partial<PostMessageEnvelope<TPayload>>;
    if (
      envelope === null ||
      typeof envelope !== 'object' ||
      typeof envelope.sessionId !== 'string' ||
      typeof envelope.csrfToken !== 'string' ||
      typeof envelope.nonce !== 'string' ||
      typeof envelope.envelopeVersion !== 'number' ||
      envelope.payload === undefined
    ) {
      return { ok: false, reason: 'malformed_envelope' };
    }
    // 4. Envelope version trip.
    if (envelope.envelopeVersion !== ENVELOPE_VERSION) {
      return { ok: false, reason: 'envelope_version_mismatch' };
    }
    // 5. Session pin (rejects post-reload stale envelopes).
    if (envelope.sessionId !== this.context.sessionId) {
      return { ok: false, reason: 'session_mismatch' };
    }
    // 6. Sweep expired tokens BEFORE checking the incoming token.
    this.sweepExpiredTokens();
    // 7. Token check — must be in activeTokens AND within validity window.
    const tokenEntry = this.activeTokens.get(envelope.csrfToken);
    if (tokenEntry === undefined) {
      return { ok: false, reason: 'token_unknown' };
    }
    const now = this.now();
    if (now >= tokenEntry.expiresAt) {
      // Stale entry that escaped the sweep (race window).
      this.activeTokens.delete(envelope.csrfToken);
      return { ok: false, reason: 'token_expired' };
    }
    // 8. Replay protection — nonce strictly increasing per (session, direction).
    let parsedNonce: bigint;
    try {
      parsedNonce = BigInt(envelope.nonce);
    } catch {
      return { ok: false, reason: 'malformed_envelope' };
    }
    const nonceKey = `${direction}:${envelope.sessionId}`;
    const lastAccepted = this.lastAcceptedNonces.get(nonceKey) ?? 0n;
    if (parsedNonce <= lastAccepted) {
      return { ok: false, reason: 'replay_nonce' };
    }
    this.lastAcceptedNonces.set(nonceKey, parsedNonce);
    // 9. Tag whether the accepted token is current or grace-window so audit
    //    logs can record `tokenWindow: 'grace'` per round-X test scenario 8a.
    const tokenWindow: 'current' | 'grace' =
      envelope.csrfToken === this.context.csrfToken ? 'current' : 'grace';
    return {
      ok: true,
      payload: envelope.payload as TPayload,
      tokenWindow,
    };
  }

  private sweepExpiredTokens(): void {
    const now = this.now();
    for (const [token, entry] of this.activeTokens) {
      if (now >= entry.expiresAt) {
        this.activeTokens.delete(token);
      }
    }
  }

  private enforceCap(): void {
    while (this.activeTokens.size > MAX_RETAINED_TOKENS) {
      // Evict the oldest by issuedAt. Map iteration is insertion-ordered so
      // the first key is the earliest-inserted; break after the first delete.
      const oldestKey = this.activeTokens.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.activeTokens.delete(oldestKey);
    }
  }
}
