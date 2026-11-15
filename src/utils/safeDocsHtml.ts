import * as fs from 'fs';
import * as path from 'path';
import { defaultTreeAdapter, Parser, serialize, type DefaultTreeAdapterMap } from 'parse5';
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

/**
 * Browser-equivalent normalisation before the allowlist.
 *
 * The sanitizer's parser (htmlparser2) and a browser tokenise some constructs differently: `<![CDATA[ ... ]]>`
 * is one opaque section to htmlparser2 but a bogus comment ending at the FIRST `>` to a browser (outside
 * foreign content); invalid end-tag openers, quotes inside unquoted attribute values, script double-escape
 * states and case folding all have rules that htmlparser2 does not follow. Content between the two readings is
 * hidden from one parser and live in the other, which is how GHSA-x3q4-9hxx-gx8m resurfaces on sanitize-html
 * 2.18.x. Patching individual constructs (a regex, then a hand-written tokenizer scanner) kept losing to a new
 * disagreement, so the design is to stop second-guessing the browser:
 *
 *  1. Parse with parse5, the WHATWG-compliant parser, with scripting enabled (so `<noscript>` is raw text, as
 *     in a browser). Whatever a browser would build as a tree, we build the same tree.
 *  2. Prune the subtrees in PRUNED_ELEMENTS and drop comment nodes. The list is deliberate normalisation
 *     policy: some entries (script, style, iframe, object, embed, form, option, svg, math, noscript, xmp,
 *     textarea) are also discarded with their contents by sanitize-html, but title, template, plaintext,
 *     noembed and noframes are removed here by our choice (sanitize-html would keep the text of some of
 *     them). The security property is narrow: after this step no raw-text or escapable-raw-text element and
 *     no comment reaches sanitize-html, so no hidden content can be reinterpreted by the lenient parser, and
 *     every remaining text node is entity-escaped by the serializer.
 *  3. Serialize canonically with parse5 (attribute values quoted and escaped, tag names lowercase), after
 *     unwrapping elements and dropping attributes whose names are not plain identifiers. This does NOT
 *     remove every structural disagreement between the two parsers (for example mis-nested formatting
 *     elements are laid out differently); it removes the hidden-content class.
 *  4. Hand the result to sanitize-html, which still owns the allowlist policy (SANITIZE_OPTIONS, unchanged):
 *     the allowlist governs every element and attribute that survives.
 *
 * Trust boundary: parse5 normalises, it does not decide what is safe; sanitize-html decides.
 *
 * Resource guarantee (deterministic bounded work, NOT "linear in general"): parse5 is quadratic on several
 * shapes (deep nesting, wide adoption-agency moves, foster parenting, many attributes on one tag, per-token
 * stack scans). The work budget is OPS_PER_BYTE (4) units per input character plus OPS_BASE (100,000), shared
 * by the tree adapter and the parser/tokenizer hooks. Charged: element and comment creation (plus the
 * attribute bytes an element copies, which covers formatting reconstruction), inserts and detaches (plus the
 * siblings scanned), each attribute record (in the tokenizer), adoptAttributes (recipient plus incoming
 * attributes), MathML annotation-xml integration checks (encoding length), every tag-name read
 * (ceil(length / 16) units, at least one for a non-empty name), and every start tag and end tag
 * token by 1 + floor((stackTop + 1 + formattingListLength) / 4), covering parse5's per-token stack and list
 * scans (a start tag also pays floor(attributeCount * formattingListLength / 16) for the formatting-entry
 * attribute comparisons), and every character token by the same amount unless reconstruction returns at once
 * (formatting list empty, newest entry a marker, or newest entry's element is the current node) and the parser is
 * not in a table mode (foster parenting scans the stack), in which case it costs 1. Examples of inputs the proxy
 * is deliberately conservative about: 500 nested spans carrying 200,000 repeated "x " tokens under an active
 * formatting element that is not the current node blank, whereas a 20-level nested list holding 250 paragraphs
 * of ordinary prose and a 130,384-byte `<pre><code>` block at that depth render (both are tested). Separate hard limits: MAX_TREE_DEPTH (512) nesting levels, measured through parent and template-content links, and MAX_ATTRS_PER_TAG stored attributes on any
 * one start or end tag, enforced inside the tokenizer. Exceeding any bound fails closed (empty document).
 * The accounting is a deterministic proxy for parse5's internal work, not an exact cost model, and the
 * serialised output is not capped separately (entity escaping is linear in the input).
 * The serializer is recursive, which MAX_TREE_DEPTH also bounds.
 */
const PRUNED_ELEMENTS: ReadonlySet<string> = new Set([
  // Raw text / escapable raw text: the content is text to a browser but markup to a lenient parser.
  'script', 'style', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes', 'plaintext', 'textarea', 'title',
  // Never rendered into docs; pruned here by policy (sanitize-html alone would keep e.g. template text).
  'object', 'embed', 'template', 'option', 'form',
  // Foreign content: CDATA is real CDATA inside these, so the tokenizer rules differ from the HTML ones.
  'svg', 'math',
]);

const PLAIN_NAME = /^[a-z][a-z0-9_.:-]*$/;

type P5Node = DefaultTreeAdapterMap['childNode'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Adapter = typeof defaultTreeAdapter;

/** Browsers cap the parser's element depth at 512; parse5 has no cap. */
const MAX_TREE_DEPTH = 512;
/**
 * Stored (distinct) attributes allowed on one tag token. Duplicates are not stored, but once this many are
 * stored any further attribute name, even a duplicate, fails closed.
 */
const MAX_ATTRS_PER_TAG = 256;
/**
 * Adapter work units allowed per input character, plus a base so tiny inputs always fit. The base also absorbs
 * bounded amplification in small malformed documents (for example a long href in an unclosed anchor
 * reconstructed across a few dozen paragraphs); amplification beyond base + 4 units per input char fails closed.
 */
const OPS_PER_BYTE = 4;
const OPS_BASE = 100_000;
/** A detach or insert scanning N siblings costs 1 + N / 2^SIBLING_SHIFT units. */
const SIBLING_SHIFT = 4;

/** One work budget shared by the tree adapter and the tokenizer hook; `spend` throws once it is exceeded. */
function createBudget(limit: number): { spend: (units: number) => void } {
  let spent = 0;
  return {
    spend(units: number): void {
      spent += units;
      if (spent > limit) throw new RangeError('docs HTML exceeds the parse work budget');
    },
  };
}

/** The default tree adapter, aborting the parse (a throw) when depth or the work budget is exceeded. */
function boundedAdapter(spend: (units: number) => void): P5Adapter {
  const siblings = (parent: P5Parent | null | undefined): number =>
    parent ? parent.childNodes.length >> SIBLING_SHIFT : 0;
  const templateOwner = new Map<object, object>();
  const depthOf = (start: object): number => {
    let d = 0;
    let cur: object | undefined = start;
    while (cur) {
      const up: object | undefined | null = (cur as { parentNode?: object | null }).parentNode ?? templateOwner.get(cur);
      if (!up) break;
      if (++d > MAX_TREE_DEPTH) throw new RangeError('docs HTML nested too deeply');
      cur = up;
    }
    return d;
  };
  // The walk itself is work: charge 1 unit per 16 levels so deep-and-wide inputs stay inside the budget.
  const guardDepth = (parent: P5Parent): void => {
    const d = depthOf(parent) + 1;
    if (d > MAX_TREE_DEPTH) throw new RangeError('docs HTML nested too deeply');
    spend(d >> 4);
  };
  const d = defaultTreeAdapter;
  return {
    ...d,
    // Charge the attribute bytes copied: formatting reconstruction re-creates elements with the same attributes.
    createElement(...args: Parameters<P5Adapter['createElement']>) {
      let bytes = 0;
      for (const a of args[2]) bytes += a.name.length + a.value.length;
      spend(1 + bytes);
      return d.createElement(...args);
    },
    createCommentNode(...args: Parameters<P5Adapter['createCommentNode']>) { spend(1); return d.createCommentNode(...args); },
    appendChild(parent, child) { spend(1); guardDepth(parent); d.appendChild(parent, child); },
    insertBefore(parent, child, ref) { spend(1 + siblings(parent)); guardDepth(parent); d.insertBefore(parent, child, ref); },
    // Tag names are re-read (and lowercased) by parse5 on every unmatched foreign end tag: charge each read, at least one unit.
    getTagName(el) { const name = d.getTagName(el); spend((name.length + 15) >> 4); return name; },
    detachNode(node) { spend(1 + siblings(node.parentNode as P5Parent | null)); d.detachNode(node); },
    // parse5 builds a Set of ALL the recipient's attributes on every call, so charge for both sides.
    adoptAttributes(el, attrs) { spend(1 + el.attrs.length + attrs.length); d.adoptAttributes(el, attrs); },
    insertText(parent, text) { spend(1); d.insertText(parent, text); },
    insertTextBefore(parent, text, ref) { spend(1 + siblings(parent)); d.insertTextBefore(parent, text, ref); },
    setTemplateContent(template, content) {
      templateOwner.set(content, template);
      d.setTemplateContent(template, content);
    },
  };
}

function isElement(node: P5Node): node is DefaultTreeAdapterMap['element'] {
  return 'tagName' in node;
}

/** Normalise `html` to the tree a browser would build, minus the pruned subtrees and comments (a deliberate policy, see PRUNED_ELEMENTS). */
function normaliseWithParse5(html: string): string {
  const budget = createBudget(OPS_PER_BYTE * html.length + OPS_BASE);
  const adapter = boundedAdapter(budget.spend);
  // parseFragment() ends by moving the root's children into a fragment one detach at a time, which is
  // quadratic in the number of top-level nodes (parse5 8.0.1: 125,000 siblings take seconds). Run the same
  // fragment parse (template context, as parseFragment does) and use the parser's root element in place.
  const parser = Parser.getFragmentParser(null, { scriptingEnabled: true, treeAdapter: adapter });
  // Cap attributes where parse5 records them. _leaveAttrName runs once per attribute name on start AND end
  // tags and does a duplicate check over the token's attrs, which is quadratic without a cap. This is a
  // deliberate dependency on a parse5 internal (8.0.1), pinned by tests: if an upgrade renames it we throw,
  // so every document renders empty and the tests go red, rather than silently running unguarded.
  const tokenizer = parser.tokenizer as unknown as { _leaveAttrName?: () => void; currentToken?: { attrs?: unknown[] } | null };
  const leaveAttrName = tokenizer._leaveAttrName;
  if (typeof leaveAttrName !== 'function') throw new Error('parse5 tokenizer internals changed: _leaveAttrName missing');
  tokenizer._leaveAttrName = function (this: typeof tokenizer): void {
    if ((this.currentToken?.attrs?.length ?? 0) >= MAX_ATTRS_PER_TAG) {
      throw new RangeError('docs HTML has a tag with too many attributes');
    }
    budget.spend(1);
    leaveAttrName.call(this);
  };
  // Same pinned-internal pattern: parse5 lowercases the whole `encoding` value of an annotation-xml element
  // on every integration-point check, which is quadratic over many children. Every call site goes through
  // the instance property, so wrapping it is honoured; a rename fails closed.
  const hooked = parser as unknown as {
    _isIntegrationPoint?: (tid: number, element: unknown, foreignNS?: unknown) => boolean;
  };
  const isIntegrationPoint = hooked._isIntegrationPoint;
  if (typeof isIntegrationPoint !== 'function') throw new Error('parse5 parser internals changed: _isIntegrationPoint missing');
  hooked._isIntegrationPoint = function (this: typeof hooked, tid: number, element: unknown, foreignNS?: unknown): boolean {
    const el = element as { tagName?: string; attrs?: { name: string; value: string }[] };
    if (el.tagName === 'annotation-xml') {
      const enc = el.attrs?.find(a => a.name === 'encoding');
      budget.spend(1 + (enc ? enc.value.length : 0));
    }
    return isIntegrationPoint.call(this, tid, element, foreignNS);
  };
  // Per-token scans: for every start/end tag and character token parse5 may walk the open-element stack and
  // the active formatting list (scope checks, reconstruction membership checks, foreign-content ancestor walks)
  // without mutating the tree, so the adapter never sees the work. Charge each token for the size of what it
  // may scan. The tokenizer calls this.handler.onStartTag / onEndTag / onCharacter / onWhitespaceCharacter /
  // onNullCharacter and the handler is the parser (new Tokenizer(options, this)), so instance wrappers are
  // honoured; this relies on parse5 8.0.1 internals, and a mismatch throws (fail closed).
  type Handler = (token: unknown) => void;
  const scanned = parser as unknown as Record<string, Handler | undefined> & {
    openElements?: { stackTop?: number; current?: unknown };
    activeFormattingElements?: { entries?: unknown[] };
  };
  // parse5 8.0.1 InsertionMode values for IN_TABLE, IN_TABLE_TEXT, IN_TABLE_BODY and IN_ROW: characters there
  // are buffered and later fostered, which walks the open-element stack even with no formatting elements.
  const TABLE_MODES: ReadonlySet<number> = new Set([8, 9, 12, 13]);
  const wrapHandler = (name: string, extra: (token: unknown, afeLength: number) => number, character = false): void => {
    const original = scanned[name];
    if (typeof original !== 'function') throw new Error(`parse5 parser internals changed: ${name} missing`);
    scanned[name] = function (this: typeof scanned, token: unknown): void {
      const top = this.openElements?.stackTop;
      const afe = this.activeFormattingElements?.entries;
      if (typeof top !== 'number' || !Array.isArray(afe)) throw new Error('parse5 parser internals changed: scan state missing');
      // A character token only scans the stack for reconstruction or for foster parenting (table modes).
      // Reconstruction returns at once when the formatting list is empty, or its NEWEST entry (entries[0]; the
      // list is unshift-ordered) is a marker (type 0) or an element that is the current node, which the
      // top-down stack search finds immediately.
      let cheap = false;
      if (character) {
        const mode = (this as unknown as { insertionMode?: unknown }).insertionMode;
        const current = this.openElements?.current;
        if (typeof mode !== 'number') throw new Error('parse5 parser internals changed: insertionMode missing');
        const newest = afe.length > 0 ? (afe[0] as { type?: unknown; element?: unknown } | undefined) : undefined;
        if (afe.length > 0 && (typeof newest !== 'object' || newest === null || typeof newest.type !== 'number')) {
          throw new Error('parse5 parser internals changed: formatting entry shape');
        }
        cheap = !TABLE_MODES.has(mode) && (afe.length === 0 || newest?.type === 0 || (current !== undefined && newest?.element === current));
      }
      budget.spend(cheap ? 1 : 1 + ((top + 1 + afe.length) >> 2) + extra(token, afe.length));
      original.call(this, token);
    };
  };
  const noExtra = (): number => 0;
  // A start tag is also compared attribute-by-attribute with the formatting entries (Noah's Ark clause).
  const startTagExtra = (token: unknown, afeLength: number): number => {
    const attrs = (token as { attrs?: unknown }).attrs;
    return Array.isArray(attrs) ? (attrs.length * afeLength) >> 4 : 0;
  };
  wrapHandler('onStartTag', startTagExtra);
  wrapHandler('onEndTag', noExtra);
  for (const name of ['onCharacter', 'onWhitespaceCharacter', 'onNullCharacter']) wrapHandler(name, noExtra, true);
  parser.tokenizer.write(html, true);
  const fragment = adapter.getFirstChild(parser.document) as P5Parent;
  const work: P5Parent[] = [fragment];
  while (work.length > 0) {
    const parent = work.pop() as P5Parent;
    const out: P5Node[] = [];
    const pending: P5Node[] = [...parent.childNodes].reverse();
    while (pending.length > 0) {
      const node = pending.pop() as P5Node;
      if (node.nodeName === '#comment') continue;
      if (isElement(node)) {
        if (PRUNED_ELEMENTS.has(node.tagName)) continue;
        if (!PLAIN_NAME.test(node.tagName)) {
          // Unwrap: keep the (already browser-parsed) children, drop the odd tag itself.
          for (let k = node.childNodes.length - 1; k >= 0; k--) pending.push(node.childNodes[k]);
          continue;
        }
        node.attrs = node.attrs.filter(a => PLAIN_NAME.test(a.name));
        work.push(node);
      }
      node.parentNode = parent;
      out.push(node);
    }
    parent.childNodes = out;
  }
  return serialize(fragment);
}

/** Sanitise HTML produced from docs Markdown (marked or the built-in fallback). */
export function sanitizeDocsHtml(html: string): string {
  let normalised: string;
  try {
    normalised = normaliseWithParse5(html);
  } catch {
    return '';
  }
  return sanitizeHtml(normalised, SANITIZE_OPTIONS);
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
