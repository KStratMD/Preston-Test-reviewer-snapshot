/**
 * Unit tests for the admin failed-apply recovery route on approvalsRouter.
 */
import 'reflect-metadata';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

let mockSession: {
  tenant_id: string;
  user_id: string;
  user_roles: string;
} | null = null;

// F3: the embedded tenant kill switch would otherwise resolve the REAL
// TenantLifecycleService through the (mocked) container — pass it through.
jest.mock('../../../../src/middleware/embeddedTenantStatusGate', () => ({
  requireActiveEmbeddedTenant: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../../../../src/middleware/embeddedAuthMiddleware', () => ({
  validateGuestContext: (_req: Request, res: Response, next: NextFunction) => {
    if (mockSession === null) {
      res.status(400).json({ error: 'missing_x_embedded_session_id' });
      return;
    }
    res.locals.embeddedSession = mockSession;
    next();
  },
}));

const mockApprovalQueueService = {
  resetFailedApplyClaim: jest.fn(),
};

// The role gate now resolves a VERIFIED grant rather than reading the
// host-asserted user_roles column, so the mocked container must answer
// container.get(TYPES.EmbeddedRoleGrantRepository) too. mockStubGrantRole is
// read at call time so each test can choose what the caller actually holds.
const mockStubGrantId = 'erg_stub_reset_claim';
let mockStubGrantRole = 'admin';

const mockGrantRepo = {
  getActiveGrant: async (id: string) =>
    id === mockStubGrantId
      ? {
          id: mockStubGrantId,
          tenant_id: 'tenant-a',
          platform: 'standalone',
          platform_account_id: '',
          user_id: 'user-a',
          role: mockStubGrantRole,
          source: 'squire_operator',
          granted_by: 'test-operator',
          granted_at: '2026-09-03T00:00:00.000Z',
          expires_at: null,
          revoked_at: null,
          revoked_by: null,
          secret_enc: 'test-ciphertext-not-decrypted-on-this-path',
        }
      : null,
};

jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    // Dispatch by token: attachEmbeddedPrincipal resolves the grant repository
    // with getAsync (DatabaseService is async-bound), and the router resolves
    // the approval service the same way. A mock that answered both with the
    // service made the role gate resolve a principal from the wrong object.
    getAsync: jest.fn(async (token: symbol) =>
      token === jest.requireActual('../../../../src/inversify/types').TYPES.EmbeddedRoleGrantRepository
        ? mockGrantRepo
        : mockApprovalQueueService),
    get: jest.fn(() => ({
      getActiveGrant: async (id: string) =>
        id === mockStubGrantId
          ? {
              id: mockStubGrantId,
              tenant_id: 'tenant-a',
              platform: 'standalone',
              platform_account_id: '',
              user_id: 'user-a',
              role: mockStubGrantRole,
              source: 'squire_operator',
              granted_by: 'test-operator',
              granted_at: '2026-09-03T00:00:00.000Z',
              expires_at: null,
              revoked_at: null,
              revoked_by: null,
              secret_enc: 'test-ciphertext-not-decrypted-on-this-path',
            }
          : null,
    })),
  },
}));

import { approvalsRouter } from '../../../../src/routes/governance/approvalsRouter';

function mount() {
  const app = express();
  app.use(express.json());
  app.use('/api/governance/approvals', approvalsRouter);
  return app;
}

function makeApprovedApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apr-1',
    tenantId: 'tenant-a',
    requesterUserId: 'user-a',
    operationType: 'ownership_write',
    resourceType: 'fixture',
    resourceId: 'resource-1',
    riskLevel: 'medium',
    redactedPayload: '{}',
    policyFindings: '[]',
    status: 'approved',
    createdAt: '2026-05-18T00:00:00.000Z',
    expiresAt: '2026-05-19T00:00:00.000Z',
    decidedAt: '2026-05-18T01:00:00.000Z',
    decidedByUserId: 'approver-1',
    decisionReason: null,
    applyIdempotencyKey: null,
    applyStatus: 'not_started',
    appliedAt: null,
    applyFailedAt: null,
    applyError: null,
    writeDescriptor: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockSession = {
    tenant_id: 'tenant-a',
    platform: 'standalone',
    platform_account_id: '',
    user_id: 'user-a',
    user_roles: JSON.stringify(['admin']),
    user_identity: 'squire_verified',
    verified_grant_id: mockStubGrantId,
  };
  // What the caller actually HOLDS. user_roles above is only what the host
  // claimed, and the gate no longer reads it.
  mockStubGrantRole = 'admin';
  mockApprovalQueueService.resetFailedApplyClaim.mockReset();
});

describe('POST /api/governance/approvals/:id/reset-claim', () => {
  it('resets a failed claim for an admin session', async () => {
    mockApprovalQueueService.resetFailedApplyClaim.mockResolvedValue({
      outcome: 'reset',
      row: makeApprovedApproval({
        applyIdempotencyKey: null,
        applyStatus: 'not_started',
        appliedAt: null,
        applyFailedAt: null,
        applyError: null,
      }),
    });

    const res = await request(mount())
      .post('/api/governance/approvals/apr-1/reset-claim')
      .send({ reason: 'retry after connector config repair' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      approval: {
        id: 'apr-1',
        applyIdempotencyKey: null,
        applyStatus: 'not_started',
      },
    });
    expect(mockApprovalQueueService.resetFailedApplyClaim).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      id: 'apr-1',
      adminUserId: 'user-a',
      reason: 'retry after connector config repair',
    });
  });

  it('returns 400 when reset reason is missing', async () => {
    const res = await request(mount())
      .post('/api/governance/approvals/apr-1/reset-claim')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'reason_required' });
    expect(mockApprovalQueueService.resetFailedApplyClaim).not.toHaveBeenCalled();
  });

  it('returns 403 when the embedded session is not admin', async () => {
    mockSession = {
      tenant_id: 'tenant-a',
      platform: 'standalone',
      platform_account_id: '',
      user_id: 'user-a',
      user_roles: JSON.stringify(['approver']),
      user_identity: 'squire_verified',
      verified_grant_id: mockStubGrantId,
    };
    // A verified APPROVER grant is still not an admin — reset-claim is stricter.
    mockStubGrantRole = 'approver';

    const res = await request(mount())
      .post('/api/governance/approvals/apr-1/reset-claim')
      .send({ reason: 'retry after triage' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'insufficient_role' });
    expect(mockApprovalQueueService.resetFailedApplyClaim).not.toHaveBeenCalled();
  });

  it('returns 404 when the service reports unknown approval', async () => {
    mockApprovalQueueService.resetFailedApplyClaim.mockResolvedValue({ outcome: 'not_found' });

    const res = await request(mount())
      .post('/api/governance/approvals/apr-missing/reset-claim')
      .send({ reason: 'retry after triage' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'approval_not_found' });
  });

  it('returns 409 when the approval is not in failed apply state', async () => {
    mockApprovalQueueService.resetFailedApplyClaim.mockResolvedValue({
      outcome: 'not_failed',
      row: makeApprovedApproval({
        applyIdempotencyKey: 'resume::apr-1',
        applyStatus: 'claimed',
        applyError: null,
      }),
    });

    const res = await request(mount())
      .post('/api/governance/approvals/apr-1/reset-claim')
      .send({ reason: 'retry after triage' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'approval_not_failed' });
  });

  it('returns 400 for a whitespace-only id', async () => {
    const res = await request(mount())
      .post('/api/governance/approvals/%20%20/reset-claim')
      .send({ reason: 'retry after triage' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_id' });
  });
});
