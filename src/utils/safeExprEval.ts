/**
 * Safe expression evaluation wrapper.
 *
 * Provides DoS protection through:
 * - Expression length limits
 * - Evaluation timeouts
 * - Complexity scoring
 * - Dangerous pattern blocking
 *
 * The evaluator is intentionally tiny and local: only the expression shapes
 * used by the transformation engine are supported.
 *
 * @module utils/safeExprEval
 */

export interface SafeEvalConfig {
  /** Maximum expression length in characters (default: 1000) */
  maxLength?: number;
  /** Maximum evaluation time in milliseconds (default: 1000) */
  timeoutMs?: number;
  /** Maximum nesting depth for parentheses (default: 20) */
  maxNestingDepth?: number;
}

type EvalPrimitive = number | string | boolean | null;
type EvalValue = EvalPrimitive;

const DEFAULT_CONFIG: Required<SafeEvalConfig> = {
  maxLength: 1000,
  timeoutMs: 1000,
  maxNestingDepth: 20,
};

const ALLOWED_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  abs: (value: unknown) => Math.abs(Number(value)),
  ceil: (value: unknown) => Math.ceil(Number(value)),
  floor: (value: unknown) => Math.floor(Number(value)),
  round: (value: unknown) => Math.round(Number(value)),
  min: (...values: unknown[]) => Math.min(...values.map(value => Number(value))),
  max: (...values: unknown[]) => Math.max(...values.map(value => Number(value))),
  pow: (base: unknown, exponent: unknown) => Math.pow(Number(base), Number(exponent)),
  sqrt: (value: unknown) => Math.sqrt(Number(value)),
  sin: (value: unknown) => Math.sin(Number(value)),
  cos: (value: unknown) => Math.cos(Number(value)),
  tan: (value: unknown) => Math.tan(Number(value)),
  log: (value: unknown) => Math.log(Number(value)),
  exp: (value: unknown) => Math.exp(Number(value)),
  parseInt: (value: unknown, radix?: unknown) => Number.parseInt(String(value), radix === undefined ? 10 : Number(radix)),
  parseFloat: (value: unknown) => Number.parseFloat(String(value)),
};

interface Token {
  type: 'number' | 'string' | 'identifier' | 'keyword' | 'operator';
  value: string;
}

interface LiteralNode {
  type: 'literal';
  value: EvalValue;
}

interface IdentifierNode {
  type: 'identifier';
  name: string;
}

interface UnaryNode {
  type: 'unary';
  operator: '+' | '-' | '!';
  argument: ExpressionNode;
}

interface BinaryNode {
  type: 'binary';
  operator: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||';
  left: ExpressionNode;
  right: ExpressionNode;
}

interface ConditionalNode {
  type: 'conditional';
  test: ExpressionNode;
  consequent: ExpressionNode;
  alternate: ExpressionNode;
}

interface CallNode {
  type: 'call';
  name: string;
  args: ExpressionNode[];
}

type ExpressionNode = LiteralNode | IdentifierNode | UnaryNode | BinaryNode | ConditionalNode | CallNode;

function convertVariables(variables: Record<string, unknown>): Record<string, EvalValue> {
  const evalVars: Record<string, EvalValue> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      evalVars[key] = value;
    } else if (value === null || value === undefined) {
      evalVars[key] = 0;
    } else {
      const num = Number(value);
      evalVars[key] = Number.isFinite(num) ? num : 0;
    }
  }
  return evalVars;
}

function checkExpressionComplexity(expression: string, config: Required<SafeEvalConfig>): { valid: boolean; error?: string } {
  if (expression.length > config.maxLength) {
    return {
      valid: false,
      error: `Expression exceeds maximum length of ${config.maxLength} characters`,
    };
  }

  let maxDepth = 0;
  let currentDepth = 0;
  let inString = false;
  let quote = '';
  let escape = false;
  for (const char of expression) {
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escape = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      inString = true;
      quote = char;
      continue;
    }

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

  const dangerousPatterns = [
    /\^{2,}/,
    /factorial\s*\(\s*\d{3,}/i,
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

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function findTopLevelKeyword(expression: string, keyword: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escape = false;
  const lower = expression.toLowerCase();

  for (let i = startIndex; i <= expression.length - keyword.length; i++) {
    const char = expression[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escape = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '(') {
      depth++;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (lower.slice(i, i + keyword.length) === keyword) {
      const before = expression[i - 1];
      const after = expression[i + keyword.length];
      if (!isWordChar(before) && !isWordChar(after)) {
        return i;
      }
    }
  }

  return -1;
}

function rewriteLegacyIf(expression: string): string {
  const trimmed = expression.trim();
  if (!/^if\b/i.test(trimmed)) {
    return expression;
  }

  const body = trimmed.slice(2).trimStart();
  const thenIndex = findTopLevelKeyword(body, 'then', 0);
  if (thenIndex < 0) {
    throw new Error('Expression parse error: missing then in if expression');
  }

  const elseIndex = findTopLevelKeyword(body, 'else', thenIndex + 4);
  if (elseIndex < 0) {
    throw new Error('Expression parse error: missing else in if expression');
  }

  const condition = body.slice(0, thenIndex).trim();
  const consequent = body.slice(thenIndex + 4, elseIndex).trim();
  const alternate = body.slice(elseIndex + 4).trim();

  if (!condition || !consequent || !alternate) {
    throw new Error('Expression parse error: malformed if expression');
  }

  return `(${rewriteLegacyIf(condition)}) ? (${rewriteLegacyIf(consequent)}) : (${rewriteLegacyIf(alternate)})`;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const char = expression[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if ((char === '.' && /\d/.test(expression[i + 1] || '')) || /\d/.test(char)) {
      let end = i + 1;
      while (end < expression.length && /[0-9_]/.test(expression[end])) {
        end++;
      }
      if (expression[end] === '.') {
        end++;
        while (end < expression.length && /[0-9_]/.test(expression[end])) {
          end++;
        }
      }
      if (expression[end] === 'e' || expression[end] === 'E') {
        let expEnd = end + 1;
        if (expression[expEnd] === '+' || expression[expEnd] === '-') {
          expEnd++;
        }
        let expDigits = expEnd;
        while (expDigits < expression.length && /[0-9_]/.test(expression[expDigits])) {
          expDigits++;
        }
        if (expDigits > expEnd) {
          end = expDigits;
        }
      }
      tokens.push({ type: 'number', value: expression.slice(i, end) });
      i = end;
      continue;
    }

    if (char === '\'' || char === '"') {
      const quote = char;
      let end = i + 1;
      let value = '';
      let escaped = false;
      while (end < expression.length) {
        const current = expression[end];
        if (escaped) {
          switch (current) {
          case 'n':
            value += '\n';
            break;
          case 'r':
            value += '\r';
            break;
          case 't':
            value += '\t';
            break;
          case 'b':
            value += '\b';
            break;
          case 'f':
            value += '\f';
            break;
          case '\\':
          case '\'':
          case '"':
            value += current;
            break;
          default:
            value += current;
            break;
          }
          escaped = false;
        } else if (current === '\\') {
          escaped = true;
        } else if (current === quote) {
          tokens.push({ type: 'string', value });
          i = end + 1;
          break;
        } else {
          value += current;
        }
        end++;
      }
      if (i !== end + 1) {
        throw new Error('Expression parse error: unterminated string literal');
      }
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) {
        end++;
      }
      const word = expression.slice(i, end);
      const lower = word.toLowerCase();
      if (['true', 'false', 'null', 'and', 'or', 'not', 'if', 'then', 'else'].includes(lower)) {
        tokens.push({ type: 'keyword', value: lower });
      } else {
        tokens.push({ type: 'identifier', value: word });
      }
      i = end;
      continue;
    }

    const twoChar = expression.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar });
      i += 2;
      continue;
    }

    if (['+', '-', '*', '/', '%', '^', '?', ':', '(', ')', ',', '!', '<', '>'].includes(char)) {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    throw new Error(`Expression parse error: unexpected character '${char}'`);
  }

  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
  ) {}

  parse(): ExpressionNode {
    const expression = this.parseConditional();
    if (!this.isAtEnd()) {
      throw new Error(`Expression parse error: unexpected token '${this.peek()?.value}'`);
    }
    return expression;
  }

  private parseConditional(): ExpressionNode {
    let expression = this.parseLogicalOr();
    if (this.matchOperator('?')) {
      const consequent = this.parseConditional();
      this.expectOperator(':');
      const alternate = this.parseConditional();
      expression = {
        type: 'conditional',
        test: expression,
        consequent,
        alternate,
      };
    }
    return expression;
  }

  private parseLogicalOr(): ExpressionNode {
    let expression = this.parseLogicalAnd();
    while (this.matchOperator('||') || this.matchKeyword('or')) {
      expression = {
        type: 'binary',
        operator: '||',
        left: expression,
        right: this.parseLogicalAnd(),
      };
    }
    return expression;
  }

  private parseLogicalAnd(): ExpressionNode {
    let expression = this.parseEquality();
    while (this.matchOperator('&&') || this.matchKeyword('and')) {
      expression = {
        type: 'binary',
        operator: '&&',
        left: expression,
        right: this.parseEquality(),
      };
    }
    return expression;
  }

  private parseEquality(): ExpressionNode {
    let expression = this.parseComparison();
    while (true) {
      if (this.matchOperator('==')) {
        expression = {
          type: 'binary',
          operator: '==',
          left: expression,
          right: this.parseComparison(),
        };
        continue;
      }
      if (this.matchOperator('!=')) {
        expression = {
          type: 'binary',
          operator: '!=',
          left: expression,
          right: this.parseComparison(),
        };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseComparison(): ExpressionNode {
    let expression = this.parseAdditive();
    while (true) {
      if (this.matchOperator('>=')) {
        expression = {
          type: 'binary',
          operator: '>=',
          left: expression,
          right: this.parseAdditive(),
        };
        continue;
      }
      if (this.matchOperator('<=')) {
        expression = {
          type: 'binary',
          operator: '<=',
          left: expression,
          right: this.parseAdditive(),
        };
        continue;
      }
      if (this.matchOperator('>')) {
        expression = {
          type: 'binary',
          operator: '>',
          left: expression,
          right: this.parseAdditive(),
        };
        continue;
      }
      if (this.matchOperator('<')) {
        expression = {
          type: 'binary',
          operator: '<',
          left: expression,
          right: this.parseAdditive(),
        };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseAdditive(): ExpressionNode {
    let expression = this.parseMultiplicative();
    while (true) {
      if (this.matchOperator('+')) {
        expression = {
          type: 'binary',
          operator: '+',
          left: expression,
          right: this.parseMultiplicative(),
        };
        continue;
      }
      if (this.matchOperator('-')) {
        expression = {
          type: 'binary',
          operator: '-',
          left: expression,
          right: this.parseMultiplicative(),
        };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseMultiplicative(): ExpressionNode {
    let expression = this.parseUnary();
    while (true) {
      if (this.matchOperator('*')) {
        expression = {
          type: 'binary',
          operator: '*',
          left: expression,
          right: this.parseUnary(),
        };
        continue;
      }
      if (this.matchOperator('/')) {
        expression = {
          type: 'binary',
          operator: '/',
          left: expression,
          right: this.parseUnary(),
        };
        continue;
      }
      if (this.matchOperator('%')) {
        expression = {
          type: 'binary',
          operator: '%',
          left: expression,
          right: this.parseUnary(),
        };
        continue;
      }
      break;
    }
    return expression;
  }

  private parseUnary(): ExpressionNode {
    if (this.matchOperator('+')) {
      return {
        type: 'unary',
        operator: '+',
        argument: this.parseUnary(),
      };
    }
    if (this.matchOperator('-')) {
      return {
        type: 'unary',
        operator: '-',
        argument: this.parseUnary(),
      };
    }
    if (this.matchOperator('!') || this.matchKeyword('not')) {
      return {
        type: 'unary',
        operator: '!',
        argument: this.parseUnary(),
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionNode {
    const token = this.peek();
    if (!token) {
      throw new Error('Expression parse error: unexpected end of expression');
    }

    if (this.matchType('number')) {
      return {
        type: 'literal',
        value: Number(token.value),
      };
    }

    if (this.matchType('string')) {
      return {
        type: 'literal',
        value: token.value,
      };
    }

    if (this.matchKeyword('true')) {
      return {
        type: 'literal',
        value: true,
      };
    }

    if (this.matchKeyword('false')) {
      return {
        type: 'literal',
        value: false,
      };
    }

    if (this.matchKeyword('null')) {
      return {
        type: 'literal',
        value: null,
      };
    }

    if (this.matchType('identifier')) {
      const name = token.value;
      if (this.matchOperator('(')) {
        const args = this.parseArguments();
        return {
          type: 'call',
          name,
          args,
        };
      }

      return {
        type: 'identifier',
        name,
      };
    }

    if (this.matchOperator('(')) {
      const expression = this.parseConditional();
      this.expectOperator(')');
      return expression;
    }

    if (token.type === 'keyword') {
      throw new Error(`Expression parse error: unexpected keyword '${token.value}'`);
    }

    throw new Error(`Expression parse error: unexpected token '${token.value}'`);
  }

  private parseArguments(): ExpressionNode[] {
    const args: ExpressionNode[] = [];
    if (this.matchOperator(')')) {
      return args;
    }

    while (true) {
      args.push(this.parseConditional());
      if (this.matchOperator(')')) {
        return args;
      }
      this.expectOperator(',');
    }
  }

  private matchType(type: Token['type']): Token | undefined {
    const token = this.peek();
    if (token && token.type === type) {
      this.index++;
      return token;
    }
    return undefined;
  }

  private matchKeyword(value: string): boolean {
    const token = this.peek();
    if (token && token.type === 'keyword' && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private matchOperator(value: string): boolean {
    const token = this.peek();
    if (token && token.type === 'operator' && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectOperator(value: string): void {
    if (!this.matchOperator(value)) {
      throw new Error(`Expression parse error: expected '${value}'`);
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

/**
 * Numeric view of an operand for arithmetic '+': numbers pass through,
 * booleans/null/undefined coerce (true=1, null=0), and numeric-looking
 * non-empty strings parse. Returns null for genuinely textual values so
 * the caller can fall back to string concatenation.
 */
function asArithmeticNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * Three-way comparison preserving JS relational semantics: lexicographic when
 * both operands are strings, numeric coercion otherwise. Returns NaN when a
 * numeric comparison involves NaN, which makes all four relational operators
 * evaluate false — same as JS.
 */
function compareOperands(left: unknown, right: unknown): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const l = Number(left);
  const r = Number(right);
  return l < r ? -1 : l > r ? 1 : l === r ? 0 : NaN;
}

function evaluateNode(node: ExpressionNode, variables: Record<string, EvalValue>): unknown {
  switch (node.type) {
  case 'literal':
    return node.value;

  case 'identifier':
    if (!Object.prototype.hasOwnProperty.call(variables, node.name)) {
      throw new Error(`Expression evaluation error: unknown identifier '${node.name}'`);
    }
    return variables[node.name];

  case 'unary': {
    const value = evaluateNode(node.argument, variables);
    const operator = node.operator as string;
    switch (operator) {
    case '+':
      return Number(value);
    case '-':
      return -Number(value);
    case '!':
      return !value;
    default:
      throw new Error(`Expression evaluation error: unsupported unary operator '${operator}'`);
    }
  }

  case 'binary': {
    if (node.operator === '&&') {
      const left = Boolean(evaluateNode(node.left, variables));
      return left ? Boolean(evaluateNode(node.right, variables)) : false;
    }
    if (node.operator === '||') {
      const left = Boolean(evaluateNode(node.left, variables));
      return left ? true : Boolean(evaluateNode(node.right, variables));
    }

    const left = evaluateNode(node.left, variables);
    const right = evaluateNode(node.right, variables);

    switch (node.operator) {
    case '+': {
      // Connector field values often arrive as numeric strings; '+' must add
      // them, not concatenate ('10' + null is 10, not '100'). Concatenation
      // only when an operand is genuinely non-numeric text.
      const leftNum = asArithmeticNumber(left);
      const rightNum = asArithmeticNumber(right);
      return (leftNum !== null && rightNum !== null) ? leftNum + rightNum : String(left) + String(right);
    }
    case '-':
      return Number(left) - Number(right);
    case '*':
      return Number(left) * Number(right);
    case '/':
      return Number(left) / Number(right);
    case '%':
      return Number(left) % Number(right);
    case '==':
      return left == right; // intentional loose equality to match expression-language semantics
    case '!=':
      return left != right; // intentional loose equality counterpart
    case '>':
      return compareOperands(left, right) > 0;
    case '<':
      return compareOperands(left, right) < 0;
    case '>=':
      return compareOperands(left, right) >= 0;
    case '<=':
      return compareOperands(left, right) <= 0;
    default:
      throw new Error(`Expression evaluation error: unsupported operator '${node.operator}'`);
    }
  }

  case 'conditional':
    return evaluateNode(node.test, variables)
      ? evaluateNode(node.consequent, variables)
      : evaluateNode(node.alternate, variables);

  case 'call': {
    const fn = ALLOWED_FUNCTIONS[node.name.toLowerCase()];
    if (!fn) {
      throw new Error(`Expression evaluation error: unsupported function '${node.name}'`);
    }
    const args = node.args.map(arg => evaluateNode(arg, variables));
    return fn(...args);
  }

  default: {
    const exhaustive: never = node;
    return exhaustive;
  }
  }
}

function compileExpression(expression: string): ExpressionNode {
  const rewritten = rewriteLegacyIf(expression);
  const tokens = tokenize(rewritten);
  const parser = new ExpressionParser(tokens);
  return parser.parse();
}

/**
 * Safely evaluate a mathematical/logical expression with best-effort timeout checks
 */
export async function safeEvaluate(
  expression: string,
  variables: Record<string, unknown> = {},
  config: SafeEvalConfig = {},
): Promise<unknown> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    throw new Error(`Expression rejected: ${complexityCheck.error}`);
  }

  const startedAt = Date.now();
  try {
    const evalVars = convertVariables(variables);
    const ast = compileExpression(expression);
    const result = evaluateNode(ast, evalVars);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > mergedConfig.timeoutMs) {
      throw new Error(
        `Expression evaluation exceeded timeout of ${mergedConfig.timeoutMs}ms (elapsed: ${elapsedMs}ms)`,
      );
    }
    return result;
  } catch (error) {
    throw new Error(`Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Synchronous version for use in non-async contexts
 */
export function safeEvaluateSync(
  expression: string,
  variables: Record<string, unknown> = {},
  config: SafeEvalConfig = {},
): unknown {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    throw new Error(`Expression rejected: ${complexityCheck.error}`);
  }

  try {
    const evalVars = convertVariables(variables);
    const ast = compileExpression(expression);
    return evaluateNode(ast, evalVars);
  } catch (error) {
    throw new Error(`Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Validate an expression without evaluating it.
 */
export function validateExpression(
  expression: string,
  config: SafeEvalConfig = {},
): { valid: boolean; error?: string } {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const complexityCheck = checkExpressionComplexity(expression, mergedConfig);
  if (!complexityCheck.valid) {
    return complexityCheck;
  }

  try {
    compileExpression(expression);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
