import * as fs from 'fs';
import * as path from 'path';
import sanitizeHtml from 'sanitize-html';

/**
 * HTML safety helpers for the /docs renderer (src/routes/docs.ts).
 *
 * Trust boundary: docs content comes only from repo files, but the route is unauthenticated and
 * CSP is off in demo mode, so every marked output passes `sanitizeDocsHtml` and every string
 * placed in page chrome goes through the escaper for its context. See
 * docs/guides/SECURITY-AND-RATE-LIMITING.md ("Docs route rendering").
 */

/** Remote hosts allowed as https image sources in rendered docs (measured usage, 2026-09-22). */
export const DOCS_IMAGE_HOSTS: readonly string[] = Object.freeze([
  'img.shields.io',
  'coveralls.io',
  'demo.kstratmdconsulting.com',
]);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The URL a browser actually resolves from an attribute value: ASCII tab/LF/CR removed anywhere,
 * C0 controls and spaces stripped from both ends, `\` read as `/` (WHATWG URL parsing).
 */
function browserNormalisedUrl(src: string): string {
  let s = '';
  for (const ch of src) {
    const c = ch.charCodeAt(0);
    if (c !== 9 && c !== 10 && c !== 13) s += ch;
  }
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end).replace(/\\/g, '/');
}

function isAllowedImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  // Decide on what the browser will request, not the raw attribute: ` https://x`, `\thttps://x`
  // and `\\x/p` all resolve to off-allowlist hosts.
  const normalized = browserNormalisedUrl(src);
  if (!normalized) return false;
  if (normalized.startsWith('//')) return false;
  if (!SCHEME_RE.test(normalized)) return true; // relative URL
  try {
    const u = new URL(normalized);
    return u.protocol === 'https:' && DOCS_IMAGE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

// Tag name that is never allowed, used to discard inputs that are not checkboxes.
const DROP_TAG = 'x-docs-drop';

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = Object.freeze({
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'details', 'summary', 'del', 'input',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'name'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['align'],
    td: ['align'],
    input: ['type', 'checked', 'disabled'],
  },
  // `class` is allowed only through this filter; no other tag keeps a class.
  allowedClasses: { code: ['language-*', 'lang-*'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Complete list (sanitize-html requires it to be complete when overridden): these are
  // dropped together with everything inside them.
  nonTextTags: [
    'script', 'style', 'textarea', 'option', 'xmp', 'noscript',
    'iframe', 'svg', 'math', 'object', 'embed', 'form',
  ],
  transformTags: {
    // Decide on the ORIGINAL attributes: exclusiveFilter only sees them after transformation.
    input: (_tagName: string, attribs: sanitizeHtml.Attributes) => {
      if ((attribs.type || '').toLowerCase() !== 'checkbox') {
        return { tagName: DROP_TAG, attribs: {} };
      }
      const out: sanitizeHtml.Attributes = { type: 'checkbox', disabled: '' };
      if ('checked' in attribs) out.checked = '';
      return { tagName: 'input', attribs: out };
    },
  },
  exclusiveFilter: (frame: sanitizeHtml.IFrame) =>
    frame.tag === 'img' && !isAllowedImageSrc(frame.attribs.src),
});

/** Sanitise HTML produced from docs Markdown (marked or the built-in fallback). */
export function sanitizeDocsHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/** Escape for HTML text and quoted attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const JS_UNSAFE_RE = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

/**
 * A JavaScript string literal for embedding inside an inline <script>: JSON.stringify, then
 * `<`, `>`, `&`, U+2028 and U+2029 become six-character unicode escapes, so the literal can
 * neither close the script element nor break the line. Evaluating it yields `s` exactly.
 */
export function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(
    JS_UNSAFE_RE,
    c => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
  );
}

/** Percent-encode each `/`-separated segment of a path, keeping the separators. */
export function encodePathSegments(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** True when `candidate` resolves to `root` itself or a path beneath it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Like isInsideRoot, but compares REAL paths, so a symlink or junction inside `root` that points
 * outside it is rejected before anything follows it. A candidate that does not exist at all has
 * nothing to follow and falls back to the lexical check (the caller's existence check then 404s);
 * any other realpath failure (ELOOP from a self-referencing link, a dangling link, EACCES) refuses.
 */
export function isRealPathInsideRoot(root: string, candidate: string): boolean {
  if (!isInsideRoot(root, candidate)) return false;
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    try {
      fs.lstatSync(candidate);
      return false; // something is there (e.g. a dangling link) but cannot be resolved
    } catch (lstatErr) {
      // Only a confirmed-missing path takes the lexical fallback; EACCES, EPERM, ELOOP... refuse.
      return (lstatErr as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  return isInsideRoot(realRoot, realCandidate);
}

/** `<li>` link list for docs indexes: labels escaped, hrefs segment-encoded then attribute-escaped. */
export function renderDocLinkList(links: readonly { path: string; label: string }[], liClass = 'mb-1'): string {
  const cls = liClass ? ` class="${escapeHtml(liClass)}"` : '';
  return links
    .map(l => `<li${cls}><a class="text-indigo-600 hover:underline" href="${escapeHtml(encodePathSegments(l.path))}">${escapeHtml(l.label)}</a></li>`)
    .join('');
}
