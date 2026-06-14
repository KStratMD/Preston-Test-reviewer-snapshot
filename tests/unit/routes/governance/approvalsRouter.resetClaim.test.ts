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

jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    getAsync: jest.fn().mockResolvedValue(mockApprovalQueueService),
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
    user_id: 'user-a',
    user_roles: JSON.stringify(['admin']),
  };
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
      user_id: 'user-a',
      user_roles: JSON.stringify(['approver']),
    };

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
