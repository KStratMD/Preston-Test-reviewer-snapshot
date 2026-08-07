#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync as _execFileSync } from 'node:child_process';
import ts from 'typescript';
import {
  CONNECTOR_REGISTRY_REL_PATH,
  extractStaticString,
  findFactoryWiredInstantiations,
  listConnectorFiles,
  parseConnectorRegistry,
  readConnectorSourceFile,
} from './lib/connector-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VALID_STATUSES = new Set(['production', 'beta', 'demo_only', 'stub']);
const PROOF_CARD_DIR = 'docs/review/proof-cards/';
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    metrics: 'metrics.json',
    checkProofCards: false,
    checkWiredConnectors: false,
    checkTenantCoverage: false,
    checkTenantIsolationInvariant: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--metrics':
        options.metrics = argv[++i];
        break;
      case '--check-proof-cards':
        // Phase 4 will set this. Phase 3 only verifies the *path* string is
        // well-formed and lives under docs/review/proof-cards/; existence is
        // intentionally deferred until the cards are actually written.
        options.checkProofCards = true;
        break;
      case '--check-wired-connectors':
        // PR 6A + 6A-2: cross-check `src/connectors/connectorRegistry.ts` against
        // the AST scan of `src/connectors/*Connector.ts` files. Fails if (a) any
        // connector class lacks a registry entry, (b) any registry entry points
        // at a non-existent class, (c) productionStatus / proofCard disagree
        // between source and registry, (d) a 'production' entry has no `factory`
        // closure or no proofCard, (e) **wiring drift** (PR 6A-2): any
        // registry-factory-wired class is instantiated outside the registry
        // file (`new XxxConnector(` under `src/`; tests and `scripts/` are
        // exempt — see `WIRING_SCAN_DIRS` in scripts/lib/connector-scan.mjs).
        options.checkWiredConnectors = true;
        break;
      case '--check-tenant-coverage':
        // PR 4B: bidirectional consistency between `src/middleware/setup/routeManifest.ts`
        // (ROUTE_MANIFEST entries) and `this.app.use(...)` path-literal calls in
        // MOUNT_SOURCE_FILES (RouteSetup.ts + src/index.ts). Fails on drift in either
        // direction:
        //   Drift A — path mounted in a source file but absent from ROUTE_MANIFEST.
        //   Drift B — path declared in ROUTE_MANIFEST but not found in any source file.
        // Exemptions: /health and /ready (framework probes, not explicitly mounted);
        // bare /api and / mounts (prefix mounts for credential/test routers that
        // define their own full sub-paths).
        options.checkTenantCoverage = true;
        break;
      case '--check-tenant-isolation-invariant':
        // PR 2C-Auth: assert that every `tenantIsolation(...)` callsite in
        // production source code (anything under `src/` except the middleware
        // definition file itself + test files) passes
        // `disableHeaderExtraction: true`. The flag is the security
        // invariant that keeps the `req.tenantContext` → identity bridge in
        // `extractIdentityContext` safe — without it, the un-verified
        // `x-tenant-id` header path silently re-opens tenant impersonation.
        // See `src/services/governance/identityContext.ts` JSDoc and
        // `src/middleware/setup/RouteSetup.ts` mountCentralTenantGate JSDoc.
        options.checkTenantIsolationInvariant = true;
        break;
      case '--help':
        console.log(
          'Usage: node scripts/audit-status-claims.mjs ' +
            '[--root <dir>] [--metrics metrics.json] [--check-proof-cards] [--check-wired-connectors] [--check-tenant-coverage] [--check-tenant-isolation-invariant]',
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function scanConnectors(root) {
  const items = [];
  for (const file of listConnectorFiles(root)) {
    const relPath = rel(root, file);
    const sourceFile = readConnectorSourceFile(file, relPath);
    items.push({
      file: relPath,
      name: path.basename(relPath, '.ts'),
      productionStatus: extractStaticString(sourceFile, 'productionStatus'),
      statusEvidence: extractStaticString(sourceFile, 'statusEvidence'),
      proofCard: extractStaticString(sourceFile, 'proofCard'),
    });
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
}

/**
 * Cross-check `src/connectors/connectorRegistry.ts` (the canonical registry)
 * against the AST scan of `src/connectors/*Connector.ts` files. Returns a list
 * of human-readable error messages; empty array on success.
 *
 * @param {string} root absolute repo root
 * @param {Array<{file: string, name: string, productionStatus: string | null, statusEvidence: string | null, proofCard: string | null}>} items
 * @param {boolean} checkProofCards when true, also verify proofCardPath files exist on disk
 * @returns {string[]}
 */
function checkRegistry(root, items, checkProofCards) {
  /** @type {string[]} */
  const errors = [];

  /** @type {ReturnType<typeof parseConnectorRegistry>} */
  let registry;
  try {
    registry = parseConnectorRegistry(root);
  } catch (e) {
    errors.push(`${CONNECTOR_REGISTRY_REL_PATH}: parse failed — ${e instanceof Error ? e.message : String(e)}`);
    return errors;
  }

  // Per-entry shape checks.
  /** @type {Map<string, number>} */
  const seenKeys = new Map();
  /** @type {Map<string, number>} */
  const seenClassNames = new Map();
  for (let i = 0; i < registry.length; i += 1) {
    const entry = registry[i];
    const ctx = `${CONNECTOR_REGISTRY_REL_PATH} entry [${i}] (${entry.className || '<unnamed>'})`;

    if (!entry.key || !KEY_PATTERN.test(entry.key)) {
      errors.push(`${ctx}: key '${entry.key}' must match ${KEY_PATTERN.source}`);
    } else if (seenKeys.has(entry.key)) {
      errors.push(`${ctx}: duplicate key '${entry.key}' (also at index ${seenKeys.get(entry.key)})`);
    } else {
      seenKeys.set(entry.key, i);
    }

    if (!entry.className) {
      errors.push(`${ctx}: missing className`);
    } else if (seenClassNames.has(entry.className)) {
      errors.push(`${ctx}: duplicate className '${entry.className}' (also at index ${seenClassNames.get(entry.className)})`);
    } else {
      seenClassNames.set(entry.className, i);
    }

    if (!VALID_STATUSES.has(entry.productionStatus)) {
      errors.push(`${ctx}: productionStatus '${entry.productionStatus}' is not one of ${[...VALID_STATUSES].join(', ')}`);
    }

    if (entry.proofCardPath != null) {
      // Apply the same validation rules as the class-level `static proofCard`
      // gate (single .md file directly under docs/review/proof-cards/, no
      // traversal segments). Closes Copilot round-1 review of PR #755 — the
      // registry validation was weaker than the class validation, allowing
      // a registry entry to declare a path that the class-level scanner
      // would reject (e.g. nested subdirs, `..` segments).
      if (!entry.proofCardPath.startsWith(PROOF_CARD_DIR)) {
        errors.push(`${ctx}: proofCardPath '${entry.proofCardPath}' must live under ${PROOF_CARD_DIR}`);
      } else if (!entry.proofCardPath.endsWith('.md')) {
        errors.push(`${ctx}: proofCardPath '${entry.proofCardPath}' must end with .md`);
      } else {
        const remainder = entry.proofCardPath.slice(PROOF_CARD_DIR.length);
        if (
          remainder === '' ||
          remainder.startsWith('/') ||
          remainder.includes('/') ||
          remainder.split('/').some((seg) => seg === '..' || seg === '.')
        ) {
          errors.push(
            `${ctx}: proofCardPath '${entry.proofCardPath}' must be a single .md file directly under ${PROOF_CARD_DIR}`,
          );
        }
      }
    }

    if (entry.productionStatus === 'production') {
      if (!entry.hasFactory) {
        errors.push(
          `${ctx}: productionStatus='production' requires a 'factory' closure ` +
            `(every production-tier connector must be reachable through ` +
            `ConnectorManager.createConnector — see PR 6A-2 / ADR-015)`,
        );
      }
      if (!entry.proofCardPath) {
        errors.push(`${ctx}: productionStatus='production' requires a proofCardPath`);
      }
    }
  }

  // Cross-check: every connector source file must have a registry entry.
  /** @type {Map<string, typeof items[number]>} */
  const itemsByName = new Map(items.map((it) => [it.name, it]));
  /** @type {Set<string>} */
  const registryClassNames = new Set(registry.map((e) => e.className));

  for (const item of items) {
    if (!registryClassNames.has(item.name)) {
      errors.push(
        `${item.file}: connector class has no entry in ${CONNECTOR_REGISTRY_REL_PATH} (add a ConnectorRegistration with className='${item.name}')`,
      );
    }
  }

  // Cross-check: every registry entry must reference a real connector source file.
  for (const entry of registry) {
    const item = itemsByName.get(entry.className);
    if (!item) {
      errors.push(
        `${CONNECTOR_REGISTRY_REL_PATH}: entry className='${entry.className}' has no matching source file under src/connectors/ (filename must match the className)`,
      );
      continue;
    }
    // productionStatus must agree between source and registry.
    if (item.productionStatus && entry.productionStatus !== item.productionStatus) {
      errors.push(
        `${item.file}: source productionStatus='${item.productionStatus}' but ${CONNECTOR_REGISTRY_REL_PATH} declares '${entry.productionStatus}' for className='${entry.className}'`,
      );
    }
    // proofCard symmetry: if either side declares one, both must agree.
    // Closes Copilot round-1 review of PR #755 — the original equality check
    // only fired when BOTH were set, so a class-only or registry-only proofCard
    // claim slipped through the gate. Symmetry is the contract: the registry
    // is the source of truth, the class's static field is its mirror.
    if (item.proofCard && !entry.proofCardPath) {
      errors.push(
        `${item.file}: source declares proofCard='${item.proofCard}' but ${CONNECTOR_REGISTRY_REL_PATH} omits proofCardPath for className='${entry.className}'`,
      );
    } else if (!item.proofCard && entry.proofCardPath) {
      errors.push(
        `${item.file}: source omits static proofCard but ${CONNECTOR_REGISTRY_REL_PATH} declares proofCardPath='${entry.proofCardPath}' for className='${entry.className}'`,
      );
    } else if (item.proofCard && entry.proofCardPath && item.proofCard !== entry.proofCardPath) {
      errors.push(
        `${item.file}: source proofCard='${item.proofCard}' disagrees with registry proofCardPath='${entry.proofCardPath}' for className='${entry.className}'`,
      );
    }
    // If --check-proof-cards is also set, verify the registry's proofCardPath exists on disk.
    if (checkProofCards && entry.proofCardPath) {
      const absolutePath = path.resolve(root, entry.proofCardPath);
      if (!fs.existsSync(absolutePath)) {
        errors.push(
          `${CONNECTOR_REGISTRY_REL_PATH}: entry className='${entry.className}' proofCardPath='${entry.proofCardPath}' does not exist on disk`,
        );
      }
    }
  }

  return errors;
}

/**
 * PR 6A-2 wiring-drift gate: walk `src/` for `new <ClassName>(` sites of
 * any registry-factory-wired connector. The only legitimate instantiation
 * site is `src/connectors/connectorRegistry.ts`. Any match outside that
 * file (excluding tests) is a wiring drift — code that bypasses the
 * registry-driven factory and could leave the registry in a stale state.
 *
 * `scripts/` is intentionally NOT scanned; it holds run-by-hand diagnostic
 * tools that legitimately construct connectors with hand-built deps.
 * Tests are also exempt: unit tests legitimately instantiate connectors
 * directly. The exclusions are enforced by `findFactoryWiredInstantiations`
 * (paths under `tests/`, `__tests__/`, or matching `*.test.*` / `*.spec.*`
 * are skipped; see `WIRING_SCAN_DIRS` in scripts/lib/connector-scan.mjs).
 *
 * @param {string} root absolute repo root
 * @returns {string[]}
 */
function checkWiringDrift(root) {
  /** @type {string[]} */
  const errors = [];
  /** @type {ReturnType<typeof parseConnectorRegistry>} */
  let registry;
  try {
    registry = parseConnectorRegistry(root);
  } catch {
    // Registry parse errors are surfaced by checkRegistry; don't double-report.
    return errors;
  }
  const factoryClassNames = new Set(
    registry.filter((entry) => entry.hasFactory).map((entry) => entry.className),
  );
  if (factoryClassNames.size === 0) return errors;

  const findings = findFactoryWiredInstantiations(root, factoryClassNames);
  for (const finding of findings) {
    errors.push(
      `${finding.file}:${finding.line}: wiring drift — ` +
        `\`new ${finding.className}(\` outside ${CONNECTOR_REGISTRY_REL_PATH} ` +
        `(this connector has a registry factory closure; route construction through ` +
        `\`getConnectorRegistration('<key>')?.factory(systemId, deps)\` instead — ` +
        `see PR 6A-2 / ADR-015).`,
    );
  }
  return errors;
}

/**
 * PR 2C-Auth tenant-isolation-invariant drift gate: every `tenantIsolation(...)`
 * callsite in production source MUST pass `disableHeaderExtraction: true`.
 *
 * Why: the `extractIdentityContext` bridge that reads `req.tenantContext`
 * is safe only because the central gate's mount of `tenantIsolation`
 * passes the flag — without it, the un-verified `x-tenant-id` header
 * path silently re-opens tenant impersonation against the bridge AND
 * against direct `req.tenantContext` consumers like `src/routes/mcpPolicies.ts`.
 *
 * Scope: every `.ts` under `src/` EXCEPT the middleware definition file
 * (`src/middleware/tenantIsolation.ts`, which defines the helper itself —
 * not a callsite) and test files (`*.test.ts`, `*.spec.ts`, `__tests__/`).
 *
 * Matching: looks for `tenantIsolation(` followed by an opening brace; reads
 * the brace-balanced options literal; asserts the literal contains
 * `disableHeaderExtraction: true`. The scanner REJECTS three callsite shapes:
 *   - Parameterless: `tenantIsolation()` — the middleware runs with library
 *     defaults (header extraction ON), so the call is itself the bug.
 *   - Variable-built options: `const opts = {...}; tenantIsolation(opts)` —
 *     scanner can't verify the flag without AST analysis. Inline the literal
 *     at the callsite OR upgrade this scanner.
 *   - Inline literal that omits the flag, or sets it `false`.
 *
 * Only inline object literals at the callsite ARE supported and verifiable.
 *
 * Bypass defense (Copilot R2+R3 on PR #823): the canonical-call scanner is
 * blind to aliased / namespace-imported / reference-assigned bindings AND
 * to CommonJS require()-based access, so we also REJECT four preludes that
 * would make a downstream call invisible:
 *   - `import { tenantIsolation as <alias> } from '.../tenantIsolation'`
 *   - `import * as <ns> from '.../tenantIsolation'`
 *   - `const <alias> = tenantIsolation;` (reference assignment)
 *   - `require('.../tenantIsolation')` anywhere in source (CommonJS path)
 * Rather than follow the binding (which would require AST analysis), the
 * gate reports the prelude itself as the violation. There's no legitimate
 * reason to alias `tenantIsolation` — direct call by canonical name is the
 * supported shape.
 *
 * There's exactly one production callsite today (the central gate's). If a
 * future PR genuinely needs variable-built options or aliased bindings,
 * upgrade this to AST analysis.
 *
 * Returns 0 on success, 1 on invariant violation, 2 on parse/IO failure.
 *
 * @param {string} rootDir absolute path to repo root (may be a temp copy)
 * @returns {number}
 */
function runTenantIsolationInvariantCheck(rootDir) {
  // Scan tracked .ts files under src/ for tenantIsolation( callsites.
  // Use execFileSync (direct binary spawn, no shell) instead of execSync
  // (`/bin/sh -c <cmd>`) — sandboxed review environments commonly restrict
  // shell spawning even when the underlying binary is available (Codex 5.4
  // review of PR #823 hit `spawnSync /bin/sh EPERM` here). The invariant
  // gate is a security-load-bearing CI check, so it stays HARD-FAIL on a
  // genuinely missing git: better a noisy false-positive in a broken
  // environment than a silently-skipped security check.
  let trackedFiles = [];
  try {
    trackedFiles = _execFileSync('git', ['ls-files', 'src'], { cwd: rootDir, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  } catch (err) {
    console.error('audit-tenant-isolation-invariant: git ls-files failed; cannot scan');
    if (err && typeof err === 'object' && 'message' in err) {
      console.error(`  (${err.message})`);
    }
    return 2;
  }

  // The middleware definition file itself — not a callsite.
  const MIDDLEWARE_DEFINITION = 'src/middleware/tenantIsolation.ts';

  /** @type {Array<{file: string, line: number, snippet: string, reason: string}>} */
  const violations = [];
  let scannedCallsites = 0;

  for (const relPath of trackedFiles) {
    if (relPath === MIDDLEWARE_DEFINITION) continue;
    if (relPath.includes('__tests__') || relPath.includes('.test.ts') || relPath.includes('.spec.ts')) continue;

    const filePath = path.join(rootDir, relPath);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Strip comments BEFORE searching — same line-then-block ordering as
    // runTenantCoverageCheck to defend against `/*`-inside-`//` bypass.
    // But preserve line numbers by replacing stripped content with same-length
    // blanks (not deletion) so violation reports point at the right line.
    const stripped = raw
      .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

    // Bypass defense: an aliased import or namespace-import of
    // tenantIsolation would let the canonical-name scanner miss the call.
    // We REJECT the alias form outright rather than try to follow the
    // binding — there's no legitimate reason to alias this name, and a
    // hard-fail keeps the security invariant load-bearing.
    //
    // Forms detected:
    //   import { tenantIsolation as <alias> } from '.../tenantIsolation'
    //   import * as <ns> from '.../tenantIsolation' (namespace import)
    //   const <alias> = tenantIsolation;  (reference assignment)
    //   require('.../tenantIsolation') anywhere in source — the codebase is
    //     TS+ESM so this is anomalous and would let CommonJS-style aliasing
    //     bypass the scanner (e.g. `const x = require(...).tenantIsolation;`
    //     OR `require(...).tenantIsolation({})` direct call). Reject all
    //     require() usage targeting the middleware module.
    // Each form makes the canonical-call scanner blind. Reject the file.
    const aliasedImportRe = /import\s*\{[^}]*\btenantIsolation\s+as\s+\w+[^}]*\}\s*from\s*['"][^'"]*\/tenantIsolation['"]/;
    const namespaceImportRe = /import\s*\*\s+as\s+\w+\s+from\s*['"][^'"]*\/tenantIsolation['"]/;
    // Assignment from the imported binding (after a regular import of
    // tenantIsolation): `const x = tenantIsolation;` or `let x = tenantIsolation;`
    const refAssignRe = /(?:^|[\s;])\s*(?:const|let|var)\s+\w+\s*=\s*tenantIsolation\s*;/m;
    const requireRe = /\brequire\s*\(\s*['"][^'"]*\/tenantIsolation['"]\s*\)/;
    const aliasedMatch = stripped.match(aliasedImportRe);
    if (aliasedMatch) {
      const lineNumber = stripped.slice(0, aliasedMatch.index ?? 0).split('\n').length;
      violations.push({
        file: relPath,
        line: lineNumber,
        snippet: aliasedMatch[0].replace(/\s+/g, ' ').slice(0, 120),
        reason: 'aliased import (`import { tenantIsolation as <alias> }`) would let the canonical-name scanner miss the call. Import as `tenantIsolation` and call by the canonical name.',
      });
      continue;
    }
    const namespaceMatch = stripped.match(namespaceImportRe);
    if (namespaceMatch) {
      const lineNumber = stripped.slice(0, namespaceMatch.index ?? 0).split('\n').length;
      violations.push({
        file: relPath,
        line: lineNumber,
        snippet: namespaceMatch[0].replace(/\s+/g, ' ').slice(0, 120),
        reason: 'namespace import of tenantIsolation module would let the canonical-name scanner miss the call. Use a named import.',
      });
      continue;
    }
    const refAssignMatch = stripped.match(refAssignRe);
    if (refAssignMatch) {
      const lineNumber = stripped.slice(0, refAssignMatch.index ?? 0).split('\n').length;
      violations.push({
        file: relPath,
        line: lineNumber,
        snippet: refAssignMatch[0].replace(/\s+/g, ' ').slice(0, 120),
        reason: 'reference assignment (`const <alias> = tenantIsolation`) would let the canonical-name scanner miss the call via the alias. Call tenantIsolation(...) directly.',
      });
      continue;
    }
    const requireMatch = stripped.match(requireRe);
    if (requireMatch) {
      const lineNumber = stripped.slice(0, requireMatch.index ?? 0).split('\n').length;
      violations.push({
        file: relPath,
        line: lineNumber,
        snippet: requireMatch[0].replace(/\s+/g, ' ').slice(0, 120),
        reason: 'CommonJS `require(.../tenantIsolation)` enables alias forms (`const x = require(...).tenantIsolation`) the canonical-name scanner cannot follow. The codebase is TS+ESM; use a named `import { tenantIsolation } from ...`.',
      });
      continue;
    }

    // Find every `tenantIsolation(` callsite. The lookbehind `(?<![\w.])`
    // prevents matching `mockTenantIsolation(` or `srcTenantIsolation(`;
    // identifier-strict so the canonical name is the only match.
    const callRe = /(?<![\w.])tenantIsolation\s*\(/g;
    let m;
    while ((m = callRe.exec(stripped)) !== null) {
      scannedCallsites += 1;
      const callStart = m.index;
      const lineNumber = stripped.slice(0, callStart).split('\n').length;

      // Find the opening of the argument list, then scan for either `)` (no
      // options) or `{` (options object literal).
      let i = callStart + m[0].length;
      while (i < stripped.length && /\s/.test(stripped[i])) i += 1;

      if (stripped[i] === ')') {
        violations.push({
          file: relPath,
          line: lineNumber,
          snippet: stripped.slice(callStart, i + 1),
          reason: 'no options argument — `tenantIsolation()` runs with library defaults (header extraction ON). Pass `{ disableHeaderExtraction: true, ... }`.',
        });
        continue;
      }

      if (stripped[i] !== '{') {
        // Variable-built options or some other shape we can't parse.
        violations.push({
          file: relPath,
          line: lineNumber,
          snippet: stripped.slice(callStart, Math.min(callStart + 80, stripped.length)).replace(/\s+/g, ' '),
          reason: 'argument is not an inline object literal — scanner cannot verify `disableHeaderExtraction: true`. Inline the literal at the callsite OR upgrade this scanner to AST analysis.',
        });
        continue;
      }

      // Brace-balance scan to extract the literal.
      let depth = 0;
      let end = i;
      let inString = null; // null | "'" | '"' | '`'
      let escape = false;
      while (end < stripped.length) {
        const c = stripped[end];
        if (escape) {
          escape = false;
        } else if (inString) {
          if (c === '\\') escape = true;
          else if (c === inString) inString = null;
        } else if (c === "'" || c === '"' || c === '`') {
          inString = c;
        } else if (c === '{') {
          depth += 1;
        } else if (c === '}') {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
        end += 1;
      }
      if (depth !== 0) {
        violations.push({
          file: relPath,
          line: lineNumber,
          snippet: stripped.slice(callStart, Math.min(callStart + 80, stripped.length)).replace(/\s+/g, ' '),
          reason: 'unbalanced braces in options literal — scanner failed to parse.',
        });
        continue;
      }

      const literal = stripped.slice(i, end);
      // Require explicit `disableHeaderExtraction: true` (whitespace tolerant).
      // Reject `disableHeaderExtraction: false` and the absence of the key.
      const trueRe = /\bdisableHeaderExtraction\s*:\s*true\b/;
      const falseRe = /\bdisableHeaderExtraction\s*:\s*false\b/;
      if (falseRe.test(literal)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          snippet: literal.replace(/\s+/g, ' ').slice(0, 120),
          reason: '`disableHeaderExtraction: false` violates the security invariant — the unverified `x-tenant-id` header would populate `req.tenantContext`.',
        });
      } else if (!trueRe.test(literal)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          snippet: literal.replace(/\s+/g, ' ').slice(0, 120),
          reason: 'options literal omits `disableHeaderExtraction: true` — library default reads the `x-tenant-id` header without authentication.',
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      'audit-tenant-isolation-invariant: FAIL — every tenantIsolation(...) callsite in src/ must pass `disableHeaderExtraction: true`:',
    );
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}`);
      console.error(`      reason: ${v.reason}`);
      console.error(`      snippet: ${v.snippet}`);
    }
    console.error(
      'Why: the security invariant of `extractIdentityContext`\'s `req.tenantContext` bridge ' +
        'depends on this flag. Without it, the unverified `x-tenant-id` header re-opens ' +
        'tenant impersonation. See src/services/governance/identityContext.ts JSDoc.',
    );
    return 1;
  }

  console.log(
    `audit-tenant-isolation-invariant: OK (${scannedCallsites} callsites scanned across ${trackedFiles.length} files)`,
  );
  return 0;
}

const CENTRAL_HELPER_NAME = 'mountCentralFamilyRoutes';

/**
 * Find every `mountCentralFamilyRoutes(...)` CALL in a source file, via the
 * TypeScript AST rather than text matching.
 *
 * Text scanning lost this argument repeatedly (Codex rounds 4, 6, 7): a regex
 * literal containing `//`, a nested template literal, or a string shaped like a
 * call or a declaration could each add or remove a match and rebalance the
 * parse tally, letting an unaudited mount through. The parser settles all of it
 * by construction — comments and string/template/regex contents are simply not
 * call expressions, and a `function mountCentralFamilyRoutes(` declaration is a
 * declaration, not a call, so it needs no special-casing.
 *
 * Returns one entry per call site. `mountPath` is the third argument when it is
 * a plain string literal, else null — a null is what the Drift D guard reports,
 * because a call whose prefix cannot be read statically mounts a family the
 * audit cannot see. `line` is 1-based so Drift D can name the exact call site
 * rather than only a count (Codex: a bare tally is not actionable).
 *
 * Detection is by NAME, resolved through the binding forms a refactor actually
 * produces: direct call, `new`, optional call, property or string-indexed
 * access, an import alias from the RouteSetup module, and a `const x = helper`
 * re-binding. Codex round 9 demonstrated the last three as fail-open before
 * they were handled.
 *
 * Known limit: a reference materialised at RUNTIME — returned from a function,
 * read from a computed key, or reassigned through a mutable binding — remains
 * untracked. Closing that needs a type checker rather than a syntax walk; it is
 * deliberate evasion rather than drift, and Drift A/B still constrain the result
 * whenever such a mount produces a manifest mismatch.
 *
 * @param {string} raw source text
 * @param {string} fileName for parser diagnostics only
 * @returns {{ mountPath: string|null, line: number }[]}
 */
function findCentralHelperCalls(raw, fileName) {
  const sourceFile = ts.createSourceFile(fileName, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Local names bound to the helper. Two binding forms are followed:
  //   import { mountCentralFamilyRoutes as m } from '.../RouteSetup'
  //   const m = mountCentralFamilyRoutes
  // The import form checks the MODULE SOURCE too — without it, an unrelated
  // `import { mountCentralFamilyRoutes as alien } from 'somewhere-else'` would
  // bind `alien` and every `alien(...)` call would be misread as a mount
  // (Codex: a false-positive class, fail-closed but still wrong).
  const helperNames = new Set([CENTRAL_HELPER_NAME]);
  const bindsHelperModule = (specifier) =>
    ts.isStringLiteral(specifier) && /(^|\/)RouteSetup(\.[jt]s)?$/.test(specifier.text);

  const collectAliases = (node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName ? node.propertyName.text : node.name.text;
      const declaration = node.parent?.parent?.parent;
      if (
        imported === CENTRAL_HELPER_NAME &&
        declaration &&
        ts.isImportDeclaration(declaration) &&
        bindsHelperModule(declaration.moduleSpecifier)
      ) {
        helperNames.add(node.name.text);
      }
    }
    // `const m = mountCentralFamilyRoutes;` — a plain re-binding, which is an
    // ordinary refactor rather than evasion, so follow it.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      helperNames.has(node.initializer.text)
    ) {
      helperNames.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  // Two passes: a `const m = <alias>` chain can be written before or after the
  // import that introduces <alias>.
  collectAliases(sourceFile);
  collectAliases(sourceFile);

  const calls = [];
  const visit = (node) => {
    // NewExpression as well as CallExpression: `new mountCentralFamilyRoutes(...)`
    // is nonsense TypeScript would reject, but the audit must not depend on the
    // type checker having run to stay closed (Codex).
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      let name = null;
      if (ts.isIdentifier(callee)) {
        name = callee.text;
      } else if (ts.isPropertyAccessExpression(callee)) {
        name = callee.name.text;
      } else if (ts.isElementAccessExpression(callee) && callee.argumentExpression &&
                 ts.isStringLiteral(callee.argumentExpression)) {
        // obj['mountCentralFamilyRoutes'](...)
        name = callee.argumentExpression.text;
      }
      if (name !== null && helperNames.has(name)) {
        const prefixArg = node.arguments?.[2];
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({
          mountPath:
            prefixArg && ts.isStringLiteral(prefixArg) ? prefixArg.text : null,
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/**
 * Remove comments while leaving string literals intact.
 *
 * The previous naive `raw.replace(/\/\/.*$/gm, '')` treats the `//` inside a
 * string such as `'https://example.test'` as the start of a line comment and
 * deletes the REST OF THE LINE — including any real mount or helper call that
 * follows it. That silently removed code from every scan below, and for the
 * Drift D parse-completeness counter it removed the call from BOTH the total
 * and the parsed tally at once, so the counts still matched and an unaudited
 * mount passed (Codex round 6).
 *
 * Newlines inside block comments are preserved so line numbering is unchanged.
 * Regex literals are not lexed; a regex containing an odd quote would be
 * mis-read as a string start, but that fails toward a count MISMATCH (a loud
 * Drift D failure), never toward a silent bypass.
 *
 * @param {string} src
 * @returns {string}
 */
function stripCommentsPreservingStrings(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 1; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 1; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 1; continue; }
      if (c === '\n') out += c;
      continue;
    }
    // Inside a string literal: copy through, honouring escapes.
    if (c === '\\') {
      out += c;
      if (c2 !== undefined) { out += c2; i += 1; }
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c;
  }
  return out;
}

/**
 * PR 4B tenant-coverage drift gate: bidirectional consistency check between
 * `src/middleware/setup/routeManifest.ts` (ROUTE_MANIFEST) and the
 * `this.app.use(...)` path-literal mounts in any of the MOUNT_SOURCE_FILES
 * (currently `src/middleware/setup/RouteSetup.ts` and `src/index.ts`).
 *
 * Returns 0 on success, 1 on drift, 2 on parse/IO failure.
 *
 * @param {string} rootDir absolute path to repo root (may be a temp copy)
 * @returns {number}
 */
function runTenantCoverageCheck(rootDir) {
  const manifestPath = path.join(rootDir, 'src/middleware/setup/routeManifest.ts');
  let manifestSource;
  try {
    manifestSource = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    console.error('audit-tenant-coverage: cannot read routeManifest.ts at', manifestPath);
    return 2;
  }

  // Parse manifest entries via regex on the typed array literal.
  // Matches: { path: '/api/foo', classification: 'tenant_required', ... }
  // (single-quoted path: + classification: — matches the exact style used in the file)
  const manifestPaths = new Set();
  const entryRe = /\{\s*path:\s*'([^']+)'\s*,\s*classification:\s*'([^']+)'/g;
  let m;
  while ((m = entryRe.exec(manifestSource)) !== null) {
    manifestPaths.add(m[1]);
  }

  if (manifestPaths.size === 0) {
    console.error('audit-tenant-coverage: ROUTE_MANIFEST parse failed — got 0 entries from', manifestPath);
    return 2;
  }

  // Source files that mount /api/* routes. Each one is scanned for
  // `*.app.use('<path>', ...)` literals AND `*.app.<method>('<path>', ...)`
  // single-endpoint registrations. Adding a new file that mounts /api/*
  // routes requires appending it here OR the audit will miss the drift.
  const MOUNT_SOURCE_FILES = [
    'src/middleware/setup/RouteSetup.ts',
    'src/index.ts',
  ];

  const sourcePaths = new Set();
  // Subset of sourcePaths mounted through the generic central-family helper.
  // Tracked separately because the /health policy-carrier exemption below must
  // key off THESE prefixes only — sourcePaths also holds exact single-endpoint
  // registrations (app.get('/api/statistics')), and keying off the whole set
  // would exempt '/api/statistics/health' and every other '<anything>/health'.
  const centralHelperMountPaths = new Set();
  // Parse-completeness accounting for the generic helper — see the guard below.
  // Call sites whose prefix is not a static string literal, as 'file:line' —
  // Drift D names them rather than reporting a bare count.
  const unreadableHelperCalls = [];
  for (const relPath of MOUNT_SOURCE_FILES) {
    const filePath = path.join(rootDir, relPath);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`audit-tenant-coverage: cannot read ${relPath} at ${filePath}`);
      return 2;
    }

    // Strip comments so commented-out mounts are not matched. Single-pass and
    // string-aware: it handles the line-before-block ordering hazard that the
    // former two-regex approach needed care about (a line comment containing a
    // bare `/*` fragment, as in RouteSetup.ts, would otherwise open a spurious
    // block comment eating hundreds of lines), and it does not mistake the `//`
    // inside a string literal for a comment.
    const stripped = stripCommentsPreservingStrings(raw);

    // Match path-literal arguments in:
    //   this.app.use('<path>'     — production source
    //   app.use('<path>'          — standalone function signatures
    //   _app.use('<path>'         — regression-test injection via synthetic function
    const useRe = /(?:this\.app|(?<!\w)app|_app)\.use\(\s*'([^']+)'/g;
    while ((m = useRe.exec(stripped)) !== null) {
      sourcePaths.add(m[1]);
    }

    // F5b generic central-family mount helper:
    //   mountCentralFamilyRoutes(this.app, tenantSvc, '<path>', router, allowlist)
    // Every F5 helper (mountHelpRoutes, mountCostTransparencyRoutes, ...) hardcodes
    // its own prefix, so the `app.use('<path>'` scan above still sees those. This
    // one takes the prefix as a PARAMETER, so without this pass all twelve central
    // families would read as Drift B even though they are genuinely mounted.
    //
    // Parsed from the AST, not the text. A call whose prefix is not a plain string
    // literal is counted but yields no path -- Drift D below rejects that, because
    // such a call mounts a family neither Drift A (the path never enters
    // sourcePaths) nor Drift C (mount source files are exempt) can see.
    for (const call of findCentralHelperCalls(raw, relPath)) {
      if (call.mountPath === null) {
        unreadableHelperCalls.push(`${relPath}:${call.line}`);
        continue;
      }
      sourcePaths.add(call.mountPath);
      centralHelperMountPaths.add(call.mountPath);
    }

    // Match single-endpoint registrations like `app.get('/api/statistics', ...)`.
    // Only matches /api/* paths to avoid false-positives on internal handler
    // routes inside routers (e.g. `router.get('/profile')` would have already
    // been rolled up under its parent mount path).
    const methodRe = /(?:this\.app|(?<!\w)app)\.(?:get|post|put|patch|delete)\(\s*'(\/api\/[^']+)'/g;
    while ((m = methodRe.exec(stripped)) !== null) {
      sourcePaths.add(m[1]);
    }
  }

  if (sourcePaths.size === 0) {
    console.error('audit-tenant-coverage: source parse failed — got 0 app.use path literals from mount source files');
    return 2;
  }

  // Paths exempt from the source→manifest direction:
  //   /health, /ready — framework-level liveness/readiness probes declared in the
  //     manifest for documentation completeness; the Express app binds them via
  //     a framework hook, not an explicit this.app.use('<path>', ...) call.
  // Pathless-mount routers (`this.app.use(<router>)` without a path string)
  //   don't appear in the source-mount scan, so their manifest entries are
  //   legitimately "missing from source". These exemptions document the gap.
  const EXEMPT_FROM_SOURCE_REQUIREMENT = new Set([
    '/health',
    '/ready',
    // Pathless-mount routers (`this.app.use(<router>)` without a path string).
    '/api/ai-config',
    '/api/sync-error-assist',
    // Sub-routes of bare `this.app.use('/api', <router>)` parents — the
    // sub-paths are defined inside the router (e.g. ConnectorCredentialRouter
    // declares `/connector-credentials`, `/connector-metadata`; connectorTest
    // declares `/test-connection`). The source-mount scan can only see the
    // bare `/api` parent (which is exempt from manifest below).
    '/api/connector-credentials',
    '/api/connector-metadata',
    '/api/test-connection',
    // Sub-routes of root `this.app.use('/', <router>)` parents — the
    // sub-paths are absolute /api/* literals defined inside each router
    // (configurationRouter declares `/api/configurations/*`;
    // enterpriseFeaturesRouter declares `/api/enterprise/*`). The
    // source-mount scan can only see the bare `/` parent (which is in
    // EXEMPT_FROM_MANIFEST_REQUIREMENT below).
    '/api/configurations',
    '/api/enterprise',
  ]);

  // Paths exempt from the manifest→source direction:
  //   /api  — bare prefix mount used by connectorCredential + connectorTest routers;
  //            those routers define their own full sub-paths internally.
  //   /     — configuration and mock routers mounted at root with full internal paths.
  const EXEMPT_FROM_MANIFEST_REQUIREMENT = new Set(['/api', '/']);

  const missingFromManifest = [...sourcePaths].filter(
    (p) => !manifestPaths.has(p) && !EXEMPT_FROM_MANIFEST_REQUIREMENT.has(p),
  );
  // F5b policy-carrier health prefixes: `<mountedPrefix>/health` is declared in
  // ROUTE_MANIFEST + ROUTE_POLICY_MANIFEST so each central family's health probe
  // can carry its own EXACT public policy on a LONGER prefix — a same-prefix
  // refinement cannot be proven disjoint by check-route-policy's
  // ANCHORED_LITERAL_SUBPATH rule. Nothing mounts these: the parent family mount
  // serves /health, so they can never appear in a mount scan.
  //
  // Derived from the central-family helper mounts rather than enumerated, which
  // keeps the check honest in both directions — a `/health` entry whose PARENT is
  // not a helper-mounted central family still fails Drift B — and means the four
  // Phase-2 families need no edit here. Keyed off centralHelperMountPaths, NOT
  // sourcePaths: the latter also contains exact endpoint registrations, so it
  // would wrongly exempt things like '/api/statistics/health'.
  const isPolicyCarrierHealthPrefix = (p) => {
    const parent = p.replace(/\/health$/, '');
    return parent !== p && centralHelperMountPaths.has(parent);
  };

  const missingFromSource = [...manifestPaths].filter(
    (p) =>
      !sourcePaths.has(p) &&
      !EXEMPT_FROM_SOURCE_REQUIREMENT.has(p) &&
      !isPolicyCarrierHealthPrefix(p),
  );

  let failed = false;
  if (unreadableHelperCalls.length > 0) {
    console.error(
      `audit-tenant-coverage: ${unreadableHelperCalls.length} mountCentralFamilyRoutes(...) call site(s) mount a family whose prefix is not a static string literal (Drift D — unparseable mount):`,
    );
    for (const site of unreadableHelperCalls.sort()) console.error('  - ' + site);
    console.error(
      "  The prefix is read from the call's THIRD argument via the TypeScript AST.",
    );
    console.error(
      '  A computed prefix — a variable, concatenation, or template — mounts a family',
    );
    console.error(
      '  this audit cannot name: the path never enters the discovered set, so Drift A',
    );
    console.error(
      '  cannot see it, and mount source files are exempt from the Drift C orphan scan.',
    );
    console.error('  Pass the prefix as a plain string literal at the call site.');
    failed = true;
  }
  if (missingFromManifest.length > 0) {
    console.error(
      'audit-tenant-coverage: paths mounted in source files but missing from ROUTE_MANIFEST (Drift A):',
    );
    for (const p of missingFromManifest.sort()) console.error('  - ' + p);
    failed = true;
  }
  if (missingFromSource.length > 0) {
    console.error(
      'audit-tenant-coverage: paths declared in ROUTE_MANIFEST but not found in any mount source file (Drift B):',
    );
    for (const p of missingFromSource.sort()) console.error('  - ' + p);
    failed = true;
  }

  // Self-discovery defense (Codex R3 residual): scan all tracked .ts files
  // under src/ for /api/* mount patterns. Any file NOT in MOUNT_SOURCE_FILES
  // that nonetheless contains `*.app.use('/api...` or
  // `*.app.<method>('/api...` is an orphan — adding it would silently
  // bypass the audit. Fail CI with a clear remediation message.
  {
    let trackedFiles = [];
    try {
      // execFileSync (no shell) — same portability fix Codex flagged on the
      // PR 2C-Auth invariant gate. Self-discovery is a softer check than
      // the invariant gate (it stays non-fatal on git unavailability), but
      // the spawn shape should match so both paths fail/succeed under the
      // same sandbox conditions.
      trackedFiles = _execFileSync('git', ['ls-files', 'src'], { cwd: rootDir, encoding: 'utf8' })
        .split('\n')
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    } catch {
      // git not available — skip the defense rather than break the audit.
      trackedFiles = [];
    }
    const expectedSet = new Set(MOUNT_SOURCE_FILES);
    // Files that legitimately use `app.use('/api', ...)` but are NOT
    // route-mount files: MiddlewareSetup.ts applies a version header to
    // the bare `/api` prefix — same as the existing `/api` exemption in
    // EXEMPT_FROM_MANIFEST_REQUIREMENT. Test files are also excluded since
    // they spin up local express apps for unit testing, not production mounts.
    const SELF_DISCOVERY_EXCLUDED = new Set([
      'src/middleware/setup/MiddlewareSetup.ts',
    ]);
    const orphanFiles = [];
    // Identifier-strict so we don't match `router.use('/api/...')` or
    // `subApp.use('/api/...')` (those would normally be inside a router file
    // mounted via app.use(router); only app/this.app top-level mounts matter).
    //
    // The trailing lookahead `(?=[/'"?)\s,])` requires the char AFTER `/api`
    // to be a path-component boundary (one of `/`, `'`, `"`, `?`, `)`,
    // whitespace, or `,`). This matches `app.use('/api', router)` (boundary
    // = `'`) AND `app.use('/api/foo', ...)` (boundary = `/`) BUT NOT
    // `app.use('/apiary', ...)` (next char = `a`, no false-positive). Per
    // Copilot R7 — tightens detection of bare-prefix `/api` mounts.
    const orphanRe = /(?:this\.app|(?<!\w)app)\.(?:use|get|post|put|patch|delete)\(\s*['"]\/api(?=[/'"?)\s,])/;

    // F5b: a generic-helper mount is just as invisible to the app.use scan as it
    // was to the Drift B scan. The helper is DEFINED in RouteSetup.ts (itself a
    // MOUNT_SOURCE_FILE), so any other src/ file CALLING it is mounting routes
    // outside the audited set — exactly the orphan condition. Test files are
    // already excluded by the caller. Detected from the AST, so a commented-out
    // or string-embedded mention cannot register a false orphan and none of the
    // lexical tricks that defeated text matching apply.
    for (const relPath of trackedFiles) {
      // Skip known non-route-mounting files and all test files.
      if (expectedSet.has(relPath)) continue;
      if (SELF_DISCOVERY_EXCLUDED.has(relPath)) continue;
      if (relPath.includes('__tests__') || relPath.includes('.test.ts') || relPath.includes('.spec.ts')) continue;
      const filePath = path.join(rootDir, relPath);
      let raw;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const stripped = stripCommentsPreservingStrings(raw);
      if (orphanRe.test(stripped) || findCentralHelperCalls(raw, relPath).length > 0) {
        orphanFiles.push(relPath);
      }
    }
    if (orphanFiles.length > 0) {
      console.error(
        'audit-tenant-coverage: files contain /api/* mount patterns but are NOT in MOUNT_SOURCE_FILES (Drift C — self-discovery):',
      );
      for (const p of orphanFiles.sort()) console.error('  - ' + p);
      console.error('Append the file path(s) to MOUNT_SOURCE_FILES in scripts/audit-status-claims.mjs, then re-run.');
      failed = true;
    }
  }

  if (failed) {
    console.error('audit-tenant-coverage: FAIL');
    return 1;
  }

  console.log(
    `audit-tenant-coverage: OK (${manifestPaths.size} manifest entries; ` +
      `${sourcePaths.size} source mounts)`,
  );
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root;
  const items = scanConnectors(root);
  const errors = [];

  // Per-connector contract checks
  for (const item of items) {
    if (!item.productionStatus) {
      errors.push(`${item.file}: missing static productionStatus field`);
      continue;
    }
    if (!VALID_STATUSES.has(item.productionStatus)) {
      errors.push(
        `${item.file}: productionStatus '${item.productionStatus}' is not one of ${[...VALID_STATUSES].join(', ')}`,
      );
    }
    if (!item.statusEvidence || item.statusEvidence.trim() === '') {
      errors.push(`${item.file}: missing static statusEvidence string`);
    }
    if (item.productionStatus === 'production' && !item.proofCard) {
      errors.push(
        `${item.file}: productionStatus='production' requires a static proofCard pointing at ${PROOF_CARD_DIR}<name>.md`,
      );
    }
    if (item.proofCard) {
      if (!item.proofCard.startsWith(PROOF_CARD_DIR)) {
        errors.push(
          `${item.file}: proofCard '${item.proofCard}' must live under ${PROOF_CARD_DIR}`,
        );
      } else if (!item.proofCard.endsWith('.md')) {
        errors.push(
          `${item.file}: proofCard '${item.proofCard}' must end with .md (Markdown proof-card file)`,
        );
      } else {
        // Reject any path that escapes the proof-cards directory or is not a
        // single file (e.g. trailing '/', '..' segments, or empty filename).
        const remainder = item.proofCard.slice(PROOF_CARD_DIR.length);
        if (
          remainder === '' ||
          remainder.startsWith('/') ||
          remainder.includes('/') ||
          remainder.split('/').some((seg) => seg === '..' || seg === '.')
        ) {
          errors.push(
            `${item.file}: proofCard '${item.proofCard}' must be a single .md file directly under ${PROOF_CARD_DIR}`,
          );
        } else if (options.checkProofCards) {
          // Phase 4 wires --check-proof-cards into CI to gate dead-link
          // proofCard paths. Without the flag we only verify the path string
          // is well-formed because the cards do not yet exist in Phase 3.
          const absolutePath = path.resolve(root, item.proofCard);
          if (!fs.existsSync(absolutePath)) {
            errors.push(
              `${item.file}: proofCard '${item.proofCard}' does not exist on disk (file not found at ${rel(root, absolutePath)})`,
            );
          }
        }
      }
    }
  }

  // PR 6A: cross-check against connector registry
  if (options.checkWiredConnectors) {
    const registryErrors = checkRegistry(root, items, options.checkProofCards);
    errors.push(...registryErrors);
    const wiringErrors = checkWiringDrift(root);
    errors.push(...wiringErrors);
  }

  // PR 4B: tenant-coverage drift gate (runs independently, exits early on parse failure)
  if (options.checkTenantCoverage) {
    const code = runTenantCoverageCheck(root);
    if (code !== 0) process.exit(code);
  }

  // PR 2C-Auth: tenant-isolation-invariant drift gate (runs independently)
  if (options.checkTenantIsolationInvariant) {
    const code = runTenantIsolationInvariantCheck(root);
    if (code !== 0) process.exit(code);
  }

  // PR 2C-Auth R8 (Copilot): short-circuit when ONLY tenant gates were
  // requested. Without this, `npm run audit-tenant-coverage` and
  // `npm run audit-tenant-isolation-invariant` fall through to the
  // connector + metrics audit below, which (a) duplicates work covered
  // by the separate `npm run audit-status-claims` CI step and (b)
  // creates misleading step names when an unrelated check fails (e.g.
  // the "Audit tenant-isolation-invariant" CI step would report metric
  // drift as if it were a tenant-isolation issue).
  //
  // Short-circuit predicate: a "main" check was requested (proof-cards
  // or wired-connectors). If neither, we're in tenant-only mode — exit 0
  // after the tenant checks passed.
  const mainCheckRequested =
    options.checkProofCards || options.checkWiredConnectors;
  const tenantOnlyMode =
    (options.checkTenantCoverage || options.checkTenantIsolationInvariant) &&
    !mainCheckRequested;
  if (tenantOnlyMode) {
    return;
  }

  // Cross-check against metrics.json
  const metricsPath = path.resolve(root, options.metrics);
  if (!fs.existsSync(metricsPath)) {
    errors.push(`${rel(root, metricsPath)}: missing — run \`npm run metrics:generate\``);
  } else {
    const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    /** @type {Record<string, number>} */
    const counts = { production: 0, beta: 0, demo_only: 0, stub: 0 };
    for (const item of items) {
      if (item.productionStatus && VALID_STATUSES.has(item.productionStatus)) {
        counts[item.productionStatus] += 1;
      }
    }
    for (const key of Object.keys(counts)) {
      const claimed = metrics?.connectors?.[key];
      if (claimed !== counts[key]) {
        errors.push(
          `metrics.json connectors.${key} = ${claimed} but source-level scan found ${counts[key]}; regenerate via \`npm run metrics:generate\``,
        );
      }
    }
    const claimedUnknown = metrics?.connectors?.unknown;
    if (claimedUnknown !== 0) {
      errors.push(
        `metrics.json connectors.unknown = ${claimedUnknown} but Phase 3 requires 0; regenerate via \`npm run metrics:generate\` after tagging all connectors`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('audit-status-claims: FAIL');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  /** @type {Record<string, number>} */
  const summary = {};
  for (const item of items) {
    const key = item.productionStatus ?? 'unknown';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  const partition = ['production', 'beta', 'demo_only', 'stub']
    .map((k) => `${k}=${summary[k] ?? 0}`)
    .join(' ');
  console.log(`audit-status-claims: OK (${items.length} connectors; ${partition})`);
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
