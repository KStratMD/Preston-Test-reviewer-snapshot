import { describe, it, expect } from '@jest/globals';
import {
  MAX_RETAINED_TOKENS,
  PostMessageReceiver,
  ROTATION_GRACE_MS,
  SESSION_MAX_LIFETIME_MS,
  type GuestToHostPayload,
} from '../../../src/embedded/contract/PostMessageProtocol';
import type { EmbeddedContext } from '../../../src/embedded/contract/EmbeddedSurfaceContract';

function buildContext(now: number, csrfToken = 'csrf_initial'): EmbeddedContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    userRoles: [],
    platform: 'netsuite',
    sessionId: 'es_test',
    sessionExpiresAt: new Date(now + SESSION_MAX_LIFETIME_MS).toISOString(),
    expectedHostOrigin: 'https://12345.app.netsuite.com',
    csrfToken,
  };
}

describe('PostMessageReceiver — bounded activeTokens map', () => {
  it('activeTokens.size <= MAX_RETAINED_TOKENS across 1000 rotations', () => {
    let now = 1_700_000_000_000;
    const ctx = buildContext(now);
    const receiver = new PostMessageReceiver<GuestToHostPayload>({
      context: ctx,
      registeredSource: { id: 'parent-window' },
      now: () => now,
    });
    expect(receiver.tokenCount).toBe(1);
    for (let i = 1; i <= 1000; i++) {
      now += 10_000; // honors MIN_ROTATION_INTERVAL_MS floor
      receiver.rotateToken(`csrf_${i}`, new Date(now + SESSION_MAX_LIFETIME_MS).toISOString());
      expect(receiver.tokenCount).toBeLessThanOrEqual(MAX_RETAINED_TOKENS);
    }
    expect(receiver.tokenCount).toBeLessThanOrEqual(MAX_RETAINED_TOKENS);
  });

  it('clear() empties the map', () => {
    let now = 1_700_000_000_000;
    const receiver = new PostMessageReceiver<GuestToHostPayload>({
      context: buildContext(now),
      registeredSource: { id: 'parent-window' },
      now: () => now,
    });
    now += 10_000;
    receiver.rotateToken('csrf_2', new Date(now + SESSION_MAX_LIFETIME_MS).toISOString());
    expect(receiver.tokenCount).toBeGreaterThan(0);
    receiver.clear();
    expect(receiver.tokenCount).toBe(0);
  });

  it('grace-window scenarios — old token accepted within grace, rejected after', () => {
    let now = 1_700_000_000_000;
    const ctx = buildContext(now, 'csrf_old');
    const sourceWindow = { id: 'parent-window' };
    const receiver = new PostMessageReceiver<GuestToHostPayload>({
      context: ctx,
      registeredSource: sourceWindow,
      now: () => now,
    });
    // Rotate to csrf_new; csrf_old now grace-windowed.
    now += 10_000;
    receiver.rotateToken('csrf_new', new Date(now + SESSION_MAX_LIFETIME_MS).toISOString());

    // (a) old token within grace window → accepted with tokenWindow: 'grace'
    const insideGraceResult = receiver.validate(
      {
        origin: ctx.expectedHostOrigin,
        source: sourceWindow,
        data: {
          envelopeVersion: 1,
          sessionId: ctx.sessionId,
          csrfToken: 'csrf_old',
          nonce: '1',
          sentAt: new Date(now).toISOString(),
          payload: { type: 'ready' as const },
        },
      },
      'incoming',
    );
    expect(insideGraceResult.ok).toBe(true);
    if (insideGraceResult.ok) {
      expect(insideGraceResult.tokenWindow).toBe('grace');
    }

    // (b) advance past ROTATION_GRACE_MS; old token rejected as token_expired
    now += ROTATION_GRACE_MS + 1_000;
    const pastGraceResult = receiver.validate(
      {
        origin: ctx.expectedHostOrigin,
        source: sourceWindow,
        data: {
          envelopeVersion: 1,
          sessionId: ctx.sessionId,
          csrfToken: 'csrf_old',
          nonce: '2',
          sentAt: new Date(now).toISOString(),
          payload: { type: 'ready' as const },
        },
      },
      'incoming',
    );
    expect(pastGraceResult.ok).toBe(false);
    if (!pastGraceResult.ok) {
      // Either swept-then-unknown or expired-on-check; both are valid outcomes.
      expect(['token_expired', 'token_unknown']).toContain(pastGraceResult.reason);
    }
  });
});

describe('PostMessageReceiver — replay + origin + envelope-version + session checks', () => {
  const now = 1_700_000_000_000;
  const ctx = buildContext(now);
  const sourceWindow = { id: 'parent-window' };

  function makeReceiver(): PostMessageReceiver<GuestToHostPayload> {
    return new PostMessageReceiver<GuestToHostPayload>({
      context: ctx,
      registeredSource: sourceWindow,
      now: () => now,
    });
  }

  function envelope(overrides: Partial<{ csrfToken: string; nonce: string; sessionId: string; envelopeVersion: number }>): unknown {
    return {
      envelopeVersion: 1,
      sessionId: ctx.sessionId,
      csrfToken: ctx.csrfToken,
      nonce: '1',
      sentAt: new Date(now).toISOString(),
      payload: { type: 'ready' as const },
      ...overrides,
    };
  }

  it('rejects on cross-origin', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: 'https://evil.example',
      source: sourceWindow,
      data: envelope({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_origin');
  });

  it('rejects on unregistered event.source', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: { id: 'other-window' },
      data: envelope({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_source');
  });

  it('rejects on session mismatch', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({ sessionId: 'es_other' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('session_mismatch');
  });

  it('rejects on envelope version mismatch', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({ envelopeVersion: 2 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('envelope_version_mismatch');
  });

  it('rejects on replayed nonce (≤ lastAccepted)', () => {
    const receiver = makeReceiver();
    const first = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({ nonce: '5' }),
    });
    expect(first.ok).toBe(true);
    const replay = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({ nonce: '5' }),
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('replay_nonce');
  });

  it('rejects on unknown csrfToken', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({ csrfToken: 'csrf_never_issued' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_unknown');
  });

  it('accepts a clean envelope', () => {
    const receiver = makeReceiver();
    const result = receiver.validate({
      origin: ctx.expectedHostOrigin,
      source: sourceWindow,
      data: envelope({}),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokenWindow).toBe('current');
      expect(result.payload).toEqual({ type: 'ready' });
    }
  });
});
