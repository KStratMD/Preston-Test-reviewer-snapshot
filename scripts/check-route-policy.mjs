#!/usr/bin/env node
/**
 * check-route-policy.mjs (PR-F0) — blocking audit for the Route Policy
 * Manifest. Design: docs/superpowers/specs/
 * 2026-07-17-tenant-auth-strictmode-migration-design.md §D5-F0.
 *
 * Checks (each tagged in output):
 *   POLICY_COVERAGE            every ROUTE_MANIFEST path has >=1 policy
 *   ORPHAN_POLICY              every policy prefix exists in ROUTE_MANIFEST
 *   BASE_POLICY                exactly one base (unscoped) policy per prefix
 *   CLASSIFICATION_CONSISTENCY base policy agrees with the classification
 *   RATE_PROFILE_KEY           rateProfile is a RATE_PROFILES key
 *   AMBIGUOUS_OVERLAP          no statically-unorderable overlapping policies
 *   SYSTEM_IDENTITY            extractIdentityContext route-file ratchet
 *   TRANSITIVE_SYSTEM_IDENTITY  AST-verified HTTP wrapper/import graph
 *
 * Policy<->mount consistency is transitive: this gate pins policy<->manifest
 * set equality, and `npm run audit-tenant-coverage` pins manifest<->mounts.
 *
 * Loads the REAL TypeScript modules via typescript.transpileModule + vm so
 * the audit can never drift from the source semantics (same reason
 * check-mirror-reproducibility imports selectFiles()). Both modules are
 * import-free by contract; routeManifest's lazy Logger require only fires
 * inside classifyRoute(), which this script never calls.
 *
 * Exit: 0 OK, 1 violation, 2 parse/IO/config failure (fail closed).
 * Flags: --root <dir> (fixture testing), --write (re-stamp the
 * SYSTEM_IDENTITY baseline to the current scan — shrinkage is routine;
 * using it to record an ADDITION requires sign-off + a PR-body note, same
 * as raising any budget ratchet), --forbid-system-identity-fallback (F6
 * wiring: fail while the baseline is non-empty).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { root: '.', write: false, forbidSystemIdentity: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--write') args.write = true;
    else if (argv[i] === '--forbid-system-identity-fallback') args.forbidSystemIdentity = true;
    else {
      console.error(`check-route-policy: unknown flag ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.root) {
    console.error('check-route-policy: --root requires a value');
    process.exit(2);
  }
  return args;
}

/** Transpile a TS module to CJS and evaluate it in an isolated context. */
function loadTsModule(tsPath) {
  let ts;
  try {
    ts = require('typescript');
  } catch {
    console.error('check-route-policy: cannot load the typescript package');
    process.exit(2);
  }
  let source;
  try {
    source = fs.readFileSync(tsPath, 'utf8');
  } catch {
    console.error(`check-route-policy: cannot read ${tsPath}`);
    process.exit(2);
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const moduleShim = { exports: {} };
  const sandbox = {
    module: moduleShim,
    exports: moduleShim.exports,
    require: (id) => {
      throw new Error(`unexpected require('${id}') while loading ${tsPath}`);
    },
  };
  try {
    vm.runInNewContext(outputText, sandbox, { filename: tsPath, timeout: 5000 });
  } catch (err) {
    console.error(`check-route-policy: failed to evaluate ${tsPath}: ${err.message}`);
    process.exit(2);
  }
  return moduleShim.exports;
}

/**
 * AMBIGUOUS_OVERLAP (Codex condition, 2026-07-18 review): reject any pair of
 * policies that can both match one request without a strict specificity
 * ordering. Nested prefixes order by length; equal prefixes must be split by
 * disjoint methods, by exactly one scoping dimension, or by
 * statically-disjoint anchored-literal subpaths — single- or multi-segment
 * (^\/<segment>(\/|$) or ^\/<seg>\/<sub>(\/|$)).
 */
// Multi-segment anchored literals are provable too (F2): ^\/a\/b(\/|$).
// Two literals are disjoint iff NEITHER segment list is a prefix of the
// other — /^\/mapping(\/|$)/ matches everything /^\/mapping\/suggestions(\/|$)/
// matches, so nesting is NOT disjoint and stays flagged.
const ANCHORED_LITERAL_SUBPATH = /^\^((?:\\\/[A-Za-z0-9_-]+)+)\(\\\/\|\$\)$/;

const literalSegments = (lit) => lit[1].split('\\/').filter((s) => s.length > 0);
const isSegmentPrefix = (a, b) => a.length <= b.length && a.every((seg, i) => seg === b[i]);

function checkAmbiguousOverlaps(policies, errors) {
  const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  const methodsOf = (p) => p.match.methods ?? ALL_METHODS;
  const describe = (p) => {
    const m = p.match;
    return `{prefix '${m.pathPrefix}'${m.methods ? `, methods [${m.methods.join(',')}]` : ''}${m.subpath ? `, subpath ${m.subpath.source ?? m.subpath}` : ''}}`;
  };
  for (let i = 0; i < policies.length; i++) {
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i];
      const b = policies[j];
      if (a.match.pathPrefix !== b.match.pathPrefix) continue; // nested prefixes: length-ordered
      const sharedMethods = methodsOf(a).filter((m) => methodsOf(b).includes(m));
      if (sharedMethods.length === 0) continue; // verb-disjoint
      const aSub = a.match.subpath;
      const bSub = b.match.subpath;
      if (!!aSub !== !!bSub) continue; // subpath dimension strictly orders the pair
      if (aSub && bSub) {
        // Static disjointness is only provable for FLAGLESS anchored
        // literals: /^\/run(\/|$)/i and /^\/RUN(\/|$)/ share matches even
        // though their sources' literal segments differ, so any flag on
        // either side voids the proof (Codex F0 review, blocking #3).
        const aFlagless = (aSub.flags ?? '') === '';
        const bFlagless = (bSub.flags ?? '') === '';
        const aLit = aFlagless ? ANCHORED_LITERAL_SUBPATH.exec(aSub.source ?? '') : null;
        const bLit = bFlagless ? ANCHORED_LITERAL_SUBPATH.exec(bSub.source ?? '') : null;
        if (aLit && bLit) {
          const aSegs = literalSegments(aLit);
          const bSegs = literalSegments(bLit);
          if (!isSegmentPrefix(aSegs, bSegs) && !isSegmentPrefix(bSegs, aSegs)) continue; // statically disjoint literals
        }
        // Method-presence still orders the pair (resolver specificity
        // component 3), so a methods-scoped refinement over a methods-open
        // one is not ambiguous even when their subpaths may intersect.
        if (!!a.match.methods !== !!b.match.methods) continue;
        errors.push(
          `AMBIGUOUS_OVERLAP: ${describe(a)} vs ${describe(b)} — subpath overlap is not statically decidable; ` +
            'use anchored literals (^\\/<segment>(\\/|$) or ^\\/<seg>\\/<sub>(\\/|$)) whose segment lists do not prefix each other, or split by disjoint methods',
        );
        continue;
      }
      // Same prefix, overlapping methods, same subpath-absence: only the
      // methods dimension is left, and one side having methods while the
      // other does not is the ONLY strict order it provides.
      if (!!a.match.methods === !!b.match.methods) {
        errors.push(
          `AMBIGUOUS_OVERLAP: ${describe(a)} vs ${describe(b)} — overlapping methods [${sharedMethods.join(',')}] with equal specificity`,
        );
      }
    }
  }
}

/**
 * SYSTEM_IDENTITY ratchet — design §D5-F0(c): report + pin which route files
 * still reach extractIdentityContext (the SYSTEM_IDENTITY HTTP-fallback
 * surface). Baseline: .route-system-identity-baseline. Additions fail
 * (backslide); removals fail until re-stamped with --write (the shrinking
 * ledger IS the F-series progress record). F6's exit criterion: empty
 * baseline, then --forbid-system-identity-fallback goes on in CI.
 * Demo-surface allowances (fixtureConnectors etc.) are decided in their
 * family PRs — until then every route file counts.
 * Returns 0 or 2 (violations go into `errors`).
 */
function checkSystemIdentityRatchet(rootDir, args, errors) {
  const baselinePath = path.join(rootDir, '.route-system-identity-baseline');

  let routeFiles = [];
  try {
    routeFiles = execFileSync('git', ['ls-files', 'src/routes'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  } catch {
    routeFiles = [];
  }
  if (routeFiles.length === 0) {
    // Fixture roots (--root tempdir) are not git repos — walk the directory.
    // Walk failures are FATAL (exit 2): an unreadable src/routes must not
    // degrade into "zero callsites", which would let a new fallback route
    // slide past the ratchet (Codex F0 review, blocking #4).
    const walk = (dir) => {
      let out = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out = out.concat(walk(full));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
      }
      return out;
    };
    try {
      routeFiles = walk(path.join(rootDir, 'src/routes')).map((f) =>
        path.relative(rootDir, f).split(path.sep).join('/'),
      );
    } catch (err) {
      console.error(`check-route-policy: cannot enumerate src/routes under ${rootDir}: ${err.message}`);
      return 2;
    }
  }

  const current = new Set();
  for (const rel of routeFiles) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    } catch (err) {
      // Fail closed — an unreadable route file could hide a new callsite.
      console.error(`check-route-policy: cannot read route file ${rel}: ${err.message}`);
      return 2;
    }
    // Line comments BEFORE block comments — same ordering rationale as
    // runTenantCoverageCheck in audit-status-claims.mjs.
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // PR-F5b-3 removed the F5b `resolveCentralTenantId` clause: that helper no
    // longer resolves anything to SYSTEM_IDENTITY (attested anonymous demo
    // reads now resolve to CENTRAL_DEMO_TENANT_ID, where the fixtures are
    // seeded), so counting its callers would no longer track what this ratchet
    // measures — HTTP handlers that can reach the system identity.
    if (/\bextractIdentityContext\s*\(/.test(stripped)) current.add(rel);
  }

  let baselineRaw;
  try {
    baselineRaw = fs.readFileSync(baselinePath, 'utf8');
  } catch {
    if (args.write) baselineRaw = '';
    else {
      console.error(`check-route-policy: baseline missing at ${baselinePath} (run with --write to create)`);
      return 2;
    }
  }
  const baseline = new Set(
    baselineRaw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );

  const added = [...current].filter((f) => !baseline.has(f)).sort();
  const removed = [...baseline].filter((f) => !current.has(f)).sort();

  if (args.write) {
    fs.writeFileSync(baselinePath, [...current].sort().join('\n') + (current.size ? '\n' : ''));
    console.log(`check-route-policy: baseline re-stamped (${current.size} route file(s))`);
  } else {
    for (const f of added) {
      errors.push(
        `SYSTEM_IDENTITY: NEW extractIdentityContext callsite in '${f}' — the F-series forbids widening the fallback surface; migrate the route or (only with sign-off) re-stamp with --write`,
      );
    }
    for (const f of removed) {
      errors.push(
        `SYSTEM_IDENTITY: '${f}' no longer calls extractIdentityContext — re-stamp the shrunken baseline with --write (improvement)`,
      );
    }
  }

  if (args.forbidSystemIdentity && current.size > 0) {
    errors.push(
      `SYSTEM_IDENTITY: ${current.size} route file(s) still call extractIdentityContext — F6 requires zero`,
    );
  }

  console.log(
    `check-route-policy: SYSTEM_IDENTITY fallback surface = ${current.size} route file(s)` +
      (current.size ? ' (F-final exit criterion: 0)' : ' — F6 exit criterion MET'),
  );
  return 0;
}

/**
 * F6 PR4 Stage 3 / design §4 D3 inventory. Keep this as data so a renamed
 * HTTP-reachable wrapper fails the audit instead of silently leaving the graph
 * unobserved. The legacy extractor implementation is the sole reviewed direct
 * caller; every other direct or transitive call is a policy violation.
 */
const TRANSITIVE_HTTP_INVENTORY = Object.freeze([
  {
    id: 'resolveActor',
    module: 'src/services/governance/resolveActor.ts',
    exportedSymbol: 'resolveActor',
    extractor: {
      module: 'src/services/governance/identityContext.ts',
      symbol: 'extractIdentityContext',
    },
    mountEvidence: {
      files: [
        'src/routes/financeCentral.ts',
        'src/routes/payment-central/gl.router.ts',
        'src/routes/payment-central/invoices.router.ts',
        'src/routes/supplierCentral.ts',
      ],
      symbols: ['resolveActor'],
    },
    posture: { forbids: ['body actor', 'request-path SYSTEM_IDENTITY fallback'] },
  },
  {
    id: 'makeTenantStatusGate',
    module: 'src/middleware/tenantStatusGate.ts',
    exportedSymbol: 'makeTenantStatusGate',
    extractor: {
      module: 'src/services/governance/identityContext.ts',
      symbol: 'extractIdentityContext',
    },
    mountEvidence: {
      files: ['src/middleware/setup/RouteSetup.ts', 'src/routes/governance/approvalsRouter.ts'],
      symbols: ['mountCentralFamilyRoutes', 'makeTenantStatusGate'],
    },
    posture: { forbids: ['implicit tenant identity from an unverified request'] },
  },
  {
    id: 'createGovernanceMiddleware',
    module: 'src/middleware/governanceMiddleware.ts',
    exportedSymbol: 'createGovernanceMiddleware',
    extractor: {
      module: 'src/services/governance/identityContext.ts',
      symbol: 'extractIdentityContext',
    },
    mountEvidence: {
      files: ['src/routes/aiProxy.ts', 'src/middleware/setup/RouteSetup.ts'],
      symbols: ['createAIProxyRouter', 'createGovernanceMiddleware'],
    },
    posture: { forbids: ['implicit SYSTEM_IDENTITY actor for HTTP requests'] },
  },
  {
    id: 'handleApprovalQueueError',
    module: 'src/middleware/governance/approvalQueueErrorHandler.ts',
    exportedSymbol: 'handleApprovalQueueError',
    extractor: {
      module: 'src/services/governance/identityContext.ts',
      symbol: 'extractIdentityContext',
    },
    mountEvidence: {
      files: ['src/routes/aiMapping.ts', 'src/routes/aiDemo.ts', 'src/routes/governance/approvalsRouter.ts'],
      symbols: ['handleApprovalQueueError', 'enqueueAndRespond'],
    },
    posture: { forbids: ['durable enqueue without verified tenant and user'] },
  },
]);

const TRANSITIVE_EXTRACTOR_MODULE = 'src/services/governance/identityContext.ts';
const TRANSITIVE_EXTRACTOR_NAME = 'extractIdentityContext';

function normalizeSourcePath(rel) {
  return rel.split(path.sep).join('/');
}

function walkTypeScriptSources(dir) {
  const output = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walkTypeScriptSources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) output.push(full);
  }
  return output;
}

function enumerateTransitiveSources(rootDir) {
  try {
    const tracked = execFileSync('git', ['ls-files', 'src'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((file) => file.trim())
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .map(normalizeSourcePath);
    if (tracked.length > 0) return tracked;
  } catch {
    // Fixture roots are not git repositories; use the filesystem walk below.
  }

  const srcRoot = path.join(rootDir, 'src');
  try {
    return walkTypeScriptSources(srcRoot)
      .map((file) => normalizeSourcePath(path.relative(rootDir, file)))
      .sort();
  } catch (err) {
    console.error(`check-route-policy: cannot enumerate TypeScript sources under ${srcRoot}: ${err.message}`);
    return null;
  }
}

function transitiveDiagnosticText(ts, diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function resolveTransitiveModule(rootDir, sourceRel, specifier) {
  if (!specifier.startsWith('.')) return null;

  const base = path.resolve(rootDir, path.dirname(sourceRel), specifier);
  const extension = path.extname(base);
  const sourceStem = ['.js', '.jsx', '.mjs'].includes(extension)
    ? base.slice(0, base.lastIndexOf('.'))
    : base;
  const candidates = [
    base,
    sourceStem,
    `${sourceStem}.ts`,
    `${sourceStem}.tsx`,
    path.join(sourceStem, 'index.ts'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts')) {
        return normalizeSourcePath(path.relative(rootDir, candidate));
      }
    } catch {
      // Try the next TypeScript resolution candidate.
    }
  }
  return undefined;
}

function isTransitiveHttpRoot(sourceRel, inventoryModules) {
  return (sourceRel.startsWith('src/routes/') && !sourceRel.includes('/__tests__/')) ||
    sourceRel.startsWith('src/middleware/') ||
    inventoryModules.has(sourceRel);
}

function exportedSymbolsOf(ts, sourceFile) {
  const exported = new Set();
  const hasExportModifier = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      exported.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
      }
    }
    if (ts.isClassDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      exported.add(statement.name.text);
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) {
      for (const element of statement.exportClause?.elements ?? []) {
        exported.add(element.name.text);
      }
    }
  }
  return exported;
}

function validateTransitiveInventory() {
  const fatal = [];
  for (const entry of TRANSITIVE_HTTP_INVENTORY) {
    if (entry.extractor?.module !== TRANSITIVE_EXTRACTOR_MODULE ||
      entry.extractor?.symbol !== TRANSITIVE_EXTRACTOR_NAME) {
      fatal.push(`TRANSITIVE_INVENTORY: '${entry.id}' must use the reviewed extractor definition`);
    }
    if (!Array.isArray(entry.mountEvidence?.files) || entry.mountEvidence.files.length === 0 ||
      !Array.isArray(entry.mountEvidence?.symbols) || entry.mountEvidence.symbols.length === 0) {
      fatal.push(`TRANSITIVE_INVENTORY: '${entry.id}' is missing structured mount evidence`);
    }
    if (!Array.isArray(entry.posture?.forbids) || entry.posture.forbids.length === 0) {
      fatal.push(`TRANSITIVE_INVENTORY: '${entry.id}' is missing structured posture constraints`);
    }
  }
  return fatal;
}

function checkTransitiveIdentityPolicy(rootDir, errors) {
  let ts;
  try {
    ts = require('typescript');
  } catch {
    console.error('check-route-policy: cannot load the typescript package for the transitive identity check');
    return 2;
  }

  const sourceFiles = enumerateTransitiveSources(rootDir);
  if (sourceFiles === null || sourceFiles.length === 0) {
    console.error('check-route-policy: transitive identity scan found no TypeScript sources');
    return 2;
  }

  const inventoryValidation = validateTransitiveInventory();
  if (inventoryValidation.length > 0) {
    for (const message of inventoryValidation) console.error(`check-route-policy: ${message}`);
    return 2;
  }

  const inventoryModules = new Set(TRANSITIVE_HTTP_INVENTORY.map((entry) => entry.module));
  const records = new Map();
  const fatal = [];

  for (const sourceRel of sourceFiles) {
    const absolute = path.join(rootDir, sourceRel);
    let raw;
    try {
      raw = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
      fatal.push(`TRANSITIVE_PARSE: cannot read '${sourceRel}': ${err.message}`);
      continue;
    }

    const sourceFile = ts.createSourceFile(
      absolute,
      raw,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (sourceFile.parseDiagnostics?.length) {
      fatal.push(
        `TRANSITIVE_PARSE: cannot parse '${sourceRel}': ${sourceFile.parseDiagnostics
          .map((diagnostic) => transitiveDiagnosticText(ts, diagnostic))
          .join('; ')}`,
      );
      continue;
    }

    const record = {
      sourceRel,
      sourceFile,
      edges: new Set(),
      bindings: new Map(),
      extractorNamedBindings: new Set(),
      extractorNamespaceBindings: new Set(),
      directExtractorCalls: [],
      unsupportedExtractorReferences: [],
      unsupportedImportExpressions: [],
    };

    const addLocalEdge = (specifier, node) => {
      if (!specifier.startsWith('.')) return null;
      if (specifier.endsWith('.json')) {
        const dataPath = path.resolve(rootDir, path.dirname(sourceRel), specifier);
        try {
          if (fs.statSync(dataPath).isFile()) return null;
        } catch {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          fatal.push(
            `TRANSITIVE_IMPORT: unresolved local import '${specifier}' from '${sourceRel}' at line ${line}`,
          );
        }
        return null;
      }
      const target = resolveTransitiveModule(rootDir, sourceRel, specifier);
      if (target === undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        fatal.push(
          `TRANSITIVE_IMPORT: unresolved local import '${specifier}' from '${sourceRel}' at line ${line}`,
        );
        return null;
      }
      record.edges.add(target);
      return target;
    };

    const inspectImportDeclaration = (node) => {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        if (isTransitiveHttpRoot(sourceRel, inventoryModules)) {
          fatal.push(`TRANSITIVE_IMPORT: unsupported local import expression in '${sourceRel}'`);
        }
        return;
      }
      const specifier = node.moduleSpecifier.text;
      const target = addLocalEdge(specifier, node.moduleSpecifier);
      if (!target || !node.importClause || node.importClause.isTypeOnly) return;

      const clause = node.importClause;
      if (clause.name) {
        record.bindings.set(clause.name.text, { target, importedName: 'default', kind: 'default' });
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        record.bindings.set(clause.namedBindings.name.text, { target, importedName: '*', kind: 'namespace' });
        if (target === TRANSITIVE_EXTRACTOR_MODULE) {
          record.extractorNamespaceBindings.add(clause.namedBindings.name.text);
        }
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = (element.propertyName ?? element.name).text;
          record.bindings.set(element.name.text, { target, importedName, kind: 'named' });
          if (target === TRANSITIVE_EXTRACTOR_MODULE && importedName === TRANSITIVE_EXTRACTOR_NAME) {
            record.extractorNamedBindings.add(element.name.text);
          }
        }
      }
    };

    const visitImportsAndCalls = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (ts.isImportDeclaration(node)) inspectImportDeclaration(node);
        else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          addLocalEdge(node.moduleSpecifier.text, node.moduleSpecifier);
        }
        return;
      }

      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) {
            addLocalEdge(argument.text, argument);
          } else if (isTransitiveHttpRoot(sourceRel, inventoryModules)) {
            record.unsupportedImportExpressions.push(node);
          }
        }
        if (ts.isIdentifier(expression) && expression.text === 'require') {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) {
            addLocalEdge(argument.text, argument);
          } else if (isTransitiveHttpRoot(sourceRel, inventoryModules)) {
            record.unsupportedImportExpressions.push(node);
          }
        }

        const isNamedExtractor = ts.isIdentifier(expression) &&
          (expression.text === TRANSITIVE_EXTRACTOR_NAME || record.extractorNamedBindings.has(expression.text));
        const isNamespaceExtractor = ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          record.extractorNamespaceBindings.has(expression.expression.text) &&
          expression.name.text === TRANSITIVE_EXTRACTOR_NAME;
        if (isNamedExtractor || isNamespaceExtractor) {
          record.directExtractorCalls.push(node);
        }
      }

      if (ts.isIdentifier(node)) {
        const binding = record.bindings.get(node.text);
        const parent = node.parent;
        const isNamedExtractorReference = record.extractorNamedBindings.has(node.text) || node.text === TRANSITIVE_EXTRACTOR_NAME;
        const isDirectCallee = ts.isCallExpression(parent) && parent.expression === node;
        if (binding && isNamedExtractorReference && !isDirectCallee) {
          record.unsupportedExtractorReferences.push(node);
        }
      }
      if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        record.extractorNamespaceBindings.has(node.expression.text) &&
        node.name.text === TRANSITIVE_EXTRACTOR_NAME &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        record.unsupportedExtractorReferences.push(node);
      }

      node.forEachChild(visitImportsAndCalls);
    };

    sourceFile.forEachChild(visitImportsAndCalls);
    records.set(sourceRel, record);
  }

  if (fatal.length > 0) {
    for (const message of fatal) console.error(`check-route-policy: ${message}`);
    return 2;
  }

  for (const entry of TRANSITIVE_HTTP_INVENTORY) {
    const record = records.get(entry.module);
    if (!record) {
      fatal.push(`TRANSITIVE_INVENTORY: missing module '${entry.module}' for '${entry.id}'`);
      continue;
    }
    if (!exportedSymbolsOf(ts, record.sourceFile).has(entry.exportedSymbol)) {
      fatal.push(
        `TRANSITIVE_INVENTORY: '${entry.module}' no longer exports '${entry.exportedSymbol}' ` +
          `(mounts: ${entry.mountEvidence.files.join(', ')}; forbids: ${entry.posture.forbids.join(', ')})`,
      );
    }
  }
  if (fatal.length > 0) {
    for (const message of fatal) console.error(`check-route-policy: ${message}`);
    return 2;
  }

  for (const record of records.values()) {
    if (record.unsupportedImportExpressions.length > 0) {
      const line = record.sourceFile.getLineAndCharacterOfPosition(
        record.unsupportedImportExpressions[0].getStart(record.sourceFile),
      ).line + 1;
      fatal.push(
        `TRANSITIVE_IMPORT: unsupported local import expression in '${record.sourceRel}' at line ${line}`,
      );
    }
  }
  if (fatal.length > 0) {
    for (const message of fatal) console.error(`check-route-policy: ${message}`);
    return 2;
  }

  const allowedExtractorModules = new Set([TRANSITIVE_EXTRACTOR_MODULE]);
  const directFallbackModules = new Set();
  for (const record of records.values()) {
    if (record.unsupportedExtractorReferences.length > 0) {
      const line = record.sourceFile.getLineAndCharacterOfPosition(
        record.unsupportedExtractorReferences[0].getStart(record.sourceFile),
      ).line + 1;
      fatal.push(
        `TRANSITIVE_IMPORT: unsupported extractIdentityContext reference in '${record.sourceRel}' at line ${line}`,
      );
    }
    if (record.directExtractorCalls.length > 0 && !allowedExtractorModules.has(record.sourceRel)) {
      directFallbackModules.add(record.sourceRel);
      const line = record.sourceFile.getLineAndCharacterOfPosition(
        record.directExtractorCalls[0].getStart(record.sourceFile),
      ).line + 1;
      errors.push(
        `TRANSITIVE_SYSTEM_IDENTITY: direct extractIdentityContext call in '${record.sourceRel}' at line ${line} — only '${TRANSITIVE_EXTRACTOR_MODULE}' may define the legacy extractor`,
      );
    }
  }
  if (fatal.length > 0) {
    for (const message of fatal) console.error(`check-route-policy: ${message}`);
    return 2;
  }

  const roots = [...records.keys()].filter((sourceRel) =>
    (sourceRel.startsWith('src/routes/') && !sourceRel.includes('/__tests__/')) || inventoryModules.has(sourceRel),
  );
  const reported = new Set();
  for (const root of roots) {
    const record = records.get(root);
    for (const edge of record?.edges ?? []) {
      if (!directFallbackModules.has(edge)) continue;
      const key = `${root}\0${edge}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const wrapper = TRANSITIVE_HTTP_INVENTORY.find((entry) => entry.module === edge);
      errors.push(
        `TRANSITIVE_SYSTEM_IDENTITY: HTTP root '${root}' reaches extractIdentityContext through '${edge}'` +
          (wrapper ? ` via inventory '${wrapper.id}'` : '') +
          ' — remove the request-path fallback',
      );
    }
  }

  return 0;
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.root);

  const policyMod = loadTsModule(path.join(rootDir, 'src/middleware/setup/routePolicy.ts'));
  const manifestMod = loadTsModule(path.join(rootDir, 'src/middleware/setup/routeManifest.ts'));

  const policies = policyMod.ROUTE_POLICY_MANIFEST;
  const rateProfiles = policyMod.RATE_PROFILES;
  const manifest = manifestMod.ROUTE_MANIFEST;

  if (!Array.isArray(policies) || policies.length === 0) {
    console.error('check-route-policy: ROUTE_POLICY_MANIFEST is empty or not an array');
    process.exit(2);
  }
  if (!rateProfiles || Object.keys(rateProfiles).length === 0) {
    console.error('check-route-policy: RATE_PROFILES is empty');
    process.exit(2);
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('check-route-policy: ROUTE_MANIFEST is empty or not an array');
    process.exit(2);
  }

  const errors = [];

  // --- POLICY_COVERAGE + ORPHAN_POLICY: set equality on prefixes ---
  const manifestPaths = new Set(manifest.map((e) => e.path));
  const policyPrefixes = new Set(policies.map((p) => p.match.pathPrefix));
  for (const p of [...manifestPaths].filter((x) => !policyPrefixes.has(x)).sort()) {
    errors.push(`POLICY_COVERAGE: ROUTE_MANIFEST path '${p}' has no policy entry`);
  }
  for (const p of [...policyPrefixes].filter((x) => !manifestPaths.has(x)).sort()) {
    errors.push(`ORPHAN_POLICY: policy prefix '${p}' has no ROUTE_MANIFEST entry`);
  }

  // --- BASE_POLICY: exactly one unscoped policy per prefix ---
  const basesByPrefix = new Map();
  for (const p of policies) {
    if (!p.match.methods && !p.match.subpath) {
      basesByPrefix.set(p.match.pathPrefix, (basesByPrefix.get(p.match.pathPrefix) ?? []).concat([p]));
    }
  }
  for (const prefix of [...policyPrefixes].sort()) {
    const bases = basesByPrefix.get(prefix) ?? [];
    if (bases.length === 0) {
      errors.push(
        `BASE_POLICY: prefix '${prefix}' has no base (unscoped) policy — scoped refinements leave method/path gaps`,
      );
    }
    if (bases.length > 1) {
      errors.push(`BASE_POLICY: prefix '${prefix}' has ${bases.length} base policies — exactly one required`);
    }
  }

  // --- CLASSIFICATION_CONSISTENCY: base policy vs manifest classification ---
  const CLASSIFICATION_RULES = {
    public: { auth: ['public'], lifecycle: ['not_applicable'] },
    demo: { auth: ['hosted_demo_public'], lifecycle: ['not_applicable'] },
    system: { auth: ['platform_admin', 'required'], lifecycle: ['not_applicable', 'platform_remediation'] },
    tenant_required: { auth: ['required'], lifecycle: ['enforce'] },
  };
  for (const entry of manifest) {
    const rule = CLASSIFICATION_RULES[entry.classification];
    if (!rule) {
      errors.push(
        `CLASSIFICATION_CONSISTENCY: unknown classification '${entry.classification}' for '${entry.path}'`,
      );
      continue;
    }
    const base = (basesByPrefix.get(entry.path) ?? [])[0];
    if (!base) continue; // BASE_POLICY already reported
    if (!rule.auth.includes(base.auth)) {
      errors.push(
        `CLASSIFICATION_CONSISTENCY: '${entry.path}' is '${entry.classification}' but base auth is '${base.auth}' (allowed: ${rule.auth.join('|')})`,
      );
    }
    if (!rule.lifecycle.includes(base.lifecycle)) {
      errors.push(
        `CLASSIFICATION_CONSISTENCY: '${entry.path}' is '${entry.classification}' but base lifecycle is '${base.lifecycle}' (allowed: ${rule.lifecycle.join('|')})`,
      );
    }
  }

  // --- RATE_PROFILE_KEY: closed registry ---
  const profileKeys = new Set(Object.keys(rateProfiles));
  for (const p of policies) {
    if (!profileKeys.has(p.rateProfile)) {
      errors.push(
        `RATE_PROFILE_KEY: '${p.match.pathPrefix}' uses unknown rateProfile '${p.rateProfile}' (registry: ${[...profileKeys].sort().join(', ')})`,
      );
    }
  }

  checkAmbiguousOverlaps(policies, errors);
  const siExit = checkSystemIdentityRatchet(rootDir, args, errors);
  if (siExit === 2) process.exit(2);
  const transitiveExit = checkTransitiveIdentityPolicy(rootDir, errors);
  if (transitiveExit === 2) process.exit(2);

  if (errors.length > 0) {
    for (const e of errors) console.error('check-route-policy: ' + e);
    console.error(`check-route-policy: FAIL (${errors.length} violation(s))`);
    process.exit(1);
  }
  console.log(
    `check-route-policy: OK (${policies.length} policies over ${manifestPaths.size} prefixes; ` +
      `${profileKeys.size} rate profiles)`,
  );
  process.exit(0);
}

main();
