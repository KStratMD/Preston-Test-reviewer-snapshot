// @ts-check
// Shared helpers for AST-scanning src/connectors/*Connector.ts files.
// Imported by scripts/generate-metrics.mjs and scripts/audit-status-claims.mjs
// so the two cannot drift in their connector discovery / static-field
// extraction. Codex review (PR #692, Copilot round 1) flagged the previous
// duplication.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Match `<Name>Connector.ts` and `<Name>ConnectorProd.ts` (a one-off
 *  naming exception kept for backwards-compat with inversify TYPES.SuiteCentralConnectorProd
 *  + `src/routes/suiteCentralProd.ts` references documented in `docs/`).
 *  Excludes `MockConnectorBase.ts`, `DemoConnectorDecorator.ts`,
 *  `MockConnectorAdapter.ts`, etc. by design — those are not connector
 *  implementations themselves. New connector files SHOULD use the
 *  `<Name>Connector.ts` convention; the `ConnectorProd` branch is a
 *  legacy escape hatch (Copilot review on PR #692 caught the original
 *  scanner missing `SuiteCentralConnectorProd.ts`, an in-use connector
 *  bound at `src/inversify/inversify.config.ts:514`). */
export const CONNECTOR_FILE_PATTERN = /(?:Connector|ConnectorProd)\.ts$/;

/**
 * Recursively list every connector file under `<root>/src/connectors`.
 * @param {string} root absolute path of the repo root
 * @returns {string[]} absolute file paths
 */
export function listConnectorFiles(root) {
  const dir = path.join(root, 'src/connectors');
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  /** @param {string} current */
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && CONNECTOR_FILE_PATTERN.test(full)) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

/**
 * Extract the value of a `static readonly <fieldName> = '...'` (or
 * `'...' as const`) declaration from a TS source file. Returns `null` if the
 * field is missing or its initializer is not a string literal.
 * @param {ts.SourceFile} sourceFile
 * @param {string} fieldName
 * @returns {string | null}
 */
export function extractStaticString(sourceFile, fieldName) {
  /** @type {string | null} */
  let value = null;
  /** @param {ts.Node} node */
  function visit(node) {
    if (
      ts.isPropertyDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
      ts.isIdentifier(node.name) &&
      node.name.text === fieldName &&
      node.initializer
    ) {
      let init = node.initializer;
      if (ts.isAsExpression(init)) {
        init = init.expression;
      }
      if (ts.isStringLiteral(init)) {
        value = init.text;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return value;
}

/**
 * Build a TS source file from an absolute path.
 * @param {string} absolutePath
 * @param {string} relativePath used as the source file name (preserves
 *   diagnostics on POSIX-style paths regardless of host OS)
 * @returns {ts.SourceFile}
 */
export function readConnectorSourceFile(absolutePath, relativePath) {
  return ts.createSourceFile(
    relativePath,
    fs.readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** @typedef {Object} ConnectorRegistryEntry
 *  @property {string} key
 *  @property {string} className
 *  @property {string} productionStatus
 *  @property {string | null} proofCardPath
 *  @property {boolean} hasFactory  Whether the entry declares a `factory:` property. Replaces the previous `factoryAvailable` boolean field — derived from the AST presence of the property, so a stale boolean cannot drift from the actual factory wiring.
 *  @property {boolean} diBindingAvailable
 *  @property {string} bulkRollbackStrategy
 *  @property {string[]} credentialRequirements
 *  @property {string | null} notes
 */

/** Path (repo-relative POSIX) where the canonical connector registry lives. */
export const CONNECTOR_REGISTRY_REL_PATH = 'src/connectors/connectorRegistry.ts';

/**
 * AST-parse `src/connectors/connectorRegistry.ts` and return the array of
 * `ConnectorRegistration` entries as plain JS objects. Avoids requiring the
 * audit script to compile TypeScript at runtime.
 *
 * Only literal-shaped fields are extracted (`key`, `className`,
 * `productionStatus`, `proofCardPath`, `diBindingAvailable`,
 * `bulkRollbackStrategy`, `credentialRequirements`, `notes`). The `classRef`
 * field is intentionally skipped — it's an expression, not a literal, and the
 * audit gate doesn't need it (cross-checking against the AST scan of the
 * connector files covers the same intent). The `factory` field, when present,
 * is an arrow-function expression and is NOT extracted as a value; instead a
 * synthesized `hasFactory: boolean` is set from the property's presence (PR
 * 6A-2 — replaces the old declared `factoryAvailable` boolean).
 *
 * Throws if the file shape doesn't match expectations (missing variable,
 * non-array initializer, etc.). The registry-shape unit test enforces the
 * happy path; this thrower exists for the case where someone restructures
 * the file in a way that silently breaks the AST walk.
 *
 * @param {string} root absolute repo root
 * @returns {ConnectorRegistryEntry[]}
 */
export function parseConnectorRegistry(root) {
  const filePath = path.join(root, CONNECTOR_REGISTRY_REL_PATH);
  if (!fs.existsSync(filePath)) {
    throw new Error(`connector registry missing at ${CONNECTOR_REGISTRY_REL_PATH}`);
  }
  const sourceFile = readConnectorSourceFile(filePath, CONNECTOR_REGISTRY_REL_PATH);

  /** @type {ts.ArrayLiteralExpression | null} */
  let arrayLiteral = null;
  /** @param {ts.Node} node */
  function findRegistry(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'CONNECTOR_REGISTRY' &&
      node.initializer
    ) {
      let init = node.initializer;
      // Allow `[...] as const` / `[...] satisfies T` wrappers without breaking the walk.
      while (
        ts.isAsExpression(init) ||
        ts.isParenthesizedExpression(init) ||
        ts.isSatisfiesExpression(init)
      ) {
        init = init.expression;
      }
      if (ts.isArrayLiteralExpression(init)) {
        arrayLiteral = init;
      }
      return;
    }
    ts.forEachChild(node, findRegistry);
  }
  findRegistry(sourceFile);

  if (!arrayLiteral) {
    throw new Error(
      `connector registry: could not locate CONNECTOR_REGISTRY array literal in ${CONNECTOR_REGISTRY_REL_PATH}`,
    );
  }

  /** @type {ConnectorRegistryEntry[]} */
  const entries = [];
  for (const element of /** @type {ts.ArrayLiteralExpression} */ (arrayLiteral).elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(
        `connector registry: non-object element at index ${entries.length} in CONNECTOR_REGISTRY`,
      );
    }
    entries.push(extractObjectEntry(element, entries.length));
  }
  return entries;
}

/**
 * @param {ts.ObjectLiteralExpression} node
 * @param {number} index for diagnostics
 * @returns {ConnectorRegistryEntry}
 */
function extractObjectEntry(node, index) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  /**
   * Tracks `factory` initializer shape separately from the literal-value path,
   * because the factory closure is intentionally non-literal. We need to
   * distinguish "property declared with a callable closure" from "property
   * declared with a non-callable placeholder" (e.g. `factory: undefined`).
   * Closing Copilot round-1 review of PR #757 — mere property presence let
   * `factory: undefined` satisfy the production-tier audit, defeating the
   * gate's purpose.
   */
  let factoryIsCallable = false;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
    let name;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    else continue;
    if (name === 'factory') {
      factoryIsCallable = isCallableExpression(prop.initializer);
      continue; // skip the literal-value extraction for factory closures
    }
    fields[name] = extractLiteralValue(prop.initializer);
  }

  const required = ['key', 'className', 'productionStatus', 'diBindingAvailable', 'bulkRollbackStrategy'];
  for (const r of required) {
    if (!(r in fields)) {
      throw new Error(`connector registry: entry index ${index} missing required field '${r}'`);
    }
  }

  return {
    key: assertString(fields.key, `entry ${index}.key`),
    className: assertString(fields.className, `entry ${index}.className`),
    productionStatus: assertString(fields.productionStatus, `entry ${index}.productionStatus`),
    proofCardPath: 'proofCardPath' in fields ? assertStringOrNull(fields.proofCardPath, `entry ${index}.proofCardPath`) : null,
    // PR 6A-2: a connector is "reachable through ConnectorManager.createConnector()"
    // iff it declares `factory: <callable>` — an arrow function, function
    // expression, or `function` declaration. Non-callable initializers
    // (`factory: undefined`, `factory: null`, `factory: 'placeholder'`) are
    // rejected so a stale property assignment cannot satisfy the production-
    // tier audit while leaving runtime consumers broken.
    hasFactory: factoryIsCallable,
    diBindingAvailable: assertBool(fields.diBindingAvailable, `entry ${index}.diBindingAvailable`),
    bulkRollbackStrategy: assertString(fields.bulkRollbackStrategy, `entry ${index}.bulkRollbackStrategy`),
    credentialRequirements: 'credentialRequirements' in fields
      ? assertStringArray(fields.credentialRequirements, `entry ${index}.credentialRequirements`)
      : [],
    notes: 'notes' in fields ? assertStringOrNull(fields.notes, `entry ${index}.notes`) : null,
  };
}

/**
 * Returns true when `node` is a syntactic form that produces a callable value.
 * Arrow functions, function expressions, and parenthesized/asserted forms of
 * the same all qualify. Identifiers and literals do not — `factory: foo` (a
 * forward reference that may or may not resolve to a function) is treated as
 * non-callable for audit purposes; the registry contract expects an inline
 * closure for review-time visibility.
 *
 * @param {ts.Expression} node
 * @returns {boolean}
 */
function isCallableExpression(node) {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (
    ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return isCallableExpression(node.expression);
  }
  return false;
}

/** @param {ts.Expression} node */
function extractLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el) => extractLiteralValue(el));
  }
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
    return extractLiteralValue(node.expression);
  }
  // Non-literal expressions (e.g. `classRef: AdyenConnector`) are intentionally
  // returned as a sentinel object so the registry parse doesn't fail; the
  // audit caller filters these out by field name (it never reads `classRef`).
  return { __nonLiteral: true };
}

/** @param {unknown} v @param {string} ctx */
function assertString(v, ctx) {
  if (typeof v !== 'string') throw new Error(`connector registry: ${ctx} must be a string literal`);
  return v;
}
/** @param {unknown} v @param {string} ctx */
function assertStringOrNull(v, ctx) {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`connector registry: ${ctx} must be a string literal or null`);
  return v;
}
/** @param {unknown} v @param {string} ctx */
function assertBool(v, ctx) {
  if (typeof v !== 'boolean') throw new Error(`connector registry: ${ctx} must be a boolean literal`);
  return v;
}
/** @param {unknown} v @param {string} ctx */
function assertStringArray(v, ctx) {
  if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
    throw new Error(`connector registry: ${ctx} must be an array of string literals`);
  }
  return v;
}

/**
 * @typedef {Object} InstantiationFinding
 * @property {string} file repo-relative POSIX path
 * @property {number} line 1-based line number of the `new` keyword
 * @property {string} className the connector class instantiated
 */

/**
 * Repo-relative directories scanned for stray `new <ClassName>(` sites by
 * `findFactoryWiredInstantiations`. Excludes `src/connectors/connectorRegistry.ts`
 * (the canonical instantiation site) and any `tests/**` paths (tests legitimately
 * instantiate connectors directly).
 *
 * Note: `scripts/` is intentionally NOT scanned. The directory holds run-by-hand
 * diagnostic / dev tools (`scripts/test-netsuite-connection.ts`,
 * `scripts/test-netsuite-crud.ts`, `scripts/demo-ai-mapping.ts`) that legitimately
 * instantiate connectors directly with hand-built deps for testing — they are
 * not part of the production dispatch path. The gate's purpose is to prevent
 * production code from bypassing the canonical registry, not to police local
 * developer tooling.
 */
const WIRING_SCAN_DIRS = ['src'];

/** Files matching these patterns are skipped by the wiring-drift scan. */
const WIRING_SCAN_EXCLUDE_PATH_SEGMENTS = [
  '/tests/',
  '/__tests__/',
  '/node_modules/',
];

/**
 * Test/spec files are excluded — tests legitimately instantiate connectors.
 * The regex covers every extension the scanner walks (ts, tsx, mts, cts, js,
 * jsx, mjs, cjs) so colocated `<Name>Connector.test.tsx` etc. don't trip the
 * gate. Closes Codex round-1 review of PR #757.
 */
const TEST_FILE_PATTERN = /\.(test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** @param {string} relPosixPath */
function isWiringScanExcluded(relPosixPath) {
  if (relPosixPath === CONNECTOR_REGISTRY_REL_PATH) return true;
  if (TEST_FILE_PATTERN.test(relPosixPath)) return true;
  for (const seg of WIRING_SCAN_EXCLUDE_PATH_SEGMENTS) {
    if (relPosixPath.includes(seg)) return true;
  }
  return false;
}

/**
 * Walk every directory in `WIRING_SCAN_DIRS` and return every site that
 * constructs an instance (`new <ClassName>(`) of one of the connectors named
 * in `factoryWiredClassNames`. Used by
 * `audit-status-claims --check-wired-connectors` to enforce the PR 6A-2
 * invariant: any connector with a registry `factory` closure is instantiated
 * only inside `src/connectors/connectorRegistry.ts`.
 *
 * Today `WIRING_SCAN_DIRS = ['src']` — the gate scans only production code.
 * `scripts/` is intentionally exempt (run-by-hand diagnostic tools); test
 * files and `tests/`-rooted paths are also exempt (legitimate direct
 * instantiation). See the `WIRING_SCAN_DIRS` doc.
 *
 * Comments are stripped via the TypeScript AST walk (`NewExpression` nodes
 * only) so a commented-out `// return new HubSpotConnector(...)` does not
 * trip the gate. Aliased and namespace-imported usages are caught — see
 * `scanFileForNewExpressions` for the import-resolution rules.
 *
 * @param {string} root absolute repo root
 * @param {ReadonlySet<string>} factoryWiredClassNames the class names whose
 *   `new` sites are exclusive to the registry file
 * @returns {InstantiationFinding[]} sorted by file then line; empty when clean
 */
export function findFactoryWiredInstantiations(root, factoryWiredClassNames) {
  /** @type {InstantiationFinding[]} */
  const findings = [];
  for (const dir of WIRING_SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    walkForNewExpressions(abs, root, factoryWiredClassNames, findings);
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

/**
 * @param {string} current absolute path of the directory being walked
 * @param {string} root absolute repo root for relativization
 * @param {ReadonlySet<string>} classNames
 * @param {InstantiationFinding[]} out
 */
function walkForNewExpressions(current, root, classNames, out) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'tests') continue;
      walkForNewExpressions(full, root, classNames, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|mts|cts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) continue;
    if (isWiringScanExcluded(rel)) continue;
    scanFileForNewExpressions(full, rel, classNames, out);
  }
}

/**
 * @param {string} absPath
 * @param {string} relPath
 * @param {ReadonlySet<string>} classNames
 * @param {InstantiationFinding[]} out
 */
function scanFileForNewExpressions(absPath, relPath, classNames, out) {
  const text = fs.readFileSync(absPath, 'utf8');
  // Cheap pre-filter: if no candidate class name appears as a substring,
  // skip the AST parse entirely (the vast majority of files fall in this
  // bucket). The match is intentionally loose — it catches direct identifiers
  // (`new HubSpotConnector(...)`), aliased imports (whose import declaration
  // still names the original class on the same line), and namespace imports
  // from a path containing the class basename. The AST walk below confirms
  // the actual usage shape.
  let anyHit = false;
  for (const name of classNames) {
    if (text.includes(name)) {
      anyHit = true;
      break;
    }
  }
  if (!anyHit) return;

  const sourceFile = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, inferScriptKind(relPath));

  /**
   * Pass 1 — walk import declarations and record:
   *   - `aliasMap`: local name → canonical class name, for any `import { X as Y }`
   *     where `X` is a factory-wired connector class. Lets the gate catch
   *     `new Y(...)` even when the local binding is renamed (Codex round-1).
   *   - `namespaceLocals`: local name → set of factory-wired class names
   *     reachable through `<local>.<ClassName>`. Lets the gate catch
   *     `new c.NetSuiteConnector(...)` from `import * as c from './NetSuiteConnector'`.
   *
   * We can't fully resolve module specifiers without a TS program; the
   * conservative approximation is "if the specifier path's basename matches
   * a factory-wired class name, assume a namespace import binds that class."
   * That's a deliberate over-trigger — false positives here mean a maintainer
   * gets a clearer error message, not a missed drift.
   */
  /** @type {Map<string, string>} */
  const aliasMap = new Map();
  /** @type {Map<string, Set<string>>} */
  const namespaceLocals = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const namedBindings = stmt.importClause.namedBindings;
    if (!namedBindings) continue;
    if (ts.isNamedImports(namedBindings)) {
      for (const elem of namedBindings.elements) {
        const moduleName = (elem.propertyName ?? elem.name).text;
        const localName = elem.name.text;
        if (classNames.has(moduleName) && localName !== moduleName) {
          aliasMap.set(localName, moduleName);
        }
      }
    } else if (ts.isNamespaceImport(namedBindings)) {
      // import * as <local> from '<spec>'; harvest the spec basename.
      // Match is intentionally exact-case (e.g. spec basename
      // 'NetSuiteConnector' === class name 'NetSuiteConnector') and matches
      // only the directly-imported file, not a barrel export. Two known
      // narrow gaps:
      //   - barrel imports: `import * as c from '../connectors'` doesn't
      //     bind because the basename is 'connectors', not the class name;
      //   - case-mismatched specifiers: `import * as c from
      //     '../connectors/netsuite'` would not bind because basename
      //     'netsuite' !== class name 'NetSuiteConnector'.
      // Neither pattern exists in the current codebase. If a future PR
      // introduces either, extend this heuristic to (a) follow re-exports
      // out of a barrel, and (b) case-fold the comparison.
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      const lastSeg = spec.split('/').pop() ?? '';
      const reachable = new Set([...classNames].filter((n) => n === lastSeg));
      if (reachable.size > 0) {
        namespaceLocals.set(namedBindings.name.text, reachable);
      }
    }
  }

  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isNewExpression(node)) {
      // Direct identifier or aliased identifier: `new X(...)`.
      if (ts.isIdentifier(node.expression)) {
        const local = node.expression.text;
        const canonical = aliasMap.get(local) ?? (classNames.has(local) ? local : undefined);
        if (canonical) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          out.push({ file: relPath, line: line + 1, className: canonical });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        // Namespace member: `new <local>.<ClassName>(...)`.
        const target = node.expression;
        if (ts.isIdentifier(target.expression) && ts.isIdentifier(target.name)) {
          const reachable = namespaceLocals.get(target.expression.text);
          if (reachable && reachable.has(target.name.text)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            out.push({ file: relPath, line: line + 1, className: target.name.text });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

/** @param {string} relPath */
function inferScriptKind(relPath) {
  if (relPath.endsWith('.tsx') || relPath.endsWith('.jsx')) return ts.ScriptKind.TSX;
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs') || relPath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
