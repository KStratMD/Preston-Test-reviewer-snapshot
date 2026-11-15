#!/usr/bin/env node
// @ts-check
//
// check-no-loopback-self-fetch.mjs
//
// Blocks the reintroduction of CREDENTIAL-LESS LOOPBACK SELF-FETCH: server-side
// code in src/ issuing an HTTP request back at its own Express app, and shipped
// browser pages calling either of the two remaining RETIRED_PREFIXES route
// families (the routes themselves are still mounted — see "WHAT RETIRED MEANS
// HERE"). A third family, /api/sync-central, left this ban in PR3 once it
// became an ordinary authenticated tenant API.
//
// WHY THIS GATE EXISTS
// --------------------
// PR2 deleted an architecture in which server code called its own HTTP API with
// no credentials attached. Those calls hit auth middleware, got a 401, and the
// caller silently fell back to fixture data. The failure mode is invisible:
// fabricated numbers render exactly like real ones, so no page ever looked
// broken and no test ever went red. Nothing about the language or the type
// system prevents someone re-adding `await fetch('/api/...')` inside a service
// tomorrow, so the deletion only holds if a gate holds it.
//
// The gate has three server-side rules plus one rule for shipped pages:
//
//   Rule 1  No identifier or string literal in src/ may name any member of the
//           retired module-HTTP-client surface (RETIRED_IDENTIFIERS). This
//           catches a revert or a copy-paste resurrection by name, before any
//           URL analysis is needed.
//
//   Rule 2  No fetch sink in src/ may target a URL that statically resolves to
//           this server. ANY root-relative value (`/api/...`, but equally
//           `/operations/health` or `/docs/search`) has no origin on the server,
//           so it can only mean loopback; and ANY absolute URL on one of the
//           recognised loopback host spellings means the same thing whatever its
//           path. A protocol-relative `//host/path` is flagged too, for a
//           different reason: it has no scheme to borrow on the server, so it
//           cannot be fetched without a base at all. Same-file chains are
//           folded to depth 5, so hiding the literal a few hops away does not
//           evade the rule. Folding is NAME-KEYED and has NO scope analysis
//           behind it, so it refuses to fold any name the file BINDS MORE THAN
//           ONCE — a second `const`/`let`/`var`, a parameter of a function that
//           HAS A BODY, a destructured element, a catch variable, a function,
//           class or enum declaration, a namespace name, an `import x = y`
//           alias, a value import. Two bindings of one name mean the folder
//           cannot know which one a reference reaches, and a name-keyed map
//           would silently pick the first. Refusing is a deliberate
//           conservative choice standing IN PLACE OF scope resolution, not an
//           approximation of it. ERASED positions are deliberately NOT counted,
//           because no runtime reference can reach them and counting them
//           refused folds that were safe: a parameter of a bodyless signature
//           (interface member, call/construct/index signature, function type,
//           overload, `declare`), anything inside a type alias or interface, and
//           a type-only import. A uniquely-bound `const` is folded
//           unconditionally. A uniquely-bound `let` is folded too, but ONLY
//           when the file never assigns to that name again — plain and
//           compound assignment, `++`/`--`, destructuring assignment, and
//           `for...of`/`for...in` over an existing binding all count — because
//           a reassigned `let` has an initializer that is not its value, so
//           folding it would manufacture false positives, while a
//           never-reassigned one is exactly the `const` case wearing a
//           different keyword. Every refusal fails in the same safe direction:
//           a fold that does not happen costs a Rule 2 proof, and the sink then
//           needs a Rule 3 entry a human had to justify. The fold is
//           still BOUNDED, and that limit is a real evasion: a chain of six
//           links exceeds MAX_FOLD_DEPTH and resolves to nothing, as does a
//           `let` the file reassigns, any multiply-bound name, and a `var`
//           (never folded). Those fall through to Rule 3, where a human
//           classification rather than a proof is what stands behind them.
//
//   Rule 3  Every remaining fetch sink — the ones whose destination is NOT
//           statically decidable — must carry a classification in
//           scripts/no-loopback-self-fetch.inventory.json. The inventory is
//           keyed structurally and is exact in BOTH directions: an undeclared
//           sink fails, and a stale entry fails. Crucially `self-fetch` is a
//           REJECTED classification, not an accepted one, and EVERY accepted
//           classification requires a non-empty justification. The only passing
//           states are "provably not a self-fetch" or "not a self-fetch, and
//           here is a human sentence saying why" — a classification on its own
//           is never enough.
//
//           The residual trust boundary lives HERE, and it is worth naming: the
//           inventory is keyed on the SHAPE of the call, not on the value the
//           URL takes. When that value is not statically resolvable — supplied
//           by a caller, imported from another module, read at runtime — the
//           entry survives a change to where it points. Editing the base URL a
//           `fetch(this.baseUrl)` sink reads from produces no key change and no
//           re-review. Rules 1 and 2 exist to shrink this set; what remains in
//           it is held by the justifications, which are human claims.
//
//   Public  Shipped pages under public/ may not call a RETIRED route prefix
//           from executable script content. Browser code legitimately calls
//           this server's /api/ (it has an origin and a session cookie), so
//           the public rule flags only those two prefixes.
//
// WHAT "RETIRED" MEANS HERE — it is NOT "deleted"
// ----------------------------------------------
// All three prefixes below — the two still in RETIRED_PREFIXES and
// /api/sync-central, which PR3 removed from the list — are STILL MOUNTED and
// still serving: src/middleware/setup/RouteSetup.ts mounts all three, and
// src/routes/{syncCentral,syncOrchestrator,automationLibraries}.ts all exist
// with live handlers. Nothing here was deleted; only what may call them
// changed.
//
// PR3 authenticated all three. /api/sync-central is now an ordinary
// authenticated tenant API (authMiddleware + the tenant kill switch), so a
// future authenticated browser consumer is legitimate — it is no longer
// banned here, and Rule 2's root-relative self-target detection still covers
// server-side calls to it.
//
// The two below stay banned for a DIFFERENT reason than before: they are
// platform-global process state behind requirePlatformAdmin, so no public
// page has a legitimate reason to call them. This is not a claim that the
// routes are gone — all three are still mounted and serving.
//
// If a platform-admin surface ever grows a legitimate public-page consumer,
// remove its prefix from RETIRED_PREFIXES. Do NOT assume the route needs
// recreating first — it never went away.
//
// WHAT THIS GATE DOES NOT CATCH — read before trusting it
// -------------------------------------------------------
//   * `axios`, `got`, `node-fetch` imports, `http.request`/`https.request`, and
//     any other HTTP client are NOT discovered. Rules 2 and 3 see `fetch` and
//     `typeof fetch` aliases only. A loopback call made through axios passes
//     this gate untouched.
//   * Cross-file dynamic URL construction is NOT folded. foldExpression walks
//     same-file initializers only; a base URL imported from another
//     module resolves to nothing and the sink falls through to Rule 3, where a
//     human classification — not a proof — is what stands behind it.
//   * Alias destinations are mechanically inventoried but NOT semantically
//     proven. When a `typeof fetch` alias is called with a runtime-supplied
//     URL, the AST cannot show where that URL points. The inventory records the
//     sink and a justification; the justification is a human claim.
//   * The source walk is FILE-EXTENSION scoped and FILESYSTEM-based, which is
//     the general rule the `src/public/**` note below is one instance of. It
//     visits `src/**/*.ts` only (see discoverSourceFiles), so a `.js`, `.mjs`,
//     `.mts` or `.tsx` file anywhere under `src/` is invisible to Rules 1-3.
//     `__mocks__` directories are excluded by name, which blinds Rule 1 there
//     too. And because the walk reads the filesystem rather than git, a
//     gitignored `.ts` file is scanned on a dev box and absent in CI — the two
//     can legitimately disagree.
//   * Verified Rule 2 evasions, none of them hypothetical (all confirmed
//     against a synthetic root):
//       - `fetch(new URL('/api/x', 'http://127.0.0.1:3000'))` — foldExpression
//         has no NewExpression case, so it resolves nothing.
//       - `'/api/x'.concat('/y')` and `['', 'api', 'x'].join('/')` — no method
//         call is folded.
//       - a fold chain longer than MAX_FOLD_DEPTH (six links), a `let` the file
//         reassigns, any `var`, and — since the fold is name-keyed with no
//         scope analysis — ANY name the file binds more than once, per the
//         Rule 2 note above. That last refusal is what makes the folder honest
//         rather than what makes it complete: a self-target hidden in an inner
//         scope under a name an outer scope also binds is NOT proven by Rule 2.
//         It used to be worse than unproven — the name-keyed map took the
//         OUTER, external initializer and reported the sink as decided — but
//         either way it is Rule 3, not Rule 2, that stands behind it.
//       - the expanded IPv6 loopback `http://[0:0:0:0:0:0:0:1]:3000/...`, which
//         LOOPBACK_HOST_RE does not spell (it lists `[::1]` only).
//     Everything on this list still records a sink and falls through to Rule 3,
//     where a human classification rather than a proof is what stands behind it.
//   * Indirect CALL SPELLINGS are recognised, but not all of them.
//     `globalThis['fetch'](url)`, `fetch.call(thisArg, url)`,
//     `fetch.bind(thisArg)(url)` and `fetch.bind(thisArg, url)()` ARE sinks —
//     each reads its URL from the argument position that spelling actually puts
//     it in, so Rule 2 and Rule 3 both reach them. A SPREAD argument moves the
//     URL out of its written position (`fetch.call(...[undefined, '/api/x'])`
//     really passes the URL at index 1), so a spread of an array LITERAL is
//     expanded first and the URL is found where it truly lands. A spread the
//     AST cannot expand — `fetch.call(...args)`, a spread of a call result —
//     makes the URL UNKNOWN rather than guessed: every argument position from
//     that spread onward is unreadable, so the URL argument is dropped
//     (fingerprint `None`) and NO later fixed argument is allowed to answer for
//     it. That last point is the whole reason this is not merely a lost proof —
//     reading on, `fetch.call(...args, 'https://api.openai.com/…')` resolved to
//     that external literal and CLEARED Rule 2 while the runtime URL came out of
//     `args`; the same fallback in the invoked-bind form let the outer call's URL
//     answer for an unreadable bound argument list. Positions BEFORE the spread
//     are still exact, so `fetch('/api/x', ...opts)` is still caught. The sink is
//     RECORDED either way, so Rule 3 forces a human classification onto it.
//     Still invisible: `.apply`
//     (the URL is inside an array literal), a bound copy stored before it is
//     called (`const f = fetch.bind(globalThis); f(url);` — `f` is not declared
//     `typeof fetch`, so alias discovery does not find it), and a computed key
//     that is not a string literal (`globalThis[k]`, where the AST cannot know
//     what `k` holds).
//   * `src/public/**` is scanned by NEITHER scan. It is excluded from the
//     server walk because it is browser-served code, and the public rule scans
//     `public/**`, which is a DIFFERENT directory. So that path is a genuine
//     hole in coverage, not a covered case.
//       No live violation exists today: its only file, src/public/docs-search.js,
//       is a stale unserved duplicate of public/docs-search.js (the two differ;
//       `build` is a bare `tsc` that does not copy it; resolvePublicDir() would
//       never select it). If src/public/** ever becomes served, this carve-out
//       becomes a real hole and must be closed.
//   * Rule 2's loopback host list is FIVE LITERAL SPELLINGS, not an address
//     classifier. Real loopback addresses it does not recognise: the rest of
//     127.0.0.0/8 (`http://127.0.0.2:3000/api/x`), the `127.1` shorthand
//     (`http://127.1:3000/api/x`), the IPv4-mapped IPv6 form
//     (`http://[::ffff:127.0.0.1]/api/x`), and integer/hex spellings such as
//     `http://0x7f000001`. All four are verified to pass Rule 2 today. They are
//     not silently allowed — they fall through to Rule 3, where a human
//     classification rather than a proof is what stands behind them. Widening
//     this into a real address parser is the fix if that ever stops being
//     enough.
//       The match also assumes the host begins immediately after `//`, which is
//       a PARSING assumption rather than a spelling one: a userinfo component
//       (`http://evil.com@localhost:3000/api/x`, whose real host IS localhost)
//       and a trailing-dot FQDN (`http://localhost.:3000/api/x`) are likewise
//       unrecognised. Both also fall through to Rule 3.
//   * Rule 1 matches names, so it cannot see a resurrection that renames every
//     symbol. Rule 2 and Rule 3 are what cover that case.
//
// Usage:
//   node scripts/check-no-loopback-self-fetch.mjs                 # gate; exit 0 clean, 1 violations, 2 fail-closed
//   node scripts/check-no-loopback-self-fetch.mjs --emit-inventory # print {"sinks":[...]} to stdout, exit 0
//   node scripts/check-no-loopback-self-fetch.mjs --root DIR       # run against a synthetic root (tests)
//
//   WARNING — `--emit-inventory` REGENERATES, it does not merge. Every entry it
//   prints is `UNCLASSIFIED` with no justification, and the emitted object has
//   neither `_comment` nor `_classifications`. Redirecting it over the live
//   inventory therefore destroys all 33 hand-written classifications and
//   justifications while leaving the sink-key set byte-identical — the entire
//   diff is human prose that nothing can regenerate. It is fail-closed
//   (UNCLASSIFIED is a violation, so CI catches the loss) but recoverable only
//   from git. Emit to a scratch file and port across the entries you need.
//
// Exit codes:
//   0  clean
//   1  violations found
//   2  fail-closed: a required page is absent, a scan scope or a file within it
//      is unreadable, or the inventory file is missing/unparseable. Never
//      degrade these to a pass.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The retired module-HTTP-client surface deleted by PR2. Any reappearance of
// these names in src/ is a revert, regardless of what the code around them does.
const RETIRED_IDENTIFIERS = [
  'moduleHttpClient',
  'fetchModuleData',
  'fetchModuleDataBatch',
  'isModuleApiAvailable',
  'useRealModuleApis',
  'USE_REAL_MODULE_APIS',
  'MODULE_API_BASE_URL',
];

// Route prefixes still banned from server code and from shipped pages. The
// ROUTES ARE STILL MOUNTED and still serving (src/middleware/setup/RouteSetup.ts;
// both routers under src/routes/ exist with live handlers) — see the "WHAT
// RETIRED MEANS HERE" note above. /api/sync-central left this list in PR3: it
// is now an ordinary authenticated tenant API, so it no longer belongs here.
// The two remaining are banned on a DIFFERENT ground than before: they are
// platform-global process state behind requirePlatformAdmin, so no public
// page has a legitimate reason to call them.
const RETIRED_PREFIXES = [
  '/api/sync-orchestrator',
  '/api/automation-libraries',
];

// Accepted classifications. `self-fetch` is deliberately ABSENT: it is the
// thing being banned, so it can never be a passing state. `UNCLASSIFIED` is the
// emitter's placeholder and is likewise absent — it must be resolved by a human.
const VALID_CLASSIFICATIONS = new Set([
  'external-provider',          // calls a third-party API over the public internet
  'external-provider-wrapper',  // a typeof-fetch alias whose caller supplies a provider URL
  'browser-embedded',           // JS inside a server-rendered template, executed by the browser
]);

// Pages PR2 rewrote to render fixture data without a network call. If one of
// these is absent the gate cannot verify its own premise, so it exits 2 rather
// than reporting a clean scan of a page that is not there.
const REQUIRED_PUBLIC_PAGES = [
  'public/sync-central-dashboard.html',
  'public/SuiteCentral-BusinessCentral-Integration-hub.html',
  'public/admin-templates.html',
  'public/integration-wizard-enhanced.html',
];

// Hosts that mean "this same server". An absolute URL on one of these is a
// loopback self-fetch dressed up as an absolute URL.
//
// The trailing `(?=[/?#]|$)` anchors the match to the END of the host. Without
// it the alternation matches a mere PREFIX, so `http://localhostevil.com/data`
// and `http://127.0.0.1.evil.com/data` — both ordinary external hosts anyone can
// register — read as loopback and get blocked. That lookahead is load-bearing:
// the `$` arm keeps a bare `http://localhost:3000` (no path) flagged, and the
// `[/?#]` arm covers every URL that has a path, query, or fragment.
const LOOPBACK_HOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?=[/?#]|$)/i;

const SOURCE_EXCLUDED_DIR_NAMES = new Set(['node_modules', '__tests__', '__mocks__']);
const PUBLIC_EXCLUDED_DIR_NAMES = new Set(['node_modules']);
const MAX_FOLD_DEPTH = 5;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ root: string, emitInventory: boolean }}
 */
function parseRoot(argv) {
  let root = process.cwd();
  let emitInventory = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--emit-inventory') {
      emitInventory = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('FAIL: --root requires a directory argument.');
        process.exit(2);
      }
      root = path.resolve(value);
      i++;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) {
        console.error('FAIL: --root requires a directory argument.');
        process.exit(2);
      }
      root = path.resolve(value);
    } else {
      console.error(`FAIL: unknown argument "${arg}".`);
      process.exit(2);
    }
  }
  return { root, emitInventory };
}

const toPosix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every src/**\/*.ts the server actually ships. Tests, type declarations and
 * src/public/** are excluded (see the header note on that last one).
 *
 * FAIL-CLOSED: an unreadable directory inside the scope exits 2. A scan that
 * silently skips what it cannot read reports "clean" for the wrong reason.
 *
 * @param {string} root
 * @returns {string[]} absolute paths
 */
function discoverSourceFiles(root) {
  const srcRoot = path.join(root, 'src');
  if (!fs.existsSync(srcRoot)) return [];
  /** @type {string[]} */
  const out = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`FAIL: cannot read source scope ${toPosix(path.relative(root, dir))}: ${err.message}`);
      process.exit(2);
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (SOURCE_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        if (rel === 'src/public') continue; // browser-served; documented carve-out
        walk(abs);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name.endsWith('.d.ts')) continue;
        if (entry.name.endsWith('.test.ts')) continue;
        if (entry.name.endsWith('.spec.ts')) continue;
        out.push(abs);
      }
    }
  };
  walk(srcRoot);
  return out.sort();
}

/**
 * Name of the class/function enclosing `node`, as `Class.method`, `method`,
 * or `<module>`. Used as part of the inventory key, so it must be derived from
 * structure — never from a line number, which every unrelated edit would churn.
 *
 * @param {ts.Node} node
 * @param {ts.SourceFile} sourceFile
 * @returns {string}
 */
function enclosingName(node, sourceFile) {
  let fnName = null;
  let className = null;
  let cur = node.parent;
  while (cur) {
    if (!fnName) {
      if (ts.isConstructorDeclaration(cur)) {
        fnName = 'constructor';
      } else if (
        (ts.isMethodDeclaration(cur) ||
          ts.isFunctionDeclaration(cur) ||
          ts.isGetAccessorDeclaration(cur) ||
          ts.isSetAccessorDeclaration(cur)) &&
        cur.name
      ) {
        fnName = cur.name.getText(sourceFile);
      } else if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
        const p = cur.parent;
        if (
          p &&
          (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) &&
          p.name
        ) {
          fnName = p.name.getText(sourceFile);
        }
      }
    }
    if (!className && (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) && cur.name) {
      className = cur.name.getText(sourceFile);
    }
    cur = cur.parent;
  }
  if (className && fnName) return `${className}.${fnName}`;
  if (className) return className;
  if (fnName) return fnName;
  return '<module>';
}

const normalizeText = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Canonical STRUCTURAL fingerprint of a call argument. Structural rather than
 * AST-kind-only so that two different literals in the same function do not
 * collapse onto one key and hide each other:
 *
 *   StringLiteral('/operations/health')  -> Str:/operations/health
 *   TemplateExpression `${baseUrl}/models` -> Tpl:${baseUrl}|/models
 *   apiUrl('dashboard/stats')            -> Call:apiUrl(Str:dashboard/stats)
 *   dep.url                              -> Prop:dep.url
 *   p                                    -> Id:p
 *
 * `ordinal` exists only for residual collisions this cannot resolve.
 *
 * @param {ts.Expression | undefined} expression
 * @param {ts.SourceFile} sourceFile
 * @returns {string}
 */
function fingerprintExpression(expression, sourceFile) {
  if (!expression) return 'None';
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return `Str:${expression.text}`;
  }
  if (ts.isTemplateExpression(expression)) {
    let out = `Tpl:${expression.head.text}`;
    for (const span of expression.templateSpans) {
      out += `\${${normalizeText(span.expression.getText(sourceFile))}}|${span.literal.text}`;
    }
    return out;
  }
  if (ts.isCallExpression(expression)) {
    const callee = normalizeText(expression.expression.getText(sourceFile));
    const args = expression.arguments.map((a) => fingerprintExpression(a, sourceFile)).join(',');
    return `Call:${callee}(${args})`;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return `Prop:${normalizeText(expression.getText(sourceFile))}`;
  }
  if (ts.isIdentifier(expression)) {
    return `Id:${expression.text}`;
  }
  if (ts.isBinaryExpression(expression)) {
    const op = ts.tokenToString(expression.operatorToken.kind) ?? '?';
    const left = fingerprintExpression(expression.left, sourceFile);
    const right = fingerprintExpression(expression.right, sourceFile);
    return `Bin:(${left}${op}${right})`;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return fingerprintExpression(expression.expression, sourceFile);
  }
  if (ts.isAwaitExpression(expression)) {
    return `Await:${fingerprintExpression(expression.expression, sourceFile)}`;
  }
  if (ts.isNewExpression(expression)) {
    const callee = normalizeText(expression.expression.getText(sourceFile));
    const args = (expression.arguments ?? []).map((a) => fingerprintExpression(a, sourceFile)).join(',');
    return `New:${callee}(${args})`;
  }
  if (ts.isConditionalExpression(expression)) {
    return `Cond:(${fingerprintExpression(expression.condition, sourceFile)}?${fingerprintExpression(
      expression.whenTrue,
      sourceFile,
    )}:${fingerprintExpression(expression.whenFalse, sourceFile)})`;
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return fingerprintExpression(expression.expression, sourceFile);
  }
  if (ts.isNonNullExpression(expression)) {
    return fingerprintExpression(expression.expression, sourceFile);
  }
  return `Raw:${normalizeText(expression.getText(sourceFile))}`;
}

/**
 * PASS A — fetch sinks the TypeScript AST can see: `fetch(...)`,
 * `globalThis.fetch(...)`, and calls through any alias declared `typeof fetch`.
 *
 * Alias discovery is deliberately GENERIC. It reads `typeof fetch` type
 * annotations off property/parameter/variable declarations and additionally
 * recognises the assignment idiom `this.fetchImpl = options.fetchImpl ?? fetch`,
 * so the gate never has to name the three classes that happen to use it today.
 * A fourth class adopting the same shape tomorrow is discovered for free.
 *
 * @param {string} relFile
 * @param {ts.SourceFile} sourceFile
 * @returns {Array<object>}
 */
function collectDirectAndAliasSinks(relFile, sourceFile) {
  /** @type {Set<string>} */
  const aliasNames = new Set();

  // Pre-pass: every name whose declared type is `typeof fetch`, plus any
  // property assigned from a `fetch`-bearing expression.
  const isTypeofFetch = (typeNode) =>
    !!typeNode &&
    ts.isTypeQueryNode(typeNode) &&
    ts.isIdentifier(typeNode.exprName) &&
    typeNode.exprName.text === 'fetch';

  const mentionsFetchIdentifier = (node) => {
    let found = false;
    const scan = (n) => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === 'fetch') {
        found = true;
        return;
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return found;
  };

  const collectAliases = (node) => {
    if (
      (ts.isPropertyDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      isTypeofFetch(node.type) &&
      node.name
    ) {
      aliasNames.add(node.name.getText(sourceFile).replace(/^this\./, ''));
    }
    // `this.fetchImpl = options.fetchImpl ?? fetch;`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      mentionsFetchIdentifier(node.right)
    ) {
      aliasNames.add(node.left.name.getText(sourceFile));
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);

  // The member name of `x.name` or `x['name']`, or null when the computed key
  // is not a static string. `globalThis[k]` with a runtime `k` is deliberately
  // NOT resolved — this function never guesses.
  const memberName = (expr) => {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr)) {
      const key = expr.argumentExpression;
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) return key.text;
    }
    return null;
  };

  // Does this expression NAME fetch (however it is spelled)? Returns the
  // canonical spelling used as the inventory's `callee`, or null.
  //
  // `globalThis['fetch']` deliberately normalises to the SAME string as
  // `globalThis.fetch`: they are one sink with two spellings, so switching
  // between them must not silently mint a new inventory key.
  const fetchSpelling = (expr) => {
    if (ts.isParenthesizedExpression(expr)) return fetchSpelling(expr.expression);
    if (ts.isIdentifier(expr)) {
      return expr.text === 'fetch' || aliasNames.has(expr.text) ? expr.text : null;
    }
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const prop = memberName(expr);
      if (!prop) return null;
      const objText = normalizeText(expr.expression.getText(sourceFile));
      const isGlobalObject = objText === 'globalThis' || objText === 'window' || objText === 'self';
      if ((prop === 'fetch' && isGlobalObject) || aliasNames.has(prop)) return `${objText}.${prop}`;
    }
    return null;
  };

  // Expand statically-known array-literal spreads so the index-based argument
  // reads below land on the argument the call REALLY passes there:
  // `fetch.call(...[undefined, '/api/x'])` executes a self-fetch whose URL is at
  // index 1, but is written with no argument at index 1 at all.
  //
  // A spread this cannot expand — `...args`, a spread of a call result — makes
  // every position FROM THAT SPREAD ONWARD unreadable, and says so through
  // `unknownFrom` rather than handing back a written argument that is not the one
  // the call passes there. Reading on regardless was worse than losing the proof:
  // `fetch.call(...args, '<external>')` would resolve to that external literal and
  // CLEAR Rule 2 while the runtime URL came out of `args`. Positions before the
  // spread are still exact — a later spread cannot shift an earlier index.
  //
  // Returns `{ list, unknownFrom }`. The sink is recorded either way, so Rule 3
  // still forces a human classification onto whatever Rule 2 cannot read.
  const expandArguments = (args) => {
    let sawSpread = false;
    /** @type {any[]} */
    const out = [];
    const push = (list) => {
      for (const arg of list) {
        if (!ts.isSpreadElement(arg)) {
          out.push(arg);
          continue;
        }
        sawSpread = true;
        let inner = arg.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (!ts.isArrayLiteralExpression(inner)) return false;
        if (!push(inner.elements)) return false;
      }
      return true;
    };
    if (!push(args)) {
      // A nested array literal can be what failed, so key the cutoff to the first
      // TOP-LEVEL spread: it is at or before the position that could not be read.
      const firstSpread = args.findIndex((a) => ts.isSpreadElement(a));
      return { list: args, unknownFrom: firstSpread < 0 ? Infinity : firstSpread };
    }
    return { list: sawSpread ? out : args, unknownFrom: Infinity };
  };

  // Read one argument position out of an expandArguments() result. `unknown` and
  // "not present" are returned separately because the invoked-bind form below
  // must not treat an UNREADABLE bound argument as an absent one and fall through
  // to the outer call.
  const argAt = (expanded, index) =>
    index >= expanded.unknownFrom
      ? { node: undefined, unknown: true }
      : { node: expanded.list[index], unknown: false };

  // Resolve a CallExpression to {callee spelling, URL argument node}, or null
  // when it is not a fetch sink. `.call`/`.bind` matter because the URL moves
  // out of argument 0: `fetch.call(thisArg, url)` puts it at 1, and
  // `fetch.bind(thisArg)(url)` puts it on the OUTER call. Reading argument 0
  // regardless would fingerprint the thisArg and hand Rule 2 the wrong node.
  const resolveSink = (node) => {
    const callee = node.expression;
    const args = expandArguments(node.arguments);

    const direct = fetchSpelling(callee);
    if (direct) return { callee: direct, argNode: argAt(args, 0).node };

    // `fetch.call(thisArg, url)` and `fetch.bind(thisArg, url)`.
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const method = memberName(callee);
      if (method === 'call' || method === 'bind') {
        const base = fetchSpelling(callee.expression);
        if (base) {
          // An IMMEDIATELY invoked bind is recorded once, at the outer call
          // below, which is the only place both the bound and the call-site
          // argument are visible.
          if (
            method === 'bind' &&
            node.parent &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node
          ) {
            return null;
          }
          return { callee: `${base}.${method}`, argNode: argAt(args, 1).node };
        }
      }
    }

    // `fetch.bind(thisArg)(url)` and `fetch.bind(thisArg, url)()`. The bound
    // argument wins when present — that is where the URL actually is.
    if (ts.isCallExpression(callee) && memberName(callee.expression) === 'bind') {
      const base = fetchSpelling(callee.expression.expression);
      if (base) {
        const bound = argAt(expandArguments(callee.arguments), 1);
        // An UNREADABLE bound position is not an absent one: when a spread hides
        // whether the bind already supplied the URL, the outer call's argument
        // cannot answer for it either, so the URL stays unknown.
        const argNode = bound.unknown ? undefined : (bound.node ?? argAt(args, 0).node);
        return { callee: `${base}.bind()`, argNode };
      }
    }

    return null;
  };

  /** @type {Array<object>} */
  const sinks = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const resolved = resolveSink(node);
      if (resolved) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        sinks.push({
          file: relFile,
          enclosing: enclosingName(node, sourceFile),
          callee: resolved.callee,
          argFingerprint: fingerprintExpression(resolved.argNode, sourceFile),
          line: line + 1,
          pass: 'direct',
          argNode: resolved.argNode,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sinks;
}

/**
 * Blank JS comments while PRESERVING offsets, so line numbers survive and a
 * commented-out `fetch(` is not reported as a sink. Quote-aware, because a
 * naive `//` strip would eat the rest of every line containing `https://`.
 *
 * @param {string} text
 * @returns {string}
 */
function blankJsComments(text) {
  let out = '';
  let i = 0;
  /** @type {string|null} */
  let mode = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = '//'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = '/*'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === '//') {
      if (c === '\n') { mode = null; out += c; } else { out += ' '; }
      i += 1; continue;
    }
    if (mode === '/*') {
      if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; }
      else { out += c === '\n' ? c : ' '; i += 1; }
      continue;
    }
    // inside a string/template literal
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if (c === mode) mode = null;
    out += c;
    i += 1;
  }
  return out;
}

const EMBEDDED_FETCH_RE = /(?<![\w$.])(?:(?:globalThis|window|self)\.)?fetch\s*\(/g;

/**
 * Extract the first argument's source text from `text` starting at the index of
 * the `(` that opens the call. Returns null if the parens never balance.
 *
 * @param {string} text
 * @param {number} openParenIndex
 * @returns {string|null}
 */
function firstArgumentText(text, openParenIndex) {
  let depth = 0;
  let start = openParenIndex + 1;
  /** @type {string|null} */
  let quote = null;
  for (let i = openParenIndex; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    if (c === ',' && depth === 1) return text.slice(start, i);
  }
  return null;
}

/**
 * PASS B — fetch sinks that live INSIDE template literals: browser JavaScript
 * embedded in server-rendered HTML strings. These are invisible to a plain
 * CallExpression walk (to the TS parser they are just string content), and
 * skipping them would under-report the census by eight sinks today.
 *
 * @param {string} relFile
 * @param {ts.SourceFile} sourceFile
 * @returns {Array<object>}
 */
function collectEmbeddedTemplateSinks(relFile, sourceFile) {
  /** @type {Array<object>} */
  const sinks = [];
  const fullText = sourceFile.getFullText();

  /** @param {ts.Node} node */
  const handleTemplate = (node) => {
    // Span the literal's INNER text — start+1/end-1 to drop the enclosing
    // backticks. This matters: blankJsComments is a quote-aware state machine,
    // so a leading backtick would put it in "inside a template string" mode for
    // the entire body and no comment would ever be blanked. That silently
    // turned every commented-out `fetch(` in an embedded script into a sink.
    const start = node.getStart(sourceFile) + 1;
    const end = node.getEnd() - 1;
    if (end <= start) return;
    const raw = fullText.slice(start, end);
    const cleaned = blankJsComments(raw);
    EMBEDDED_FETCH_RE.lastIndex = 0;
    let m;
    while ((m = EMBEDDED_FETCH_RE.exec(cleaned)) !== null) {
      const openParen = m.index + m[0].length - 1;
      const argText = firstArgumentText(cleaned, openParen);
      const absPos = start + m.index;
      const { line } = sourceFile.getLineAndCharacterOfPosition(absPos);
      sinks.push({
        file: relFile,
        enclosing: enclosingName(node, sourceFile),
        callee: 'embedded:fetch',
        argFingerprint: `Emb:${normalizeText(argText ?? '')}`,
        line: line + 1,
        pass: 'embedded',
        embeddedArgText: argText ?? '',
      });
    }
  };

  const visit = (node) => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      handleTemplate(node);
      // Do not descend: nested templates are already inside the span above, and
      // descending would double-count every occurrence.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sinks;
}

// ---------------------------------------------------------------------------
// Rule 1 / Rule 2
// ---------------------------------------------------------------------------

const RETIRED_IDENTIFIER_SET = new Set(RETIRED_IDENTIFIERS);

/**
 * Rule 1 — any identifier OR string literal exactly naming a retired symbol.
 * String literals count because the retired surface was also reachable by name
 * through env lookups (`process.env['MODULE_API_BASE_URL']`).
 *
 * @param {string} relFile
 * @param {ts.SourceFile} sourceFile
 * @param {Array<object>} violations
 */
function checkRetiredIdentifiers(relFile, sourceFile, violations) {
  const visit = (node) => {
    let name = null;
    if (ts.isIdentifier(node)) name = node.text;
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) name = node.text;
    if (name && RETIRED_IDENTIFIER_SET.has(name)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        file: relFile,
        line: line + 1,
        rule: 'retired-identifier',
        detail: `"${name}" is part of the retired module HTTP client surface deleted by PR2.`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Same-file constant folding. Returns every string value the expression could
 * statically evaluate to (`??`/`||` contribute BOTH branches), or an empty array
 * when the value is not statically decidable — this function never guesses, and
 * an empty result means "unknown", which routes the sink to Rule 3.
 *
 * @param {ts.Expression | undefined} expression
 * @param {ts.SourceFile} sourceFile
 * @param {Map<string, ts.Expression>} constInitializers
 * @param {number} depth
 * @returns {string[]}
 */
function foldExpression(expression, sourceFile, constInitializers, depth) {
  if (!expression || depth > MAX_FOLD_DEPTH) return [];

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
    return foldExpression(expression.expression, sourceFile, constInitializers, depth + 1);
  }
  if (ts.isTemplateExpression(expression)) {
    let candidates = [expression.head.text];
    for (const span of expression.templateSpans) {
      const parts = foldExpression(span.expression, sourceFile, constInitializers, depth + 1);
      if (parts.length === 0) return []; // unresolvable span -> do not claim a value
      const next = [];
      for (const prefix of candidates) {
        for (const part of parts) next.push(prefix + part + span.literal.text);
      }
      candidates = next.slice(0, 8); // bound the cross product
    }
    return candidates;
  }
  if (ts.isIdentifier(expression)) {
    const init = constInitializers.get(expression.text);
    if (!init) return [];
    return foldExpression(init, sourceFile, constInitializers, depth + 1);
  }
  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind;
    const left = foldExpression(expression.left, sourceFile, constInitializers, depth + 1);
    const right = foldExpression(expression.right, sourceFile, constInitializers, depth + 1);
    if (kind === ts.SyntaxKind.PlusToken) {
      if (left.length === 0 || right.length === 0) return [];
      const out = [];
      for (const l of left) for (const r of right) out.push(l + r);
      return out.slice(0, 8);
    }
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      // Either branch can be the runtime value, so BOTH are candidates.
      return [...left, ...right].slice(0, 8);
    }
    return [];
  }
  return [];
}

/**
 * Add every identifier an ASSIGNMENT TARGET writes to. A target is an
 * identifier, or an array/object literal standing in for a destructuring
 * pattern — `[endpoint] = [...]` and `({ endpoint } = o)` reassign `endpoint`
 * exactly as `endpoint = …` does, and reading only the identifier case left
 * both as free evasions of the `let` fold. Property targets (`o.x = …`) bind
 * nothing and are correctly ignored.
 *
 * @param {ts.Node} target
 * @param {(name: string) => void} add
 */
function collectAssignmentTargets(target, add) {
  let expr = target;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  if (ts.isIdentifier(expr)) {
    add(expr.text);
    return;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isSpreadElement(element)) {
        collectAssignmentTargets(element.expression, add);
      } else if (
        ts.isBinaryExpression(element) &&
        element.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        collectAssignmentTargets(element.left, add); // `[x = 1] = …`
      } else {
        collectAssignmentTargets(element, add);
      }
    }
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isShorthandPropertyAssignment(property)) add(property.name.text);
      else if (ts.isPropertyAssignment(property)) collectAssignmentTargets(property.initializer, add);
      else if (ts.isSpreadAssignment(property)) collectAssignmentTargets(property.expression, add);
    }
  }
}

/**
 * Every identifier the file assigns to after declaration: `x = …`, any compound
 * assignment (`x += …`), `++x`/`x--`, destructuring assignment
 * (`[x] = …`, `({ x } = …)`), and `for (x of …)`/`for (x in …)` over an
 * EXISTING binding. Used to decide which `let` bindings still have their
 * initializer as their value.
 *
 * A `for` head that DECLARES its target (`for (const x of …)`) is not an
 * assignment to an outer name and is deliberately not counted here — it is a
 * second binding of that name, which collectBindingCounts already refuses to
 * fold.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Set<string>}
 */
function collectReassignedNames(sourceFile) {
  /** @type {Set<string>} */
  const names = new Set();
  const add = (name) => names.add(name);
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      collectAssignmentTargets(node.left, add);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      names.add(node.operand.text);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      collectAssignmentTargets(node.initializer, add);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/**
 * How many times the file BINDS each name. Folding is keyed by name with no
 * scope resolution behind it, so a name bound twice is ambiguous: the map can
 * only keep one initializer, and which reference reaches which binding is
 * precisely the question an AST-only walk cannot answer. Counting every binding
 * form lets collectConstInitializers refuse those names outright.
 *
 * Counted: `const`/`let`/`var` declarations (including every identifier inside a
 * destructuring pattern and the catch-clause variable, both of which are
 * VariableDeclaration nodes), RUNTIME function and method parameters,
 * function/class/enum declarations and named function/class expressions,
 * namespace names, `import x = y` aliases, and value imports.
 *
 * NOT counted, because they are ERASED and no runtime reference can ever reach
 * them — counting them cost folds that were safe (a coverage regression, never a
 * bypass: the sink fell through to Rule 3): parameters of a signature with no
 * body (interface members, call/construct/index signatures, function type nodes,
 * overload signatures, `declare` declarations), anything inside a
 * TypeAliasDeclaration or InterfaceDeclaration, and type-only imports (`import
 * type …` and individually `{ type X }`-marked specifiers).
 *
 * Two deliberate over-counts remain, both safe (an over-count only refuses a
 * fold, and a refused fold costs a Rule 2 proof rather than granting a pass):
 * the NAME of a bodyless FunctionDeclaration — an overload signature or an
 * ambient `declare function` — is still counted alongside its implementation, and
 * ambient `declare module`/`declare namespace` bodies are walked like any other.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Map<string, number>}
 */
function collectBindingCounts(sourceFile) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);

  /** @param {ts.BindingName} name */
  const bindName = (name) => {
    if (ts.isIdentifier(name)) {
      bump(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindName(element.name);
    }
  };

  // A parameter binds a runtime value only when the signature it belongs to has
  // a body to bind it in. `load(endpoint: string): void` inside an interface, a
  // type literal, a function type, an overload or a `declare` binds nothing.
  const isRuntimeParameter = (node) => {
    const parent = node.parent;
    return !!parent && ts.isFunctionLike(parent) && !!(/** @type {any} */ (parent).body);
  };

  const visit = (node) => {
    // Erased subtrees: nothing declared inside a type alias or an interface is a
    // runtime binding, so the whole subtree is skipped rather than filtered.
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    // `import type X, { Y }` — the entire clause is erased.
    if (ts.isImportClause(node) && node.isTypeOnly) return;
    if (ts.isImportSpecifier(node) && node.isTypeOnly) return;

    if (ts.isVariableDeclaration(node)) {
      bindName(node.name);
    } else if (ts.isParameter(node)) {
      if (isRuntimeParameter(node)) bindName(node.name);
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require('y')` and the namespace form `export import x = N.y`
      // both declare a value binding — and the namespace form can legally carry a
      // name a module-level `const` also uses, which is exactly the ambiguity
      // this map exists to refuse.
      if (!node.isTypeOnly) bump(node.name.text);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      // `namespace N {}` binds N. (`declare module 'x'` has a StringLiteral name
      // and binds nothing local.)
      bump(node.name.text);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      bump(node.name.text);
    } else if (ts.isImportClause(node) && node.name) {
      bump(node.name.text);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      bump(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

/**
 * Collect same-file `NAME = <expr>` initializers for folding.
 *
 * A name the file binds MORE THAN ONCE is never folded, whatever keyword
 * declared it. This map is keyed by name and has no scope resolution behind it,
 * so with two bindings in play it can only keep one initializer and cannot know
 * which reference reaches which — and keeping the first is not a neutral
 * default: an outer `const endpoint = 'https://external…'` would answer for an
 * inner, differently-scoped `endpoint` holding a self-target, and Rule 2 would
 * report a decided destination that is simply not the one the call uses.
 * Refusing costs the Rule 2 proof and nothing else: the sink still needs a
 * Rule 3 entry with a written justification behind it.
 *
 * Among UNIQUELY-bound names, `const` is folded unconditionally (its
 * initializer IS its value), and a `let` is folded only when the file never
 * assigns to that name again (collectReassignedNames) — a reassigned `let` has
 * an initializer that is genuinely not its value.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Map<string, ts.Expression>}
 */
function collectConstInitializers(sourceFile) {
  /** @type {Map<string, ts.Expression>} */
  const map = new Map();
  const reassigned = collectReassignedNames(sourceFile);
  const bindingCounts = collectBindingCounts(sourceFile);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      const name = node.name.text;
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const isLet = (node.parent.flags & ts.NodeFlags.Let) !== 0;
      const uniquelyBound = (bindingCounts.get(name) ?? 0) <= 1;
      const foldable = uniquelyBound && (isConst || (isLet && !reassigned.has(name)));
      if (foldable && !map.has(name)) map.set(name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
}

/**
 * Rule 2 — does this resolved URL point back at this same server?
 *
 * @param {string} value
 * @returns {string|null} reason, or null when the value is not a self-fetch
 */
function selfFetchReason(value) {
  // Retired prefixes are checked FIRST. Every one of them is also root-relative,
  // so putting the generic root-relative branch first would make this branch
  // unreachable and lose the more actionable message.
  const retiredAnywhere = RETIRED_PREFIXES.find((p) => value.startsWith(p));
  if (retiredAnywhere) {
    return (
      `retired route prefix "${retiredAnywhere}" in "${value}" — this route is still mounted and ` +
      'serving, but it is platform-global process state behind requirePlatformAdmin, so no server-side ' +
      'caller has a legitimate reason to call it'
    );
  }
  // A protocol-relative `//host/path` is checked BEFORE the root-relative
  // branch, which would otherwise swallow it and report it with a reason that is
  // simply untrue — it is not root-relative and it does not resolve to this app.
  // It stays a violation for a different reason: on the server there is no
  // document origin to borrow a scheme from, so Node's fetch cannot resolve it
  // without a base and the call is broken however it was meant. Flagging it
  // fails closed.
  if (value.startsWith('//')) {
    return (
      `protocol-relative "${value}" has no scheme on the server and cannot be fetched ` +
      'without a base — give it an absolute URL'
    );
  }
  // ANY root-relative value, not just /api/. The server has no origin, so
  // `/operations/health` and `/docs/search` resolve back to this app exactly as
  // `/api/...` does.
  if (value.startsWith('/')) {
    return `root-relative "${value}" has no origin on the server, so it can only resolve to this app`;
  }
  const loopback = value.match(LOOPBACK_HOST_RE);
  if (loopback) {
    const rest = value.slice(loopback[0].length);
    const retired = RETIRED_PREFIXES.find((p) => rest.startsWith(p));
    if (retired) return `loopback host with retired prefix "${retired}" in "${value}"`;
    // Any path on a loopback host, not just /api/: the host alone already means
    // "this same server".
    return `"${value}" is on a loopback host, so it resolves to this same server`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inventory (Rule 3)
// ---------------------------------------------------------------------------

const INVENTORY_REL = 'scripts/no-loopback-self-fetch.inventory.json';
const sinkKey = (s) => `${s.file}|${s.enclosing}|${s.callee}|${s.argFingerprint}|${s.ordinal}`;

/**
 * FAIL-CLOSED: a missing or unparseable inventory exits 2. Treating it as "no
 * declared sinks" would turn a deleted file into a green build.
 *
 * @param {string} root
 * @returns {{sinks: any[]}}
 */
function readInventory(root) {
  const abs = path.join(root, INVENTORY_REL);
  if (!fs.existsSync(abs)) {
    console.error(`FAIL: ${INVENTORY_REL} is missing.`);
    console.error('Regenerate it with: node scripts/check-no-loopback-self-fetch.mjs --emit-inventory');
    console.error(
      'WARNING: that flag REGENERATES rather than merges — every entry comes back UNCLASSIFIED with no ' +
        'justification, and _comment/_classifications are dropped. Redirecting it over an existing inventory ' +
        'destroys every hand-written classification. Emit to a scratch file and port the entries across.',
    );
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error(`FAIL: ${INVENTORY_REL} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  if (!parsed || !Array.isArray(parsed.sinks)) {
    console.error(`FAIL: ${INVENTORY_REL} must be an object with a "sinks" array.`);
    process.exit(2);
  }
  return parsed;
}

/**
 * Rule 3 — exact two-way reconciliation between discovered sinks and the
 * inventory, plus classification validity.
 *
 * @param {Array<object>} discoveredSinks
 * @param {{sinks: any[]}} inventory
 * @param {Array<object>} violations
 */
function validateInventory(discoveredSinks, inventory, violations) {
  /** @type {Map<string, any>} */
  const declared = new Map();

  inventory.sinks.forEach((entry, index) => {
    const where = `${INVENTORY_REL} entry #${index}`;
    const missing = ['file', 'enclosing', 'callee', 'argFingerprint'].filter(
      (f) => typeof entry?.[f] !== 'string' || entry[f].length === 0,
    );
    if (typeof entry?.ordinal !== 'number') missing.push('ordinal');
    if (missing.length > 0) {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-malformed',
        detail: `${where} is missing required field(s): ${missing.join(', ')}.`,
      });
      return;
    }
    const key = sinkKey(entry);
    if (declared.has(key)) {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-duplicate',
        detail: `duplicate inventory key ${key}. Each sink must appear exactly once.`,
      });
      return;
    }
    declared.set(key, entry);

    const classification = entry.classification;
    if (typeof classification !== 'string' || classification.length === 0) {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-unclassified',
        detail: `${where} has no classification. Every sink must be classified.`,
      });
    } else if (classification === 'self-fetch') {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-self-fetch',
        detail:
          `${where} is classified "self-fetch". That is the architecture this gate exists to ban — ` +
          'it is never an accepted classification. Delete the call instead of declaring it.',
      });
    } else if (classification === 'UNCLASSIFIED') {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-unclassified',
        detail: `${where} is still UNCLASSIFIED. Replace the emitter placeholder with a real classification.`,
      });
    } else if (!VALID_CLASSIFICATIONS.has(classification)) {
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-bad-classification',
        detail: `${where} has unknown classification "${classification}". Valid: ${[...VALID_CLASSIFICATIONS].join(', ')}.`,
      });
    } else if (typeof entry.justification !== 'string' || entry.justification.trim().length === 0) {
      // EVERY valid classification costs a written sentence, not just the
      // wrapper. Requiring it of `external-provider-wrapper` alone left the
      // header's "there is no classifying past this gate" claim false: a real
      // credential-less loopback could be declared `external-provider` with no
      // rationale anyone had to write. The gate reaches Rule 3 precisely
      // because the AST could NOT decide the destination, so every entry here
      // is a human claim — `external-provider` asserts a runtime-built host is
      // external, and `browser-embedded` asserts a template really is executed
      // by a browser. Neither is checkable; both must be stated.
      violations.push({
        file: INVENTORY_REL,
        line: index + 1,
        rule: 'inventory-missing-justification',
        detail:
          classification === 'external-provider-wrapper'
            ? `${where} is "external-provider-wrapper" but has no justification. The AST cannot prove where an alias call points, so a written rationale is required.`
            : `${where} is "${classification}" but has no justification. Rule 3 sinks are exactly the ones the AST could not decide, so every classification is a human claim and must carry a written rationale.`,
      });
    }
  });

  const discovered = new Map(discoveredSinks.map((s) => [sinkKey(s), s]));

  for (const [key, sink] of discovered) {
    if (!declared.has(key)) {
      violations.push({
        file: sink.file,
        line: sink.line,
        rule: 'inventory-missing',
        detail:
          `fetch sink is not declared in ${INVENTORY_REL} (key: ${key}). ` +
          'Add an entry BY HAND with a classification and a justification. Do not ' +
          'run --emit-inventory against the real inventory: it regenerates rather ' +
          'than merges, re-stamping every entry UNCLASSIFIED and dropping all ' +
          'existing justifications. Emit to a scratch file if you need the key.',
      });
    }
  }
  for (const key of declared.keys()) {
    if (!discovered.has(key)) {
      violations.push({
        file: INVENTORY_REL,
        line: 1,
        rule: 'inventory-stale',
        detail:
          `inventory declares a sink that no longer exists (key: ${key}). ` +
          'Delete that entry BY HAND — do not run --emit-inventory against the ' +
          'real inventory, which would also destroy every other justification.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public-page rule
// ---------------------------------------------------------------------------

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const QUOTED_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Shipped pages may not call a retired route prefix from EXECUTABLE content.
 * Only <script> bodies (HTML) or whole files (.js) are inspected, and only
 * quoted string literals within them — so documentation prose such as
 * `<p>POST /api/sync-orchestrator/.../cancel</p>` is correctly not a call.
 *
 * Note this rule flags RETIRED prefixes only. Browser code has an origin and a
 * session cookie, so a page calling any OTHER /api/ route is normal and
 * allowed. Both remaining prefixes are still mounted too — they are banned
 * because they are platform-admin-only process state with no legitimate
 * public-page consumer, not because a call to them would 404.
 *
 * @param {string} root
 * @param {Array<object>} violations
 */
function scanPublicScripts(root, violations) {
  const publicRoot = path.join(root, 'public');
  if (!fs.existsSync(publicRoot)) return;

  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`FAIL: cannot read public scope ${toPosix(path.relative(root, dir))}: ${err.message}`);
      process.exit(2);
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PUBLIC_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.js'))) {
        files.push(abs);
      }
    }
  };
  walk(publicRoot);

  for (const abs of files.sort()) {
    const rel = toPosix(path.relative(root, abs));
    // FAIL-CLOSED, like the readdirSync above: an unreadable file must not exit
    // 1, which is this gate's "violations found" code.
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot read public file ${rel}: ${err.message}`);
      process.exit(2);
    }
    /** @type {Array<{code: string, offset: number}>} */
    const segments = [];
    if (abs.endsWith('.js')) {
      segments.push({ code: text, offset: 0 });
    } else {
      SCRIPT_BLOCK_RE.lastIndex = 0;
      let block;
      while ((block = SCRIPT_BLOCK_RE.exec(text)) !== null) {
        segments.push({ code: block[1], offset: block.index + block[0].indexOf(block[1]) });
      }
    }

    for (const segment of segments) {
      const cleaned = blankJsComments(segment.code);
      QUOTED_LITERAL_RE.lastIndex = 0;
      let lit;
      while ((lit = QUOTED_LITERAL_RE.exec(cleaned)) !== null) {
        const value = lit[2];
        const retired = RETIRED_PREFIXES.find((p) => value.startsWith(p));
        if (!retired) continue;
        const absOffset = segment.offset + lit.index;
        const line = text.slice(0, absOffset).split('\n').length;
        violations.push({
          file: rel,
          line,
          rule: 'public-retired-route',
          detail:
            `executable script literal "${value}" calls retired route prefix "${retired}". ` +
            'The route is still mounted and serving, but it is platform-global process state behind ' +
            'requirePlatformAdmin, so no public page has a legitimate reason to call it. ' +
            'Render page-local fixtures instead.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** @param {Array<object>} violations */
function printViolations(violations) {
  const sorted = [...violations].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  for (const v of sorted) {
    console.error(`${v.file}:${v.line} ${v.rule}: ${v.detail}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const { root, emitInventory } = parseRoot(process.argv.slice(2));

// Fail-closed premise check, BEFORE any inventory read: if a page PR2 rewrote is
// gone, the gate cannot verify what it claims to verify.
const missingPages = REQUIRED_PUBLIC_PAGES.filter((p) => !fs.existsSync(path.join(root, p)));
if (missingPages.length > 0) {
  console.error('FAIL: required shipped page(s) are missing — cannot verify the fixture-render premise:');
  for (const p of missingPages) console.error(`  ${p}`);
  console.error('If a page was intentionally renamed or deleted, update REQUIRED_PUBLIC_PAGES in this script.');
  process.exit(2);
}

/** @type {Array<object>} */
const violations = [];
/** @type {Array<object>} */
const allSinks = [];

for (const abs of discoverSourceFiles(root)) {
  const rel = toPosix(path.relative(root, abs));
  // FAIL-CLOSED, like the readdirSync in discoverSourceFiles: an unreadable file
  // must not exit 1, which is this gate's "violations found" code.
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read source file ${rel}: ${err.message}`);
    process.exit(2);
  }
  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);

  checkRetiredIdentifiers(rel, sourceFile, violations);

  const constInitializers = collectConstInitializers(sourceFile);
  const fileSinks = [
    ...collectDirectAndAliasSinks(rel, sourceFile),
    ...collectEmbeddedTemplateSinks(rel, sourceFile),
  ];

  // Ordinals disambiguate residual same-key collisions within one file.
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const sink of fileSinks) {
    const base = `${sink.enclosing}|${sink.callee}|${sink.argFingerprint}`;
    const n = seen.get(base) ?? 0;
    sink.ordinal = n;
    seen.set(base, n + 1);
  }

  for (const sink of fileSinks) {
    if (sink.pass === 'direct') {
      // Rule 2: server-side code has no origin, so a resolvable self-target is
      // definitionally a loopback call.
      for (const value of foldExpression(sink.argNode, sourceFile, constInitializers, 0)) {
        const reason = selfFetchReason(value);
        if (reason) {
          violations.push({ file: rel, line: sink.line, rule: 'loopback-self-fetch', detail: reason });
          break;
        }
      }
    } else {
      // Embedded browser code MAY call this server's live /api/ routes; it may
      // never call one of the RETIRED prefixes. Those routes are still
      // mounted and still serving — they are banned because they are
      // platform-admin-only process state with no legitimate public-page
      // consumer.
      QUOTED_LITERAL_RE.lastIndex = 0;
      let lit;
      while ((lit = QUOTED_LITERAL_RE.exec(sink.embeddedArgText)) !== null) {
        const retired = RETIRED_PREFIXES.find((p) => lit[2].startsWith(p));
        if (retired) {
          violations.push({
            file: rel,
            line: sink.line,
            rule: 'loopback-self-fetch',
            detail:
              `embedded browser fetch targets retired route prefix "${retired}". ` +
              'The route is still mounted and serving, but it is platform-global process state behind ' +
              'requirePlatformAdmin, so no public page has a legitimate reason to call it.',
          });
          break;
        }
      }
    }
    allSinks.push({
      file: sink.file,
      enclosing: sink.enclosing,
      callee: sink.callee,
      argFingerprint: sink.argFingerprint,
      ordinal: sink.ordinal,
      // Carried for violation reporting ONLY. Deliberately stripped before the
      // inventory is emitted and never part of sinkKey(): a line number churns
      // on every unrelated edit above it, which would make the inventory a
      // merge-conflict generator instead of a stable record.
      line: sink.line,
    });
  }
}

// --emit-inventory branches HERE: after discovery and Rule 1/Rule 2, but BEFORE
// reading the inventory file. Shell redirection (`> inventory.json`) truncates
// the target before node starts, so a gate that read the inventory in this mode
// would read an empty file and emit a wrong census.
if (emitInventory) {
  if (violations.length > 0) {
    console.error('NOTE: rule violations exist in this tree; the emitted inventory is still written.');
    printViolations(violations);
  }
  const payload = {
    sinks: allSinks.map(({ line: _line, ...s }) => ({ ...s, classification: 'UNCLASSIFIED' })),
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(0);
}

validateInventory(allSinks, readInventory(root), violations);
scanPublicScripts(root, violations);

if (violations.length > 0) {
  printViolations(violations);
  console.error('');
  console.error(`FAIL: ${violations.length} loopback self-fetch violation(s).`);
  console.error('Server code must never call its own HTTP API — it has no credentials, gets a 401,');
  console.error('and the silent fixture fallback makes fabricated data indistinguishable from real data.');
  process.exit(1);
}

console.log(
  `[no-loopback-self-fetch] OK: ${allSinks.length} classified fetch sink(s); 0 self-fetch; ` +
    `${REQUIRED_PUBLIC_PAGES.length} shipped pages verified.`,
);
process.exit(0);
