/**
 * SECURITY: Safe expression evaluation wrapper for expr-eval.
 *
 * See `.github/audit-exceptions.md` for the accepted audit rationale.
 * This wrapper is the only permitted `expr-eval` call site in `src/`.
 *
 * Provides DoS protection through:
 * - Expression length limits
 * - Evaluation timeouts
 * - Complexity scoring
 * - Dangerous pattern blocking
 *
 * IMPORTANT LIMITATION: expr-eval's evaluate() is synchronous. safeEvaluate()
 * performs a best-effort elapsed-time check after evaluation completes, but cannot
 * interrupt a blocking evaluation in progress. For hard timeout guarantees against
 * CPU-bound expressions, run evaluation in worker threads or child processes.
 *
 * The pre-evaluation checks (length, nesting depth, dangerous patterns) are the
 * primary defense against DoS - they prevent obviously malicious expressions from
 * being evaluated at all.
 *
 * @module utils/safeExprEval
 */

import { Parser } from 'expr-eval';

/**
 * Configuration for safe expression evaluation
 */
export interface SafeEvalConfig {
  /** Maximum expression length in characters (default: 1000) */
  maxLength?: number;
  /** Maximum evaluation time in milliseconds (default: 1000) */
  timeoutMs?: number;
  /** Maximum nesting depth for parentheses (default: 20) */
  maxNestingDepth?: number;
}

const DEFAULT_CONFIG: Required<SafeEvalConfig> = {
  maxLength: 1000,
  timeoutMs: 1000,
  maxNestingDepth: 20,
};

/**
 * Convert variables to types expr-eval can handle
 * Extracts duplicated logic from safeEvaluate and safeEvaluateSync
 *
 * Note: expr-eval's TypeScript definitions don't include boolean in the variable
 * type, but booleans work at runtime. See: https://github.com/silentmatt/expr-eval
 * This type assertion is safe as of expr-eval v2.0.2.
 */
function convertVariables(variables: Record<string, unknown>): Record<string, number | string | boolean> {
  const evalVars: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      evalVars[key] = value;
    } else if (value !== null && value !== undefined) {
      // Try to convert to number
      const num = Number(value);
      evalVars[key] = Number.isFinite(num) ? num : 0;
    } else {
      evalVars[key] = 0;
    }
  }
  return evalVars;
}

/**
 * Check expression complexity to prevent DoS attacks
 * Returns true if expression is within safe limits
 */
function checkExpressionComplexity(expression: string, config: Required<SafeEvalConfig>): { valid: boolean; error?: string } {
  // Check length
  if (expression.length > config.maxLength) {
    return {
      valid: false,
      error: `Expression exceeds maximum length of ${config.maxLength} characters`,
    };
  }

  // Check nesting depth (count parentheses)
  let maxDepth = 0;
  let currentDepth = 0;
  for (const char of expression) {
    if (char === '(') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === ')') {
      currentDepth--;
    }
  }

  if (maxDepth > config.maxNestingDepth) {
    return {
      valid: false,
      error: `Expression nesting depth (${maxDepth}) exceeds maximum of ${config.maxNestingDepth}`,
    };
  }

  // Check for dangerous patterns that could cause excessive computation
  const dangerousPatterns = [
    /\^{2,}/,           // Multiple exponentiation operators (e.g., 2^^2)
    /factorial\s*\(\s*\d{3,}/i,  // Factorial of large numbers (3+ digits)
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(expression)) {
      return {
        valid: false,
        error: 'Expression contains potentially dangerous computation patterns',
      };
    }
  }

  return { valid: true };
}

/**
 * Safely evaluate a mathematical/logical expression with best-effort timeout checks
 *
 * @param expression - The expression string to evaluate
 * @param variables - Variables available in the expression context
 * @param config - Optional configuration overrides
 * @returns Promise resolving to the evaluation result
 * @throws Error if expression is invalid, exceeds timeout budget, or fails safety checks
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await safeEvaluate('x + y * 2', { x: 10, y: 5 });
 * console.log(result); // 20
 *
 * // With custom timeout
 * const result = await safeEvaluate('complex_expr', vars, { timeoutMs: 500 });
 * ```
 */
export async function safeEvaluate(
  expression: string,
  variables: Record<string, unknown> = {},
  config: SafeEvalConfig = {}
): Promise<unknown> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Validate expression complexity
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    throw new Error(`Expression rejected: ${complexityCheck.error}`);
  }

  // Create parser
  const parser = new Parser();

  // Parse expression (this is synchronous and fast)
  let parsedExpr;
  try {
    parsedExpr = parser.parse(expression);
  } catch (parseError) {
    throw new Error(`Expression parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`, { cause: parseError });
  }

  // Best-effort timeout semantics: elapsed time is checked after synchronous execution.
  const startedAt = Date.now();
  try {
    // Convert variables using shared helper (see convertVariables for type safety notes)
    const evalVars = convertVariables(variables);
    const result = parsedExpr.evaluate(evalVars as Record<string, number | string>);

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > mergedConfig.timeoutMs) {
      throw new Error(
        `Expression evaluation exceeded timeout of ${mergedConfig.timeoutMs}ms (elapsed: ${elapsedMs}ms)`
      );
    }

    return result;
  } catch (evalError) {
    throw new Error(`Expression evaluation error: ${evalError instanceof Error ? evalError.message : String(evalError)}`, { cause: evalError });
  }
}

/**
 * Synchronous version for use in non-async contexts
 * WARNING: Does not provide timeout protection - use safeEvaluate when possible
 *
 * @param expression - The expression string to evaluate
 * @param variables - Variables available in the expression context
 * @param config - Optional configuration overrides (timeoutMs is ignored)
 * @returns The evaluation result
 * @throws Error if expression is invalid or fails safety checks
 */
export function safeEvaluateSync(
  expression: string,
  variables: Record<string, unknown> = {},
  config: SafeEvalConfig = {}
): unknown {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Validate expression complexity
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    throw new Error(`Expression rejected: ${complexityCheck.error}`);
  }

  // Create parser and evaluate
  const parser = new Parser();
  let parsedExpr;
  try {
    parsedExpr = parser.parse(expression);
  } catch (parseError) {
    throw new Error(`Expression parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`, { cause: parseError });
  }

  try {
    // Convert variables using shared helper (see convertVariables for type safety notes)
    const evalVars = convertVariables(variables);
    return parsedExpr.evaluate(evalVars as Record<string, number | string>);
  } catch (evalError) {
    throw new Error(`Expression evaluation error: ${evalError instanceof Error ? evalError.message : String(evalError)}`, { cause: evalError });
  }
}

/**
 * Validate an expression without evaluating it
 *
 * @param expression - The expression to validate
 * @param config - Optional configuration overrides
 * @returns Object with valid status and any error message
 */
export function validateExpression(
  expression: string,
  config: SafeEvalConfig = {}
): { valid: boolean; error?: string } {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Check complexity first
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    return complexityCheck;
  }

  // Try to parse
  try {
    const parser = new Parser();
    parser.parse(expression);
    return { valid: true };
  } catch (parseError) {
    return {
      valid: false,
      error: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    };
  }
}
