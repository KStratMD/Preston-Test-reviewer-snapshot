import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { env } from '../../config';
import { isDemo } from '../../utils/features';
import { createApiCompressionMiddleware, createStaticCompressionMiddleware } from '../compression';
import { apiVersionMiddleware } from '../apiVersion';
import { createSanitizationMiddleware } from '../sanitization';
import { skipEmbeddedHtml } from '../embeddedHtmlRoutes';
import { resolvePublicDir } from './publicDir';
import { logger } from '../../utils/Logger';
import type { Logger } from '../../utils/Logger';
import type { SyncErrorAssistMetrics } from '../../services/syncErrorAssist/SyncErrorAssistMetrics';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';

// ---------------------------------------------------------------------------
// PR 17c Task 11 Step 0 — IP-limiter module state + reset seams (R21-1 /
// R24-6 / R25-4). The lazy IP-limiter for the sync-error-assist webhook
// ingest endpoint lives at module scope. The `createIpPreAuthLimiter()`
// factory + `getIpPreAuthDeps()` consumer + delegator middleware (Task 11
// Step 3) ADD to this state — they do NOT re-declare it.
// ---------------------------------------------------------------------------

let activeIpPreAuthLimiter: RateLimitRequestHandler | null = null;
let ipPreAuthDepsPromise: Promise<{ metrics: SyncErrorAssistMetrics; logger: Logger }> | null = null;

/**
 * Test-only seam: drops the cached limiter dep promise so the next request
 * re-resolves Logger/Metrics from the (test-controlled) Inversify container
 * snapshot.
 */
export function resetIpPreAuthLimiterDepsForTest(): void {
  ipPreAuthDepsPromise = null;
}

/**
 * Test-only seam: nulls the limiter so the next request through the
 * delegator (Step 3) lazily creates a FRESH limiter with a clean per-IP
 * counter Map.
 */
export function resetIpPreAuthLimiterForTest(): void {
  activeIpPreAuthLimiter = null;
}

// ---------------------------------------------------------------------------
// PR 17c Task 11 Step 3 — lazy-cache helpers + IP limiter factory + delegator
// (R7-4 + R8-1 + R15-3 + R18-4 + R25-4)
// ---------------------------------------------------------------------------

// R7-4 + R8-1 — cache metrics + logger references once. Clear cache on rejection so a
// transient DI failure doesn't poison the cache forever.
async function getIpPreAuthDeps(): Promise<{ metrics: SyncErrorAssistMetrics; logger: Logger }> {
  if (!ipPreAuthDepsPromise) {
    const pending = (async () => {
      const [metrics, l] = await Promise.all([
        container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics),
        container.getAsync<Logger>(TYPES.Logger),
      ]);
      return { metrics, logger: l };
    })();
    pending.catch(() => {
      if (ipPreAuthDepsPromise === pending) ipPreAuthDepsPromise = null;
    });
    ipPreAuthDepsPromise = pending;
  }
  return ipPreAuthDepsPromise;
}

function createIpPreAuthLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // R19-2 deferred — express-rate-limit major bump (7.5.1 → 8.x) owed by follow-up PR.
    // 8.x exports `ipKeyGenerator` for IPv6 /64 prefix masking; until then the default
    // (req.ip) matches all other production limiters in this repo (no other consumers use
    // ipKeyGenerator yet).
    // R6-2 / spec §3.7 + §7.1 — pre-auth IP rate-limited rejection emits validation_failed
    // metric (tenantId='unknown', reason='rate_limited') AND the canonical warn log.
    // R7-4 — uses cached DI deps to avoid per-call container lookups.
    handler: async (req, res) => {
      // R18-4 — Mint a correlationId here (the route handler hasn't run yet, so res.locals
      // doesn't have one). Spec §7.1 requires every "webhook validation failed" warn to carry
      // `correlationId, reason, tenantId`. Stash on res.locals for any downstream observer.
      const correlationId = randomUUID();
      res.locals.syncErrorAssistCorrelationId = correlationId;
      try {
        const { metrics: m, logger: l } = await getIpPreAuthDeps();
        m.recordWebhookValidationFailed('unknown', 'rate_limited');
        l.warn('webhook validation failed', { correlationId, reason: 'rate_limited', tenantId: 'unknown', ip: req.ip ?? 'unknown' });
      } catch {
        // ignore — the 429 response still goes out below
      }
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });
}

// R15-3 — Delegator middleware mounted by setupBasicMiddleware. Lazily creates the limiter on
// first request — so `resetIpPreAuthLimiterForTest()` (Step 0) can null the active instance
// and force a fresh-counter limiter on the next request, without re-mounting the chain.
export const ipPreAuthLimiter: import('express').RequestHandler = (req, res, next) => {
  activeIpPreAuthLimiter ??= createIpPreAuthLimiter();
  return activeIpPreAuthLimiter(req, res, next);
};

/**
 * Configuration options for middleware setup
 */
export interface MiddlewareConfig {
  enableCors?: boolean;
  enableHelmet?: boolean;
  enableCompression?: boolean;
  enableRateLimit?: boolean;
  corsOptions?: unknown;
  helmetOptions?: unknown;
  compressionOptions?: unknown;
  rateLimitOptions?: {
    windowMs?: number;
    maxRequests?: number;
    skipPaths?: string[];
  };
}

/**
 * Default middleware configuration
 */
/**
 * SECURITY: Environment-aware CORS configuration
 * - Production: Requires explicit ALLOWED_ORIGINS or defaults to same-origin only
 * - Hosted Demo: Merges ALLOWED_ORIGINS with safe hosted defaults
 * - Development: Allows all origins for easier local development
 */
const isHostedDemo = () => env.HOSTED_DEMO;

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

const parseAllowedOrigins = (): string[] => (
  process.env.ALLOWED_ORIGINS?.split(',').map((origin) => normalizeOrigin(origin)).filter(Boolean) ?? []
);

const hostedDemoDefaultOrigins = (): string[] => {
  const defaults = [
    'https://demo.kstratmdconsulting.com',
    process.env.HOSTED_DEMO_ORIGIN ?? '',
  ];
  return defaults.map((origin) => normalizeOrigin(origin)).filter(Boolean);
};

const applyStaticNoCacheHeaders = (res: Response): void => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

const resolveWikiExportFallback = (staticPath: string, requestPath: string): string | null => {
  const normalizedRequestPath = path.posix.normalize(requestPath);
  const isWikiPath = normalizedRequestPath === '/wiki' || normalizedRequestPath.startsWith('/wiki/');
  if (!isWikiPath || path.posix.extname(normalizedRequestPath)) return null;

  const relativePath = normalizedRequestPath.replace(/^\/+/, '');
  const htmlCandidate = path.join(staticPath, `${relativePath}.html`);
  if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) {
    return htmlCandidate;
  }

  const indexCandidate = path.join(staticPath, relativePath, 'index.html');
  if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
    return indexCandidate;
  }

  return null;
};

const getCorsOptions = () => {
  if (process.env.NODE_ENV === 'production' || isHostedDemo()) {
    const allowedOrigins = new Set(parseAllowedOrigins());
    if (isHostedDemo()) {
      hostedDemoDefaultOrigins().forEach((origin) => allowedOrigins.add(origin));
    }

    if (allowedOrigins.size === 0) {
      logger.warn('SECURITY: No ALLOWED_ORIGINS configured for production/hosted demo. CORS will only allow same-origin requests.');
      return { origin: false, credentials: true };
    }

    const allowAll = allowedOrigins.has('*');
    const allowPagesPreview = isHostedDemo();
    const originValidator = (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      const normalized = normalizeOrigin(requestOrigin);
      if (allowAll || allowedOrigins.has(normalized)) {
        callback(null, true);
        return;
      }
      if (allowPagesPreview && normalized.endsWith('.pages.dev')) {
        callback(null, true);
        return;
      }
      callback(null, false);
    };

    return {
      origin: originValidator,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    };
  }
  // Development/test: allow all origins
  return { origin: true, credentials: true };
};

/**
 * SECURITY: Environment-aware CSP configuration
 * - Production: Stricter CSP (unsafe-inline only for styles due to Alpine.js requirements)
 * - Development: Permissive CSP for easier debugging
 */
const getCspDirectives = () => {
  const isProduction = process.env.NODE_ENV === 'production';

  // Get allowed frame ancestors from env or use defaults
  // Include both *.businesscentral.dynamics.com and *.bc.dynamics.com as requested
  const allowedAncestors = process.env.ALLOWED_FRAME_ANCESTORS
    ? process.env.ALLOWED_FRAME_ANCESTORS.split(',').map(d => d.trim())
    : [
      "'self'",
      'https://*.netsuite.com',
      'https://*.app.netsuite.com',
      'https://*.businesscentral.dynamics.com',
      'https://*.bc.dynamics.com'
    ];

  if (isProduction) {
    // Production: More restrictive CSP with explicit trusted CDN domains
    //
    // SECURITY NOTE on 'unsafe-eval' (Accepted Risk - Admin-Only Dashboards):
    // Alpine.js requires 'unsafe-eval' when using x-data with JavaScript expressions that need
    // runtime evaluation (e.g., x-data="{ count: 0, increment() { this.count++ } }").
    // Alpine's reactivity system uses Function() constructor to evaluate these expressions.
    //
    // Risk Assessment:
    // - Impact: Medium - XSS could execute arbitrary code via eval()
    // - Likelihood: Low - All HTML dashboards are admin-only internal tools, not public-facing
    // - Mitigations: Input sanitization, auth required, CSP restricts script sources to trusted CDNs
    //
    // To remove 'unsafe-eval' in future:
    // 1. Use Alpine's CSP build (alpinejs/csp) which pre-compiles expressions
    // 2. Move all JavaScript logic to separate .js files and use x-data with object references
    // See: https://alpinejs.dev/advanced/csp
    //
    // Decision: Accept risk for now given admin-only context and multiple compensating controls
    return {
      defaultSrc: ["'self'"],
      // SECURITY: Restrict script sources to specific trusted CDNs instead of all HTTPS
      scriptSrc: [
        "'self'",
        'cdnjs.cloudflare.com',
        'cdn.jsdelivr.net',
        'unpkg.com',
        "'unsafe-eval'", // Required for Alpine.js - see note above
      ],
      // SECURITY: Restrict style sources to specific trusted CDNs
      styleSrc: [
        "'self'",
        'cdnjs.cloudflare.com',
        'cdn.jsdelivr.net',
        'fonts.googleapis.com',
        "'unsafe-inline'", // Required for inline styles
      ],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'], // No http: in production
      fontSrc: ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: allowedAncestors,
      upgradeInsecureRequests: [] as string[], // Upgrade HTTP to HTTPS
    };
  }

  // Development: More permissive for debugging
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https:', "'unsafe-inline'", "'unsafe-eval'"],
    styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'https:', 'http:'],
    fontSrc: ["'self'", 'https:', 'data:'],
    objectSrc: ["'none'"],
    frameAncestors: allowedAncestors,
  };
};

const DEFAULT_CONFIG: Required<MiddlewareConfig> = {
  enableCors: true,
  enableHelmet: true,
  enableCompression: true,
  enableRateLimit: !isDemo() || isHostedDemo(),
  corsOptions: getCorsOptions(),
  helmetOptions: {
    contentSecurityPolicy: process.env.DEMO_DISABLE_CSP === '1' || isDemo()
      ? false
      : {
        useDefaults: true,
        directives: getCspDirectives(),
      },
  },
  compressionOptions: {},
  rateLimitOptions: {
    windowMs: isHostedDemo()
      ? 60 * 1000
      : env.NODE_ENV === 'test' ? env.TEST_RATE_LIMIT_WINDOW_MS : env.RATE_LIMIT_WINDOW_MS,
    maxRequests: isHostedDemo()
      ? 100
      : env.NODE_ENV === 'test' ? env.TEST_RATE_LIMIT_MAX_REQUESTS : env.RATE_LIMIT_MAX_REQUESTS,
    skipPaths: [
      '/',
      '/index.html',
      '/executive/executive-hub.html',
      '/metrics.html',
      '/system-status.html',
      '/favicon.ico',
      '/health',
      '/metrics',
    ],
  },
};

/**
 * Core middleware setup class
 */
export class MiddlewareSetup {
  private app: Application;
  private config: Required<MiddlewareConfig>;

  constructor(app: Application, config: MiddlewareConfig = {}) {
    this.app = app;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Setup all middleware in the correct order
   */
  async setupAll(): Promise<void> {
    await this.setupCors();
    this.setupBasicMiddleware();
    this.setupStaticFiles();
    this.setupDocumentationRedirects();
    await this.setupSecurity();
    await this.setupCompression();
    await this.setupRateLimit();
    await this.setupRateLimitHeaders();
  }

  /**
   * Setup CORS middleware
   */
  private async setupCors(): Promise<void> {
    if (!this.config.enableCors) return;

    try {
      const { default: cors } = await import('cors');
      this.app.use(cors(this.config.corsOptions));
    } catch (error) {
      logger.warn('[middleware] CORS not available, skipping');
    }
  }

  /**
   * Setup basic Express middleware
   */
  private setupBasicMiddleware(): void {
    // Add compression middleware
    this.app.use(createApiCompressionMiddleware());

    // Add API versioning middleware
    this.app.use('/api', apiVersionMiddleware);

    // Add input sanitization middleware
    // NOTE: SQL injection prevention relies on Kysely ORM's parameterized queries, not input sanitization
    this.app.use(createSanitizationMiddleware({
      preventXss: true,
      trimWhitespace: true,
      // Allow larger payloads so governance rules (e.g., 1MB size limit) can evaluate correctly
      maxLength: 5_000_000
    }));

    // R3-17 + R9-2 — IP rate limiter MUST mount BEFORE express.raw, and the WHOLE chain
    // MUST mount BEFORE the global express.json parser so the raw buffer is preserved for
    // HMAC verification. Express body-parser order: first parser that handles content-type
    // wins; a later express.json would NOT overwrite a buffer already set by express.raw.
    this.app.use(
      '/api/sync-error-assist/ingest',
      ipPreAuthLimiter,
      express.raw({ type: 'application/json', limit: '256kb' }),
    );

    // Basic Express middleware with increased limits so governance can evaluate large payloads
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  }

  /**
   * Setup static file serving
   */
  private setupStaticFiles(): void {
    // Static file options - disable caching in development/Docker
    const staticOptions = {
      etag: false, // Disable ETags to prevent caching
      lastModified: false, // Disable Last-Modified to prevent caching
      maxAge: 0, // No caching
      immutable: false
    };

    // Serve static files
    // Serve static files
    // Use process.cwd() to verify we are serving from the project root (volume mount in Docker)
    // rather than relative to __dirname (which might be in dist/ and contain stale build artifacts)
    const staticPath = resolvePublicDir();
    logger.debug(`[MiddlewareSetup] __dirname: ${__dirname}`);
    logger.debug(`[MiddlewareSetup] process.cwd(): ${process.cwd()}`);
    logger.debug(`[MiddlewareSetup] Resolved Static Path: ${staticPath}`);
    logger.debug(`[MiddlewareSetup] Static Path exists: ${fs.existsSync(staticPath)}`);

    if (fs.existsSync(path.join(staticPath, 'index.html'))) {
      const stat = fs.statSync(path.join(staticPath, 'index.html'));
      logger.debug(`[MiddlewareSetup] index.html found. Size: ${stat.size} bytes. Mtime: ${stat.mtime}`);
    } else {
      logger.warn(`[MiddlewareSetup] index.html NOT found in ${staticPath}`);
    }

    this.app.use('/public', express.static(staticPath, staticOptions));
    this.app.use('/vendor', express.static(path.join(staticPath, 'vendor'), staticOptions));
    this.app.use('/webfonts', express.static(path.join(staticPath, 'webfonts'), staticOptions));
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (!(req.method === 'GET' || req.method === 'HEAD')) return next();

      const fallbackPath = resolveWikiExportFallback(staticPath, req.path);
      if (!fallbackPath) return next();

      applyStaticNoCacheHeaders(res);
      res.sendFile(fallbackPath, {
        etag: false,
        lastModified: false,
        maxAge: 0,
      }, (error) => {
        if (error) next(error);
      });
    });

    // Serve JavaScript files directly from root for backwards compatibility.
    // Wrapped in skipEmbeddedHtml so GET/HEAD requests for CSP-routed embedded
    // pages fall through to the route handlers in RouteSetup (which attach the
    // frame-ancestors header) rather than being served as raw static files without
    // it. See src/middleware/embeddedHtmlRoutes.ts for the allowlist.
    this.app.use(skipEmbeddedHtml(express.static(staticPath, {
      ...staticOptions,
      index: false, // Don't serve index.html from root
      setHeaders: (res, filePath) => {
        // Force no-cache headers for all static files (especially important for Docker)
        applyStaticNoCacheHeaders(res);

        // Ensure correct content type for JavaScript files
        if (filePath.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      }
    })));

    // Apply compression to static files
    this.app.use('/public', createStaticCompressionMiddleware());
    this.app.use('/vendor', createStaticCompressionMiddleware());
    this.app.use('/webfonts', createStaticCompressionMiddleware());
  }

  /**
   * Setup documentation redirects
   */
  private setupDocumentationRedirects(): void {
    // Explicit high-priority redirects for common top-level docs
    this.app.get(
      [
        '/README.md',
        '/GETTING-STARTED.md',
        '/API-REFERENCE.md',
        '/AGENTS.md',
        '/DEPLOYMENT.md',
        '/DEMO-GUIDE.md',
        '/CLAUDE.md',
        '/ARCHITECTURE.md',
        '/DOCKER-PARITY.md',
        '/PROJECT-README.md',
        '/SuiteCentral_Evolved_The_Integration_Advantage.md',
        '/SQUIRE_BUSINESS_CASE.md',
      ],
      (req, res) => {
        const target = req.path.replace(/^\//, '');
        const querySuffix = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        if (process.env.BOOT_DEBUG === '1') {
          logger.debug('Redirecting explicit root markdown to docs', {
            source: req.path,
            target: `/docs/${target}${querySuffix}`
          });
        }
        res.redirect(301, `/docs/${target}${querySuffix}`);
      },
    );

    // Generic markdown redirect handler
    this.app.use((req, res, next) => {
      if (!(req.method === 'GET' || req.method === 'HEAD')) return next();
      const m = /^\/([^/]+\.md)$/i.exec(req.path);
      if (!m) return next();
      const file = m[1];
      if (!file) return next();
      const lower = file.toLowerCase();
      if (['api-docs.json', 'swagger.json'].includes(lower)) return next();

      const alwaysAllowed = [
        'readme.md',
        'getting-started.md',
        'api-reference.md',
        'squire_internal_business_case.md',
        'squire_revenue_model_analysis.md',
        'squire_competitive_strategy.md',
        'squire_value_proposition.md',
        'improvements_summary.md',
      ];

      if (!alwaysAllowed.includes(lower)) {
        const candidates = [
          path.join(__dirname, '../../../../', file), // Root directory
          path.join(__dirname, '../../../', file),
          path.join(__dirname, '../../../public', file),
          path.join(__dirname, '../../../docs', file),
          path.join(__dirname, '../../../../docs', file),
        ].filter(candidate => candidate);

        if (!candidates.some(p => fs.existsSync(p))) return next();
      }

      const querySuffix = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      if (process.env.BOOT_DEBUG === '1') {
        logger.debug('Redirecting generic root markdown to docs', {
          source: req.path,
          target: `/docs/${file}${querySuffix}`
        });
      }
      return res.redirect(301, `/docs/${file}${querySuffix}`);
    });
  }

  /**
   * Setup security middleware (Helmet)
   */
  private async setupSecurity(): Promise<void> {
    if (!this.config.enableHelmet) return;

    try {
      const helmetModule = await import('helmet');
      const helmet = (helmetModule as any).default || helmetModule;
      this.app.use(helmet(this.config.helmetOptions));
    } catch (error) {
      logger.warn('[middleware] Helmet not available, skipping security headers');
    }
  }

  /**
   * Setup compression middleware
   */
  private async setupCompression(): Promise<void> {
    if (!this.config.enableCompression) return;

    try {
      const compressionModule = await import('compression');
      const compression = (compressionModule as any).default || compressionModule;
      this.app.use(compression(this.config.compressionOptions));
    } catch (error) {
      logger.warn('[middleware] Compression not available, skipping');
    }
  }

  /**
   * Setup rate limiting middleware
   */
  private async setupRateLimit(): Promise<void> {
    const hostedDemoEnforcedRateLimit = env.HOSTED_DEMO;
    if (!this.config.enableRateLimit || (!env.RATE_LIMIT_ENABLED && !hostedDemoEnforcedRateLimit)) return;

    if (hostedDemoEnforcedRateLimit && !env.RATE_LIMIT_ENABLED) {
      logger.warn('[middleware] RATE_LIMIT_ENABLED=false ignored because HOSTED_DEMO=true');
    }

    try {
      const rateLimitModule = await import('express-rate-limit');
      const rateLimit = (rateLimitModule as any).default || rateLimitModule;
      const limiter = rateLimit({
        windowMs: this.config.rateLimitOptions.windowMs,
        max: this.config.rateLimitOptions.maxRequests,
        standardHeaders: true,
        legacyHeaders: true,
      });

      this.app.use((req, res, next) => {
        if (isDemo() && !env.HOSTED_DEMO) return next();

        // Check if path should be skipped
        const skipPaths = [...(this.config.rateLimitOptions?.skipPaths || [])];
        if (!env.HOSTED_DEMO) {
          skipPaths.push(
            '/api/dashboard',
            '/api/suitecentral',
            '/api/integrations',
            '/api/ai',
            '/api/ai-demo',
          );
        }
        skipPaths.push('/vendor', '/webfonts', '/docs', '/postman', '/public');

        const shouldSkip = skipPaths.some(skipPath =>
          req.path === skipPath || req.path.startsWith(skipPath)
        );

        if (shouldSkip) {
          return next();
        }

        return limiter(req, res, next);
      });
    } catch (error) {
      logger.warn('[middleware] Rate limiting not available, skipping');
    }
  }

  /**
   * Setup rate limit headers
   */
  private async setupRateLimitHeaders(): Promise<void> {
    try {
      const { apiRateLimitHeaders } = await import('../rateLimitHeaders');
      this.app.use(apiRateLimitHeaders);
    } catch (error) {
      logger.warn('[middleware] Rate limit headers not available, skipping');
    }
  }
}

/**
 * Convenience function to setup all middleware
 */
export async function setupMiddleware(
  app: Application,
  config: MiddlewareConfig = {}
): Promise<void> {
  const middlewareSetup = new MiddlewareSetup(app, config);
  await middlewareSetup.setupAll();
}

export default MiddlewareSetup;
