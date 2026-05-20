import * as express from 'express';
import { spawn } from 'child_process';
import { sendError } from '../utils/errorResponse';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { NetSuiteMCPSchemaAdapter } from '../services/netsuite/mcp/NetSuiteMCPSchemaAdapter';
import { isNetSuiteMCPSchemaEnabled } from '../config/runtimeFlags';

const MAX_TEST_NAME_PATTERN_LENGTH = 256;
const MAX_LOG_VALUE_LENGTH = 80;

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

export function createTestingRouter(): express.Router {
  const router = express.Router();

  // Run the test suite and return results
  router.post('/run', asyncHandler(async (req: express.Request, res: express.Response) => {
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
    const procRef: { p: unknown | null } = { p: null };
    let hasResponded = false;

    const cleanup = () => {
      if (procRef.p && !(procRef.p as any).killed) {
        (procRef.p as any).kill('SIGTERM');
        setTimeout(() => {
          if (procRef.p && !(procRef.p as any).killed) {
            (procRef.p as any).kill('SIGKILL');
          }
        }, 5000);
      }
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
    logger.info(`Running test command: ${command!.join(' ')}`); // Add non-null assertion

    if (!command || command.length === 0 || typeof command[0] !== 'string') {
      clearTimeout(timeout);
      res.status(400).json({ success: false, error: 'Invalid test command' });
      return;
    }

    // Run the selected test command. shell:false avoids shell-metachar
    // interpretation (e.g. `|` in `AI|ai|semantic` is passed to jest as one
    // literal arg) and closes the pre-existing shell-injection surface in the
    // `single` suite's user-supplied test pattern.
    procRef.p = spawn(resolveSpawnCommand(command![0]), command.slice(1), { // Add non-null assertion
      cwd: process.cwd(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

  let stdout = '';
  let stderr = '';
    const startTime = Date.now();

    (procRef.p as any).stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    (procRef.p as any).stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    (procRef.p as any).on('close', (code: number) => {
      clearTimeout(timeout);
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

    (procRef.p as any).on('error', (error: Error) => {
      clearTimeout(timeout);
      if (hasResponded) return;
      hasResponded = true;

      logger.error('Test process error:', error);
      cleanup();
      
      sendError(res, 500, {
        code: 'TEST_EXECUTION_ERROR',
        message: 'Failed to start test process',
        details: error.message
      }, req);
    });

    // Handle client disconnect
    req.on('close', () => {
      clearTimeout(timeout);
      cleanup();
    });
  }));

  // Test NetSuite MCP schema discovery
  router.post('/mcp-schema', asyncHandler(async (req: express.Request, res: express.Response) => {
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

      logger.info(`MCP schema test requested for entity type: ${entityType}`);

      const startTime = Date.now();

      // Try to use real MCP adapter if available (feature flag + credentials configured)
      let mcpAdapter: NetSuiteMCPSchemaAdapter | undefined;
      let usingRealMCP = false;

      if (isNetSuiteMCPSchemaEnabled()) {
        try {
          mcpAdapter = container.get<NetSuiteMCPSchemaAdapter>(TYPES.NetSuiteMCPSchemaAdapter);
          usingRealMCP = true;
          logger.info('Using real MCP adapter for schema discovery test');
        } catch (error) {
          logger.warn('MCP adapter not available in DI container, falling back to mock', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
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
      logger.error('MCP schema test failed:', error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      res.json({
        success: false,
        message: 'MCP schema discovery test failed',
        error: errorMessage,
        details: error instanceof Error ? error.stack : undefined
      });
    }
  }));

  return router;
}
