import express from "express";
import fs from "fs";
import path from "path";
import type { IObservabilityService } from "./observability";
import { isDemo } from "./utils/features";
import { AdvancedSecurityMiddleware } from "./middleware/advancedSecurity";
import { ServiceFactory } from "./factories/ServiceFactory";
import { setupMiddleware, setupRoutes, type MiddlewareConfig, type RouteConfig } from "./middleware/setup";
import type { IntegrationService } from "./services/IntegrationService";
import type { ConfigurationService } from "./services/ConfigurationService";
import type { DocumentationKnowledgeBase } from "./services/help/DocumentationKnowledgeBase";
import { logger } from "./utils/Logger";

export interface AppOptions {
  // When true, mount lightweight demo/test routes only (no external services)
  // When false, leave core middleware and UI, but defer API routes to the Server
  lightweight?: boolean;
}

type SetIntervalParameters = Parameters<typeof setInterval>;
type IntervalHandler = SetIntervalParameters[0];
type IntervalTimeout = SetIntervalParameters[1];
type IntervalRestArgs = SetIntervalParameters extends [unknown, unknown, ...infer Rest] ? Rest : unknown[];
type IntervalHandle = ReturnType<typeof setInterval>;
type ClearIntervalArgument = Parameters<typeof clearInterval>[0];

export class App {
  private readonly app: express.Application;
  private cleanupFunctions: (() => void | Promise<void>)[] = [];
  private intervals: IntervalHandle[] = [];
  private configurations = new Map<string, Record<string, unknown>>();
  private readonly options: Required<AppOptions>;
  private observabilityService!: IObservabilityService; // Use definite assignment assertion
  public securityMiddleware!: AdvancedSecurityMiddleware; // Use definite assignment assertion
  private initializationPromise: Promise<void>;
  private integrationService?: IntegrationService;
  private configurationService?: ConfigurationService;
  private knowledgeBase?: DocumentationKnowledgeBase; // Phase 2B: DocumentationKnowledgeBase
  private static intervalPatchApplied = false;
  private static originalSetInterval?: typeof global.setInterval;
  private static originalClearInterval?: typeof global.clearInterval;
  private static trackedIntervals: Set<IntervalHandle> = new Set<IntervalHandle>();

  constructor(options: AppOptions = {}) {
    this.app = express();

    // Override lightweight mode for integration tests
    const forceFull = process.env.FORCE_FULL_APP_MODE === "1" || process.env.LIGHTWEIGHT_MODE === "0";
    this.options = { lightweight: forceFull ? false : (options.lightweight ?? true) };

    this.patchIntervalTrackingForTests();

    // Initialize services asynchronously and store the promise
    this.initializationPromise = this.initializeServices();
  }

  /**
   * Wait for the app to be fully initialized
   */
  async waitForInitialization(): Promise<void> {
    await this.initializationPromise;
  }

  /**
   * Inject services after app creation. MERGES partial updates — only fields
   * explicitly present in `services` overwrite the stored reference.
   *
   * Copilot R2 (PR 13b): the prior overwrite semantics caused destructive
   * interaction with the async-DI cascade introduced by PR 13b Stage A3 —
   * `start()` resolves IntegrationService via `container.getAsync()` and then
   * calls `injectServices({integrationService})`, which under the old
   * semantics nulled out the previously-injected `configurationService` and
   * `knowledgeBase`. Merge semantics preserve sync-injected services across
   * subsequent partial injections.
   */
  injectServices(services: {
    integrationService?: IntegrationService;
    configurationService?: ConfigurationService;
    knowledgeBase?: DocumentationKnowledgeBase; // Phase 2B: DocumentationKnowledgeBase
  }): void {
    if (services.integrationService !== undefined) {
      this.integrationService = services.integrationService;
    }
    if (services.configurationService !== undefined) {
      this.configurationService = services.configurationService;
    }
    if (services.knowledgeBase !== undefined) {
      this.knowledgeBase = services.knowledgeBase;
    }
  }

  private async initializeServices(): Promise<void> {
    // Initialize observability service with proper typing
    const observabilityService = await ServiceFactory.createObservabilityService();

    this.observabilityService = observabilityService
      ?? await ServiceFactory.createDemoObservabilityAdapter();

    this.addCleanupFunction(() => this.observabilityService.shutdown());

    // Initialize security middleware with static import
    this.securityMiddleware = new AdvancedSecurityMiddleware();
    this.addCleanupFunction(() => this.securityMiddleware.cleanup());

    // Setup middleware using the new modular approach
    const middlewareConfig: MiddlewareConfig = {
      enableCors: true,
      enableHelmet: true,
      enableCompression: true,
      enableRateLimit: !this.options.lightweight,
    };
    await setupMiddleware(this.app, middlewareConfig);

    // Setup routes using the new modular approach
    const routeConfig: RouteConfig = {
      enableAIServices: true,
      enableAIProvider: true, // deprecated (PR 1B) — no longer consumed
      enableMappings: true,
      enableMappingTemplates: true,
      enableDocs: true,
      enableMetrics: true,
      enableSwagger: true,
      enableSuiteCentralSync: true,
      enableConfiguration: true,
      enableIntegration: true,
      enableFileUpload: true,
      enableTesting: true,
      enableDownloadMaterials: isDemo(),
      enableAIDemo: true,
      enableAIMapping: true,
      enableDataMigration: true,
      enableROIDashboard: true,
      enableFullPipelineDemo: true,
      enableOperationalDashboard: true,
    };
    await setupRoutes(this.app, routeConfig, {
      integrationService: this.integrationService,
      configurationService: this.configurationService,
      knowledgeBase: this.knowledgeBase, // Phase 2B: Help Chat RAG
    });

    // Informative warning if CSP is enabled but vendor assets are missing
    await this.checkVendorAssets();
  }

  private async checkVendorAssets(): Promise<void> {
    try {
      const disableCsp = process.env.DEMO_DISABLE_CSP === "1" || isDemo();
      const vendorDir = path.join(__dirname, "../public/vendor");
      const need = ["chart.umd.min.js", "alpine.3.14.9.min.js", "fontawesome-6.0.0.min.css"];

      // Use async file access for better performance
      const missing = [];
      for (const file of need) {
        try {
          await fs.promises.access(path.join(vendorDir, file));
        } catch {
          missing.push(file);
        }
      }

      if (!disableCsp && missing.length > 0) {
        // Make vendor asset warning more visible with formatting
        logger.warn("\n" + "=".repeat(60));
        logger.warn("⚠️  VENDOR ASSETS WARNING");
        logger.warn("=".repeat(60));
        logger.warn("CSP is enabled but vendor assets are missing:");
        missing.forEach(file => logger.warn(`  ❌ ${file}`));
        logger.warn("\n📄 Pages will fallback to CDN, which may be blocked by CSP.");
        logger.warn("\n🔧 To fix this, either:");
        logger.warn("   1. Set DEMO_DISABLE_CSP=1 in environment");
        logger.warn("   2. Install and build vendor assets:");
        logger.warn("      npm i -D chart.js@4.4.1 alpinejs@3.14.9 @fortawesome/fontawesome-free@6");
        logger.warn("      npm run vendor:build");
        logger.warn("=".repeat(60) + "\n");
      } else if (!disableCsp && missing.length === 0) {
        logger.info("✅ All vendor assets found - CSP will work properly");
      }
    } catch (error) {
      logger.warn("⚠️  Could not check vendor assets", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  public getExpressApp(): express.Application {
    return this.app;
  }

  public async shutdown(): Promise<void> {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.length = 0;

    await Promise.all(
      this.cleanupFunctions.map(async cleanup => {
        try {
          await cleanup();
        } catch (error) {
          logger.error("Error during cleanup:", error);
        }
      }),
    );
    this.cleanupFunctions.length = 0;

    if ((global as Record<string, unknown>).gc) {
      ((global as Record<string, unknown>).gc as () => void)();
    }

    if (App.intervalPatchApplied && App.originalSetInterval && App.originalClearInterval) {
      for (const timer of App.trackedIntervals) {
        try {
          App.originalClearInterval(timer);
        } catch {
          // ignore cleanup errors
        }
      }
      App.trackedIntervals.clear();
    }
  }

  public addCleanupFunction(cleanup: () => void | Promise<void>): void {
    this.cleanupFunctions.push(cleanup);
  }

  public registerInterval(interval: IntervalHandle): void {
    this.intervals.push(interval);
  }

  private patchIntervalTrackingForTests(): void {
    if (App.intervalPatchApplied) {
      return;
    }

    const inTest = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === "test";
    if (!inTest) {
      return;
    }

    const globalObj = global as typeof globalThis;
    App.originalSetInterval = globalObj.setInterval.bind(globalObj);
    App.originalClearInterval = globalObj.clearInterval.bind(globalObj);

    globalObj.setInterval = ((handler: IntervalHandler, timeout?: IntervalTimeout, ...args: IntervalRestArgs) => {
      const effectiveTimeout = timeout ?? 0;
      if (!App.originalSetInterval) {
        const fallbackTimer = setInterval(handler, effectiveTimeout, ...args);
        App.trackedIntervals.add(fallbackTimer);
        return fallbackTimer;
      }

      const timer = App.originalSetInterval(handler, effectiveTimeout, ...args);
      App.trackedIntervals.add(timer);
      return timer;
    }) as typeof global.setInterval;

    globalObj.clearInterval = ((timer: ClearIntervalArgument) => {
      const handle = timer as IntervalHandle;
      if (App.trackedIntervals.has(handle)) {
        App.trackedIntervals.delete(handle);
      }
      App.originalClearInterval?.(timer);
    }) as typeof global.clearInterval;

    App.intervalPatchApplied = true;

    this.addCleanupFunction(() => {
      if (App.originalClearInterval) {
        for (const tracked of App.trackedIntervals) {
          try {
            App.originalClearInterval(tracked);
          } catch {
            // ignore cleanup errors
          }
        }
      }
      App.trackedIntervals.clear();

      if (App.originalSetInterval) {
        globalObj.setInterval = App.originalSetInterval;
      }
      if (App.originalClearInterval) {
        globalObj.clearInterval = App.originalClearInterval;
      }

      App.intervalPatchApplied = false;
      App.originalSetInterval = undefined;
      App.originalClearInterval = undefined;
    });
  }
}
