// tests/unit/routes/hubSpot.test.ts
//
// Stage A2 — guardedWrite migration tests for src/routes/hubSpot.ts
//
// Design note: ALL 12 mutating HubSpot routes use callerSystem:
// 'operator_action'. The OwnershipResolver only grants writes to the declared
// manifest owner system. Since 'operator_action' is never a manifest owner,
// every mutation route blocks by default:
//
//   - contact (hubspot-owned, source_wins)  → OwnershipBlockedError  → 409
//     { error: 'ownership_blocked', ... }
//   - customer (netsuite-owned, reject_with_alert) → OwnershipViolationError → 409
//     { error: 'ownership_violation', ... }
//   - deal    (hubspot-owned, source_wins)  → OwnershipBlockedError  → 409
//   - ticket  (hubspot-owned, source_wins)  → OwnershipBlockedError  → 409
//
// Two test groups exercise this contract:
//   1. Stage A2 (this preamble) — six scenarios verifying the policy-gate path
//      (operator_action → 409) when NO override is supplied.
//   2. Stage B (bottom of file) — operator-override scenarios (PR 13c-1 Task 1)
//      that show: governance_override role + X-Governance-Override-Reason header
//      flips the 409 → 201; missing role OR missing reason silently drops the
//      override and the 409 still fires.

import express from 'express';
import request from 'supertest';
import { hubSpotRouter } from '../../../src/routes/hubSpot';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import {
  OwnershipBlockedError,
  OwnershipViolationError,
} from '../../../src/governance/sourceOfTruth/ConflictResolutionPolicy';
import type { OwnershipResolver } from '../../../src/governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../../../src/services/ai/orchestrator/AuditService';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/hubspot', hubSpotRouter);
  return app;
}

/**
 * Variant that injects req.user before the router runs. Used by Stage B
 * (operator override) tests — the override helper reads roles from
 * req.user.roles via the augmented Express type in src/types/express.d.ts.
 */
function makeAppWithUser(roles: string[]): express.Express {
  const app = express();
  app.use(express.json());
  // `req: any` is a deliberate cast: req.user is declared on the augmented
  // Express Request via src/types/express.d.ts (ambient global) but this
  // synthetic middleware is the test stand-in for authenticationMiddleware
  // and the augmented Request type isn't materialised in this scope.
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'test-user',
      username: 'test',
      tenantId: 'test-tenant',
      roles,
      permissions: [],
    };
    next();
  });
  app.use('/api/hubspot', hubSpotRouter);
  return app;
}

/**
 * Build a minimal OwnershipResolver stub that throws the supplied error from
 * validateWrite so guardedWrite routes surface the correct 409 shape.
 *
 * detectLoop is stubbed to resolve (it is called during Stage C; not wired yet
 * in A2 routes).
 */
function makeResolverThrowing(err: Error): Pick<OwnershipResolver, 'validateWrite' | 'detectLoop'> {
  return {
    validateWrite: jest.fn().mockRejectedValue(err),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

/**
 * Build a minimal AuditService stub — logGovernanceCheck is fire-and-forget
 * from guardedWrite's perspective; it should not affect the response shape.
 */
function makeAuditStub(): Pick<AuditService, 'logGovernanceCheck'> {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue(undefined),
  };
}

// ── test lifecycle ────────────────────────────────────────────────────────────

function makeApprovalQueueStub() {
  return { enqueue: jest.fn().mockResolvedValue('noop-queue-id') };
}

beforeEach(() => {
  container.snapshot();
  // ApprovalQueueService is async-bound; container.get() synchronously on it throws.
  // Rebind as a constant no-op stub so routes that call getApprovalQueueService()
  // synchronously can resolve it. The block paths (ownership_blocked,
  // ownership_violation) never call enqueue, so the stub is never invoked.
  container.rebind(TYPES.ApprovalQueueService).toConstantValue(makeApprovalQueueStub() as any);
});
afterEach(() => { container.restore(); });

// ── contact routes (entity=contact, owner=hubspot, policy=source_wins) ────────

describe('POST /api/hubspot/contacts — entity:contact, operator_action → 409 ownership_blocked', () => {
  it('returns 409 with error: ownership_blocked', async () => {
    const blockedErr = new OwnershipBlockedError({
      entity: 'contact',
      declaredOwner: 'hubspot',
      callerSystem: 'operator_action',
      policy: 'source_wins',
      correlationId: 'cor-test-1',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(blockedErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .post('/api/hubspot/contacts')
      .set('Content-Type', 'application/json')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
    expect(res.body.entity).toBe('contact');
    expect(res.body.declaredOwner).toBe('hubspot');
  });
});

describe('PATCH /api/hubspot/contacts/:id — entity:contact, operator_action → 409 ownership_blocked', () => {
  it('returns 409 with error: ownership_blocked', async () => {
    const blockedErr = new OwnershipBlockedError({
      entity: 'contact',
      declaredOwner: 'hubspot',
      callerSystem: 'operator_action',
      policy: 'source_wins',
      correlationId: 'cor-test-2',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(blockedErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .patch('/api/hubspot/contacts/contact-123')
      .set('Content-Type', 'application/json')
      .send({ firstName: 'Updated' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
  });
});

describe('DELETE /api/hubspot/contacts/:id — entity:contact, operator_action → 409 ownership_blocked', () => {
  it('returns 409 with error: ownership_blocked', async () => {
    const blockedErr = new OwnershipBlockedError({
      entity: 'contact',
      declaredOwner: 'hubspot',
      callerSystem: 'operator_action',
      policy: 'source_wins',
      correlationId: 'cor-test-3',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(blockedErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .delete('/api/hubspot/contacts/contact-123');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
  });
});

// ── company routes (entity=customer, owner=netsuite, policy=reject_with_alert) ─

describe('POST /api/hubspot/companies — entity:customer, operator_action → 409 ownership_violation', () => {
  it('returns 409 with error: ownership_violation', async () => {
    const violationErr = new OwnershipViolationError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'operator_action',
      conflictPolicy: 'reject_with_alert',
      correlationId: 'cor-test-4',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(violationErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .post('/api/hubspot/companies')
      .set('Content-Type', 'application/json')
      .send({ name: 'Acme Corp' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_violation');
    expect(res.body.entity).toBe('customer');
    expect(res.body.declaredOwner).toBe('netsuite');
    expect(res.body.conflictPolicy).toBe('reject_with_alert');
  });
});

// ── deal routes (entity=deal, owner=hubspot, policy=source_wins) ──────────────

describe('POST /api/hubspot/deals — entity:deal, operator_action → 409 ownership_blocked', () => {
  it('returns 409 with error: ownership_blocked', async () => {
    const blockedErr = new OwnershipBlockedError({
      entity: 'deal',
      declaredOwner: 'hubspot',
      callerSystem: 'operator_action',
      policy: 'source_wins',
      correlationId: 'cor-test-5',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(blockedErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .post('/api/hubspot/deals')
      .set('Content-Type', 'application/json')
      .send({ dealname: 'Q3 Deal', amount: 50000 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
    expect(res.body.entity).toBe('deal');
    expect(res.body.declaredOwner).toBe('hubspot');
  });
});

// ── ticket routes (entity=ticket, owner=hubspot, policy=source_wins) ──────────

describe('POST /api/hubspot/tickets — entity:ticket, operator_action → 409 ownership_blocked', () => {
  it('returns 409 with error: ownership_blocked', async () => {
    const blockedErr = new OwnershipBlockedError({
      entity: 'ticket',
      declaredOwner: 'hubspot',
      callerSystem: 'operator_action',
      policy: 'source_wins',
      correlationId: 'cor-test-6',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(blockedErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());

    const res = await request(makeApp())
      .post('/api/hubspot/tickets')
      .set('Content-Type', 'application/json')
      .send({ subject: 'Support ticket', hs_pipeline: 'default' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
    expect(res.body.entity).toBe('ticket');
    expect(res.body.declaredOwner).toBe('hubspot');
  });
});

// ── Stage B — operator override unblocks 409 ─────────────────────────────────
//
// PR 13c-1 Task 1. The 12 mutation routes use callerSystem: 'operator_action'
// (Stage A2, confirmed correct in PR 13b R6↔R13 then R13/R20). Operators with
// the 'governance_override' role can pass X-Governance-Override-Reason to
// unblock the 409 — guardedWrite catches the OwnershipViolationError /
// pre-flips the source_wins decision when canOverride is true. See
// `src/services/governance/operatorOverride.ts` for the role+header gate.
//
// Override is silently DROPPED (not 4xx) when role or reason is missing.
// Silent-drop matches the principle of least surprise: a non-privileged
// caller without the role gets the same 409 as if they hadn't tried.

describe('Stage B — operator override', () => {
  function makeAllowedResolverAfterOverride(): Pick<OwnershipResolver, 'validateWrite' | 'detectLoop'> {
    // source_wins: resolver returns a non-throwing block decision. guardedWrite
    // flips decision.allowed to true (and stamps governance_override flags)
    // when canOverride is true — see the `sourceWinsOverride` branch in
    // src/governance/sourceOfTruth/guardedWrite.ts. Behavioral description +
    // stable symbol reference (not a line number), per Copilot R1#3 on PR #852.
    return {
      validateWrite: jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'non_owner_write',
        policy: 'source_wins',
        declaredOwner: 'hubspot',
      }) as any,
      detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    };
  }

  /**
   * Stub the HubSpot connector so the success path doesn't make a real HTTP
   * call. Returns a static record from create() so the route's res.json(...)
   * has a shape to serialize.
   */
  function rebindConnectorStub(): void {
    const stub = {
      create: jest.fn().mockResolvedValue({ id: 'stub-rec-1', email: 'x@example.com' }),
      update: jest.fn().mockResolvedValue({ id: 'stub-rec-1', email: 'x@example.com' }),
      delete: jest.fn().mockResolvedValue(true),
      initialize: jest.fn().mockResolvedValue(undefined),
    };
    container.rebind(TYPES.HubSpotConnector).toConstantValue(stub as any);
  }

  it('POST /api/hubspot/contacts with governance_override role + reason header: 201', async () => {
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeAllowedResolverAfterOverride());
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());
    rebindConnectorStub();

    const res = await request(makeAppWithUser(['governance_override']))
      .post('/api/hubspot/contacts')
      .set('Content-Type', 'application/json')
      .set('X-Governance-Override-Reason', 'manual fix for ticket 12345')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('stub-rec-1');
  });

  it('POST /api/hubspot/companies (reject_with_alert) with governance_override + reason: 201', async () => {
    const violationErr = new OwnershipViolationError({
      entity: 'customer',
      declaredOwner: 'netsuite',
      callerSystem: 'operator_action',
      conflictPolicy: 'reject_with_alert',
      correlationId: 'cor-test-stage-b-1',
    });
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeResolverThrowing(violationErr));
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());
    rebindConnectorStub();

    const res = await request(makeAppWithUser(['governance_override']))
      .post('/api/hubspot/companies')
      .set('Content-Type', 'application/json')
      .set('X-Governance-Override-Reason', 'reconciling stale netsuite mirror')
      .send({ name: 'Acme Corp' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('stub-rec-1');
  });

  it('POST with reason header but WITHOUT governance_override role: 409 (override silently dropped)', async () => {
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeAllowedResolverAfterOverride());
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());
    rebindConnectorStub();

    const res = await request(makeAppWithUser(['admin']))  // wrong role
      .post('/api/hubspot/contacts')
      .set('X-Governance-Override-Reason', 'attempted bypass')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
  });

  it('POST with governance_override role but NO reason header: 409 (override silently dropped)', async () => {
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeAllowedResolverAfterOverride());
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());
    rebindConnectorStub();

    const res = await request(makeAppWithUser(['governance_override']))
      .post('/api/hubspot/contacts')
      // no X-Governance-Override-Reason
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
  });

  it('POST with governance_override role but empty/whitespace reason: 409', async () => {
    container.rebind(TYPES.OwnershipResolver).toConstantValue(makeAllowedResolverAfterOverride());
    container.rebind(TYPES.AuditService).toConstantValue(makeAuditStub());
    rebindConnectorStub();

    const res = await request(makeAppWithUser(['governance_override']))
      .post('/api/hubspot/contacts')
      .set('X-Governance-Override-Reason', '   ')
      .send({ email: 'test@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ownership_blocked');
  });
});
