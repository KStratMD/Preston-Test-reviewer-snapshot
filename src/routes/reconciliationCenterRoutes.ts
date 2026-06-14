import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { ReconciliationExceptionNotFoundError } from '../services/reconciliationCenter/ReconciliationExceptionRepository';
import { UnknownReconcilerError, ReconcilerConfigError } from '../services/reconciliationCenter/reconcilers/Reconciler';
import { ReconciliationScheduleNotFoundError } from '../services/reconciliationCenter/ReconciliationScheduleRepository';
import type { ReconciliationCenterService } from '../services/reconciliationCenter/ReconciliationCenterService';
import type { ReconciliationCadence } from '../services/reconciliationCenter/cadence';

// Synthetic placeholder userIds the auth chain can produce when there is no
// real operator identity attached to the request:
//   - `SYSTEM_IDENTITY.userId`: returned by extractIdentityContext when only
//     req.tenantContext is populated (no req.auth / req.user).
// Resolve writes resolved_by to the DB, so we fail closed on any of these
// values — otherwise the audit trail can record a synthetic identity and
// silently break the "operator attribution" claim. Stored as a Set so adding
// a new sentinel later is a one-line change.
const SYNTHETIC_OPERATOR_USER_IDS: ReadonlySet<string> = new Set([
  SYSTEM_IDENTITY.userId,
]);

const VALID_CADENCES: ReadonlySet<ReconciliationCadence> = new Set(['hourly', 'daily', 'weekly']);
function isValidCadence(v: unknown): v is ReconciliationCadence {
  return typeof v === 'string' && VALID_CADENCES.has(v as ReconciliationCadence);
}

export function reconciliationCenterRouter(service: ReconciliationCenterService): express.Router {
  const router = express.Router();

  router.get('/exceptions', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    const exceptions = await service.listOpen(identity.tenantId);
    res.json({ exceptions });
  }));

  router.post('/exceptions/:id/resolve', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    // Resolve writes resolved_by to the DB row, so the userId must be a real
    // operator identity — not any of the synthetic placeholders the auth
    // chain can produce. See SYNTHETIC_OPERATOR_USER_IDS above for the full
    // list.
    if (!identity.userId || SYNTHETIC_OPERATOR_USER_IDS.has(identity.userId)) {
      return res.status(401).json({ error: 'operator_identity_required' });
    }
    try {
      await service.resolveException({
        tenantId: identity.tenantId,
        exceptionId: req.params.id,
        actorUserId: identity.userId,
        note: typeof req.body?.note === 'string' ? req.body.note : '',
      });
    } catch (err) {
      if (err instanceof ReconciliationExceptionNotFoundError) {
        return res.status(404).json({ error: 'exception_not_found' });
      }
      throw err;
    }
    res.status(204).end();
  }));

  router.post('/schedules', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name_required' });
    }
    if (!isValidCadence(req.body?.cadence)) {
      return res.status(400).json({ error: 'invalid_cadence' });
    }
    const integrationConfigId = typeof req.body?.integrationConfigId === 'string' ? req.body.integrationConfigId.trim() : '';
    if (!integrationConfigId) {
      return res.status(400).json({ error: 'integration_config_required' });
    }
    // handlerKey presence + registration is validated by the service; an empty or
    // unregistered key surfaces as UnknownReconcilerError -> 400 unknown_handler.
    const handlerKey = typeof req.body?.handlerKey === 'string' ? req.body.handlerKey.trim() : '';
    try {
      const schedule = await service.createSchedule({
        tenantId: identity.tenantId,
        name,
        cadence: req.body.cadence,
        handlerKey,
        integrationConfigId,
      });
      return res.status(201).json({ schedule });
    } catch (err) {
      if (err instanceof UnknownReconcilerError) return res.status(400).json({ error: 'unknown_handler' });
      if (err instanceof ReconcilerConfigError) return res.status(400).json({ error: 'invalid_config', reason: err.reasonCode });
      throw err;
    }
  }));

  router.get('/schedules', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    const schedules = await service.listSchedules(identity.tenantId);
    res.json({ schedules });
  }));

  router.patch('/schedules/:id', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    const patch: { name?: string; cadence?: ReconciliationCadence; active?: boolean; integrationConfigId?: string } = {};
    const body = req.body ?? {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return res.status(400).json({ error: 'name_required' });
      }
      patch.name = body.name.trim();
    }
    if (body.cadence !== undefined) {
      if (!isValidCadence(body.cadence)) return res.status(400).json({ error: 'invalid_cadence' });
      patch.cadence = body.cadence;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'invalid_active' });
      patch.active = body.active;
    }
    if (body.integrationConfigId !== undefined) {
      if (typeof body.integrationConfigId !== 'string' || body.integrationConfigId.trim() === '') {
        return res.status(400).json({ error: 'integration_config_required' });
      }
      patch.integrationConfigId = body.integrationConfigId.trim();
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no_updates' });
    }

    try {
      const schedule = await service.updateSchedule(identity.tenantId, req.params.id, patch);
      return res.status(200).json({ schedule });
    } catch (err) {
      if (err instanceof ReconciliationScheduleNotFoundError) return res.status(404).json({ error: 'schedule_not_found' });
      // Defensive: handlerKey is immutable and was validated at creation; the registry
      // has no deregister, so an existing row's handler is always registered. Kept for
      // parity with POST.
      if (err instanceof UnknownReconcilerError) return res.status(400).json({ error: 'unknown_handler' });
      if (err instanceof ReconcilerConfigError) return res.status(400).json({ error: 'invalid_config', reason: err.reasonCode });
      throw err;
    }
  }));

  router.delete('/schedules/:id', asyncHandler(async (req, res) => {
    const identity = extractIdentityContext(req);
    if (!identity.tenantId || identity.tenantId === SYSTEM_IDENTITY.tenantId) {
      return res.status(401).json({ error: 'identity_required' });
    }
    try {
      await service.deleteSchedule(identity.tenantId, req.params.id);
    } catch (err) {
      if (err instanceof ReconciliationScheduleNotFoundError) return res.status(404).json({ error: 'schedule_not_found' });
      throw err;
    }
    res.status(204).end();
  }));

  return router;
}
