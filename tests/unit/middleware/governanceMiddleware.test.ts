import type { Request, Response } from 'express';
import { createGovernanceMiddleware } from '../../../src/middleware/governanceMiddleware';
import { DEMO_ACTOR_ID, SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

/** Capture the context object handed to validateInput. */
function makeCapturingMiddleware(): {
  middleware: ReturnType<typeof createGovernanceMiddleware>;
  seen: () => { userId?: string } | undefined;
} {
  let inspectedContext: { userId?: string } | undefined;
  const middleware = createGovernanceMiddleware({
    governanceService: {
      validateInput: jest.fn(async (_input: unknown, context: { userId?: string }) => {
        inspectedContext = context;
        return { approved: true, flags: [], riskLevel: 'low', complianceChecks: [] };
      }),
    } as any,
    logger: { warn: jest.fn(), error: jest.fn() } as any,
  });
  return { middleware, seen: () => inspectedContext };
}

const baseReq = {
  method: 'GET',
  body: {},
  query: {},
  headers: {},
  originalUrl: '/api/ai/proxy/status',
  path: '/status',
};

describe('createGovernanceMiddleware', () => {
  it('includes the request path in governance input for route parameter coverage', async () => {
    let inspectedInput: unknown;
    const middleware = createGovernanceMiddleware({
      governanceService: {
        validateInput: jest.fn(async (input: unknown) => {
          inspectedInput = input;
          return {
            approved: true,
            flags: [],
            riskLevel: 'low',
            complianceChecks: [],
          };
        }),
      } as any,
      logger: {
        warn: jest.fn(),
        error: jest.fn(),
      } as any,
    });

    const req = {
      method: 'GET',
      body: {},
      query: {},
      headers: {},
      originalUrl: '/api/ai/proxy/natural-language/documentation/123-45-6789',
      path: '/natural-language/documentation/123-45-6789',
    } as Request;
    const res = {} as Response;
    const next = jest.fn();

    await middleware(req, res, next);

    expect(inspectedInput).toMatchObject({
      path: '/natural-language/documentation/123-45-6789',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ---- F6 PR4 Stage 2: explicit attribution, no system-sentinel fallback ----
  // This middleware is mounted router-wide on /api/ai/proxy (aiProxy.ts:137),
  // so it sees F2's anonymous demo traffic as well as authenticated requests.

  it('passes the verified req.user id to governance attribution', async () => {
    const { middleware, seen } = makeCapturingMiddleware();
    const req = {
      ...baseReq,
      user: { id: 'verified-user', username: 'verified-user', tenantId: 'tenant-a', roles: ['user'], permissions: [] },
    } as unknown as Request;

    await middleware(req, {} as Response, jest.fn());

    expect(seen()?.userId).toBe('verified-user');
  });

  it('uses DEMO_ACTOR_ID for anonymous policy attribution', async () => {
    const { middleware, seen } = makeCapturingMiddleware();

    await middleware({ ...baseReq } as unknown as Request, {} as Response, jest.fn());

    // Deliberate Stage 2 change: anonymous governance checks were attributed to
    // the retired system sentinel. They now carry the persistence-free demo
    // label, so anonymous policy traffic is distinguishable from system work.
    expect(seen()?.userId).toBe(DEMO_ACTOR_ID);
    expect(seen()?.userId).not.toBe(SYSTEM_IDENTITY.userId);
  });

  it('refuses a sentinel-claiming user id and falls back to the demo label', async () => {
    const { middleware, seen } = makeCapturingMiddleware();
    const req = {
      ...baseReq,
      user: { id: SYSTEM_IDENTITY.userId, username: 'sys', tenantId: 'tenant-a', roles: ['user'], permissions: [] },
    } as unknown as Request;

    await middleware(req, {} as Response, jest.fn());

    expect(seen()?.userId).toBe(DEMO_ACTOR_ID);
  });
});
