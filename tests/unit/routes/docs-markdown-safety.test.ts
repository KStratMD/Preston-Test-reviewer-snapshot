/**
 * Docs route rendering safety (plan: docs/superpowers/plans/2026-09-22-docs-markdown-sanitisation.md).
 *
 * marked 18 is ESM-only; under Jest `import('marked')` throws and docs.ts silently falls back to
 * its built-in renderer, which escapes `<` and would make every hostile-input assertion pass
 * vacuously. Map `marked` to its UMD build so these tests exercise the real renderer, and keep G1
 * as the positive control that fails if the fallback is ever in use.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

// Resolved through the package (not a node_modules literal) so it works wherever marked is installed.
jest.mock('marked', () => {
  const p = require('path');
  return jest.requireActual(p.join(p.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js'));
});

import { createDocsRouter } from '../../../src/routes/docs';

const FILES: Record<string, string> = {
  'docs/basic.md': [
    '# T',
    '',
    '**b**',
    '',
    '```',
    '<img src=x onerror=alert(1)>',
    '```',
    '',
    '<details><summary>S</summary>body</details>',
    '',
    '| a | b |',
    '|:-|-:|',
    '| 1 | 2 |',
    '',
    '[a](https://x.test) [b](#anchor) [c](other.md)',
    '',
    '- [ ] task',
    '- [x] done',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '![badge](https://img.shields.io/x.svg)',
    '',
    '## Second',
    '',
  ].join('\n'),
  'docs/r1.md': 'raw img: <img src=x onerror="alert(1)">\n',
  'docs/r2.md': '[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) <a href="&#106;avascript:alert(1)">z</a>\n',
  'docs/r3.md': '<div onmouseover="alert(3)">html block text</div>\n',
  'docs/r4.md': [
    '<iframe src="javascript:alert(5)"></iframe>',
    '',
    '<svg><animate onbegin=alert(4) attributeName=x dur=1s></svg>',
    '',
    '<math><mi>x</mi></math>',
    '',
    '<style>body{display:none}</style>',
    '',
    '<form action="https://x.test"><input type=text name=q></form>',
    '',
    '<object data="https://x.test/a.swf"></object>',
    '',
  ].join('\n'),
  'docs/dirhostile/README.md': 'preface <img src=x onerror="alert(1)">\n',
  'docs/r9.md': [
    '<table><tr><td style="background:url(https://x.test/p)">c</td></tr></table>',
    '',
    '<span style="position:fixed">s</span>',
    '',
  ].join('\n'),
  'docs/r10.md': '<code class="hidden fixed inset-0">h</code> <code class="language-ts hidden">k</code>\n',
  'docs/r11.md': [
    '![t](https://tracker.example/p.gif)',
    '',
    '<img src="//tracker.example/p">',
    '',
    '![r](images/x.png)',
    '',
    '<img src="data:image/png;base64,AAAA">',
    '',
    '<img src="images/y.png" srcset="https://tracker.example/a.png 2x">',
    '',
  ].join('\n'),
  'docs/r12.md': [
    '# a <img src=x onerror=alert(1)>',
    '',
    '# &lt;img src=x onerror=alert(1)&gt;',
    '',
    '# x</a><img src=x onerror=alert(1)>',
    '',
  ].join('\n'),
  "docs/x'-alert(1)-'/README.md": 'plain\n',
  'docs/a&b #1.md': '# amp\n\nroundtriproot\n',
  'docs/listing/a&b #1.md': '# amp\n\nroundtriplisting\n',
  'docs/listing/sub dir&x #2/inner.md': '# inner\n\nroundtripinner\n',
  'docs/100% done.md': '# pct\n\nroundtrippercent\n',
  // Its encoded link is `%2541.md`; decoding twice would ask for `A.md`.
  'docs/%41.md': '# once\n\nroundtripsingledecode\n',
  'repo/root a&b.md': '# rootamp\n\nroundtriprepo\n',
  'postman/my coll&x #3.postman_collection.json': JSON.stringify({
    info: { name: 'roundtrip collection' },
    item: [{ name: 'Fold er', item: [{ name: 'Get thing', request: { method: 'GET', url: 'https://x.test/roundtrippostman' } }] }],
  }),
  'postman/dir.postman_collection.json/inner.txt': 'not a collection',
  'postman/env x&.postman_environment.json': JSON.stringify({ values: [{ key: 'token', value: 'ENVSECRETVALUE' }] }),
  'repo/root-hostile.md': 'root <img src=x onerror="alert(1)"> [j](javascript:alert(1))\n',
  'postman/bad.postman_collection.json': '<img src=x onerror=alert(1)> not json',
  'postman/named.postman_collection.json': JSON.stringify({
    info: { name: 'n\'"</h1><img src=x onerror=alert(1)>' },
    item: [],
  }),
};

let tmp: string;
let app: express.Express;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-safety-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  // A directory outside every configured root, reachable only through a link inside docs/.
  // 'junction' needs no privilege on Windows and is an ordinary directory symlink elsewhere.
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside', 'secret.md'), '# TOPSECRETTITLE\n\nTOPSECRETBODY\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'outside', 'README.md'), 'TOPSECRETREADME\n', 'utf8');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'docs', 'linked'), 'junction');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'docs', 'listing', 'outlink'), 'junction');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'postman', 'leak.postman_environment.json'), 'junction');
  app = express();
  app.use(
    '/docs',
    createDocsRouter({
      docsRoot: path.join(tmp, 'docs'),
      repoRoot: path.join(tmp, 'repo'),
      postmanRoot: path.join(tmp, 'postman'),
    }),
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function get(p: string): Promise<string> {
  const res = await request(app).get(p);
  return res.text;
}

/** The rendered document body (marked output plus the trusted copy-button script). */
function article(html: string): string {
  const m = html.match(/<article[^>]*>([\s\S]*)<\/article>/);
  if (!m) throw new Error('no <article> in response');
  return m[1];
}

function toc(html: string): string {
  return html.match(/<nav[^>]*aria-label="Table of contents"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
}

/** Every start tag in a fragment. Escaped text (`&lt;img`) never matches, so this sees only live markup. */
function tags(fragment: string): string[] {
  return fragment.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

function expectNoActiveMarkup(fragment: string): void {
  for (const t of tags(fragment)) {
    expect(t).not.toMatch(/\son[a-z]+\s*=/i);
    expect(t).not.toMatch(/javascript:/i);
    expect(t).not.toMatch(/^<(iframe|svg|math|style|form|object|embed|xmp|animate)\b/i);
  }
}

/** Raw HTTP/1.1 request so the path reaches Express byte-for-byte (supertest may encode it). */
function rawGet(port: number, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let d = '';
    s.on('data', c => { d += c; });
    s.on('end', () => resolve(d));
    s.on('error', reject);
  });
}

describe('guards (real marked, content preserved)', () => {
  it('G1: real marked rendered the document (positive control against the Jest fallback)', async () => {
    const body = article(await get('/docs/basic.md'));
    expect(body).toContain('<strong>b</strong>');
    expect(body).toContain('<h1 id="t">');
  });

  it('G2: markup inside a fenced block stays escaped text', async () => {
    const body = article(await get('/docs/basic.md'));
    expect(body).toMatch(/<pre><code>&lt;img src=x onerror=alert\(1\)&gt;/);
    expect(body).not.toContain('<img src=x');
  });

  it('G3: details/summary survive', async () => {
    const body = article(await get('/docs/basic.md'));
    expect(body).toContain('<details><summary>S</summary>');
  });

  it('G4: tables, alignment, safe links, task lists and language classes survive', async () => {
    const body = article(await get('/docs/basic.md'));
    expect(body).toContain('<table>');
    expect(body).toContain('<th align="left">');
    expect(body).toContain('href="https://x.test"');
    expect(body).toContain('href="#anchor"');
    expect(body).toContain('href="other.md"');
    const boxes = tags(body).filter(t => t.startsWith('<input'));
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b).toContain('type="checkbox"');
      expect(b).toContain('disabled');
    }
    expect(body).toContain('<code class="language-ts">');
  });

  it('G5: TOC links to generated heading ids', async () => {
    const nav = toc(await get('/docs/basic.md'));
    expect(nav).toContain('href="#second"');
  });

  it('G6: allowlisted remote badge image survives', async () => {
    const body = article(await get('/docs/basic.md'));
    expect(body).toContain('<img src="https://img.shields.io/x.svg"');
  });
});

describe('rendered Markdown is sanitised', () => {
  it('R1: event-handler attributes on raw <img> are removed', async () => {
    expectNoActiveMarkup(article(await get('/docs/r1.md')));
  });

  it('R2: javascript: links (plain, mixed case, entity-encoded) are removed', async () => {
    const body = article(await get('/docs/r2.md'));
    expectNoActiveMarkup(body);
    expect(body).toContain('x');
  });

  it('R3: handler on an HTML block is removed, its text kept', async () => {
    const body = article(await get('/docs/r3.md'));
    expectNoActiveMarkup(body);
    expect(body).toContain('html block text');
  });

  it('R4: iframe, svg, math, style, form/input[text] and object are removed', async () => {
    const body = article(await get('/docs/r4.md'));
    expectNoActiveMarkup(body);
    expect(tags(body).some(t => /^<input/i.test(t))).toBe(false);
    expect(body).not.toContain('display:none');
  });

  it('R5: a directory README preface is sanitised', async () => {
    const html = await get('/docs/dirhostile');
    expectNoActiveMarkup(article(html));
    expect(article(html)).toContain('preface');
  });

  it('R9: no style attribute survives anywhere in the rendered body', async () => {
    const body = article(await get('/docs/r9.md'));
    for (const t of tags(body)) expect(t).not.toMatch(/\sstyle\s*=/i);
    expect(body).toContain('<td>c</td>');
  });

  it('R10: code classes are limited to language-*/lang-*', async () => {
    const codes = tags(article(await get('/docs/r10.md'))).filter(t => t.startsWith('<code'));
    expect(codes).toEqual(['<code>', '<code class="language-ts">']);
  });

  it('R11: only relative and allowlisted-host https images survive; no data: or srcset', async () => {
    const imgs = tags(article(await get('/docs/r11.md'))).filter(t => t.startsWith('<img'));
    expect(imgs.map(t => t.match(/src="([^"]*)"/)?.[1])).toEqual(['images/x.png', 'images/y.png']);
    for (const t of imgs) expect(t).not.toMatch(/srcset/i);
  });

  it('R12: hostile headings produce no active markup in the body or the TOC', async () => {
    const html = await get('/docs/r12.md');
    expectNoActiveMarkup(article(html));
    const nav = toc(html);
    expectNoActiveMarkup(nav);
    for (const t of tags(nav).filter(x => x.startsWith('<a'))) {
      expect(t).toMatch(/href="#[a-z0-9-]+"/);
    }
  });

  it('R13: repo-root fallback Markdown is sanitised', async () => {
    const body = article(await get('/docs/root-hostile.md'));
    expect(body).toContain('root');
    expectNoActiveMarkup(body);
  });
});

describe('containment follows symlinks (Copilot #1343)', () => {
  it('R19: a link inside docs/ to an outside directory serves, lists and indexes nothing from it', async () => {
    const page = await request(app).get('/docs/linked/secret.md');
    expect(page.status).not.toBe(200);
    expect(page.text).not.toContain('TOPSECRETBODY');
    const dir = await request(app).get('/docs/linked');
    expect(dir.status).not.toBe(200);
    expect(dir.text).not.toContain('TOPSECRETREADME');
    const search = await request(app).get('/docs/search?q=topsecretbody');
    expect(search.body.results).toEqual([]);
    const highlight = await request(app).get('/docs/highlight?q=topsecretbody');
    expect(highlight.body.results).toEqual([]);
  });

  it('R20: a directory listing omits an entry that links outside the root', async () => {
    const html = await get('/docs/listing');
    expect(html).toContain('a&amp;b #1.md');
    expect(html).not.toContain('outlink');
  });

  it('R21: a directory link back to an ancestor does not loop the search indexer', async () => {
    const loopTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-loop-'));
    try {
      fs.mkdirSync(path.join(loopTmp, 'docs', 'a'), { recursive: true });
      fs.writeFileSync(path.join(loopTmp, 'docs', 'a', 'page.md'), '# Loopcheck\n\nloopcheckbody\n', 'utf8');
      fs.symlinkSync(path.join(loopTmp, 'docs'), path.join(loopTmp, 'docs', 'a', 'up'), 'junction');
      fs.symlinkSync(path.join(loopTmp, 'docs', 'a'), path.join(loopTmp, 'docs', 'self'), 'junction');
      const loopApp = express();
      loopApp.use('/docs', createDocsRouter({ docsRoot: path.join(loopTmp, 'docs'), repoRoot: path.join(loopTmp, 'repo') }));
      const res = await request(loopApp).get('/docs/search?q=loopcheckbody');
      // Indexed once, not once per path through the loop.
      expect(res.body.results).toHaveLength(1);
    } finally {
      fs.rmSync(loopTmp, { recursive: true, force: true });
    }
  });

  it('R22: self-referencing and mutually recursive links do not crash the router or leak (Copilot #1343)', async () => {
    const loopTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-eloop-'));
    try {
      const docs = path.join(loopTmp, 'docs');
      fs.mkdirSync(docs);
      fs.writeFileSync(path.join(docs, 'ok.md'), '# Fine\n\neloopcheckbody\n', 'utf8');
      // realpath() of each of these throws ELOOP rather than ENOENT.
      fs.symlinkSync(path.join(docs, 'self'), path.join(docs, 'self'), 'junction');
      fs.symlinkSync(path.join(docs, 'pong'), path.join(docs, 'ping'), 'junction');
      fs.symlinkSync(path.join(docs, 'ping'), path.join(docs, 'pong'), 'junction');
      const loopApp = express();
      loopApp.use('/docs', createDocsRouter({ docsRoot: docs, repoRoot: path.join(loopTmp, 'repo') }));
      expect((await request(loopApp).get('/docs/search?q=eloopcheckbody')).body.results).toHaveLength(1);
      for (const p of ['/docs/self', '/docs/ping', '/docs/self/x.md']) {
        const r = await request(loopApp).get(p);
        expect(r.status).not.toBe(200);
        expect(r.status).not.toBe(500);
      }
    } finally {
      fs.rmSync(loopTmp, { recursive: true, force: true });
    }
  });
});

describe('page chrome is escaped', () => {
  it('R7: the 404 page escapes a raw request path', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as net.AddressInfo).port;
      const raw = await rawGet(port, '/docs/<img/src=x/onerror=alert(1)>');
      expect(raw).toMatch(/^HTTP\/1\.1 404/);
      expect(raw).toContain('&lt;img/src=x/onerror=alert(1)&gt;');
      expect(raw).not.toContain('<img/src=x');
    } finally {
      server.close();
    }
  });

  it('R8: a hostile directory name is escaped in <title>/header and JSON-encoded in the script sink', async () => {
    const html = await get("/docs/x'-alert(1)-'");
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    expect(title).toContain('Dir x&#39;-alert(1)-&#39;');
    expect(html).toContain('<h1>Directory: /x&#39;-alert(1)-&#39;</h1>');
    const stmt = html.match(/document\.title = (.*)\.replace\(/)?.[1] ?? '';
    expect(stmt).toMatch(/^"(?:[^"\\<>&]|\\.)*"$/);
    expect(JSON.parse(stmt)).toBe("Dir x'-alert(1)-'");
  });

  it('R14: the index escapes file names and URL-encodes their links; no inline debug search', async () => {
    const html = await get('/docs/');
    expect(html).toContain('>a&amp;b #1.md</a>');
    expect(html).toContain('href="/docs/a%26b%20%231.md"');
    expect(html).not.toContain('Testing search for:');
  });

  it('R15: directory listings escape labels and encode hrefs', async () => {
    const html = await get('/docs/listing');
    expect(html).toContain('>a&amp;b #1.md</a>');
    expect(html).toContain('href="/docs/listing/a%26b%20%231.md"');
  });

  it('R16: a Postman parse error message is escaped', async () => {
    const html = await get('/docs/postman/bad.postman_collection.json');
    expect(html).toContain('Failed to render collection');
    expect(html).not.toContain('<img src=x');
  });

  it('R17: a hostile Postman collection name is escaped in every context', async () => {
    const html = await get('/docs/postman/named.postman_collection.json');
    expect(html).not.toContain('<img src=x');
    expect(html).toMatch(/<h1>n&#39;&quot;&lt;\/h1&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    expect(title).not.toMatch(/['"<>]/);
    const stmt = html.match(/document\.title = (.*)\.replace\(/)?.[1] ?? '';
    expect(stmt).toMatch(/^"(?:[^"\\<>&]|\\.)*"$/);
    expect(JSON.parse(stmt)).toBe('Postman n\'"</h1><img src=x onerror=alert(1)>');
  });
});

describe('encoded links round-trip (Copilot #1343: req.path is not decoded)', () => {
  const { renderResultsHtml } = require('../../../public/docs-search.js') as {
    renderResultsHtml: (list: Record<string, unknown>[], q: string) => string;
  };

  /** The value a browser requests for an escaped href attribute. */
  function unescapeAttr(v: string): string {
    return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /** The href of the link whose (escaped) label is exactly `labelHtml`. */
  function hrefFor(html: string, labelHtml: string): string {
    const m = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].find(x => x[2] === labelHtml);
    if (!m) throw new Error(`no link labelled ${labelHtml}`);
    return unescapeAttr(m[1]);
  }

  /** Follow an href the way a browser does: the fragment is never sent. */
  async function follow(href: string): Promise<request.Response> {
    return request(app).get(href.split('#')[0]);
  }

  it('P1: every index link serves its own document', async () => {
    const index = await get('/docs/');
    const cases: [string, string][] = [
      ['a&amp;b #1.md', 'roundtriproot'],
      ['100% done.md', 'roundtrippercent'],
      ['%41.md', 'roundtripsingledecode'],
      ['root a&amp;b.md', 'roundtriprepo'],
      ['my coll&amp;x #3.postman_collection.json', 'roundtrip collection'],
    ];
    for (const [label, token] of cases) {
      const res = await follow(hrefFor(index, label));
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      expect(res.text).toContain(token);
    }
  });

  it('P2: directory listing links, nested listings and the Up link all resolve', async () => {
    const listing = await get('/docs/listing');
    const doc = await follow(hrefFor(listing, 'a&amp;b #1.md'));
    expect(doc.status).toBe(200);
    expect(doc.text).toContain('roundtriplisting');

    const sub = await follow(hrefFor(listing, 'sub dir&amp;x #2/'));
    expect(sub.status).toBe(200);
    expect(sub.text).toContain('<h1>Directory: /listing/sub dir&amp;x #2</h1>');

    const inner = await follow(hrefFor(sub.text, 'inner.md'));
    expect(inner.status).toBe(200);
    expect(inner.text).toContain('roundtripinner');

    const up = await follow(unescapeAttr(sub.text.match(/href="([^"]*)">⬅ Up<\/a>/)?.[1] ?? ''));
    expect(up.status).toBe(200);
    expect(up.text).toContain('<h1>Directory: /listing</h1>');
  });

  it('P3: every search-client result link serves the document it names', async () => {
    const cases: [string, string][] = [
      ['roundtriproot', 'roundtriproot'],
      ['roundtriplisting', 'roundtriplisting'],
      ['roundtripinner', 'roundtripinner'],
      ['roundtrippercent', 'roundtrippercent'],
      ['roundtripsingledecode', 'roundtripsingledecode'],
      ['roundtriprepo', 'roundtriprepo'],
      ['roundtrippostman', 'roundtrip collection'],
    ];
    for (const [q, token] of cases) {
      const { results } = (await request(app).get(`/docs/search?q=${q}`)).body as { results: Record<string, unknown>[] };
      expect({ q, n: results.length }).toEqual({ q, n: 1 });
      const hrefs = [...renderResultsHtml(results, q).matchAll(/href="([^"]*)"/g)].map(m => unescapeAttr(m[1]));
      expect(hrefs).toHaveLength(1);
      const res = await follow(hrefs[0]);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
      expect(res.text).toContain(token);
    }
  });

  it('P4: a non-collection Postman file is neither served nor confirmed (Copilot #1350: the old redirect target was never mounted)', async () => {
    const present = await request(app).get('/docs/postman/env%20x%26.postman_environment.json');
    expect(present.status).toBe(404);
    expect(present.headers.location).toBeUndefined();
    expect(present.text).not.toContain('ENVSECRETVALUE');
    const absent = await request(app).get('/docs/postman/nope%20x%26.postman_environment.json');
    expect(absent.status).toBe(404);
    // Same page apart from the echoed path and the per-request script cache-buster, so the response
    // does not reveal that the file exists.
    const norm = (t: string, name: string) => t.split(name).join('X').replace(/docs-search\.js\?v=\d+/g, 'docs-search.js');
    expect(norm(present.text, 'env x&amp;')).toBe(norm(absent.text, 'nope x&amp;'));
    // Codex #1350 round 2: a non-collection link that escapes the root, and a directory carrying the
    // collection suffix, answer 404 like a missing file rather than 400 or 500.
    expect((await request(app).get('/docs/postman/leak.postman_environment.json')).status).toBe(404);
    expect((await request(app).get('/docs/postman/dir.postman_collection.json')).status).toBe(404);
    // The collection page no longer links to the unmounted /postman/<file> path.
    expect(await get('/docs/postman/my%20coll%26x%20%233.postman_collection.json')).not.toContain('Download JSON');
  });

  it('P5: encoded traversal is rejected after decoding, in both branches', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as net.AddressInfo).port;
      for (const p of [
        '/docs/%2e%2e/x.md',
        '/docs/%2E%2E/outside/secret.md',
        '/docs/%2e%2e%2foutside%2fsecret.md',
        '/docs/%2e%2e%5coutside%5csecret.md',
        '/docs/postman/%2e%2e%2fx',
        '/docs/postman/%2e%2e%2fdocs%2fbasic.md',
      ]) {
        const raw = await rawGet(port, p);
        expect({ p, status: raw.slice(0, 12) }).toEqual({ p, status: 'HTTP/1.1 400' });
        expect(raw).not.toContain('TOPSECRET');
      }
    } finally {
      server.close();
    }
  });

  it('P6: malformed escapes and encoded NUL are rejected with 400', async () => {
    for (const p of ['/docs/%E0%A4%A.md', '/docs/%zz.md', '/docs/postman/%zz', '/docs/a%00.md', '/docs/postman/a%00.json']) {
      const res = await request(app).get(p);
      expect({ p, status: res.status }).toEqual({ p, status: 400 });
    }
  });
});
