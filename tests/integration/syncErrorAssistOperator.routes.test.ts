/**
 * sync-error-assist operator routes (PR 17b) — integration tests.
 *
 * Drives validateGuestContext + requireOperatorRole + the four route
 * handlers (list / accept / reject / escalate) against a real in-memory
 * sqlite DatabaseService rebound on the Inversify container. Connector
 * writes are intercepted with a `ConnectorManager.prototype.getConnector`
 * spy that returns a stub with `create`/`update` jest mocks.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { syncErrorAssistRoutes } from '../../src/routes/syncErrorAssistRoutes';
import {
  seedEmbeddedSession,
  seedSuggestion,
  fetchAuditLogsByAction,
  clearSyncErrorAssistTestState,
  setupTestDatabase,
  teardownTestDatabase,
} from './helpers/syncErrorAssistTestHelpers';
import { ConnectorManager } from '../../src/services/integration/ConnectorManager';
import { embeddedCspMiddleware } from '../../src/middleware/embeddedCspMiddleware';
import { sendEmbeddedHtml } from '../../src/middleware/embeddedHtmlHandler';

const HOST = 'localhost:3000';
const ORIGIN = 'http://localhost:3000';

describe('sync-error-assist operator routes (PR 17b)', () => {
  let app: express.Express;
  let validSessionId: string;
  let mockConnector: { create: jest.Mock; update: jest.Mock };
  const tenantId = 'tnt_test';

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use(syncErrorAssistRoutes);
    // Mirror the production mount: dedicated route inside the embedded block
    // so the CSP-header assertion below exercises the same middleware chain
    // RouteSetup.ts wires up.
    app.get(
      '/embedded/sync-error-triage.html',
      embeddedCspMiddleware,
      sendEmbeddedHtml('sync-error-triage.html'),
    );
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearSyncErrorAssistTestState();
    mockConnector = {
      create: jest.fn().mockResolvedValue({ id: 'ns_created_42' }),
      update: jest.fn().mockResolvedValue({ id: 'ns_updated_99' }),
    };
    jest
      .spyOn(ConnectorManager.prototype, 'getConnector')
      .mockResolvedValue(mockConnector as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);
    validSessionId = await seedEmbeddedSession({
      tenantId,
      userId: 'op_42',
      userRoles: ['ops'],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // GET /suggestions
  // -------------------------------------------------------------------------

  describe('GET /api/sync-error-assist/suggestions', () => {
    it('returns pending suggestions for the session tenant', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1', confidence: 'high' });
      const res = await request(app)
        .get('/api/sync-error-assist/suggestions')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].errorRecordId).toBe('e1');
    });

    it('returns 403 cross_origin_rejected when Origin header is missing', async () => {
      const res = await request(app).get('/api/sync-error-assist/suggestions');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('cross_origin_rejected');
    });

    it('returns 400 missing_x_embedded_session_id when session header is absent (Origin OK)', async () => {
      const res = await request(app)
        .get('/api/sync-error-assist/suggestions')
        .set('Host', HOST)
        .set('Origin', ORIGIN);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_x_embedded_session_id');
    });

    it('returns 403 forbidden_role when session holds no operator role', async () => {
      const noRoleSession = await seedEmbeddedSession({
        tenantId,
        userId: 'op_99',
        userRoles: ['viewer'],
      });
      const res = await request(app)
        .get('/api/sync-error-assist/suggestions')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', noRoleSession);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
    });

    it('does NOT leak suggestions from other tenants', async () => {
      await seedSuggestion({ tenantId: 'tnt_other', errorRecordId: 'cross', confidence: 'high' });
      const res = await request(app)
        .get('/api/sync-error-assist/suggestions')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId);
      expect(res.status).toBe(200);
      expect(
        res.body.items.find((i: { errorRecordId: string }) => i.errorRecordId === 'cross'),
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // POST /:errorRecordId/accept
  // -------------------------------------------------------------------------

  describe('POST /api/sync-error-assist/suggestions/:errorRecordId/accept', () => {
    it('accepts a valid create action, calls connector, writes audit, returns ok', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/accept')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } } });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Payload wrapped in { fields: ... } to match NetSuiteConnector contract.
      expect(mockConnector.create).toHaveBeenCalledWith('item', { fields: { name: 'Widget' } });
      const audits = await fetchAuditLogsByAction('sync_error_assist.accept');
      expect(audits).toHaveLength(1);
      expect(audits[0].tenant_id).toBe(tenantId);
      expect(audits[0].user_id).toBe('op_42');
      expect(audits[0].resource_id).toBe('e1');
    });

    it('400 on malformed applyAction', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/accept')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ applyAction: { type: 'delete' } });
      expect(res.status).toBe(400);
    });

    it('404 on unknown errorRecordId', async () => {
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/unknown/accept')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ applyAction: { type: 'create', entityType: 'item', payload: {} } });
      expect(res.status).toBe(404);
    });

    it('409 when row already accepted', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1', operatorDisposition: 'accepted' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/accept')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ applyAction: { type: 'create', entityType: 'item', payload: {} } });
      expect(res.status).toBe(409);
    });

    it('cross-tenant attempt returns 404 (no leak)', async () => {
      await seedSuggestion({ tenantId: 'tnt_other', errorRecordId: 'cross_e' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/cross_e/accept')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ applyAction: { type: 'create', entityType: 'item', payload: {} } });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /:errorRecordId/reject
  // -------------------------------------------------------------------------

  describe('POST /api/sync-error-assist/suggestions/:errorRecordId/reject', () => {
    it('marks rejected, writes audit, does NOT call connector', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/reject')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ reason: 'wrong field' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockConnector.create).not.toHaveBeenCalled();
      expect(mockConnector.update).not.toHaveBeenCalled();
      const audits = await fetchAuditLogsByAction('sync_error_assist.reject');
      expect(audits).toHaveLength(1);
    });

    it('400 on missing reason', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/reject')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /:errorRecordId/escalate
  // -------------------------------------------------------------------------

  describe('POST /api/sync-error-assist/suggestions/:errorRecordId/escalate', () => {
    it('marks escalated, writes audit', async () => {
      await seedSuggestion({ tenantId, errorRecordId: 'e1' });
      const res = await request(app)
        .post('/api/sync-error-assist/suggestions/e1/escalate')
        .set('Host', HOST)
        .set('Origin', ORIGIN)
        .set('X-Embedded-Session-Id', validSessionId)
        .send({ note: 'needs engineering' });
      expect(res.status).toBe(200);
      const audits = await fetchAuditLogsByAction('sync_error_assist.escalate');
      expect(audits).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /embedded/sync-error-triage.html — CSP header gate
  // -------------------------------------------------------------------------

  describe('GET /embedded/sync-error-triage.html', () => {
    it('emits the embedded CSP frame-ancestors header', async () => {
      const res = await request(app)
        .get('/embedded/sync-error-triage.html')
        .set('Host', HOST);
      expect(res.status).toBe(200);
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toMatch(/frame-ancestors\s+https:\/\/\*\.netsuite\.com\s+https:\/\/\*\.dynamics\.com/);
    });
  });
});
