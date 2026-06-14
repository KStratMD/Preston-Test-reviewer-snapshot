/**
 * Identity propagation through the help chat route, plus the Task-2
 * context-validation / internal-audience authorization contract.
 *
 * The global `/api` `optionalAuthMiddleware` mount is the PRODUCTION path.
 * Tests that need a real Bearer JWT wire that same middleware here so we prove
 * the no-second-mount decision: the route itself does NOT add another
 * `optionalAuthMiddleware`.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHelpRouter } from '../../src/routes/help';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { optionalAuthMiddleware } from '../../src/middleware/auth';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';

// --- helpers ----------------------------------------------------------------

/** Build a minimal Express app backed by a mock processMessage. */
function createApp(
  processMessage: jest.Mock,
  /** When true, wire the global /api optionalAuthMiddleware (proves no-second-mount). */
  withGlobalAuth = false,
  /** Alternative: inject a custom identity middleware for simple cases. */
  identityMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
): express.Express {
  const app = express();
  app.use(express.json());
  if (withGlobalAuth) {
    app.use('/api', optionalAuthMiddleware);
  } else if (identityMiddleware) {
    app.use(identityMiddleware);
  }
  app.use('/api/help', createHelpRouter(
    { processMessage } as never,
    {} as never,
  ));
  return app;
}

const JWT_SECRET = STRONG_TEST_JWT_SECRET;

/** Sign a JWT accepted by optionalAuthMiddleware (requires `sub` + optional tenant claims). */
function signJwt(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
}

/** A minimal valid response returned by the mock processMessage. */
function mockResponse() {
  return {
    response: 'ok',
    sources: [],
    sessionId: 'session-1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
  };
}

// --- original identity-propagation tests ------------------------------------

describe('identity propagation through help chat route', () => {
  it('passes SYSTEM_IDENTITY when no authenticated identity exists', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());

    await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'How do I use mappings?' })
      .expect(200);

    expect(processMessage).toHaveBeenCalledWith(
      { message: 'How do I use mappings?', sessionId: undefined, context: undefined },
      SYSTEM_IDENTITY,
    );
  });

  it('passes req.user tenant identity when middleware populates it', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());

    const app = createApp(processMessage, false, (req, _res, next) => {
      req.user = {
        id: 'user-route',
        username: 'route-user',
        tenantId: 'tenant-route',
        roles: [],
        permissions: [],
      };
      next();
    });

    await request(app)
      .post('/api/help/chat')
      .send({ message: 'How do I use mappings?' })
      .expect(200);

    expect(processMessage).toHaveBeenCalledWith(
      { message: 'How do I use mappings?', sessionId: undefined, context: undefined },
      { tenantId: 'tenant-route', userId: 'user-route' },
    );
  });
});

// --- backward-compatibility --------------------------------------------------

describe('help chat context — backward compatibility', () => {
  it('request with only `message` still calls processMessage (no context field)', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());

    await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'What is the connector registry?' })
      .expect(200);

    expect(processMessage).toHaveBeenCalledTimes(1);
    const [callArg] = processMessage.mock.calls[0] as [{ context: unknown }];
    expect(callArg.context).toBeUndefined();
  });
});

// --- global optionalAuthMiddleware proof (no-second-mount decision) ----------

describe('global /api optionalAuthMiddleware propagates to /api/help routes', () => {
  it('Bearer JWT on /api/help/chat populates req.user through the global /api mount — no route-local middleware needed', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());
    // Wire the SAME global middleware that production uses (/api route prefix).
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const token = signJwt({ sub: 'user-jwt', tenant_id: 'tenant-jwt' });

    await request(app)
      .post('/api/help/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Prove JWT propagates' })
      .expect(200);

    // The identity context forwarded to processMessage must carry the JWT tenant.
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Prove JWT propagates' }),
      expect.objectContaining({ tenantId: 'tenant-jwt', userId: 'user-jwt' }),
    );
  });
});

// --- anonymous public-context ------------------------------------------------

describe('help chat context — anonymous public requests', () => {
  it('anonymous request with public context succeeds and calls processMessage', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());

    await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'Show me public docs', context: { audience: 'public', surface: 'code-architecture-dashboard' } })
      .expect(200);

    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('anonymous request with no audience (default public) succeeds', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());

    await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'Show me docs', context: { nodeId: 'auth-service' } })
      .expect(200);

    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});

// --- internal-audience authorization ----------------------------------------

describe('help chat context — internal audience authorization', () => {
  it('anonymous internal-audience request returns 403 and does NOT call processMessage', async () => {
    const processMessage = jest.fn();

    const res = await request(createApp(processMessage))
      .post('/api/help/chat')
      .send({ message: 'Show internal docs', context: { audience: 'internal' } })
      .expect(403);

    expect(res.body).toMatchObject({ success: false, error: 'internal_audience_requires_auth' });
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('authenticated internal-audience request calls processMessage with context.audience === "internal"', async () => {
    const processMessage = jest.fn().mockResolvedValue(mockResponse());
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const token = signJwt({ sub: 'internal-user', tenant_id: 'tenant-int' });

    await request(app)
      .post('/api/help/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Show internal docs', context: { audience: 'internal', nodeId: 'auth-service' } })
      .expect(200);

    expect(processMessage).toHaveBeenCalledTimes(1);
    const [callArg] = processMessage.mock.calls[0] as [{ context: { audience: string } }];
    expect(callArg.context.audience).toBe('internal');
  });
});

// --- context validation: 400 paths ------------------------------------------

describe('help chat context — validation rejects hostile shapes with 400', () => {
  async function expectInvalidContext(body: unknown): Promise<void> {
    const processMessage = jest.fn();
    const res = await request(createApp(processMessage))
      .post('/api/help/chat')
      .send(body)
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: 'invalid_context' });
    expect(processMessage).not.toHaveBeenCalled();
  }

  it('context as an array is rejected', () =>
    expectInvalidContext({ message: 'hi', context: ['bad'] }));

  it('context as a string is rejected', () =>
    expectInvalidContext({ message: 'hi', context: 'bad' }));

  it('context as a number is rejected', () =>
    expectInvalidContext({ message: 'hi', context: 42 }));

  it('context.surface as a number is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { surface: 123 } }));

  it('context.surface longer than 80 characters is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { surface: 'x'.repeat(81) } }));

  it('context.nodeId with uppercase letters is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { nodeId: 'Auth-Service' } }));

  it('context.nodeId longer than 80 characters is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { nodeId: 'a'.repeat(81) } }));

  it('context.nodeId as empty string is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { nodeId: '' } }));

  it('context.audience "Internal" (wrong case) is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { audience: 'Internal' } }));

  it('context.audience "admin" is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { audience: 'admin' } }));

  it('context.corpus with non-string elements is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { corpus: ['ok', 42] } }));

  it('context.corpus with 11 entries is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { corpus: Array.from({ length: 11 }, (_, i) => `entry-${i}`) } }));

  it('context.corpus entry longer than 80 characters is rejected', () =>
    expectInvalidContext({ message: 'hi', context: { corpus: ['y'.repeat(81)] } }));
});

// --- GET /api/help/audiences -------------------------------------------------

describe('GET /api/help/audiences', () => {
  it('returns public-only for anonymous callers', async () => {
    const processMessage = jest.fn();
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const res = await request(app)
      .get('/api/help/audiences')
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        authenticated: false,
        allowedAudiences: ['public'],
        defaultAudience: 'public',
      },
    });
  });

  it('returns public + internal for authenticated callers', async () => {
    const processMessage = jest.fn();
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const token = signJwt({ sub: 'user-aud', tenant_id: 'tenant-aud' });

    const res = await request(app)
      .get('/api/help/audiences')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        authenticated: true,
        allowedAudiences: ['public', 'internal'],
        defaultAudience: 'public',
      },
    });
  });

  it('returns public-only for a JWT that lacks a tenantId claim (resolves to SYSTEM_IDENTITY)', async () => {
    // A JWT with sub but no tenant_id claim populates req.user but extractIdentityContext
    // falls through to SYSTEM_IDENTITY (requires both tenantId AND id to be set).
    // isSystemIdentity must treat it as anonymous — /audiences must NOT advertise 'internal'.
    const processMessage = jest.fn();
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    // No tenant_id claim → normalizeTenantIdClaim returns undefined → req.user.tenantId = undefined
    // → extractIdentityContext returns SYSTEM_IDENTITY.
    const token = signJwt({ sub: 'no-tenant-user' });

    const res = await request(app)
      .get('/api/help/audiences')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        authenticated: false,
        allowedAudiences: ['public'],
        defaultAudience: 'public',
      },
    });
  });
});

// --- isSystemIdentity boundary: JWT with req.user but no valid identity -------

describe('help chat context — JWT with req.user but no valid tenantId is treated as anonymous', () => {
  it('internal-audience chat with a no-tenantId JWT returns 403 without calling processMessage', async () => {
    // req.user IS populated (optionalAuthMiddleware accepted the JWT) but tenantId is absent.
    // The old !req.user check would have passed this through; isSystemIdentity correctly
    // catches it and returns 403 before calling processMessage.
    const processMessage = jest.fn();
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const token = signJwt({ sub: 'no-tenant-user' }); // no tenant_id claim

    const res = await request(app)
      .post('/api/help/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Show internal docs', context: { audience: 'internal' } })
      .expect(403);

    expect(res.body).toMatchObject({ success: false, error: 'internal_audience_requires_auth' });
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('public-audience chat with a no-tenantId JWT succeeds (not blocked)', async () => {
    // Partial JWT should not block public requests — only internal ones.
    const processMessage = jest.fn().mockResolvedValue(mockResponse());
    const app = createApp(processMessage, /* withGlobalAuth= */ true);

    const token = signJwt({ sub: 'no-tenant-user' }); // no tenant_id claim

    await request(app)
      .post('/api/help/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Show public docs', context: { audience: 'public' } })
      .expect(200);

    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});
