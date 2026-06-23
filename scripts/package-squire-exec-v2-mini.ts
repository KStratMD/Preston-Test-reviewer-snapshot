import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import archiver from 'archiver';

const DIST_DIR = path.join(process.cwd(), 'dist', 'executive-package-v2-mini');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

function run(command: string, args: string[], label: string): void {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function formatStamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function sha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function resolveReleaseLabel(): string {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const fallback = `v${String(packageJson.version || '0.0.0')}`;
  const raw = (process.env.EXEC_PACKAGE_RELEASE || fallback).trim();
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-');
}

const WATCH_PAGES = [
  'squire-v2-media-demo/watch/storyboard.html',
  'squire-v2-media-demo/watch/scenes/scene1-problem-visual.html',
  'squire-v2-media-demo/watch/scenes/scene6-nl-action-gate-visual.html',
  'squire-v2-media-demo/watch/scenes/scene7-opportunity-visual.html',
  'squire-v2-media-demo/watch/videos/index.html',
  'squire-v2-media-demo/watch/videos/player.html',
  'squire-v2-media-demo/watch/videos/transcripts.html',
];

const MINI_EXTRA_PUBLIC_FILES = [
  'squire-v2-media-demo/index.html',
  'squire-v2-media-demo/click/demo-guide.html',
  'squire-v2-media-demo/click/setup.html',
  'squire-v2-media-demo/for-leadership.html',
  'squire-v2-media-demo/read/business-case.html',
  'squire-v2-media-demo/read/context-sidecar-proof.html',
  'squire-v2-media-demo/read/executive-summary.html',
  'squire-v2-media-demo/read/competitive-diff.html',
  'squire-v2-media-demo/read/talking-points.html',
  'squire-v2-media-demo/read/risks-mitigations.html',
  'squire-v2-media-demo/read/elevator-pitch.html',
  'squire-v2-media-demo/read/mcp-proof-console.html',
  'squire-v2-media-demo/read/roi-calculator.html',
  'squire-v2-media-demo/read/mcp-positioning-diagram.html',
  'squire-v2-media-demo/read/engineering-scale.html',
  'squire-v2-media-demo/read/suiteapp-badge-readiness.html',
  'squire-v2-media-demo/oracle-comparison.html',
  'compliance-dashboard.html',
  'squire-portfolio-evidence.html',
  // Required by squire-portfolio-evidence.html — the surface fetches this
  // JSON for its content. Validator currently only enforces HTML→HTML
  // links, but the data file is needed for the page to work offline in
  // the mini-pack.
  'portfolio-evidence.json',
  // Integration Hub shell assets statically referenced by the two shelled
  // pages above (<link>/<script> in their <head>). Bundle them so the pages
  // keep their styling offline and the mini-pack link validator passes. The
  // shell's JS-injected Review tab → /review-hub.html is a server-only surface
  // here (like the dashboards in MINI_ALLOWED_SERVER_LINK_PREFIXES), not bundled.
  'css/integration-hub-shell.css',
  'js/integration-hub-shell.js',
];

const MINI_EXTRA_PUBLIC_DIRS = [
  'wiki',
];

const MINI_EXTRA_REPO_FILES = [
  {
    absolutePath: path.join(process.cwd(), 'docs', 'suiteapp', 'SUITEAPP-AI-BADGE-PREP.md'),
    zipPath: 'docs/suiteapp/SUITEAPP-AI-BADGE-PREP.md',
  },
  {
    absolutePath: path.join(process.cwd(), 'docs', 'research', 'NETSUITE-SDF-AND-ERP-MCP-RESEARCH.md'),
    zipPath: 'docs/research/NETSUITE-SDF-AND-ERP-MCP-RESEARCH.md',
  },
  {
    absolutePath: path.join(process.cwd(), 'docs', 'deliverables', 'SuiteCentral-2.0-Leadership-Brief.md'),
    zipPath: 'docs/deliverables/SuiteCentral-2.0-Leadership-Brief.md',
  },
  {
    absolutePath: path.join(process.cwd(), 'SQUIRE_BUSINESS_CASE.md'),
    zipPath: 'SQUIRE_BUSINESS_CASE.md',
  },
];

const MINI_EXTRA_MEDIA_FILES = [
  'media/demos/ai-governance-layer-20260308.mp4',
  'media/demos/ai-governance-layer-20260308-poster.png',
  'media/demos/sync-error-assist-demo.mp4',
  'media/demos/sync-error-assist-demo.webp',
  'media/demos/captions/sync-error-assist-demo.vtt',
];

const MINI_ALLOWED_SERVER_LINK_PREFIXES = [
  'api/',
  // Narrowly scoped to the one tag page that is NOT in the committed (and
  // therefore packaged) wiki: tags/portfolio.html is swallowed by the
  // over-broad `port*.html` rule in .gitignore, so its links can't resolve
  // inside the mini-pack even though hosted-deploy regenerates it on the live
  // site. isAllowedServerOnlyLink matches by prefix, so this exempts the
  // portfolio tag page (and only the portfolio* prefix) rather than the whole
  // wiki/tags/ subtree, so genuine broken tag links elsewhere are still caught.
  // Follow-up: narrow the .gitignore rule so portfolio.html gets committed,
  // after which this entry can be removed.
  'wiki/tags/portfolio',
  // The full offline package zip is stripped from the hosted build (exceeds
  // Cloudflare Pages' per-file limit) and served via a _redirects 302; the wiki
  // pages legitimately link to it.
  'wiki/downloads/suitecentral-offline-package.zip',
  // Interactive knowledge dashboards whose "Ask" panels call /api/help/*. They
  // ship in the hosted build (Cloudflare static + Railway API) but NOT in the
  // no-server mini-pack, so the curated nav pages link to them as server-only
  // surfaces. Exact filenames keep the exemption from leaking to other links.
  'code-architecture-dashboard.html',
  'suitecentral-deployment-options-dashboard.html',
];

const WATCH_MEDIA_BASES = [
  'executive-reel-4min',
  'scene1-problem-visual',
  'scene2-suitecentral-intro',
  'storyboard-overview',
  'ai-field-mapping-editor-demo',
  'scene4-governance-compliance',
  'context-sidecar-demo',
  'context-sidecar-demo-highlight',
  'scene6-nl-action-gate-visual',
  'scene7-opportunity-visual',
  'contract-central-demo',
  'customer-central-demo',
  'customer-payment-portal-demo',
  'finance-central-demo',
  'installer-central-proximity',
  'inventory-central-demo',
  'mdm-central-demo',
  'payment-central-demo',
  'payout-central-demo',
  'portal-central-demo',
  'quality-central-demo',
  'service-central-demo',
  'supplier-central-demo',
  'sync-central-demo',
  'vendor-portal-demo',
  'workflow-central-demo',
];

function getMiniExecutiveFiles(): string[] {
  const executiveRoot = path.join(PUBLIC_DIR, 'Squire-Executive-Package-v2');
  const htmlFiles = fs.readdirSync(executiveRoot)
    .filter((entry) => entry.toLowerCase().endsWith('.html'))
    .map((entry) => `Squire-Executive-Package-v2/${entry}`);

  const appendixRoot = path.join(executiveRoot, 'APPENDIX');
  const appendixFiles = fs.existsSync(appendixRoot)
    ? fs.readdirSync(appendixRoot)
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .map((entry) => `Squire-Executive-Package-v2/APPENDIX/${entry}`)
    : [];

  return [
    ...htmlFiles.sort(),
    'Squire-Executive-Package-v2/README.md',
    ...appendixFiles.sort(),
  ];
}

function addFileOrWarn(archive: archiver.Archiver, absolutePath: string, zipPath: string): boolean {
  if (fs.existsSync(absolutePath)) {
    archive.file(absolutePath, { name: zipPath });
    return true;
  }
  console.warn(`Skipping missing file: ${zipPath}`);
  return false;
}

function toRelativeFileUrl(fromZipPath: string, targetPath: string): string {
  const fromDir = path.posix.dirname(fromZipPath);
  const cleanTarget = targetPath.replace(/^\/+/, '');
  const relative = path.posix.relative(fromDir, cleanTarget);
  if (!relative || relative.length === 0) return './';
  return relative;
}

function splitFileUrlSuffix(targetPath: string): { pathPart: string; suffix: string } {
  const hashIndex = targetPath.indexOf('#');
  const queryIndex = targetPath.indexOf('?');
  const indices = [hashIndex, queryIndex].filter((index) => index >= 0);
  const cutoff = indices.length > 0 ? Math.min(...indices) : -1;
  if (cutoff === -1) {
    return { pathPart: targetPath, suffix: '' };
  }
  return {
    pathPart: targetPath.slice(0, cutoff),
    suffix: targetPath.slice(cutoff),
  };
}

function resolvePackagedFileModeTarget(fromZipPath: string, targetPath: string): string | null {
  const { pathPart, suffix } = splitFileUrlSuffix(targetPath.trim());
  const normalized = normalizeMiniLink(fromZipPath, pathPart);
  if (!normalized) return null;
  if (isAllowedServerOnlyLink(normalized)) return targetPath;

  const resolvedCandidates = path.posix.extname(normalized)
    ? [normalized]
    : [`${normalized}.html`, path.posix.join(normalized, 'index.html'), normalized];

  const resolved = resolvedCandidates.find((candidate) => fs.existsSync(path.join(PUBLIC_DIR, candidate)))
    ?? normalized;

  return `${toRelativeFileUrl(fromZipPath, resolved)}${suffix}`;
}

function rewriteHtmlForFileMode(html: string, zipPath: string): string {
  const rewrittenAttributes = html.replace(
    /\b(href|src|poster|action)=(["'])([^"']+)\2/g,
    (match, attr, quote, target) => {
      const rewritten = resolvePackagedFileModeTarget(zipPath, String(target));
      if (!rewritten) return match;
      return `${attr}=${quote}${rewritten}${quote}`;
    },
  );

  return rewrittenAttributes.replace(
    /<meta\b[^>]*http-equiv=(["'])refresh\1[^>]*>/gi,
    (tag) => tag.replace(/\bcontent=(["'])([^"']*)\1/i, (contentMatch, quote: string, value: string) => {
      const rewrittenValue = value.replace(/^(.*?\burl=)(.+)$/i, (_match, prefix: string, target: string) => {
        const rewrittenTarget = resolvePackagedFileModeTarget(zipPath, target.trim());
        return rewrittenTarget ? `${prefix}${rewrittenTarget}` : `${prefix}${target}`;
      });
      return rewrittenValue === value ? contentMatch : `content=${quote}${rewrittenValue}${quote}`;
    }),
  );
}

function injectOfflineMarkdown(html: string, markdown: string, target: string): string {
  const safeMd = markdown.replace(/<\/script/gi, '<\\/script');
  const offlineMarkdownTag = `<script type="text/markdown" id="offline-md">\n${safeMd}\n</script>\n`;
  let injectionApplied = false;

  const injectedHtml = html.replace(/<\/head\s*>/i, (match) => {
    injectionApplied = true;
    return `${offlineMarkdownTag}${match}`;
  });

  if (!injectionApplied) {
    throw new Error(`Failed to inject offline markdown into ${target}: closing </head> tag not found`);
  }

  return injectedHtml;
}

/**
 * Replace the placeholder `<script type="application/json" id="offline-manifest"></script>`
 * in `html` with one that carries the JSON payload inline. The mini-pack
 * contract is "browser-only, no local server" (see EVALUATION.md /
 * REVIEWER-GUIDE.md), so any page that would otherwise need fetch() must
 * have its data inlined here. Mirrors injectOfflineMarkdown's safety:
 * escapes any literal `</script` inside the JSON so a value containing
 * that token cannot close the wrapping tag.
 */
function injectOfflineManifestJson(html: string, jsonText: string, target: string): string {
  const safeJson = jsonText.replace(/<\/script/gi, '<\\/script');
  let injectionApplied = false;

  // Tolerant placeholder match (Copilot R7 finding on PR 22 — the prior
  // exact-string regex broke on harmless reformats):
  //   - attribute order is allowed in either direction via two lookaheads;
  //   - any other attributes on the opening tag are permitted;
  //   - whitespace/newlines inside the opening tag, between tags, and
  //     before the close-tag name are all tolerated.
  // The body must still be empty (whitespace only) so we never silently
  // overwrite real content; non-placeholder occurrences fail loud below.
  const placeholderRe =
    /<script\b(?=[^>]*\btype\s*=\s*"application\/json")(?=[^>]*\bid\s*=\s*"offline-manifest")[^>]*>\s*<\/script\s*>/i;
  const injected = html.replace(placeholderRe, () => {
    injectionApplied = true;
    return `<script type="application/json" id="offline-manifest">\n${safeJson}\n</script>`;
  });

  if (!injectionApplied) {
    throw new Error(
      `Failed to inject offline manifest into ${target}: placeholder ` +
        `<script type="application/json" id="offline-manifest"></script> not found ` +
        `(checked with a tolerant regex — attribute order and whitespace are flexible, ` +
        `but a non-empty body or a missing required attribute will not match).`,
    );
  }

  return injected;
}

function addHtmlFileForMini(archive: archiver.Archiver, absolutePath: string, zipPath: string): string | null {
  if (!fs.existsSync(absolutePath)) {
    console.warn(`Skipping missing file: ${zipPath}`);
    return null;
  }

  let raw = fs.readFileSync(absolutePath, 'utf8');

  // Inject markdown directly for offline viewing of the business case
  if (zipPath === 'squire-v2-media-demo/read/business-case.html') {
    const mdPath = path.join(process.cwd(), 'SQUIRE_BUSINESS_CASE.md');
    const mdContent = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    raw = injectOfflineMarkdown(raw, mdContent, zipPath);
  }

  // Inject the portfolio evidence manifest JSON so the page renders without
  // an HTTP server (the mini-pack contract is browser-only/no-server). The
  // HTML carries an empty placeholder
  // `<script type="application/json" id="offline-manifest"></script>`;
  // both `type` and `id` attributes are required (see the lookaheads in
  // injectOfflineManifestJson's regex). We fill it with the contents of
  // public/portfolio-evidence.json here so the
  // page's three-tier loader (offline / file://-warning / fetch) picks the
  // offline path first. Codex P2 on PR 22 caught the contract violation
  // where the prior file://-warning fallback contradicted the mini-pack
  // promise.
  if (zipPath === 'squire-portfolio-evidence.html') {
    const manifestPath = path.join(PUBLIC_DIR, 'portfolio-evidence.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Cannot inject portfolio-evidence.json into ${zipPath}: ${manifestPath} is missing. ` +
          `Run npm run build:portfolio-evidence-manifest first.`,
      );
    }
    raw = injectOfflineManifestJson(raw, fs.readFileSync(manifestPath, 'utf8'), zipPath);
  }

  const rewritten = rewriteHtmlForFileMode(raw, zipPath);
  archive.append(rewritten, { name: zipPath });
  return rewritten;
}

function appendPublicDirectoryForMini(
  archive: archiver.Archiver,
  publicRelativeDir: string,
  packagedPaths: Set<string>,
  packagedHtml: Map<string, string>,
): void {
  const absoluteDir = path.join(PUBLIC_DIR, publicRelativeDir);
  if (!fs.existsSync(absoluteDir)) {
    console.warn(`Skipping missing directory: ${publicRelativeDir}`);
    return;
  }

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    entries.forEach((entry) => {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        return;
      }

      const zipPath = path.relative(PUBLIC_DIR, absolutePath).replace(/\\/g, '/');
      if (zipPath.endsWith('.html')) {
        const html = addHtmlFileForMini(archive, absolutePath, zipPath);
        if (html !== null) {
          packagedPaths.add(zipPath);
          packagedHtml.set(zipPath, html);
        }
        return;
      }

      if (addFileOrWarn(archive, absolutePath, zipPath)) packagedPaths.add(zipPath);
    });
  };

  walk(absoluteDir);
}

export function normalizeMiniLink(fromZipPath: string, link: string): string | null {
  const trimmed = (link || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.includes('${')) return null;
  if (/^(mailto:|tel:|javascript:|data:|https?:|\/\/)/i.test(trimmed)) return null;

  const withoutHash = trimmed.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  if (!withoutQuery) return null;

  const normalized = withoutQuery.startsWith('/')
    ? withoutQuery.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromZipPath), withoutQuery));

  if (!normalized || normalized === '.') return path.posix.dirname(fromZipPath);
  if (normalized.endsWith('/')) return path.posix.join(normalized, 'index.html');
  return normalized;
}

function collectHtmlLinks(html: string): string[] {
  const links = new Set<string>();
  const attrPattern = /\b(?:href|src|poster|action)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    if (match[1]) links.add(match[1]);
  }
  return [...links];
}

export function isAllowedServerOnlyLink(normalizedTarget: string): boolean {
  return MINI_ALLOWED_SERVER_LINK_PREFIXES.some((prefix) => (
    normalizedTarget === prefix || normalizedTarget.startsWith(prefix)
  ));
}

export function resolveMiniLinkCandidates(normalizedTarget: string): string[] {
  if (path.posix.extname(normalizedTarget)) {
    return [normalizedTarget];
  }
  return [
    normalizedTarget,
    `${normalizedTarget}.html`,
    path.posix.join(normalizedTarget, 'index.html'),
  ];
}

export function validateMiniHtmlLinks(
  htmlByPath: Map<string, string>,
  packagedPaths: Set<string>,
  pagesToValidate: Set<string>,
): void {
  const missing: Array<{ from: string; to: string }> = [];

  for (const [fromPath, html] of htmlByPath.entries()) {
    if (!pagesToValidate.has(fromPath)) continue;
    const links = collectHtmlLinks(html);
    for (const link of links) {
      const normalized = normalizeMiniLink(fromPath, link);
      if (!normalized) continue;
      if (isAllowedServerOnlyLink(normalized)) continue;
      if (resolveMiniLinkCandidates(normalized).some((candidate) => packagedPaths.has(candidate))) continue;

      missing.push({ from: fromPath, to: normalized });
    }
  }

  if (missing.length > 0) {
    const details = missing
      .slice(0, 40)
      .map((entry) => `${entry.from} -> ${entry.to}`)
      .join('\n');
    const suffix = missing.length > 40 ? `\n...and ${missing.length - 40} more` : '';
    throw new Error(`Mini-pack link validation failed (${missing.length} missing target(s)):\n${details}${suffix}`);
  }
}

function startHereText(): string {
  return [
    'SuiteCentral 2.0 No-Server Mini-Pack',
    '',
    'Open this file first in your browser:',
    '  START-HERE.html',
    '',
    'Primary package guide:',
    '  Squire-Executive-Package-v2/20-NO-SERVER-MINI-PACK-STANDALONE.html',
    '',
    'Suggested async review order:',
    '  1) Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html',
    '  2) squire-v2-media-demo/index.html',
    '  3) Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html',
    '  4) squire-v2-media-demo/watch/videos/player.html?video=executive-reel',
    '  5) SELF-TEST.html',
    '',
    'Note:',
    '  This mini-pack is browser-only and does not require npm or a local API server.',
    '  Direct .webm files are raw media assets and do not run narration scripts.',
    '',
  ].join('\n');
}

function buildRootStartHereHtml(releaseLabel: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>SuiteCentral 2.0 - Mini Pack Start Here</title>',
    '  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#020617;color:#e2e8f0;padding:32px;line-height:1.5}a{color:#22d3ee}.card{max-width:900px;border:1px solid #334155;background:#0f172a;padding:24px;border-radius:16px}</style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    '    <p><strong>SuiteCentral 2.0 No-Server Mini Pack</strong> &middot; Release ' + releaseLabel + '</p>',
    '    <h1>Start Here</h1>',
    '    <p>Open this page first:</p>',
    '    <p><a href="./Squire-Executive-Package-v2/20-NO-SERVER-MINI-PACK-STANDALONE.html">./Squire-Executive-Package-v2/20-NO-SERVER-MINI-PACK-STANDALONE.html</a></p>',
    '    <p>Then open:</p>',
    '    <ul>',
    '      <li><a href="./Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html">Start Here (Async)</a></li>',
    '      <li><a href="./squire-v2-media-demo/index.html">Demo Hub (Watch / Click / Read)</a></li>',
    '      <li><a href="./Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html">Decision Path</a></li>',
    '      <li><a href="./squire-v2-media-demo/watch/videos/player.html?video=executive-reel">Narrated player (executive reel)</a></li>',
    '      <li><a href="./SELF-TEST.html">Run quick package self-test</a></li>',
    '    </ul>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function buildReviewChecklistHtml(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>SuiteCentral 2.0 - Mini Pack Review Checklist</title>',
    '  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#020617;color:#e2e8f0;padding:32px;line-height:1.6}.card{max-width:920px;border:1px solid #334155;background:#0f172a;padding:24px;border-radius:16px}li{margin-bottom:10px}</style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    '    <h1>Mini Pack Checklist</h1>',
    '    <ol>',
    '      <li>Open <strong>START-HERE.html</strong> in the zip root.</li>',
    '      <li>Run Path A, B, or C from the Start Here page.</li>',
    '      <li>Use narrated player links, not raw webm links.</li>',
    '      <li>Run SELF-TEST.html and confirm all checks pass.</li>',
    '      <li>Review role brief + pilot memo and capture decision.</li>',
    '    </ol>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function buildSelfTestHtml(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>SuiteCentral 2.0 Mini Pack - Self Test</title>',
    '  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#020617;color:#e2e8f0;padding:28px;line-height:1.5}a{color:#22d3ee}.card{max-width:980px;border:1px solid #334155;background:#0f172a;padding:24px;border-radius:16px}.ok{color:#34d399}.fail{color:#f87171}.pending{color:#94a3b8}li{margin:8px 0}</style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    '    <h1>Mini Pack Self-Test</h1>',
    '    <p>Use this once after unzip to confirm links and media are readable from <code>file://</code>.</p>',
    '    <ol id="results">',
    '      <li data-check="start" class="pending">Checking START-HERE launcher...</li>',
    '      <li data-check="async" class="pending">Checking async guide...</li>',
    '      <li data-check="decision" class="pending">Checking decision path...</li>',
    '      <li data-check="player" class="pending">Checking narrated player page...</li>',
    '      <li data-check="video" class="pending">Checking scene2 video metadata...</li>',
    '      <li data-check="captions" class="pending">Checking scene2 captions file...</li>',
    '    </ol>',
    '    <p class="pending" id="summary">Running checks...</p>',
    '    <p><a href="./START-HERE.html">Open START-HERE.html</a></p>',
    '  </div>',
    '  <script>',
    '    const checks = [',
    "      { key: 'start', url: './START-HERE.html', type: 'html' },",
    "      { key: 'async', url: './Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html', type: 'html' },",
    "      { key: 'decision', url: './Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html', type: 'html' },",
    "      { key: 'player', url: './squire-v2-media-demo/watch/videos/player.html?video=scene2-intro', type: 'html' },",
    "      { key: 'video', url: './media/demos/scene2-suitecentral-intro.webm', type: 'video' },",
    "      { key: 'captions', url: './media/demos/captions/scene2-suitecentral-intro.vtt', type: 'text' },",
    '    ];',
    '',
    '    function mark(key, passed, detail) {',
    "      const row = document.querySelector(`[data-check=\"${key}\"]`);",
    '      if (!row) return;',
    "      row.className = passed ? 'ok' : 'fail';",
    "      row.textContent = `${passed ? 'PASS' : 'FAIL'}: ${detail}`;",
    '    }',
    '',
    '    function checkLoad(url) {',
    '      return new Promise((resolve) => {',
    '        const frame = document.createElement("iframe");',
    '        frame.style.display = "none";',
    '        frame.src = url;',
    '        const timer = setTimeout(() => { frame.remove(); resolve(false); }, 8000);',
    '        frame.onload = () => { clearTimeout(timer); frame.remove(); resolve(true); };',
    '        frame.onerror = () => { clearTimeout(timer); frame.remove(); resolve(false); };',
    '        document.body.appendChild(frame);',
    '      });',
    '    }',
    '',
    '    function checkVideo(url) {',
    '      return new Promise((resolve) => {',
    '        const video = document.createElement("video");',
    '        video.preload = "metadata";',
    '        video.src = url;',
    '        const timer = setTimeout(() => resolve(false), 8000);',
    '        video.onloadedmetadata = () => { clearTimeout(timer); resolve(video.duration > 1); };',
    '        video.onerror = () => { clearTimeout(timer); resolve(false); };',
    '      });',
    '    }',
    '',
    '    (async () => {',
    '      let passes = 0;',
    '      for (const check of checks) {',
    '        let ok = false;',
    "        if (check.type === 'video') ok = await checkVideo(check.url);",
    '        else ok = await checkLoad(check.url);',
    '        if (ok) passes += 1;',
    '        mark(check.key, ok, `${check.url} ${ok ? "loaded" : "failed"}`);',
    '      }',
    "      const summary = document.getElementById('summary');",
    "      summary.className = passes === checks.length ? 'ok' : 'fail';",
    "      summary.textContent = passes === checks.length ? `All checks passed (${passes}/${checks.length}).` : `Some checks failed (${passes}/${checks.length}). Use START-HERE links only.`;",
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function buildEmailTemplate(role: 'general' | 'cfo' | 'cto' | 'coo'): string {
  const roleLine = role === 'general'
    ? 'Role brief: choose CFO, CTO, or COO.'
    : `Role brief: ${role.toUpperCase()} first.`;
  return [
    'Subject: SuiteCentral 2.0 Mini Pack - Async Review',
    '',
    'Team,',
    '',
    'This mini package is browser-only (no local server required).',
    'Open START-HERE.html in the zip root.',
    'Run SELF-TEST.html once after unzip.',
    '',
    roleLine,
    'Decision path: Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html',
    'Demo Hub: squire-v2-media-demo/index.html',
    'Narrated demo: squire-v2-media-demo/watch/videos/player.html?video=executive-reel',
    '',
    'Requested outcome: approve or defer pilot with date and owner.',
    '',
  ].join('\n');
}

function buildOfflinePlaceholderHtml(
  title: string,
  description: string,
  links: Array<{ href: string; label: string }>,
): string {
  const listItems = links
    .map((entry) => `      <li><a href="${entry.href}">${entry.label}</a></li>`)
    .join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${title}</title>`,
    '  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#020617;color:#e2e8f0;padding:32px;line-height:1.6}a{color:#22d3ee}.card{max-width:920px;border:1px solid #334155;background:#0f172a;padding:24px;border-radius:16px}li{margin:8px 0}</style>',
    '</head>',
    '<body>',
    '  <div class="card">',
    `    <h1>${title}</h1>`,
    `    <p>${description}</p>`,
    '    <p>Recommended next steps:</p>',
    '    <ul>',
    listItems,
    '    </ul>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

async function createMiniZip(zipPath: string, releaseLabel: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('warning', (error: any) => {
      if (error?.code === 'ENOENT') {
        console.warn('Archive warning:', error.message);
        return;
      }
      reject(error);
    });
    archive.on('error', (error: any) => reject(error));

    archive.pipe(output);

    try {
      const packagedPaths = new Set<string>();
      const packagedHtml = new Map<string, string>();
      const miniExecutiveFiles = getMiniExecutiveFiles();

      miniExecutiveFiles.forEach((file) => {
        const fullPath = path.join(PUBLIC_DIR, file);
        if (file.endsWith('.html')) {
          const html = addHtmlFileForMini(archive, fullPath, file);
          if (html !== null) {
            packagedPaths.add(file);
            packagedHtml.set(file, html);
          }
          return;
        }
        if (addFileOrWarn(archive, fullPath, file)) packagedPaths.add(file);
      });

      WATCH_PAGES.forEach((file) => {
        const fullPath = path.join(PUBLIC_DIR, file);
        if (file.endsWith('.html')) {
          const html = addHtmlFileForMini(archive, fullPath, file);
          if (html !== null) {
            packagedPaths.add(file);
            packagedHtml.set(file, html);
          }
          return;
        }
        if (addFileOrWarn(archive, fullPath, file)) packagedPaths.add(file);
      });

      MINI_EXTRA_PUBLIC_FILES.forEach((file) => {
        const fullPath = path.join(PUBLIC_DIR, file);
        if (file.endsWith('.html')) {
          const html = addHtmlFileForMini(archive, fullPath, file);
          if (html !== null) {
            packagedPaths.add(file);
            packagedHtml.set(file, html);
          }
          return;
        }
        if (addFileOrWarn(archive, fullPath, file)) packagedPaths.add(file);
      });

      MINI_EXTRA_PUBLIC_DIRS.forEach((dir) => {
        appendPublicDirectoryForMini(archive, dir, packagedPaths, packagedHtml);
      });

      MINI_EXTRA_REPO_FILES.forEach((entry) => {
        if (addFileOrWarn(archive, entry.absolutePath, entry.zipPath)) {
          packagedPaths.add(entry.zipPath);
        }
      });

      MINI_EXTRA_MEDIA_FILES.forEach((file) => {
        const fullPath = path.join(PUBLIC_DIR, file);
        if (addFileOrWarn(archive, fullPath, file)) {
          packagedPaths.add(file);
        }
      });

      if (addFileOrWarn(archive, path.join(PUBLIC_DIR, 'js', 'narrator.js'), 'js/narrator.js')) packagedPaths.add('js/narrator.js');
      if (addFileOrWarn(archive, path.join(PUBLIC_DIR, 'js', 'narration-scripts.js'), 'js/narration-scripts.js')) packagedPaths.add('js/narration-scripts.js');
      if (addFileOrWarn(archive, path.join(PUBLIC_DIR, 'js', 'exec-metrics.js'), 'js/exec-metrics.js')) packagedPaths.add('js/exec-metrics.js');
      if (addFileOrWarn(archive, path.join(PUBLIC_DIR, 'js', 'demo-tab-nav.js'), 'js/demo-tab-nav.js')) packagedPaths.add('js/demo-tab-nav.js');

      WATCH_MEDIA_BASES.forEach((base) => {
        const webm = `media/demos/${base}.webm`;
        const webp = `media/demos/${base}.webp`;
        const captions = `media/demos/captions/${base}.vtt`;
        if (addFileOrWarn(archive, path.join(PUBLIC_DIR, webm), webm)) packagedPaths.add(webm);
        if (addFileOrWarn(archive, path.join(PUBLIC_DIR, webp), webp)) packagedPaths.add(webp);
        if (addFileOrWarn(archive, path.join(PUBLIC_DIR, captions), captions)) packagedPaths.add(captions);
      });

      const generatedStartHere = buildRootStartHereHtml(releaseLabel);
      const generatedSelfTest = buildSelfTestHtml();
      const generatedChecklist = buildReviewChecklistHtml();

      archive.append(startHereText(), { name: 'START-HERE.txt' });
      archive.append(generatedStartHere, { name: 'START-HERE.html' });
      archive.append(generatedSelfTest, { name: 'SELF-TEST.html' });
      archive.append(generatedChecklist, { name: 'REVIEW-CHECKLIST.html' });
      archive.append(buildEmailTemplate('general'), { name: 'EMAIL-TEMPLATE-GENERAL.txt' });
      archive.append(buildEmailTemplate('cfo'), { name: 'EMAIL-TEMPLATE-CFO.txt' });
      archive.append(buildEmailTemplate('cto'), { name: 'EMAIL-TEMPLATE-CTO.txt' });
      archive.append(buildEmailTemplate('coo'), { name: 'EMAIL-TEMPLATE-COO.txt' });

      packagedPaths.add('START-HERE.txt');
      packagedPaths.add('START-HERE.html');
      packagedPaths.add('SELF-TEST.html');
      packagedPaths.add('REVIEW-CHECKLIST.html');
      packagedPaths.add('EMAIL-TEMPLATE-GENERAL.txt');
      packagedPaths.add('EMAIL-TEMPLATE-CFO.txt');
      packagedPaths.add('EMAIL-TEMPLATE-CTO.txt');
      packagedPaths.add('EMAIL-TEMPLATE-COO.txt');

      packagedHtml.set('START-HERE.html', rewriteHtmlForFileMode(generatedStartHere, 'START-HERE.html'));
      packagedHtml.set('SELF-TEST.html', rewriteHtmlForFileMode(generatedSelfTest, 'SELF-TEST.html'));
      packagedHtml.set('REVIEW-CHECKLIST.html', rewriteHtmlForFileMode(generatedChecklist, 'REVIEW-CHECKLIST.html'));

      const demoCenterStub = buildOfflinePlaceholderHtml(
        'SuiteCentral Demo Center (Live Server Experience)',
        'This mini package is optimized for offline review. The full interactive Demo Center requires a running local server and live APIs.',
        [
          { href: '../Squire-Executive-Package-v2/18-LIVE-DEMO-SETUP-STANDALONE.html', label: 'Open Live Demo Setup Guide' },
          { href: '../Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html', label: 'Return to Async Start Here' },
          { href: '../squire-v2-media-demo/watch/videos/player.html?video=executive-reel', label: 'Watch Executive Reel (offline-safe)' },
        ],
      );

      const mappingStub = buildOfflinePlaceholderHtml(
        'AI Field Mapping Editor (Live Server Experience)',
        'The interactive mapping editor is available in live server mode. In this mini package, use the narrated storyboard clip instead.',
        [
          { href: './Squire-Executive-Package-v2/18-LIVE-DEMO-SETUP-STANDALONE.html', label: 'Open Live Demo Setup Guide' },
          { href: './squire-v2-media-demo/watch/videos/player.html?video=ai-field-mapping', label: 'Play AI Field Mapping Storyboard Clip' },
          { href: './Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html', label: 'Return to Async Start Here' },
        ],
      );

      archive.append(demoCenterStub, { name: 'executive/demo-center.html' });
      archive.append(mappingStub, { name: 'ai-field-mapping-editor.html' });
      packagedPaths.add('executive/demo-center.html');
      packagedPaths.add('ai-field-mapping-editor.html');
      packagedHtml.set('executive/demo-center.html', rewriteHtmlForFileMode(demoCenterStub, 'executive/demo-center.html'));
      packagedHtml.set('ai-field-mapping-editor.html', rewriteHtmlForFileMode(mappingStub, 'ai-field-mapping-editor.html'));

      validateMiniHtmlLinks(packagedHtml, packagedPaths, new Set(packagedHtml.keys()));

      archive.finalize().catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

async function main(): Promise<void> {
  const releaseLabel = resolveReleaseLabel();
  const stamp = formatStamp(new Date());
  const zipName = `squire-executive-package-v2-mini-${releaseLabel}-${stamp}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);
  const shaPath = `${zipPath}.sha256`;
  const latestZipPath = path.join(DIST_DIR, 'squire-executive-package-v2-mini-latest.zip');
  const latestShaPath = `${latestZipPath}.sha256`;

  const skipBuild = process.env.SKIP_BUILD === '1';
  const skipReel = process.env.SKIP_REEL === '1';
  if (skipBuild) {
    console.log('\n==> Skipping TypeScript build (SKIP_BUILD=1)');
  } else {
    run('npm', ['run', 'build'], 'TypeScript build');
  }
  run('npm', ['run', 'demo:validate:test-counts'], 'Validate executive test-count consistency');
  run('npm', ['run', 'demo:posters:optimize'], 'Generate lightweight static posters');
  if (skipReel) {
    console.log('\n==> Skipping executive reel build (SKIP_REEL=1)');
  } else {
    run('npm', ['run', 'demo:build:executive-reel'], 'Build executive reel media');
  }
  run('npm', ['run', 'demo:validate:watch'], 'Validate watch assets');

  console.log(`\n==> Creating mini package zip ${zipName}`);
  await createMiniZip(zipPath, releaseLabel);

  const digest = sha256(zipPath);
  fs.writeFileSync(shaPath, `${digest}  ${path.basename(zipPath)}\n`, 'utf8');
  fs.copyFileSync(zipPath, latestZipPath);
  fs.writeFileSync(latestShaPath, `${digest}  ${path.basename(latestZipPath)}\n`, 'utf8');

  const zipKB = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`Created ${zipPath} (${zipKB}KB)`);
  console.log(`Created ${shaPath}`);
  console.log(`Updated ${latestZipPath}`);
  console.log(`Updated ${latestShaPath}`);
  console.log(`SHA-256 ${digest}`);
}

// Guard the entrypoint so importing this module (e.g. from a unit test that
// exercises the pure link-classification helpers above) does not kick off the
// whole packaging pipeline. Matches scripts/openapi-drift-check.ts.
if (require.main === module) {
  main().catch((error) => {
    console.error('Mini-pack pipeline failed:', error);
    process.exit(1);
  });
}
