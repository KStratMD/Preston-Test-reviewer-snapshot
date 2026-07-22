import { Router } from 'express';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { Logger } from '../utils/Logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { NotFoundError } from '../errors/NotFoundError';
import { requireTenantId } from './tenantGuard';

type CreateConfigRouterOpts = {
  configurationService: ConfigurationService;
  logger?: Logger;
};

/**
 * The route handlers historically interacted with `ConfigurationService` via
 * `as any`, which masked two facts:
 *   1. Tests inject a mock that exposes additional methods that are not on
 *      `ConfigurationService` (`duplicateConfiguration`, `getConfigurationHistory`).
 *   2. Several call sites pass arguments / read return shapes that do not match
 *      the concrete service signatures (e.g. `validateConfiguration(id)` rather
 *      than `validateConfiguration(config)`, `saveConfiguration` returning a
 *      saved record rather than `void`).
 *
 * Pattern 5 of the routes-recipe makes the loose contract explicit so the
 * casts can be removed: declare every optionally-present alias method on
 * `ExtendedConfigurationService` and resolve handlers via bound references at
 * the route boundary. This preserves the original "best-effort" semantics
 * (silently no-op when the service does not implement an alias) while letting
 * the rest of the file drop `as any`.
 */
type ExtendedConfigurationService = ConfigurationService & {
  validateConfiguration?: (configOrId: unknown) => unknown | Promise<unknown>;
  saveConfiguration: (config: unknown) => Promise<unknown>;
  deleteConfiguration: (id: string) => Promise<unknown>;
  importConfiguration: (data: unknown) => Promise<unknown>;
  duplicateConfiguration?: (id: string, newName: string) => Promise<unknown>;
  getConfigurationHistory?: (id: string) => Promise<unknown>;
};

interface ValidationShape {
  valid?: boolean;
  isValid?: boolean;
  errors?: unknown[];
}

interface SavedConfigShape {
  id?: string;
  [k: string]: unknown;
}

export const createConfigurationRouter = (optsOrService: ConfigurationService | CreateConfigRouterOpts): Router => {
  const configService: ExtendedConfigurationService =
    ((optsOrService as CreateConfigRouterOpts)?.configurationService || (optsOrService as ConfigurationService)) as ExtendedConfigurationService;
  const router = Router();
  // Route-registration prefix becomes router-relative ('' = mount-point root).
  // The router is mounted at `/api/configurations` (with authMiddleware) in
  // RouteSetup.ts, so registrations use bare router-relative paths.
  const base = '';
  // Public-facing prefix retained for Location headers and other absolute-URL
  // emissions. publicBase is the SINGLE source of truth for what
  // /api/configurations means to clients; route registration uses `base`
  // (router-relative), response URLs use `publicBase`. They stay
  // equal-but-separate so a future re-mount changes one line.
  const publicBase = '/api/configurations';

  /**
   * @swagger
   * /api/configurations:
   *   get:
   *     summary: Get all integration configurations
   *     description: Retrieves a list of all configured integrations in the system
   *     tags: [Configurations]
   *     responses:
   *       200:
   *         description: List of integration configurations
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/IntegrationConfig'
   *             example:
   *               - id: "sf_to_ns_customers"
   *                 name: "Salesforce to NetSuite Customer Sync"
   *                 sourceSystem: "Salesforce"
   *                 targetSystem: "NetSuite"
   *                 syncDirection: "source_to_target"
   *                 syncMode: "realtime"
   *                 isActive: true
   */
  // Support absolute path (for unit tests inspecting router) and relative path (when mounted under base)
  const getAllHandler = asyncHandler(async (req, res) => {
    const acceptHeaderRaw = req.headers?.accept;
    const acceptHeader = Array.isArray(acceptHeaderRaw)
      ? acceptHeaderRaw.join(',').toLowerCase()
      : (acceptHeaderRaw ?? '').toLowerCase();
    const wantsHtml = acceptHeader.includes('text/html') && !acceptHeader.includes('application/json');

    // Fail-closed BEFORE the HTML convenience redirect (Copilot review): a Bearer
    // token that passes authMiddleware but lacks the tenantId claim must get the
    // 401 tenant_required contract uniformly, regardless of Accept header — not a
    // 302 to the dashboard.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    if (wantsHtml) {
      res.redirect(302, '/integration-dashboard.html');
      return;
    }

    try {
      let configs = await Promise.resolve(configService.getAllConfigurationsForTenant(tenantId));

      // Filter by sourceSystem if provided
      const sourceSystem = req.query.sourceSystem as string;
      if (sourceSystem) {
        configs = configs.filter(c => c.sourceSystem === sourceSystem);
      }

      // Filter by targetSystem if provided
      const targetSystem = req.query.targetSystem as string;
      if (targetSystem) {
        configs = configs.filter(c => c.targetSystem === targetSystem);
      }

      res.status(200).json(configs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve configurations';
      res.status(500).json({ error: message });
    }
  });
  router.get('/', getAllHandler);

  /**
   * @swagger
   * /api/configurations/{id}:
   *   get:
   *     summary: Get integration configuration by ID
   *     description: Retrieves a specific integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     responses:
   *       200:
   *         description: Integration configuration details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/IntegrationConfig'
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const getByIdHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const config = await Promise.resolve(configService.getConfigurationForTenant(tenantId, id));
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    res.status(200).json(config);
  });
  router.get(`${base}/:id`, getByIdHandler);

  /**
   * @swagger
   * /api/configurations:
   *   post:
   *     summary: Create new integration configuration
   *     description: Creates a new integration configuration with validation
   *     tags: [Configurations]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConfig'
   *           example:
   *             id: "new_integration"
   *             name: "New Integration"
   *             sourceSystem: "Salesforce"
   *             targetSystem: "NetSuite"
   *             syncDirection: "bidirectional"
   *             syncMode: "batch"
   *             isActive: true
   *             authentication:
   *               type: "oauth2"
   *               credentials:
   *                 clientId: "your_client_id"
   *                 clientSecret: "your_client_secret"
   *                 tokenUrl: "https://login.salesforce.com/services/oauth2/token"
   *     responses:
   *       201:
   *         description: Configuration created successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration saved successfully"
   *                 id:
   *                   type: string
   *                   example: "new_integration"
   *       400:
   *         description: Invalid configuration data
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // Create configuration with minimal inline validation (single handler for test harness)
  const createHandler = asyncHandler(async (req, res) => {
    const body = req.body || {};

    // Auth gate FIRST (fail-closed, Codex review): a Bearer-authenticated caller
    // with no tenant claim must get 401 tenant_required BEFORE body validation,
    // consistent with the tenant enforcement the rest of this PR applies — a
    // tenantless request should never receive a payload 400 that masks the auth
    // failure. req.user.tenantId is authoritative (spec §9); a body naming a
    // different tenant is rejected (403) before binding the caller's tenant.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    if (typeof body.tenantId === 'string' && body.tenantId !== requesterTenantId) {
      res.status(403).json({ error: 'forbidden', reason: 'tenant_mismatch' });
      return;
    }

    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.sourceSystem) missing.push('sourceSystem');
    if (!body.targetSystem) missing.push('targetSystem');
    if (missing.length) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
      return;
    }

    // Force tenant binding from authenticated identity BEFORE validation
    // (Copilot R0+R1). Cross-tenant id-collision precheck (Copilot R2):
    // refuse 404 if body.id already belongs to a different tenant.
    body.tenantId = requesterTenantId;
    if (typeof body.id === 'string' && body.id.length > 0) {
      const existing = configService.getConfigurationForTenant(requesterTenantId, body.id);
      const collidesOtherTenant =
        !existing && configService.getAllConfigurations().some(c => c.id === body.id);
      if (collidesOtherTenant) {
        res.status(404).json({ error: 'Configuration not found' });
        return;
      }
    }

    // Optional pre-save validation via service if available.
    // typeof-guard BEFORE bind: validateConfiguration could be a truthy
    // non-function (e.g. mis-wired DI mock) — `validateConfiguration?.bind`
    // would throw synchronously in that case, turning the best-effort
    // no-op path into a 500.
    const rawValidateFn = configService.validateConfiguration;
    const validateFn = typeof rawValidateFn === 'function'
      ? rawValidateFn.bind(configService)
      : undefined;
    if (validateFn) {
      try {
        const validation = (await validateFn(body)) as ValidationShape | undefined;
        // Support either {valid:boolean, errors:string[]} or {isValid:boolean, errors:string[]}
        const valid = validation?.valid ?? validation?.isValid;
        if (valid === false && Array.isArray(validation?.errors) && validation.errors.length) {
          res.status(400).json({ error: String(validation.errors[0]) });
          return;
        }
      } catch (e) {
        // If validation throws, treat as server error
        const msg = e instanceof Error ? e.message : 'Validation failed';
        res.status(500).json({ error: msg });
        return;
      }
    }

    const saved = (await configService.saveConfiguration(body)) as SavedConfigShape | undefined;
    // For create semantics return 201 + Location + message (tests expect message containing 'successfully')
    res.status(201);
    // Location/id use the authoritative request id (body.id), falling back to a
    // returned record's id if the impl provides one. The concrete
    // ConfigurationService.saveConfiguration() returns void (Copilot review): keying
    // the Location header off `saved.id` alone silently omitted it in production while
    // tests — which mock a returned record — still passed. body.id is set here because
    // create requests carry the id and tenantId binding ran above.
    const createdId = (saved && typeof saved === 'object' && saved.id) ? saved.id : body.id;
    try {
      if (createdId) {
        res.setHeader('Location', `${publicBase}/${createdId}`);
      }
    } catch {/* ignore header errors */}
    const responsePayload: Record<string, unknown> = {
      message: 'Configuration saved successfully',
      id: createdId,
    };
    if (saved && typeof saved === 'object') {
      Object.assign(responsePayload, saved);
    }
    res.json(responsePayload);
  });
  router.post('/', createHandler);

  /**
   * @swagger
   * /api/configurations/{id}:
   *   put:
   *     summary: Update integration configuration
   *     description: Updates an existing integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConfig'
   *     responses:
   *       200:
   *         description: Configuration updated successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration updated successfully"
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // Update configuration with minimal inline validation (single handler)
  const updateHandler = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const id = req.params.id;
    // Auth gate: req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    // Reject a body that names a different tenant (403) before binding.
    if (typeof body.tenantId === 'string' && body.tenantId !== requesterTenantId) {
      res.status(403).json({ error: 'forbidden', reason: 'tenant_mismatch' });
      return;
    }
    // Cross-tenant id-collision precheck (Copilot R2): refuse 404 if the path
    // id belongs to a different tenant.
    const ownedByRequester = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!ownedByRequester && configService.getAllConfigurations().some(c => c.id === id)) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const config = { ...body, id, tenantId: requesterTenantId };
    await configService.saveConfiguration(config);
    res.status(200);
    res.json({ message: 'Configuration updated successfully' });
  });
  router.put(`${base}/:id`, updateHandler);

  /**
   * @swagger
   * /api/configurations/{id}:
   *   delete:
   *     summary: Delete integration configuration
   *     description: Permanently deletes an integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     responses:
   *       200:
   *         description: Configuration deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration deleted successfully"
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const deleteHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    // Auth gate: req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    // Tenant ownership precheck (Copilot R1): refuse 404 on cross-tenant
    // delete attempts to avoid existence leak.
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    try {
      const result: unknown = await configService.deleteConfigurationForTenant(requesterTenantId, id);
      // Support different return contracts from the service:
      // - boolean true/false
      // - object with success/message (pass-through)
      if (result === false || result == null) {
        res.status(404).json({ error: 'Configuration not found' });
        return;
      }
      if (typeof result === 'object') {
        res.status(200).json(result);
        return;
      }
      res.status(200).json({ success: true, message: 'Configuration deleted' });
    } catch (err) {
      const message = err instanceof NotFoundError || (err instanceof Error && err.message === 'Configuration not found')
        ? 'Configuration not found'
        : (err instanceof Error ? err.message : 'Failed to delete configuration');
      const status = message === 'Configuration not found' ? 404 : 500;
      res.status(status).json({ error: message });
    }
  });
  router.delete(`${base}/:id`, deleteHandler);

  /**
   * @swagger
   * /api/configurations/{id}/validate:
   *   post:
   *     summary: Validate integration configuration
   *     description: Validates an integration configuration and checks connectivity
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     responses:
   *       200:
   *         description: Validation results
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 isValid:
   *                   type: boolean
   *                   description: Whether the configuration is valid
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of validation errors
   *                 warnings:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of validation warnings
   *               example:
   *                 isValid: true
   *                 errors: []
   *                 warnings: ["Consider enabling real-time sync for better performance"]
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const validateHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const validateFn = configService.validateConfiguration;
    if (typeof validateFn !== 'function') {
      // Service deployments without validateConfiguration return a
      // structured 501 instead of throwing — the global error handler
      // would otherwise emit a generic 500.
      res.status(501).json({ error: 'Configuration validation is not implemented' });
      return;
    }
    // ConfigurationService.validateConfiguration expects an
    // IntegrationConfig object, not an id string, so fetch the
    // configuration first and return 404 if it does not exist.
    const config = await Promise.resolve(configService.getConfigurationForTenant(tenantId, id));
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const validation = await validateFn.call(configService, config);
    res.status(200).json(validation);
  });
  router.post(`${base}/:id/validate`, validateHandler);

  // Additional endpoints used by tests
  const ALLOWED_EXPORT_FORMATS = new Set(['json']);
  const exportHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const rawFormat = String((req.query?.format as string) || 'json');
    // Normalize case + whitespace so semantically-equivalent formats
    // (?format=JSON, ?format=json%20) aren't rejected.
    const format = rawFormat.trim().toLowerCase();
    if (!ALLOWED_EXPORT_FORMATS.has(format)) {
      res.status(400).json({
        error: `Unsupported export format '${rawFormat}'. Supported: ${[...ALLOWED_EXPORT_FORMATS].join(', ')}`,
      });
      return;
    }
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    try {
      const result = await configService.exportConfigurationForTenant(tenantId, id);
      res.setHeader('Content-Disposition', `attachment; filename="${id}-export.${format}"`);
      // Concrete service returns a pre-serialized JSON string; res.json
      // would double-encode it (clients receive a quoted JSON string).
      // Send strings via .send() with the right content-type; fall through
      // to .json() for non-string mock returns.
      if (typeof result === 'string') {
        res.status(200).type('application/json').send(result);
      } else {
        res.status(200).json(result);
      }
    } catch (err) {
      // Cross-tenant / missing-config now throws NotFoundError (Copilot R8).
      if (err instanceof NotFoundError || (err instanceof Error && err.message === 'Configuration not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to export configuration';
      res.status(500).json({ error: message });
    }
  });
  router.get(`${base}/:id/export`, exportHandler);

  const importHandler = asyncHandler(async (req, res) => {
    // Auth gate FIRST (fail-closed, Codex review): tenant_required 401 before any
    // body validation/serialization, so a Bearer-authenticated caller with no
    // tenant claim never receives a payload 400 that masks the auth failure.
    // req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    const data = req.body;
    if (!data || typeof data !== 'object' || !('configuration' in data)) {
      res.status(400).json({ error: 'Invalid import data' });
      return;
    }
    // The concrete ConfigurationService.importConfiguration expects a
    // non-empty JSON string payload. Serialize objects defensively:
    // JSON.stringify can throw (circular refs, BigInt) or return undefined
    // (e.g. for `undefined` input). Both produce a deterministic 400 here
    // rather than a generic 500 from the global error handler.
    let configurationPayload: string | undefined;
    if (typeof data.configuration === 'string') {
      configurationPayload = data.configuration;
    } else {
      try {
        configurationPayload = JSON.stringify(data.configuration);
      } catch {
        res.status(400).json({ error: 'Invalid import data' });
        return;
      }
    }
    if (typeof configurationPayload !== 'string' || configurationPayload.trim().length === 0) {
      res.status(400).json({ error: 'Invalid import data' });
      return;
    }

    // Tenant ownership override + id-collision precheck for import (Copilot
    // R1 + R3). Parse the JSON payload, refuse 404 on cross-tenant id
    // collision, force-override the payload's tenantId to the caller's
    // tenant. If payload doesn't parse as an object, fall through.
    try {
      const parsed = JSON.parse(configurationPayload) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.id === 'string' && parsed.id.length > 0) {
          const ownedByRequester = configService.getConfigurationForTenant(requesterTenantId, parsed.id);
          if (!ownedByRequester && configService.getAllConfigurations().some(c => c.id === parsed.id)) {
            res.status(404).json({ error: 'Configuration not found' });
            return;
          }
        }
        parsed.tenantId = requesterTenantId;
        configurationPayload = JSON.stringify(parsed);
      }
    } catch {
      // Non-JSON-object payload — let the service reject.
    }

    const result = await configService.importConfiguration(configurationPayload);
    res.status(200).json(result);
  });
  router.post(`${base}/import`, importHandler);

  const duplicateHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { newName } = req.body || {};
    // Auth gate: req.user.tenantId is authoritative (spec §9). Optional
    // service methods — calls return undefined when not implemented — but
    // the route contract shouldn't be tenant-blind. Returns 404 on
    // cross-tenant id.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const result = await configService.duplicateConfiguration?.(id, newName);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/duplicate`, duplicateHandler);

  const historyHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    // Auth gate + tenant ownership precheck — see duplicateHandler comment.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    try {
      const history = await configService.getConfigurationHistory?.(id);
      res.status(200).json(history);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve configuration history';
      res.status(500).json({ error: message });
    }
  });
  router.get(`${base}/:id/history`, historyHandler);

  return router;
};
