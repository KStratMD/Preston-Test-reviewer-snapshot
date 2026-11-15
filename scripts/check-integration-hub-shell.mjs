#!/usr/bin/env node
// Static audit for the Integration Hub shell rollout (local/internal scope).
// Asserts the home dashboard IA, the Sync AI Error Assist rename, the Review
// hub wiring, and that the shared shell assets exist. Fails closed (exit 1).
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const read = (rel) => {
  const fp = path.join(repoRoot, rel);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
};

let failed = false;
const fail = (msg) => { console.error(`[shell-audit] ${msg}`); failed = true; };

// 1) Shared shell assets must exist.
for (const asset of ['public/css/integration-hub-shell.css', 'public/js/integration-hub-shell.js']) {
  if (read(asset) === null) fail(`missing shared asset ${asset}`);
}

// 2) Home dashboard: required present, forbidden absent.
const home = read('public/index.html');
if (home === null) {
  fail('missing public/index.html');
} else {
  const required = [
    'integration-hub-shell.css',
    'data-shell-section="docs"',
    'Sync AI Error Assist',
    '/sync-error-assist.html',
    '/review-hub.html',          // Review top tab points at the hub
    'Ask NotebookLM',
    'Ask Help Assistant',
    'Go to Docs',
  ];
  const forbidden = [
    'AI-Integrated Mapping Studio',  // legacy nav item removed
    'Architecture docs &rarr;',      // redundant micro-row removed
    'Deployment report &rarr;',      // redundant micro-row removed
  ];
  for (const needle of required) {
    if (!home.includes(needle)) fail(`index.html missing ${JSON.stringify(needle)}`);
  }
  for (const needle of forbidden) {
    if (home.includes(needle)) fail(`index.html still contains ${JSON.stringify(needle)}`);
  }
  // exactly eight primary doc cards (pastel accents). Count the accent modifier
  // directly so the check doesn't depend on class-attribute ordering/spacing.
  const accents = (home.match(/ih-doc-card--(?:emerald|blue|slate|amber|cyan|rose|violet)/g) || []).length;
  if (accents !== 8) fail(`index.html expected 8 accented doc cards, found ${accents}`);
}

// 3) Sync page uses the user-facing label.
const sync = read('public/sync-error-assist.html');
if (sync === null) fail('missing public/sync-error-assist.html');
else if (!sync.includes('Sync AI Error Assist')) fail('sync-error-assist.html should use the label "Sync AI Error Assist"');

// 4) Review hub exists and exposes the proof-card surface.
const hub = read('public/review-hub.html');
if (hub === null) fail('missing public/review-hub.html');
else {
  if (!hub.includes('data-shell-section="review"')) fail('review-hub.html missing data-shell-section="review"');
  if (!/docs\/review\/proof-cards\//.test(hub)) fail('review-hub.html should link to proof cards');
}

// 5) Hosted split is intentional and complete. The shell injects a Review tab →
// /review-hub.html onto dashboards that ship to the hosted demo, so the rollout now
// ships review-hub.html PLUS the pages it links to. For every page this rollout adds
// to the hosted build, every same-origin link AND asset ref (href/src) must resolve
// in the hosted output or it 404s there. Derive the served-set from the build's
// copy DESTINATIONS, then verify each ref. Fail closed so new refs can't silently break.
const hostedBuild = read('scripts/build-hosted-artifacts.sh');
if (hostedBuild === null) {
  fail('missing scripts/build-hosted-artifacts.sh');
} else if (hub !== null) {
  // Hosted output is rooted at ${TARGET_DIR}; collect the served paths relative to it.
  const toRel = (dest) => dest.replace(/^\$\{TARGET_DIR\}\//, '/');
  const copiedFiles = [...hostedBuild.matchAll(/copy_file\s+"[^"]+"\s+"(\$\{TARGET_DIR\}\/[^"]+)"/g)].map((m) => toRel(m[1]));
  const copiedDirs = [...hostedBuild.matchAll(/copy_dir_contents\s+"[^"]+"\s+"(\$\{TARGET_DIR\}\/?[^"]*)"/g)].map((m) => toRel(m[1]).replace(/\/?$/, '/'));
  // "/" and "/index.html" are the build's generated redirect stub (heredoc, not a
  // copy_file); "/wiki/" + the copied dirs serve their trees.
  const served = new Set([...copiedFiles, '/', '/index.html']);
  const servedDirs = ['/wiki/', ...copiedDirs];
  const isServed = (ref) => served.has(ref) || servedDirs.some((d) => ref === d || ref.startsWith(d));
  // Normalize an HTML ref to a hosted absolute path; null = not same-origin (skip).
  const normalize = (raw) => {
    if (!raw || /^(https?:|mailto:|data:|tel:|javascript:|#|\/\/)/i.test(raw)) return null;
    const clean = raw.split(/[?#]/)[0];
    if (!clean) return null;
    return clean.startsWith('/') ? clean : `/${clean}`; // pages sit at hosted root
  };
  // Pages this rollout ships to the hosted EVIDENCE surface. The Review hub is
  // evidence-only on hosted (its "Live Dashboards" section is data-local-only and
  // hidden there), so the operational dashboards are intentionally NOT shipped.
  const shellHostedPages = [
    'public/review-hub.html',
    'public/squire-portfolio-evidence.html',
  ];
  for (const rel of shellHostedPages) {
    let html = read(rel);
    if (html === null) { fail(`missing ${rel}`); continue; }
    // Strip inline <script>/<style> BODIES (keep the opening tags so <script src>
    // refs survive) so JS string concatenation like '/' + link + '' isn't scanned,
    // and drop data-local-only sections — their tiles are hidden on the hosted demo.
    html = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
    html = html.replace(/<section\b[^>]*\bdata-local-only\b[^>]*>[\s\S]*?<\/section>/gi, '');
    const refs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => normalize(m[1])).filter(Boolean);
    for (const ref of [...new Set(refs)]) {
      if (!isServed(ref)) {
        fail(`${rel} references ${JSON.stringify(ref)} but build-hosted-artifacts.sh does not ship it (would 404 on the demo)`);
      }
    }
  }
  // Belt-and-suspenders: the hub page, the Portfolio page + its data, and the
  // evidence tree must be copied; the live-only dashboards must NOT be.
  for (const [re, msg] of [
    [/copy_file\s+"\$\{PUBLIC_DIR\}\/review-hub\.html"/, 'build-hosted-artifacts.sh must copy review-hub.html (shell injects a hosted Review tab)'],
    [/copy_file\s+"\$\{PUBLIC_DIR\}\/squire-portfolio-evidence\.html"/, 'build-hosted-artifacts.sh must copy squire-portfolio-evidence.html (Review hub Portfolio tile)'],
    [/copy_file\s+"\$\{PUBLIC_DIR\}\/portfolio-evidence\.json"/, 'build-hosted-artifacts.sh must copy portfolio-evidence.json (squire-portfolio-evidence.html fetches it)'],
    [/copy_file\s+"\$\{PUBLIC_DIR\}\/Integration-Command-Center\.html"/, 'build-hosted-artifacts.sh must copy Integration-Command-Center.html (hosted Build/Back-to-Hub target)'],
    [/copy_dir_contents\s+"\$\{DOCS_DIR\}\/review"/, 'build-hosted-artifacts.sh must copy docs/review (review-hub tiles link to proof cards + benchmarks)'],
    [/window\.__IH_HOSTED__\s*=\s*true/, 'build-hosted-artifacts.sh must stamp window.__IH_HOSTED__ into the hosted integration-hub-shell.js (artifact-specific gate for hosted Build target + local-only hide)'],
  ]) {
    if (!re.test(hostedBuild)) fail(msg);
  }
  for (const localOnly of ['system-status.html', 'metrics-viewer.html', 'cost-transparency-dashboard.html']) {
    if (new RegExp(`copy_file\\s+"\\$\\{PUBLIC_DIR\\}\\/${localOnly.replace('.', '\\.')}"`).test(hostedBuild)) {
      fail(`build-hosted-artifacts.sh ships ${localOnly}, but it is a local-only live dashboard (hidden on the hosted Review hub) — do not ship it`);
    }
  }
}

if (failed) process.exit(1);
console.log('[shell-audit] Integration Hub shell checks passed');
