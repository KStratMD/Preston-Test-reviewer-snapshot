/**
 * Unit tests for GET /api/governance/dlp-pattern-metadata
 * (PR followup/2026-06-10 — Task 3).
 *
 * New endpoint on operationsRouter: serves DLP pattern metadata to the
 * embedded operator approvals iframe via the embedded-session gate
 * (`validateGuestContext` + `requireApproverRole`), so mapFindings can
 * humanize policy-finding keys without a Bearer JWT.
 *
 * Scenarios:
 *   1. 200 happy path — envelope shape `{success: true, data: {count, patterns}}`
 *      matches the compliance endpoint's shape so mapFindings consumes it
 *      verbatim.
 *   2. 403 when the embedded session lacks approver role — sent through the REAL
 *      route chain (no app-level middleware shim) so the test pins the route's
 *      own `requireApproverRole` wiring.
 *   3. 500 (session_not_populated) when validateGuestContext did not populate
 *      the session — defensive branch, mirrors operationsRouter.test.ts.
 *   4. 500 when DLPService.getRegisteredPatterns() throws.
 *
 * 401 (missing session / no embedded session header) is exercised by the
 * shared `validateGuestContext` integration path already covered in the
 * approvalsRouter integration tests; auth middleware is stubbed here to a
 * passthrough per operationsRouter.test.ts precedent.
 */

import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';
import type { DLPService, PIIPatternMetadata } from '../../../../src/services/security/DLPService';

// Module-scope variable the validateGuestContext stub reads at call time so
// individual tests can control which roles the session carries.
let stubbedUserRoles: string[] = ['approver'];

// Stub validateGuestContext BEFORE importing the router. The stub reads
// `stubbedUserRoles` at call time so the 403 test can set a non-approver role
// without rebuilding the app.
jest.mock('../../../../src/middleware/embeddedAuthMiddleware', () => ({
  validateGuestContext: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    res.locals.embeddedSession = {
      session_id: 'es-dlp-test',
      tenant_id: 't-dlp-1',
      user_id: 'u-dlp-1',
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: 'csrf-dlp',
      expected_host_origin: 'http://localhost',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      last_rotation_at: null,
      erp_record_type: null,
      erp_record_id: null,
      erp_record_url: null,
      // Read the module-scope variable at call time so tests can vary the role.
      user_roles: JSON.stringify(stubbedUserRoles),
      created_at: new Date().toISOString(),
    };
    next();
  },
}));

// Safe to import after mocking.
import { operationsRouter } from '../../../../src/routes/governance/operationsRouter';

const SAMPLE_PATTERNS: PIIPatternMetadata[] = [
  { type: 'ssn', displayName: 'Social Security Number', category: 'government_id', severity: 'critical', requiresFieldContext: false },
  { type: 'credit_card', displayName: 'Credit Card Number', category: 'financial', severity: 'critical', requiresFieldContext: false },
  { type: 'email', displayName: 'Email Address', category: 'contact', severity: 'medium', requiresFieldContext: false },
];

describe('operationsRouter — GET /dlp-pattern-metadata', () => {
  let app: express.Express;
  let getRegisteredPatterns: jest.Mock;

  beforeEach(() => {
    stubbedUserRoles = ['approver'];
    container.snapshot();
    getRegisteredPatterns = jest.fn().mockReturnValue(SAMPLE_PATTERNS);
    const stubDlpService = { getRegisteredPatterns } as unknown as DLPService;
    container.rebind<DLPService>(TYPES.DLPService).toConstantValue(stubDlpService);
    // Stub the logger so the 500-path test doesn't write through the real
    // LoggingService to the console (keeps the suite hermetic and quiet).
    const stubLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    container.rebind(TYPES.Logger).toConstantValue(stubLogger);

    app = express();
    app.use('/api/governance', operationsRouter);
  });

  afterEach(() => {
    container.restore();
    jest.clearAllMocks();
  });

  it('200 — returns {success:true, data:{count, patterns}} matching compliance endpoint envelope', async () => {
    const res = await request(app).get('/api/governance/dlp-pattern-metadata');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        count: SAMPLE_PATTERNS.length,
        patterns: SAMPLE_PATTERNS,
      },
    });
    expect(getRegisteredPatterns).toHaveBeenCalledTimes(1);
  });

  it('403 when the embedded session lacks an approver role', async () => {
    // Set a non-approver role so the route's own requireApproverRole gate fires.
    // The request goes through the REAL operationsRouter chain (validateGuestContext
    // stub → requireApproverRole on the route registration → handler), pinning the
    // wiring at operationsRouter.ts rather than a shim in front.
    stubbedUserRoles = ['viewer'];
    const res = await request(app).get('/api/governance/dlp-pattern-metadata');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: 'insufficient_role' });
  });

  it('500 session_not_populated when middleware did not set res.locals.embeddedSession', () => {
    // Test the requireApproverRole defensive branch directly (same pattern as
    // operationsRouter.test.ts) — building an isolated app that skips session
    // population would require re-importing the router against a different mock.
    // Instead, exercise the role-gate helper directly.
    const { requireApproverRole } = require('../../../../src/routes/governance/_governanceAuth');
    const fakeReq = {} as express.Request;
    const fakeRes = {
      locals: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as express.Response;
    const next = jest.fn();
    requireApproverRole(fakeReq, fakeRes, next);
    expect(fakeRes.status).toHaveBeenCalledWith(500);
    expect(fakeRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'session_not_populated' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('500 when DLPService.getRegisteredPatterns() throws', async () => {
    getRegisteredPatterns.mockImplementation(() => { throw new Error('dlp exploded'); });
    const res = await request(app).get('/api/governance/dlp-pattern-metadata');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false });
  });
});
