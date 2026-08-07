/**
 * Unit tests for the `isSameOriginRequest` logic inside
 * `embeddedAuthMiddleware.ts`.
 *
 * The function is not exported, so we exercise it through `validateGuestContext`
 * (the primary consumer on GET routes) and `validateSessionTeardown` (the
 * DELETE consumer) by stubbing out the DI container calls that the downstream
 * session-lookup code would make.
 *
 * Focus areas (per the 2026-06-10 live-verification bug report):
 *   - GET + no Origin + Sec-Fetch-Site: same-origin → gate should PASS (200 /
 *     next() called); used to 403.
 *   - GET + no Origin + no Sec-Fetch-Site → 403.
 *   - GET + no Origin + Sec-Fetch-Site: cross-site → 403.
 *   - GET + no Origin + Sec-Fetch-Site: same-site → 403 (strict: same-site
 *     is NOT same-origin).
 *   - GET + cross-origin Origin + Sec-Fetch-Site: same-origin → 403 (Sec-Fetch
 *     must NOT rescue a bad Origin).
 *   - POST + no Origin + Sec-Fetch-Site: same-origin → 403 (GET/HEAD only).
 *   - POST + valid same-origin Origin → still passes (regression).
 *   - HEAD treated like GET (Sec-Fetch-Site: same-origin, no Origin → passes).
 *
 * Stub architecture: we jest.mock the inversify container so no DB is needed.
 * validateGuestContext calls getSessionRepo().findSession() after the
 * isSameOriginRequest gate; we always return a valid unexpired session so that
 * a gate-pass produces next() rather than a downstream 404/410. This lets us
 * distinguish gate-fail (403) from gate-pass (next-called / session-level
 * response).
 */

import 'reflect-metadata';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Stub the DI bindings so no real DB is needed.
// ---------------------------------------------------------------------------

// A fixed future expiry that validateGuestContext will treat as valid.
const FAR_FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const mockFindSession = jest.fn(async (_id: string) => ({
  session_id: _id,
  tenant_id: 'tenant-test',
  user_id: 'user-test',
  platform: 'test',
  platform_account_id: null,
  csrf_token: 'csrf-test',
  expected_host_origin: 'http://127.0.0.1',
  expires_at: FAR_FUTURE,
  last_rotation_at: null,
  erp_record_type: null,
  erp_record_id: null,
  erp_record_url: null,
  user_roles: null,
}));

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: (_token: unknown) => {
      // Return stub implementations for all tokens the middleware calls.
      return {
        warn: jest.fn(),
        error: jest.fn(),
        // EmbeddedSessionRepository stub
        findSession: mockFindSession,
        // EmbeddedServiceTokenRepository stub (not used by validateGuestContext)
        validateToken: jest.fn(),
      };
    },
  },
}));

// Import AFTER the mock is set up.
import {
  validateGuestContext,
  validateSessionTeardown,
  EMBEDDED_SESSION_ID_HEADER,
} from '../../../src/middleware/embeddedAuthMiddleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express Request mock. */
function makeReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}): Request {
  const { method = 'GET', headers = {}, params = {}, body = {} } = opts;
  // Normalise header keys to lower-case (what Express does).
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lc[k.toLowerCase()] = v;
  }
  return {
    method,
    headers: lc,
    get: (name: string) => lc[name.toLowerCase()],
    params,
    body,
  } as unknown as Request;
}

/** Build a minimal Express Response mock with a next() spy. */
function makeResNext(): { res: Response; next: NextFunction; nextCalled: () => boolean } {
  let _nextCalled = false;
  const next: NextFunction = jest.fn(() => { _nextCalled = true; });

  const json = jest.fn();
  const status = jest.fn((_code: number) => {
    return { json };
  });

  const res = {
    status,
    json,
    locals: {},
  } as unknown as Response;

  return { res, next, nextCalled: () => _nextCalled };
}

// ---------------------------------------------------------------------------
// Tests: GET without Origin header — Sec-Fetch-Site determines outcome
// ---------------------------------------------------------------------------

describe('isSameOriginRequest — GET, no Origin', () => {
  it('PASS: GET + no Origin + Sec-Fetch-Site: same-origin calls next()', async () => {
    const req = makeReq({
      method: 'GET',
      headers: {
        'sec-fetch-site': 'same-origin',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(true);
    expect((res as unknown as { status: jest.Mock }).status).not.toHaveBeenCalledWith(403);
  });

  it('FAIL: GET + no Origin + no Sec-Fetch-Site → 403 cross_origin_rejected', async () => {
    const req = makeReq({
      method: 'GET',
      headers: {
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });

  it('FAIL: GET + no Origin + Sec-Fetch-Site: cross-site → 403', async () => {
    const req = makeReq({
      method: 'GET',
      headers: {
        'sec-fetch-site': 'cross-site',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });

  it('FAIL: GET + no Origin + Sec-Fetch-Site: same-site → 403 (same-site is NOT same-origin)', async () => {
    const req = makeReq({
      method: 'GET',
      headers: {
        'sec-fetch-site': 'same-site',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET with Origin present — Sec-Fetch-Site must NOT rescue a bad Origin
// ---------------------------------------------------------------------------

describe('isSameOriginRequest — GET, Origin present', () => {
  it('FAIL: cross-origin Origin + Sec-Fetch-Site: same-origin → 403 (Sec-Fetch must not rescue)', async () => {
    const req = makeReq({
      method: 'GET',
      headers: {
        origin: 'https://attacker.example.com',
        'sec-fetch-site': 'same-origin',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });

  it('PASS: POST + same-origin Origin present (regression — existing behavior preserved)', async () => {
    const req = makeReq({
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(true);
    expect((res as unknown as { status: jest.Mock }).status).not.toHaveBeenCalledWith(403);
  });

  it('PASS: IPv6 same-origin Origin with bracketed Host (Copilot round-2 — naive split(":") broke [::1])', async () => {
    const req = makeReq({
      method: 'POST',
      headers: {
        origin: 'http://[::1]',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '[::1]:3000',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(true);
    expect((res as unknown as { status: jest.Mock }).status).not.toHaveBeenCalledWith(403);
  });

  it('FAIL: IPv6 cross-origin Origin vs bracketed Host → 403', async () => {
    const req = makeReq({
      method: 'POST',
      headers: {
        origin: 'http://[2001:db8::1]',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '[::1]:3000',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST — Sec-Fetch-Site must NOT substitute for Origin on mutating methods
// ---------------------------------------------------------------------------

describe('isSameOriginRequest — POST, no Origin', () => {
  it('FAIL: POST + no Origin + Sec-Fetch-Site: same-origin → 403 (GET/HEAD only rule)', async () => {
    const req = makeReq({
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: HEAD treated like GET
// ---------------------------------------------------------------------------

describe('isSameOriginRequest — HEAD, no Origin', () => {
  it('PASS: HEAD + no Origin + Sec-Fetch-Site: same-origin calls next()', async () => {
    const req = makeReq({
      method: 'HEAD',
      headers: {
        'sec-fetch-site': 'same-origin',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_test_123',
        host: '127.0.0.1',
      },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateGuestContext(req, res, next);

    expect(nextCalled()).toBe(true);
    expect((res as unknown as { status: jest.Mock }).status).not.toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateSessionTeardown (DELETE) — Sec-Fetch-Site must NOT substitute
// ---------------------------------------------------------------------------

describe('isSameOriginRequest — validateSessionTeardown DELETE, no Origin', () => {
  it('FAIL: DELETE + no Origin + Sec-Fetch-Site: same-origin → 403 (mutating method)', async () => {
    const req = makeReq({
      method: 'DELETE',
      headers: {
        'sec-fetch-site': 'same-origin',
        [EMBEDDED_SESSION_ID_HEADER]: 'es_delete_123',
        host: '127.0.0.1',
      },
      params: { id: 'es_delete_123' },
    });
    const { res, next, nextCalled } = makeResNext();

    await validateSessionTeardown(req, res, next);

    expect(nextCalled()).toBe(false);
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(403);
  });
});
