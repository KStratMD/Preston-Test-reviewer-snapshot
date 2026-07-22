// Set max listeners before any other imports to prevent warnings
process.setMaxListeners(30);

// If running in demo/lightweight mode, permanently disable OTEL to avoid
// exporter shutdown noise. This must happen before any module that might
// initialize OTEL is imported.
import { applyEnvDerivations, isBootDebug } from './utils/features';
applyEnvDerivations();

import 'reflect-metadata';
import './config/env'; // Ensures environment variables are validated and loaded first
import { setupGlobalErrorHandlers } from './middleware/errorBoundary';

// Set up global error handlers - will be configured with shutdown callback in main()
import type http from 'http';
import type { AddressInfo } from 'net';
import { resolveAvailablePort } from './utils/portResolver';
import { container } from './inversify/inversify.config';
import { TYPES } from './inversify/types';
import type { Logger } from './utils/Logger';
import type { IntegrationService } from './services/IntegrationService';
import type { AuthService } from './services/AuthService';
import { PerformanceMonitor } from './utils/monitoring';
import { authMiddleware } from './middleware/auth';
import { App } from './app';
import { isDemo, isRedisDisabled } from './utils/features';
import { env, serverConfig } from './config';
import type { ConfigurationService } from './services/ConfigurationService';
import { sampleConfigurations } from './examples/sample-integrations';
import type express from 'express';
import type { SecureAIService } from './services/ai/SecureAIService';
// Type-only import for the startup guard — the runtime value isn't needed
// because the only consumer is an `InstanceType<typeof ...>` generic, which
// is erased at compile time (Copilot R7). Top-level `import type` avoids
// the per-request dynamic-import overhead.
import type { DatabaseService } from './database/DatabaseService';
import type { DocumentationKnowledgeBase } from './services/help/DocumentationKnowledgeBase';


const BOOT_DEBUG = isBootDebug();
// bootLog will use logger.debug once logger is available
const bootLog = (...args: unknown[]) => {
  if (BOOT_DEBUG) {
    try {
      const logger = container.get<Logger>(TYPES.Logger);
      logger.debug(args.join(' '));
    } catch {
      // Fallback during early boot before container is ready
      console.error(...args);
    }
  }
};

class Server {
  // Internal App instance
  public readonly application: App;
  // Expose Express application for backward compatibility (app.app)
  public app: import('express').Application;
  private readonly logger: Logger;
  private readonly port: number;
  private server?: http.Server;
  // Resolved asynchronously in start() because the DI binding is async
  private integrationService!: IntegrationService;
  private readonly configService: ConfigurationService;
  private readonly secureAIService: SecureAIService;
  private readonly lightweightMode: boolean;
  private readonly enableAdvancedFeatures: boolean;
  private knowledgeBase?: DocumentationKnowledgeBase; // Phase 2B: Help Chat RAG for AI service enhancement

  constructor() {
    // Server runtime chooses lightweight mode for demo flows to avoid loading
    // optional heavy dependencies (OTEL, Redis, external connectors). When
    // DEMO_MODE=1 or DISABLE_REDIS=1 we prefer lightweight mode.
    const preferLightweight = isDemo() || isRedisDisabled();

    // Phase 2B: Initialize Help Chat components BEFORE App creation
    // to enable AI service enhancement with documentation knowledge
    bootLog('[BOOT][Ctor] Initializing Help Chat components...');
    try {
      const { DocumentationIndexer } = require('./services/help/DocumentationIndexer');
      const { DocumentationKnowledgeBase } = require('./services/help/DocumentationKnowledgeBase');
      const { EmbeddingService } = require('./services/ai/rag/EmbeddingService');
      const { VectorStoreService } = require('./services/ai/rag/VectorStoreService');
      const disableOpenAIEmbeddings = (process.env.DISABLE_OPENAI_EMBEDDINGS || '').toLowerCase() === '1'
        || (process.env.DISABLE_OPENAI_EMBEDDINGS || '').toLowerCase() === 'true';

      // Initialize embedding service
      const embeddingService = new EmbeddingService({
        useOpenAI: !!process.env.OPENAI_API_KEY && !disableOpenAIEmbeddings,
        openaiApiKey: process.env.OPENAI_API_KEY,
        cacheEnabled: true
      });

      // Initialize vector store
      const vectorStore = new VectorStoreService({
        embeddingService,
        maxSize: 10000
      });

      // Initialize documentation indexer
      const indexer = new DocumentationIndexer({
        docsPath: require('path').join(process.cwd(), 'docs'),
        chunkSize: 750,
        chunkOverlap: 100
      });

      // Initialize knowledge base (store for use with App)
      this.knowledgeBase = new DocumentationKnowledgeBase(
        indexer,
        embeddingService,
        vectorStore
      );

      bootLog('[BOOT][Ctor] Help Chat components initialized');
    } catch (error) {
      bootLog('[BOOT][Ctor] Failed to initialize Help Chat components (non-critical):', error);
      // Non-critical - continue without Help Chat enhancement
      this.knowledgeBase = undefined;
    }

    bootLog('[BOOT][Ctor] Creating App instance...');
    this.application = new App({ lightweight: preferLightweight ? true : false });
    bootLog('[BOOT][Ctor] App created');
    // Expose express Application
    this.app = this.application.getExpressApp();
    bootLog('[BOOT][Ctor] Resolving Logger...');
    this.logger = container.get<Logger>(TYPES.Logger);
    bootLog('[BOOT][Ctor] Logger resolved');
    this.port = serverConfig.port;
    // IntegrationService is bound asynchronously (transitively depends on
    // OwnershipResolver → LineageQueryService → DatabaseService). Resolved in
    // start() via container.getAsync so the constructor stays synchronous.
    bootLog('[BOOT][Ctor] Resolving ConfigurationService...');
    this.configService = container.get<ConfigurationService>(TYPES.ConfigurationService);
    bootLog('[BOOT][Ctor] ConfigurationService resolved');
    bootLog('[BOOT][Ctor] Resolving SecureAIService...');
    this.secureAIService = container.get<SecureAIService>(TYPES.SecureAIService);
    bootLog('[BOOT][Ctor] SecureAIService resolved');

    // Determine whether to enable advanced features (true if not lightweight mode)
    this.enableAdvancedFeatures = !preferLightweight;
    bootLog(`[BOOT][Ctor] enableAdvancedFeatures=${this.enableAdvancedFeatures}`);

    // Inject synchronous services into the app.
    // integrationService is resolved asynchronously in start(); it is injected
    // there via a second injectServices() call after await container.getAsync().
    bootLog('[BOOT][Ctor] Injecting services into app...');
    this.application.injectServices({
      configurationService: this.configService,
      knowledgeBase: this.knowledgeBase, // Phase 2B: Help Chat RAG
    });
    bootLog('[BOOT][Ctor] Services injected');

    // Mount real routers
    bootLog('[BOOT][Ctor] Determining router mode...');
    // Determine lightweight/demo mode from environment or App options
    this.lightweightMode = isDemo() || isRedisDisabled();
    bootLog(`[BOOT][Ctor] lightweightMode=${this.lightweightMode}`);
    bootLog('[BOOT][Ctor] Mounting routers...');
    this.mountRouters(this.app);
    bootLog('[BOOT][Ctor] Routers mounted');
  }


  private mountRouters(app: express.Application) {
    // Health routes (always present) — keep minimal in Server; App mounts the rest
    try {
      const createHealthRouter = require('./routes/health').createHealthRouter;
      app.use(createHealthRouter());
    } catch (_) {
      app.get('/health', (_req, res) => res.status(200).json({ status: 'healthy' }));
    }

    // Defer API routers to App.setupRoutes() to avoid duplication.
    if (this.lightweightMode) return;

    // System integration status summary — requires auth: exposes cross-tenant
    // aggregate config metadata (ERP types, sync modes, auth mechanisms).
    app.get('/api/statistics', authMiddleware, (_req, res) => {
      const configs = this.configService.getAllConfigurations();
      const total = configs.length;
      const active = configs.filter(c => c.isActive).length;
      const systemBreakdown: Record<string, number> = {};
      const syncModeBreakdown: Record<string, number> = {};
      const authTypeBreakdown: Record<string, number> = {};
      for (const c of configs) {
        const src = typeof c.sourceSystem === 'string' ? c.sourceSystem : c.sourceSystem?.type;
        const mode = c.syncMode || 'unknown';
        const srcAuth = c.sourceAuthentication?.type || 'unknown';
        if (src) systemBreakdown[src] = (systemBreakdown[src] || 0) + 1;
        syncModeBreakdown[mode] = (syncModeBreakdown[mode] || 0) + 1;
        authTypeBreakdown[srcAuth] = (authTypeBreakdown[srcAuth] || 0) + 1;
      }
      res.json({
        totalConfigurations: total,
        activeConfigurations: active,
        systemBreakdown,
        syncModeBreakdown,
        authTypeBreakdown,
        lastUpdate: new Date().toISOString(),
      });
    });

    // Removed overly aggressive 404 catch-all that was blocking legitimate API routes
    // Express will handle 404s naturally for undefined routes
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Integration Hub server...');

    // Copilot R7 on PR #851: wait for the constructor's initializationPromise
    // (setupMiddleware + setupRoutes) to complete BEFORE the async DI
    // resolution and the late /api/integrations mount. Without this await,
    // route ordering is race-dependent: the late mount could land before
    // shared middleware is wired, OR RouteSetup could reach its integration
    // block right before the late mount and produce a duplicate route.
    // After waitForInitialization() returns, the constructor's mounting work
    // is complete and we know RouteSetup definitely SKIPPED /api/integrations
    // (because integrationService was undefined at that time), so the late
    // mount below is the sole entry point for that route.
    await this.application.waitForInitialization();

    // Resolve IntegrationService asynchronously (async DI binding cascades from
    // OwnershipResolver → LineageQueryService → DatabaseService).
    this.integrationService = await container.getAsync<IntegrationService>(TYPES.IntegrationService);
    this.application.injectServices({ integrationService: this.integrationService });

    // Mount /api/integrations late: setupRoutes() runs during the constructor's
    // initializationPromise chain, when integrationService is still undefined,
    // so RouteSetup's `if (enableIntegration && this.integrationService)` gate
    // skips the mount. Now that the async resolution is complete AND we've
    // awaited initialization above, mount the router directly so the snapshot
    // semantics of RouteSetup don't strand /api/integrations as unmounted.
    // (Copilot R2 — PR 13b A3's async-DI cascade turned a previously-sync
    // injection point into an async one and the route setup wasn't
    // restructured to match.)
    const { createIntegrationRouter } = await import('./routes/integration');
    // PR 13c-4 Task 6: gate the late /api/integrations mount with
    // authMiddleware to match RouteSetup.ts. This is the sole production
    // entry point for the route (RouteSetup skips it because
    // integrationService is undefined during constructor init), so the
    // anonymous-bypass closure must be applied here too — without it the
    // gate would be effectively absent in the running server.
    // PR-E (A1): the ERP write-family limiter must ALSO be applied here, not
    // just at the RouteSetup mount (which never runs in production), or the
    // production integrations family stays unlimited. limitMutatingMethods
    // keeps reads unthrottled; the limiter skips in demo/RATE_LIMIT_ENABLED=0.
    const { authMiddleware } = await import('./middleware/auth');
    const { createErpWriteRateLimit, limitMutatingMethods } = await import('./middleware/rateLimit');
    this.app.use(
      '/api/integrations',
      limitMutatingMethods(createErpWriteRateLimit()),
      authMiddleware,
      createIntegrationRouter(this.integrationService),
    );

    // Copilot R8 on PR #851: setupRoutes() appended the project `errorHandler`
    // as the LAST middleware (see RouteSetup.ts:1310). Express resolves
    // `next(err)` against handlers REGISTERED AFTER the caller — so any
    // /api/integrations handler that errors would fall through to Express's
    // default HTML 500 because the error handler is before the integration
    // router in the chain. Re-register the project error handler AFTER the
    // late mount so JSON-shaped error responses + structured logging still
    // apply to /api/integrations failures.
    const { errorHandler } = await import('./middleware/errorHandler');
    this.app.use(errorHandler(this.logger));

    try {
      this.logger.info('Initializing SecureAIService...');
      await this.secureAIService.initialize();
      this.logger.info('SecureAIService initialized successfully.');
    } catch (error) {
      this.logger.warn('Failed to initialize SecureAIService. Live AI features may be disabled. Continuing with fallback mechanisms.', { error: (error as Error).message });
    }

    try {
      this.logger.info('Initializing IntegrationService...');
      await this.integrationService.initialize();
      this.logger.info('IntegrationService initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize IntegrationService', error);
      throw error;
    }

    // PR 3B: refuse to boot when `approvalMode === 'queue'` (the new default)
    // but `governance_approvals` is unreachable — failing fast is preferable
    // to silently dropping high-risk PII writes mid-request. Runs after
    // IntegrationService.initialize so DatabaseService is wired, but BEFORE
    // any seed / hydration writes so a misconfigured deploy fails at the
    // earliest possible point.
    //
    // Reads the canonical default via `getDefaultOutboundGovernanceConfig`
    // so this guard cannot desync from the service's runtime default
    // (Copilot R1). When per-tenant approvalMode lands (Tier-C), this guard
    // should switch to "queue mode reachable for at least one tenant."
    try {
      const { assertApprovalQueueReachableIfNeeded } = await import('./services/governance/approvalModeStartupGuard');
      const { getDefaultOutboundGovernanceConfig } = await import('./services/governance/OutboundGovernanceService');
      const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
      const defaultConfig = getDefaultOutboundGovernanceConfig();
      await assertApprovalQueueReachableIfNeeded(
        { approvalMode: defaultConfig.approvalMode },
        dbService,
        this.logger,
      );
    } catch (error) {
      // ApprovalQueueUnreachableError carries fail-closed intent; re-throw to
      // exit the process with a non-zero code. Any other error means the
      // guard itself failed (e.g. dynamic import); treat as the same fail-
      // closed condition — boot rather than silently bypass.
      this.logger.error(
        'approvalModeStartupGuard: refusing to start server (mode=queue + table unreachable)',
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }

    try {
      this.logger.info('Loading sample data...');
      await this.loadSampleDataIfNeeded();
      this.logger.info('Sample data loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load sample data', error);
      throw error;
    }

    // PR 6 (operator-promotion): seed FinanceCentral demo approvals into the
    // new finance_central_approvals table for the dashboard read path. The
    // seed function self-gates on NODE_ENV (skips production + test) and is
    // idempotent (ON CONFLICT DO NOTHING). Failure is non-fatal — dashboard
    // will show an empty pending-approvals list rather than break startup.
    // PR 6 R6 (Copilot): early-return when NODE_ENV is production or test so
    // we don't pay the DI resolution + dynamic-import cost (no-op anyway).
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      try {
        const { seedFinanceCentralDemoData } = await import('./services/financeCentral/demoSeed');
        const { SYSTEM_IDENTITY } = await import('./services/governance/identityContext');
        const { FinanceCentralRepository } = await import('./services/financeCentral/FinanceCentralRepository');
        const repo = await container.getAsync<InstanceType<typeof FinanceCentralRepository>>(TYPES.FinanceCentralRepository);
        await seedFinanceCentralDemoData(repo, {
          tenantId: SYSTEM_IDENTITY.tenantId,
          logger: this.logger,
        });
      } catch (error) {
        this.logger.warn('Failed to seed FinanceCentral demo data; dashboard pending-approvals list will be empty.', { error: (error as Error).message });
      }

      // PR-OP-2 / T11 + T12: seed WorkflowCentral demo data.
      // seedWorkflowCentralDemoData (T12) seeds in-memory definitions via
      // engine.seedDemoDefinitions() AND inserts instance rows durably via
      // repo.insertInstance inside a TX (so instances survive hydration).
      // seedWorkflowCentralDemoTasks seeds the tasks the dashboard reads from
      // workflow_central_tasks. Both functions wrap per-row try/catch around
      // PK collisions (effective ON CONFLICT DO NOTHING).
      try {
        const { WorkflowEngineService } = await import('./services/workflowCentral/WorkflowEngineService');
        const { seedWorkflowCentralDemoData, seedWorkflowCentralDemoTasks } = await import('./services/workflowCentral/demoSeed');
        const { SYSTEM_IDENTITY } = await import('./services/governance/identityContext');
        const { WorkflowCentralRepository } = await import('./services/workflowCentral/WorkflowCentralRepository');
        const { DatabaseService } = await import('./database/DatabaseService');
        const engine = container.get<InstanceType<typeof WorkflowEngineService>>(TYPES.WorkflowEngineService);
        const wcRepo = await container.getAsync<InstanceType<typeof WorkflowCentralRepository>>(TYPES.WorkflowCentralRepository);
        const dbService = await container.getAsync<InstanceType<typeof DatabaseService>>(TYPES.DatabaseService);
        await seedWorkflowCentralDemoData(engine, wcRepo, dbService, {
          tenantId: SYSTEM_IDENTITY.tenantId,
          logger: this.logger,
        });
        await seedWorkflowCentralDemoTasks(wcRepo, dbService, {
          tenantId: SYSTEM_IDENTITY.tenantId,
          logger: this.logger,
        });
      } catch (error) {
        this.logger.warn('Failed to seed WorkflowCentral demo data; dashboard task list may be empty.', { error: (error as Error).message });
      }
    }

    // PR-OP-3 T11: catch-up backfill for rolling-deploy safety, then hydrate
    // the engine's instance cache from durable rows. catchUpBackfill synthesizes
    // instance rows for any orphan tasks (race-safe via INSERT OR IGNORE /
    // ON CONFLICT (id) DO NOTHING per D20). hydrate flips engine.hydrationReady
    // to true ONLY after the active-count gauge emits, so the T6 readiness gate
    // 503s workflow-central routes until both steps complete (spec §3.3, §6.2).
    // Hydration failure does NOT throw — server keeps serving other routes;
    // workflow-central stays 503 until manual recovery / restart.
    try {
      const { WorkflowCentralRepository } = await import('./services/workflowCentral/WorkflowCentralRepository');
      const { WorkflowEngineService } = await import('./services/workflowCentral/WorkflowEngineService');
      const repo = await container.getAsync<InstanceType<typeof WorkflowCentralRepository>>(TYPES.WorkflowCentralRepository);
      const engine = container.get<InstanceType<typeof WorkflowEngineService>>(TYPES.WorkflowEngineService);
      const { recovered } = await repo.catchUpBackfill();
      if (recovered > 0) this.logger.info('WorkflowCentral catch-up backfill', { recovered });
      await engine.hydrate(repo);
    } catch (error) {
      this.logger.error('WorkflowCentral hydration failed; readiness gate will 503 routes', { error: (error as Error).message });
    }

    // Initialize Help Chat system (documentation assistance)
    try {
      this.logger.info('Initializing Help Chat system...');
      await this.initializeHelpChat();
      this.logger.info('Help Chat system initialized successfully');
    } catch (error) {
      this.logger.warn('Failed to initialize Help Chat system. Help features may be disabled.', { error: (error as Error).message });
      // Non-critical, don't throw - continue server startup
    }

    // PR 10a: start the embedded retention job. Idempotent start; stopped in
    // Server.stop() before HTTP close so any in-flight tick has time to drain.
    try {
      const { EmbeddedRetentionJob } = await import('./services/embedded/EmbeddedRetentionJob');
      const job = container.get<InstanceType<typeof EmbeddedRetentionJob>>(TYPES.EmbeddedRetentionJob);
      job.start();
      this.logger.info('EmbeddedRetentionJob started');
    } catch (error) {
      this.logger.warn('Failed to start EmbeddedRetentionJob; embedded session/token retention may not run on this replica.', { error: (error as Error).message });
    }

    // PR 17a: start the Sync Error AI Assist daily job. Idempotent start; stopped in
    // Server.stop() before HTTP close so the inflight cycle drains gracefully.
    try {
      const { SyncErrorAssistDailyJob } = await import('./services/syncErrorAssist/SyncErrorAssistDailyJob');
      // Use getAsync — SyncErrorAssistRepository binding is async (depends
      // on async-bound DatabaseService). A sync .get() against an async dep
      // chain returns Promise<DailyJob> instead of the resolved instance.
      const job = await container.getAsync<InstanceType<typeof SyncErrorAssistDailyJob>>(TYPES.SyncErrorAssistDailyJob);
      job.start();
      this.logger.info('SyncErrorAssistDailyJob started');
    } catch (error) {
      this.logger.warn('Failed to start SyncErrorAssistDailyJob; Sync Error AI Assist polling may not run on this replica.', { error: (error as Error).message });
    }

    // PR-A5: reconcile SuiteCentral monitoring from persisted enablement, after
    // database readiness and before HTTP listen. INERT on existing databases —
    // no tenant has an enabled monitoring config until an administrator creates
    // one through the PR-A6 routes, so this starts zero timers today. Stopped in
    // Server.stop() before HTTP close so an in-flight probe drains. Async-bound
    // (depends on the async control-plane repository), hence getAsync.
    try {
      const { SuiteCentralMonitoringRuntime } = await import(
        './services/suitecentral/controlPlane/SuiteCentralMonitoringRuntime'
      );
      const runtime = await container.getAsync<InstanceType<typeof SuiteCentralMonitoringRuntime>>(
        TYPES.SuiteCentralMonitoringRuntime,
      );
      await runtime.start();
      this.logger.info('SuiteCentralMonitoringRuntime started');
    } catch (error) {
      this.logger.warn(
        'Failed to start SuiteCentralMonitoringRuntime; SuiteCentral environment monitoring may not run on this replica.',
        { error: (error as Error).message },
      );
    }

    // C1: ephemeral-payload retention reaper. Sweeps expired ephemeral_hosted
    // payloads on the workflow_central_tasks + workflow_central_instances
    // tables. Idempotent start; stopped in Server.stop() before HTTP close so
    // the inflight tick drains gracefully. WorkflowCentralRepository is
    // async-bound (depends on async-bound DatabaseService), so we use
    // getAsync — a sync .get() returns Promise<Job> instead of the instance.
    try {
      const { WorkflowPayloadRetentionJob } = await import('./services/workflowCentral/WorkflowPayloadRetentionJob');
      const job = await container.getAsync<InstanceType<typeof WorkflowPayloadRetentionJob>>(TYPES.WorkflowPayloadRetentionJob);
      job.start();
      this.logger.info('WorkflowPayloadRetentionJob started');
    } catch (error) {
      // `(error as Error).message` would yield `undefined` for non-Error
      // throws (string/number rejections from dynamic-import or DI
      // resolution failures), making the diagnostic useless. Stringify
      // safely so the warn log always carries something queryable.
      this.logger.warn(
        'Failed to start WorkflowPayloadRetentionJob; ephemeral workflow-payload retention may not run on this replica.',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    // PR 21: start the Cost Transparency daily rollup job. Idempotent start;
    // stopped in Server.stop() before HTTP close so the inflight tick drains.
    // Use getAsync — CostTransparencyRepository depends on async-bound
    // DatabaseService; a sync container.get() on this chain returns
    // Promise<CostTransparencyDailyJob> instead of the resolved instance
    // (feedback_inversify_getasync_for_async_bindings.md).
    try {
      const { CostTransparencyDailyJob: _CostTransparencyDailyJobClass } = await import('./services/cost/CostTransparencyDailyJob');
      const job = await container.getAsync<InstanceType<typeof _CostTransparencyDailyJobClass>>(TYPES.CostTransparencyDailyJob);
      job.start();
      this.logger.info('CostTransparencyDailyJob started');
    } catch (error) {
      this.logger.warn(
        'Failed to start CostTransparencyDailyJob; cost rollups may not run on this replica.',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    // PR 11: start the Reconciliation Center schedule job. Same async
    // resolution rules as the cost transparency job above — the repo
    // depends on async-bound DatabaseService.
    try {
      const { ReconciliationScheduleJob: _ReconciliationScheduleJobClass } = await import('./services/reconciliationCenter/ReconciliationScheduleJob');
      const job = await container.getAsync<InstanceType<typeof _ReconciliationScheduleJobClass>>(TYPES.ReconciliationScheduleJob);
      job.start();
      this.logger.info('ReconciliationScheduleJob started');
    } catch (error) {
      this.logger.warn(
        'Failed to start ReconciliationScheduleJob; reconciliation sweeps may not run on this replica.',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    // Determine CLI flags for auto-port behavior
    const args = process.argv.slice(2);
    const forceAutoPort = args.includes('--auto-port');
    const disableAutoPort = args.includes('--no-auto-port');
    if (forceAutoPort && disableAutoPort) {
      this.logger.warn('Both --auto-port and --no-auto-port specified; disabling auto-port fallback.');
    }
    const userSpecifiedPort = !!process.env.PORT;
    const selectedPort = await resolveAvailablePort(this.port, {
      forceAutoPort,
      disableAutoPort,
      userSpecifiedPort,
      logger: { info: (m: string) => this.logger.info(m), warn: (m: string) => this.logger.warn(m) },
    });

    // Attempt to bind; if EADDRINUSE occurs despite pre-checks, try subsequent ports
    const maxBindAttempts = 10;
    const bindHost = process.env.BIND_HOST || (process.env.DOCKER === '1' ? '0.0.0.0' : '127.0.0.1');

    const tryBind = async (basePort: number): Promise<{ server: http.Server; port: number }> => {
      for (let attempt = 0; attempt < maxBindAttempts; attempt++) {
        const candidateBase = basePort + attempt;
        // Re-run availability resolution starting from candidateBase to skip busy ports
        const portToTry = await resolveAvailablePort(candidateBase, {
          forceAutoPort: true,
          disableAutoPort,
          userSpecifiedPort: false,
          logger: { info: (m: string) => this.logger.info(m), warn: (m: string) => this.logger.warn(m) },
        });

        try {
          await new Promise<void>((resolve, reject) => {
            const srv = this.application.getExpressApp().listen(portToTry, bindHost, () => resolve());
            // If error happens before 'listening', reject so we can try next port
            srv.on('error', (err: unknown) => {
              try { srv.close(); } catch (_) { /* ignore */ }
              reject(err);
            });
            // On success, assign to this.server after resolve in outer scope
            this.server = srv;
          });
          return { server: this.server!, port: portToTry };
        } catch (err: unknown) {
          if (err && (err as any).code === 'EADDRINUSE') {
            this.logger.warn(`Port ${portToTry} in use at bind time, trying next...`);
            continue; // try next attempt
          }
          // Non-port error: rethrow
          throw err;
        }
      }
      throw new Error(`Failed to bind server after ${maxBindAttempts} attempts starting at port ${basePort}`);
    };

    try {
      const { port: boundPort } = await tryBind(selectedPort);

      // Prominent console output for easy port identification
      console.log('\n========================================');
      console.log(`🚀 SERVER STARTED ON PORT ${boundPort}`);
      console.log('========================================');
      console.log(`📍 Access at: http://localhost:${boundPort}`);
      console.log(`📚 API docs: http://localhost:${boundPort}/api-docs`);
      console.log('========================================\n');

      // Write port to file for dynamic discovery by tests
      try {
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(path.join(process.cwd(), '.server-port'), String(boundPort), 'utf8');
      } catch (e) {
        // ignore
      }

      const message = `Server listening on port ${boundPort}${boundPort !== this.port ? ` (fallback from ${this.port})` : ''}`;
      this.logger.info(message, { port: boundPort, originalPort: this.port, fallback: boundPort !== this.port });
      // Also log to stdout for test/automation detection
      this.logger.info('Server ready for connections', { stdout: true });
      this.logger.info(`API docs available at http://localhost:${boundPort}/api-docs`, { port: boundPort });
      return; // void
    } catch (error) {
      this.logger.error('Server error during startup:', error as Error);
      throw error;
    }
  }

  /**
   * Return the actual bound port (after any fallback) once server is listening.
   */
  public getPort(): number | undefined {
    if (!this.server) return undefined;
    const addr = this.server.address() as AddressInfo | null;
    return addr?.port;
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Integration Hub server...');

    // PR 10a: stop the embedded retention job before closing HTTP so we don't
    // strand an in-flight DB cleanup tick mid-batch.
    try {
      const { EmbeddedRetentionJob } = await import('./services/embedded/EmbeddedRetentionJob');
      if (container.isBound(TYPES.EmbeddedRetentionJob)) {
        const job = container.get<InstanceType<typeof EmbeddedRetentionJob>>(TYPES.EmbeddedRetentionJob);
        await job.stop();
      }
    } catch (e) {
      try { this.logger.warn('EmbeddedRetentionJob.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    // PR-A5: stop SuiteCentral monitoring before HTTP close — stop() awaits every
    // in-flight probe so a shutdown cannot cut one mid-authentication.
    try {
      const { SuiteCentralMonitoringRuntime } = await import(
        './services/suitecentral/controlPlane/SuiteCentralMonitoringRuntime'
      );
      if (container.isBound(TYPES.SuiteCentralMonitoringRuntime)) {
        const runtime = await container.getAsync<InstanceType<typeof SuiteCentralMonitoringRuntime>>(
          TYPES.SuiteCentralMonitoringRuntime,
        );
        await runtime.stop();
      }
    } catch (e) {
      try { this.logger.warn('SuiteCentralMonitoringRuntime.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    // PR 17a: stop the Sync Error AI Assist daily job before HTTP close — its
    // async stop awaits the inflight cycle so writes don't get cut off mid-NS-create.
    try {
      const { SyncErrorAssistDailyJob } = await import('./services/syncErrorAssist/SyncErrorAssistDailyJob');
      if (container.isBound(TYPES.SyncErrorAssistDailyJob)) {
        // Same async-resolution requirement as the start() path above.
        const job = await container.getAsync<InstanceType<typeof SyncErrorAssistDailyJob>>(TYPES.SyncErrorAssistDailyJob);
        await job.stop();
      }
    } catch (e) {
      try { this.logger.warn('SyncErrorAssistDailyJob.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    // C1: stop the workflow-payload retention reaper before HTTP close — its
    // async stop awaits the inflight tick so an in-progress sweep does not
    // get cut mid-UPDATE.
    try {
      const { WorkflowPayloadRetentionJob } = await import('./services/workflowCentral/WorkflowPayloadRetentionJob');
      if (container.isBound(TYPES.WorkflowPayloadRetentionJob)) {
        const job = await container.getAsync<InstanceType<typeof WorkflowPayloadRetentionJob>>(TYPES.WorkflowPayloadRetentionJob);
        await job.stop();
      }
    } catch (e) {
      try { this.logger.warn('WorkflowPayloadRetentionJob.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    // PR 21: stop the Cost Transparency daily rollup job before HTTP close.
    // Same async-resolution requirement as the start() path above.
    try {
      const { CostTransparencyDailyJob: _CostTransparencyDailyJobClass } = await import('./services/cost/CostTransparencyDailyJob');
      if (container.isBound(TYPES.CostTransparencyDailyJob)) {
        const job = await container.getAsync<InstanceType<typeof _CostTransparencyDailyJobClass>>(TYPES.CostTransparencyDailyJob);
        await job.stop();
      }
    } catch (e) {
      try { this.logger.warn('CostTransparencyDailyJob.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    // PR 11: stop the Reconciliation Center schedule job before HTTP close.
    try {
      const { ReconciliationScheduleJob: _ReconciliationScheduleJobClass } = await import('./services/reconciliationCenter/ReconciliationScheduleJob');
      if (container.isBound(TYPES.ReconciliationScheduleJob)) {
        const job = await container.getAsync<InstanceType<typeof _ReconciliationScheduleJobClass>>(TYPES.ReconciliationScheduleJob);
        await job.stop();
      }
    } catch (e) {
      try { this.logger.warn('ReconciliationScheduleJob.stop failed', { error: e }); } catch (_) { /* ignore */ }
    }

    if (this.server) {
      const closePromise = new Promise<void>(resolve => {
        this.server?.close(err => {
          if (err) {
            // Ignore errors if server is not running, log others
            // err.code may be 'ERR_SERVER_NOT_RUNNING'
            if (typeof (err as { code?: string }).code === 'string' && (err as { code?: string }).code === 'ERR_SERVER_NOT_RUNNING') {
              this.logger.warn('Server was not running when closing', { error: err });
            } else {
              this.logger.error('Error closing server', { error: err });
            }
            return resolve();
          }
          this.logger.info('Server closed gracefully');
          resolve();
        });
      });

      await Promise.race([
        closePromise,
        new Promise<void>(resolve => setTimeout(() => {
          this.logger.warn('Force closing server after 5s timeout');
          resolve();
        }, 5000)),
      ]);
    }

    // Ensure App-level intervals and registered cleanup hooks are executed
    try {
      await this.application.shutdown();
    } catch (e) {
      // Logger should always be available at this point, but guard just in case
      try { this.logger.warn('App.shutdown failed', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
    }

    // Shutdown advanced services if they were enabled
    if (this.enableAdvancedFeatures) {
      try {
        this.logger.info('Shutting down advanced services...');

        // Stop performance monitoring
        await PerformanceMonitor.getInstance().shutdown();

        this.logger.info('Advanced services shutdown completed');
      } catch (error) {
        this.logger.warn('Error during advanced services shutdown', { error });
      }
    }

    const authService = container.get<AuthService>(TYPES.AuthService);
    try {
      if (authService && authService.cleanup) {
        try {
          authService.cleanup();
        } catch (e) {
          try { this.logger.warn('authService.cleanup failed', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
        }
      }
    } catch (e) {
      try { this.logger.warn('Error during authService cleanup guard', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
    }

    try {
      try {
        await this.integrationService.shutdown();
      } catch (e) {
        try { this.logger.warn('integrationService.shutdown failed', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
      }
    } catch (e) {
      try { this.logger.warn('Error during integrationService shutdown guard', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
    }

    try {
      try {
        await PerformanceMonitor.getInstance().shutdown();
      } catch (e) {
        try { this.logger.warn('PerformanceMonitor.shutdown failed', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
      }
    } catch (e) {
      try { this.logger.warn('Error during PerformanceMonitor shutdown guard', { error: e }); } catch (_) { /* Already logged or logger unavailable */ }
    }

    try { this.logger.info('Integration Hub has been shut down successfully.'); } catch (_) { /* Already logged or logger unavailable */ }

    // Ensure Prometheus default metrics interval is stopped if it was started
    try {
      const stopper: undefined | (() => void) = (global as any).__promDefaultMetricsStopper;
      if (typeof stopper === 'function') {
        stopper();
        (global as any).__promDefaultMetricsStopper = undefined;
      }
    } catch (_) {
      // ignore
    }
  }

  private async loadSampleDataIfNeeded(): Promise<void> {
    const configs = this.configService.getAllConfigurations();
    if (configs.length === 0) {
      this.logger.info('No configurations found, loading sample configurations...');
      for (const config of sampleConfigurations) {
        try {
          await this.configService.saveConfiguration(config);
        } catch (error) {
          this.logger.warn(`Failed to load sample configuration ${config.id}`, { error });
        }
      }
    }
  }

  /**
   * Complete Help Chat initialization (mount routes and start indexing)
   * Phase 2B: Components are initialized in constructor; this handles async parts
   */
  private async initializeHelpChat(): Promise<void> {
    // Phase 2B: Skip if knowledgeBase wasn't initialized in constructor
    if (!this.knowledgeBase) {
      this.logger.warn('Help Chat components not available, skipping route mounting and indexing');
      return;
    }

    try {
      // Dynamic imports to avoid circular dependencies
      const { HelpChatService } = await import('./services/help/HelpChatService');
      const { createHelpRouter } = await import('./routes/help');
      const { TYPES } = await import('./inversify/types');
      const { container } = await import('./inversify/inversify.config');
      const { UnifiedTelemetryService } = await import('./services/UnifiedTelemetryService');
      const { GovernanceService } = await import('./services/ai/orchestrator/GovernanceService');

      // Get services from container (optional, may not exist)
      let telemetry: InstanceType<typeof UnifiedTelemetryService> | undefined;
      let governance: InstanceType<typeof GovernanceService> | undefined;
      let providerRegistry: unknown;
      try {
        telemetry = container.get<InstanceType<typeof UnifiedTelemetryService>>(TYPES.UnifiedTelemetryService);
      } catch {
        telemetry = undefined;
      }
      try {
        governance = container.get<InstanceType<typeof GovernanceService>>(TYPES.GovernanceService);
      } catch {
        governance = undefined;
      }
      try {
        providerRegistry = container.get(TYPES.ProviderRegistry);
      } catch {
        providerRegistry = undefined;
      }

      // Initialize help chat service (providerRegistry is optional)
      const helpChatService = new HelpChatService(
        this.knowledgeBase,
        providerRegistry as any
      );

      // Mount help routes
      const helpRouter = createHelpRouter(
        helpChatService,
        this.knowledgeBase,
        telemetry,
        governance
      );
      this.app.use('/api/help', helpRouter);

      this.logger.info('Help routes mounted at /api/help');

      // Start background indexing (non-blocking)
      this.knowledgeBase.indexDocumentation().catch((error: Error) => {
        this.logger.error('Background documentation indexing failed', { error });
      });

      this.logger.info('Documentation indexing started in background');

      // Phase 2B: Log successful AI service enhancement
      this.logger.info('AI Natural Language Service enhanced with Help Chat RAG integration', {
        context: 'Server',
        feature: 'documentation-aware-troubleshooting'
      });
    } catch (error) {
      this.logger.error('Failed to complete Help Chat initialization', { error });
      throw error;
    }
  }

  /**
     * Alias for start(), maintaining older initialize() API.
     */
  public async initialize(): Promise<void> {
    return this.start();
  }
  /**
     * Return the Express application instance.
     */
  public getExpressApp(): import('express').Application {
    return this.application.getExpressApp();
  }
  /**
     * Wait for the application to be fully initialized (routes, services, etc.)
     */
  public async waitForInitialization(): Promise<void> {
    return this.application.waitForInitialization();
  }
  /**
     * Alias for stop(), providing shutdown API.
     */
  public async shutdown(): Promise<void> {
    return this.stop();
  }
}

export const main = async () => {
  // Increase max listeners for process to prevent MaxListeners warnings
  process.setMaxListeners(20);

  const logger = container.get<Logger>(TYPES.Logger);

  // SECURITY: Production guard - prevent demo mode in production
  if (process.env.NODE_ENV === 'production' && isDemo() && !env.HOSTED_DEMO) {
    logger.error('FATAL: DEMO_MODE=1 cannot be used in production environment. This is a security risk.');
    console.error('\n========================================');
    console.error('SECURITY ERROR: DEMO_MODE is enabled in production!');
    console.error('This bypasses authentication and is a critical security risk.');
    console.error('Set HOSTED_DEMO=1 only for an intentionally gated hosted demo runtime.');
    console.error('Otherwise set DEMO_MODE=0 or remove DEMO_MODE from your environment.');
    console.error('========================================\n');
    process.exit(1);
  }

  logger.debug('[BOOT] Constructing Server...');
  let server: Server;
  try {
    server = new Server();
  } catch (err) {
    logger.error('[BOOT] Server construction failed', err);
    throw err; // propagate to outer catch
  }
  logger.debug('[BOOT] Server constructed');

  const shutdown = async (code = 0) => {
    try {
      await server.stop();
    } finally {
      process.exit(code);
    }
  };

  // Set up global error handlers with shutdown callback
  setupGlobalErrorHandlers(() => shutdown(1));

  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  // Note: Global error handlers are already set up in setupGlobalErrorHandlers()
  // called at the top of this file - no need for duplicate handlers here

  try {
    logger.info('About to start server...');
    await server.start();
    logger.info('Server started successfully!');
  } catch (error) {
    logger.error('[BOOT] server.start() failed', { error, stack: (error as Error)?.stack });
    await shutdown(1);
  }
};

// If this module is run directly, start the server
if (require.main === module || process.argv.includes('--start-server')) {
  void main();
}
// Backward compatibility: export Server class and alias IntegrationHub
export { Server, Server as IntegrationHub };

// Lightweight factory for tests to obtain an express app without binding a fixed port
export async function createApp() {
  const srv = new Server();
  // Initialize sample configs if needed without starting listener
  // (reuse private method via any cast if necessary)
  // We only need express instance; side effects handled by constructor
  return srv;
}
