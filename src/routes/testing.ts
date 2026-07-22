import * as express from 'express';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { sendError } from '../utils/errorResponse';
import { asyncHandler } from '../middleware/asyncHandler';
import { authMiddleware } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/verifiedAdmin';
import { createTestingRunRateLimit, createMcpSchemaRateLimit } from '../middleware/rateLimit';
import { logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { NetSuiteMCPSchemaAdapter } from '../services/netsuite/mcp/NetSuiteMCPSchemaAdapter';
import { isNetSuiteMCPSchemaEnabled } from '../config/runtimeFlags';

const MAX_TEST_NAME_PATTERN_LENGTH = 256;
const MAX_LOG_VALUE_LENGTH = 80;
// Per-stream capture cap. Jest prints its summary last, so keeping the TAIL
// preserves everything the result parser and the 2000-char response excerpt
// read while bounding memory for verbose runs (repo-review RVW-001).
const MAX_CAPTURED_OUTPUT = 1024 * 1024;

function appendCapped(existing: string, chunk: Buffer): string {
  const text = chunk.toString();
  // Never build a string larger than the cap: an oversized chunk keeps only
  // its own tail, and `existing` is pre-trimmed to the remaining room before
  // concatenation (Copilot R3 — the naive concat-then-slice allocated up to
  // existing+chunk bytes transiently).
  if (text.length >= MAX_CAPTURED_OUTPUT) {
    return text.slice(text.length - MAX_CAPTURED_OUTPUT);
  }
  const room = MAX_CAPTURED_OUTPUT - text.length;
  const head = existing.length > room ? existing.slice(existing.length - room) : existing;
  return head + text;
}

// Kill the child's whole tree, not just the direct process: the runner spawns
// npm/npx wrappers whose jest grandchildren survive a plain child.kill(). On
// POSIX the child is spawned detached (its own process group) so -pid signals
// the group; on Windows SIGKILL escalates to taskkill /T /F. Children without
// a pid (spawn failed, or unit-test doubles) fall back to child.kill(signal).
function killChildTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) {
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      try {
        // spawn() failures surface as an async 'error' event, not a throw —
        // without this listener a missing taskkill would be an uncaught
        // exception AND would silently skip the plain-kill fallback.
        const treeKill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
        treeKill.on('error', () => {
          try { child.kill(signal); } catch { /* already gone */ }
        });
        // taskkill can also start fine but FAIL (non-zero exit: access denied
        // etc.) — fall back to a plain kill then too (Copilot R5).
        treeKill.on('close', (code) => {
          if (code !== 0) {
            try { child.kill(signal); } catch { /* already gone */ }
          }
        });
        return;
      } catch { /* fall through to plain kill */ }
    }
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Ownership handle for the single-run concurrency slot: the middleware owns
// release until a child is spawned, then the child's exit owns it (RVW-001 —
// releasing on response close let an aborted request free the slot while its
// child was still running, allowing a second concurrent run).
interface RunSlot {
  spawned: boolean;
  /** Set when the response closed before any child was spawned (client abort
   *  in the pre-spawn window) — the handler must not spawn after this. */
  releasedBeforeSpawn: boolean;
  release: () => void;
}

function sanitizeLogValue(value: unknown): string {
  const text = String(value ?? '');
  const sanitized = text.replace(/[\0\r\n\t]/g, ' ');

  if (sanitized.length <= MAX_LOG_VALUE_LENGTH) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_LOG_VALUE_LENGTH)}...(${sanitized.length} chars)`;
}

function resolveSpawnCommand(command: string): string {
  if (process.platform !== 'win32') {
    return command;
  }

  if (command === 'npm' || command === 'npx') {
    return `${command}.cmd`;
  }

  return command;
}

export function createTestingRouter(
  deps?: {
    runRateLimit?: express.RequestHandler;
    mcpSchemaRateLimit?: express.RequestHandler;
    /** SIGTERM→SIGKILL escalation delay; injectable so tests don't wait 5s. */
    killEscalationMs?: number;
  },
): express.Router {
  const router = express.Router();
  const runRateLimit = deps?.runRateLimit ?? createTestingRunRateLimit();
  const mcpSchemaRateLimit = deps?.mcpSchemaRateLimit ?? createMcpSchemaRateLimit();
  const killEscalationMs = deps?.killEscalationMs ?? 5000;

  // At most one test run at a time per router instance (production mounts
  // exactly one, so this is process-wide there). Slot ownership (RVW-001):
  // until a child is spawned the response's 'finish'/'close' releases it
  // (covers the handler's early 400s and other pre-spawn exits);
  // once a child exists, ONLY the child's exit releases it — an aborted
  // request must not free the slot while its child is still running, or a
  // second concurrent run becomes possible. Releasing is idempotent.
  let runActive = false;
  const acquireRunSlot: express.RequestHandler = (_req, res, next) => {
    if (runActive) {
      res.status(429).json({
        success: false,
        error: 'A test run is already in progress. Retry after it completes.',
      });
      return;
    }
    runActive = true;
    // Ownership-aware, idempotent release: each slot may free the shared
    // runActive flag at most once. Without the guard, a stale closure (e.g. a
    // late event from a previous run's child) could release a slot a NEWER
    // run now owns, reopening the concurrent-run window.
    let released = false;
    const slot: RunSlot = {
      spawned: false,
      releasedBeforeSpawn: false,
      release: () => {
        if (released) return;
        released = true;
        runActive = false;
      },
    };
    res.locals.runSlot = slot;
    const releaseIfNotSpawned = () => {
      if (!slot.spawned) {
        slot.releasedBeforeSpawn = true;
        slot.release();
      }
    };
    res.once('finish', releaseIfNotSpawned);
    res.once('close', releaseIfNotSpawned);
    next();
  };

  // Run the test suite and return results.
  //
  // PR-C: spawning the repo's test tooling is a platform-operator action, so
  // the route carries its own auth chain — authMiddleware (401 for anonymous)
  // then requirePlatformAdmin (403 for non-admins) — instead of relying on the
  // anonymous /api/testing mount, which must stay open for POST /mcp-schema
  // (consumed by public/js/ai-config-dashboard.js). The dedicated limiter and
  // concurrency slot sit after auth so anonymous traffic cannot consume them.
  router.post('/run', authMiddleware, requirePlatformAdmin, runRateLimit, acquireRunSlot, asyncHandler(async (req: express.Request, res: express.Response) => {
    logger.info('Starting test execution via API...');

    const { suite } = req.body;
    const rawTestNamePattern = req.body.testNamePattern ?? req.body.testFile;
    logger.info(
      `Test suite requested: ${sanitizeLogValue(suite)}, test name pattern provided: ${rawTestNamePattern !== undefined}, length: ${
        rawTestNamePattern === undefined ? 0 : String(rawTestNamePattern).length
      }`
    );
    
    // Validate testNamePattern before allocating any async resources so that
    // early 400 returns don't leave a dangling timeout timer.
    let testNamePattern: string | undefined;
    if (suite === 'single' && rawTestNamePattern !== undefined) {
      if (
        req.body.testFile !== undefined &&
        req.body.testNamePattern !== undefined &&
        String(req.body.testFile) !== String(req.body.testNamePattern)
      ) {
        res.status(400).json({ success: false, error: 'Conflicting testNamePattern / testFile parameters' });
        return;
      }

      testNamePattern = String(rawTestNamePattern);
      if (
        testNamePattern.length > MAX_TEST_NAME_PATTERN_LENGTH ||
        /[\0\r\n]/.test(testNamePattern)
      ) {
        res.status(400).json({ success: false, error: 'Invalid testNamePattern (also accepted as testFile) parameter' });
        return;
      }

      try {
        new RegExp(testNamePattern);
      } catch {
        res.status(400).json({ success: false, error: 'Invalid testNamePattern (also accepted as testFile) parameter' });
        return;
      }
    }

    // Set up process tracking and timeout AFTER synchronous validation exits so
    // early 400 returns don't need to clear a dangling timer.
    const timeoutMs = 10 * 60 * 1000; // 10 minutes for comprehensive tests
    const procRef: { p: ChildProcess | null } = { p: null };
    let hasResponded = false;
    // True only once the child has actually exited ('close'). child.killed is
    // NOT that signal — Node sets it as soon as a SIGTERM is successfully
    // SENT, so gating the SIGKILL escalation on !killed meant the escalation
    // could never fire (RVW-001, reproduced on Node 22).
    let childExited = false;

    const cleanup = () => {
      const child = procRef.p;
      if (!child || childExited) return;
      killChildTree(child, 'SIGTERM');
      const escalation = setTimeout(() => {
        if (!childExited) {
          killChildTree(child, 'SIGKILL');
        }
      }, killEscalationMs);
      escalation.unref?.();
    };

    const timeout = setTimeout(() => {
      if (!hasResponded) {
        hasResponded = true;
        cleanup();
        res.status(408).json({
          success: false,
          error: 'Test execution timed out after 10 minutes',
          results: {
            passed: 0,
            failed: 1,
            skipped: 0,
            total: 1,
            successRate: 0,
            duration: '10:00',
            output: 'Tests timed out'
          }
        });
      }
    }, timeoutMs);

    // Determine test command based on suite
    const testCommands: Record<string, string[]> = {
      'comprehensive': ['npm', 'run', 'analyze'], // Runs build, typecheck, and lint - comprehensive quality check
      'fast': ['npm', 'run', 'test:fast'],
      'all': ['npm', 'test'],
      'integration': ['npm', 'run', 'test:integration'],
      'load': ['npm', 'run', 'test:load'],
      'e2e': ['npm', 'run', 'test:e2e'],
      'e2e-smoke': ['npm', 'run', 'test:e2e:smoke'],
      'performance': ['npm', 'run', 'test:performance'],
      'auth': ['npx', 'jest', '--testPathPatterns=Auth', '--passWithNoTests'],
      'connectors': ['npx', 'jest', '--testPathPatterns=Connector', '--passWithNoTests'],
      'transformation': ['npx', 'jest', '--testPathPatterns=Transformation', '--passWithNoTests'],
      'ai': ['npx', 'jest', '--testPathPatterns=AI|ai|semantic', '--passWithNoTests'],
      'single': testNamePattern ? ['npx', 'jest', '--testNamePattern=' + testNamePattern] : ['npm', 'test']
    };

    const command = testCommands[suite as keyof typeof testCommands] || testCommands['fast'];
    logger.info(`Running test command: ${command.join(' ')}`);

    if (!command || command.length === 0 || typeof command[0] !== 'string') {
      clearTimeout(timeout);
      res.status(400).json({ success: false, error: 'Invalid test command' });
      return;
    }

    // Run the selected test command. shell:false avoids shell-metachar
    // interpretation (e.g. `|` in `AI|ai|semantic` is passed to jest as one
    // literal arg) and closes the pre-existing shell-injection surface in the
    // `single` suite's user-supplied test pattern. detached on POSIX puts the
    // npm/npx wrapper in its own process group so killChildTree can signal
    // the whole tree (jest grandchildren included).
    // Abort guard (Copilot, PR #1032 R1): if the client aborted between slot
    // acquisition and here (asyncHandler defers the handler a microtask, so a
    // 'close' can land in that window), the slot has already been released via
    // releaseIfNotSpawned — spawning now would create a child that no slot
    // tracks, enabling a concurrent second run. The slot's own flag is the
    // signal (req/res.destroyed are unreliable: Node auto-destroys a fully
    // consumed request stream in normal flow). No await sits between this
    // check and spawn(), so the window cannot reopen.
    const preSpawnSlot = res.locals.runSlot as RunSlot | undefined;
    if (preSpawnSlot?.releasedBeforeSpawn) {
      clearTimeout(timeout);
      return;
    }

    procRef.p = spawn(resolveSpawnCommand(command[0]), command.slice(1), {
      cwd: process.cwd(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // The child now owns the concurrency slot: it is released ONLY on the
    // child's 'close' (real exit — which also follows 'error' for spawn
    // failures), never on response close and never on 'error' alone (a
    // failed kill emits 'error' while the process is still alive).
    const slot = preSpawnSlot;
    if (slot) slot.spawned = true;

    let stdout = '';
    let stderr = '';
    const startTime = Date.now();

    procRef.p.stdout?.on('data', (data: Buffer) => {
      stdout = appendCapped(stdout, data);
    });

    procRef.p.stderr?.on('data', (data: Buffer) => {
      stderr = appendCapped(stderr, data);
    });

    procRef.p.on('close', (code: number) => {
      clearTimeout(timeout);
      childExited = true;
      slot?.release();
      if (hasResponded) return;
      hasResponded = true;

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(1) + 's';

      logger.info(`Test process finished with code: ${code}`);
      
      try {
        // Parse Jest output for test results
        const output = stdout + stderr;
        
        // Look for Jest summary patterns
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
        
        // Try to parse "Tests: X passed, Y failed, Z skipped, W total"
        const testSummaryMatch = output.match(/Tests:\s+(?:(\d+)\s+passed(?:,\s*)?)?(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped(?:,\s*)?)?(?:(\d+)\s+total)?/i);
        if (testSummaryMatch) {
          passed = parseInt(testSummaryMatch[1] || '0');
          failed = parseInt(testSummaryMatch[2] || '0');
          skipped = parseInt(testSummaryMatch[3] || '0');
          total = parseInt(testSummaryMatch[4] || '0');
        }

        // Alternative: look for "Test Suites: X passed, Y total"
        if (total === 0) {
          const suiteMatch = output.match(/Test Suites:\s+(?:(\d+)\s+passed(?:,\s*)?)?(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped(?:,\s*)?)?(?:(\d+)\s+total)?/i);
          if (suiteMatch) {
            const suitePassed = parseInt(suiteMatch[1] || '0');
            const suiteFailed = parseInt(suiteMatch[2] || '0');
            const suiteSkipped = parseInt(suiteMatch[3] || '0');
            const suiteTotal = parseInt(suiteMatch[4] || '0');
            
            // Estimate individual tests (suites typically have multiple tests)
            passed = suitePassed * 15; // Rough estimate
            failed = suiteFailed * 5;
            skipped = suiteSkipped * 2;
            total = suiteTotal * 15;
          }
        }

        // If still no results, try to count individual test results
        if (total === 0) {
          const passMatches = output.match(/√/g);
          const failMatches = output.match(/×/g);
          const skipMatches = output.match(/○/g);
          
          passed = passMatches ? passMatches.length : 0;
          failed = failMatches ? failMatches.length : 0;
          skipped = skipMatches ? skipMatches.length : 0;
          total = passed + failed + skipped;
        }

        const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

        const results = {
          passed,
          failed,
          skipped,
          total,
          successRate: parseFloat(successRate),
          duration,
          output: output.length > 2000 ? output.substring(output.length - 2000) : output,
          exitCode: code
        };

        logger.info('Parsed test results:', results);

        res.json({
          success: code === 0,
          results
        });

      } catch (error) {
        logger.error('Error parsing test results:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to parse test results',
          results: {
            passed: 0,
            failed: 1,
            skipped: 0,
            total: 1,
            successRate: 0,
            duration,
            output: stdout + stderr
          }
        });
      }
    });

    procRef.p.on('error', (error: Error) => {
      clearTimeout(timeout);
      // Do NOT mark the child exited or release the slot here: 'error' also
      // fires when a KILL attempt fails — the process is still alive, and
      // releasing on that path allowed a second concurrent child while
      // disarming the SIGKILL escalation exactly when SIGTERM had failed
      // (Codex review, post-#1032). Spawn failures are covered without a
      // release here: Node emits 'close' after 'error' for them (verified on
      // Node 22), and 'close' is the single release point.
      if (hasResponded) return;
      hasResponded = true;

      logger.error('Test process error:', error);

      sendError(res, 500, {
        code: 'TEST_EXECUTION_ERROR',
        message: 'Failed to start test process',
        details: error.message
      }, req);
    });

    // Handle client disconnect. res 'close' fires after normal completion
    // too, so the hasResponded guard is what keeps a successful run's child
    // alive — the pre-PR-C req.on('close') handler killed every child a few
    // milliseconds after the request body completed, breaking execution
    // entirely (2026-07-14 review, finding A8).
    res.on('close', () => {
      if (hasResponded) return;
      hasResponded = true;
      clearTimeout(timeout);
      cleanup();
    });
  }));

  // Test NetSuite MCP schema discovery. Stays anonymous for the public
  // dashboard (public/js/ai-config-dashboard.js), but with two guards
  // (RVW-002): a dedicated per-IP limiter (the global limiter is a documented
  // no-op), and real-MCP discovery only for authenticated callers — anonymous
  // requests always get the fixture/mock response, so an unauthenticated
  // client can never drive traffic at a live NetSuite MCP endpoint.
  router.post('/mcp-schema', mcpSchemaRateLimit, asyncHandler(async (req: express.Request, res: express.Response) => {
    try {
      const { entityType } = req.body;

      if (!entityType || typeof entityType !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Entity type is required',
          error: 'Missing or invalid entityType parameter'
        });
        return;
      }

      logger.info(`MCP schema test requested for entity type: ${sanitizeLogValue(entityType)}`);

      const startTime = Date.now();

      // Try to use real MCP adapter if available (feature flag + credentials
      // configured + authenticated caller — the global optionalAuthMiddleware
      // on /api/* populates req.user from a valid Bearer JWT). The flag is
      // evaluated ONCE in a try/catch: a throwing flag reads as disabled so a
      // public endpoint's anonymous behavior stays stable (mock, not an error
      // response) — Copilot R5.
      const isAuthenticated = Boolean((req as express.Request & { user?: unknown }).user);
      let mcpFlagEnabled = false;
      try {
        mcpFlagEnabled = isNetSuiteMCPSchemaEnabled();
      } catch (flagError) {
        logger.warn('MCP schema feature-flag evaluation failed; treating as disabled', {
          error: flagError instanceof Error ? flagError.message : String(flagError)
        });
      }
      let mcpAdapter: NetSuiteMCPSchemaAdapter | undefined;
      let usingRealMCP = false;

      if (!isAuthenticated && mcpFlagEnabled) {
        logger.debug('Anonymous mcp-schema caller: serving mock response (real MCP requires authentication)');
      }

      if (isAuthenticated && mcpFlagEnabled) {
        try {
          mcpAdapter = container.get<NetSuiteMCPSchemaAdapter>(TYPES.NetSuiteMCPSchemaAdapter);
          usingRealMCP = true;
          logger.info('Using real MCP adapter for schema discovery test');
        } catch (error) {
          logger.warn('MCP adapter not available in DI container, falling back to mock', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else if (isAuthenticated) {
        logger.debug('MCP schema discovery disabled via feature flag, using mock response');
      }

      // Attempt real MCP schema discovery
      if (usingRealMCP && mcpAdapter) {
        try {
          const schema = await mcpAdapter.getSchema(entityType);
          const duration = Date.now() - startTime;

          const health = mcpAdapter.getHealthStatus();

          res.json({
            success: true,
            message: `Successfully discovered ${schema.fields.length} fields for ${entityType} via MCP`,
            entityType,
            fieldCount: schema.fields.length,
            fields: schema.fields.slice(0, 10).map(f => ({
              name: f.name,
              type: f.type,
              required: f.required,
              description: f.description
            })),
            duration: `${duration}ms`,
            timestamp: new Date().toISOString(),
            source: schema.metadata?.source || 'api',
            mcpHealth: {
              connected: health.connected,
              lastSuccessfulQuery: health.lastSuccessfulQuery,
              consecutiveFailures: health.consecutiveFailures,
              uptime: health.uptime
            }
          });
          return;
        } catch (mcpError) {
          logger.warn('MCP schema discovery failed, falling back to mock', {
            error: mcpError instanceof Error ? mcpError.message : String(mcpError)
          });
          // Fall through to mock response
        }
      }

      // Mock fallback response (for UI testing when MCP not available)
      const duration = Date.now() - startTime;
      const mockFieldCount = entityType === 'customer' ? 45 : entityType === 'vendor' ? 38 : 30;

      res.json({
        success: true,
        message: `[MOCK] Successfully discovered ${mockFieldCount} fields for ${entityType}`,
        entityType,
        fieldCount: mockFieldCount,
        fields: Array.from({ length: Math.min(10, mockFieldCount) }, (_, i) => ({
          name: `field_${i + 1}`,
          label: `Field ${i + 1}`,
          type: 'string'
        })),
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
        source: 'mock',
        note: 'Mock response: Enable MCP feature flag and configure NetSuite credentials for real schema discovery.'
      });

    } catch (error) {
      // Full error (incl. stack) goes to the log only — never to the client
      // (RVW-002: this route is reachable anonymously).
      logger.error('MCP schema test failed:', error);

      res.json({
        success: false,
        message: 'MCP schema discovery test failed',
        error: 'Internal error during schema discovery test'
      });
    }
  }));

  return router;
}
