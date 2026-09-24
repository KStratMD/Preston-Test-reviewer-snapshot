import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DOCS_IMAGE_HOSTS,
  encodePathSegments,
  escapeHtml,
  isInsideRoot,
  isRealPathInsideRoot,
  jsStringLiteral,
  renderDocLinkList,
  sanitizeDocsHtml,
} from '../../../src/utils/safeDocsHtml';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BACKSLASH = String.fromCharCode(92);

function tags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

describe('sanitizeDocsHtml', () => {
  it('drops event-handler attributes and javascript: URLs', () => {
    const out = sanitizeDocsHtml(
      '<p><img src="images/a.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a>' +
      '<a href="JaVaScRiPt:alert(1)">y</a><a href="&#106;avascript:alert(1)">z</a></p>' +
      '<div onmouseover="alert(3)">t</div>',
    );
    for (const t of tags(out)) {
      expect(t).not.toMatch(/\son[a-z]+\s*=/i);
      expect(t).not.toMatch(/javascript:/i);
    }
    expect(out).toContain('<img src="images/a.png" />');
    expect(out).toContain('t');
  });

  it('discards dangerous elements together with their contents, including xmp', () => {
    const out = sanitizeDocsHtml(
      '<iframe src="https://x.test"></iframe><svg><a xlink:href="javascript:alert(1)"><text>s</text></a></svg>' +
      '<math><mi>m</mi></math><style>body{}</style><form><input type=text></form>' +
      '<object data="x"></object><embed src="x"><xmp><img src=x onerror=alert(1)></xmp>' +
      '<noscript><img src=x onerror=alert(1)></noscript><script>alert(1)</script>',
    );
    expect(out).toBe('');
  });

  it('keeps no style attribute but keeps table alignment', () => {
    const out = sanitizeDocsHtml(
      '<table><tr><th align="left" style="color:red">h</th><td align="right" style="background:url(https://x.test/p)">c</td></tr></table>',
    );
    expect(out).not.toMatch(/style=/);
    expect(out).toContain('<th align="left">h</th>');
    expect(out).toContain('<td align="right">c</td>');
  });

  it('limits code classes to language-* and lang-*', () => {
    expect(sanitizeDocsHtml('<code class="language-ts hidden">a</code>')).toBe('<code class="language-ts">a</code>');
    expect(sanitizeDocsHtml('<code class="lang-js">a</code>')).toBe('<code class="lang-js">a</code>');
    expect(sanitizeDocsHtml('<code class="hidden fixed">a</code>')).toBe('<code>a</code>');
    expect(sanitizeDocsHtml('<p class="hidden">a</p>')).toBe('<p>a</p>');
  });

  it('keeps relative images and https images on allowlisted hosts only', () => {
    for (const host of DOCS_IMAGE_HOSTS) {
      expect(sanitizeDocsHtml(`<img src="https://${host}/b.svg">`)).toBe(`<img src="https://${host}/b.svg" />`);
    }
    expect(sanitizeDocsHtml('<img src="images/x.png" alt="a">')).toBe('<img src="images/x.png" alt="a" />');
    expect(sanitizeDocsHtml('<img src="/docs/images/x.png">')).toBe('<img src="/docs/images/x.png" />');
    for (const bad of [
      'https://tracker.example/p.gif',
      'http://img.shields.io/x.svg',
      '//tracker.example/p',
      'data:image/png;base64,AAAA',
      'https://img.shields.io.evil.example/x.svg',
      '',
      // Backslash forms browsers read as protocol-relative (Codex diff review Q2).
      BACKSLASH + BACKSLASH + 'evil.example/p.gif',
      '/' + BACKSLASH + 'evil.example/p.gif',
      BACKSLASH + '/evil.example/p.gif',
      ' //evil.example/p.gif',
    ]) {
      expect(sanitizeDocsHtml(`<p>k<img src="${bad}"></p>`)).toBe('<p>k</p>');
    }
    // Browsers strip leading/trailing space and tab/newline before resolving (Copilot #1343).
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);
    for (const lead of [' ', TAB, LF, '  ' + TAB]) {
      expect(sanitizeDocsHtml(`<p>k<img src="${lead}https://evil.example/p.gif"></p>`)).toBe('<p>k</p>');
      expect(sanitizeDocsHtml(`<p>k<img src="${lead}//evil.example/p.gif"></p>`)).toBe('<p>k</p>');
    }
    expect(sanitizeDocsHtml(`<p>k<img src="ht${TAB}tps://evil.example/p.gif"></p>`)).toBe('<p>k</p>');
    expect(sanitizeDocsHtml('<img src=" https://img.shields.io/x.svg">')).toContain('<img src=');
    expect(sanitizeDocsHtml('<img src="images/y.png" srcset="https://tracker.example/a.png 2x">')).toBe(
      '<img src="images/y.png" />',
    );
  });

  it('keeps only disabled checkboxes among inputs', () => {
    expect(sanitizeDocsHtml('<li><input type="checkbox" checked=""> done</li>')).toBe(
      '<li><input type="checkbox" disabled checked /> done</li>',
    );
    expect(sanitizeDocsHtml('<li><input type="checkbox"> todo</li>')).toBe(
      '<li><input type="checkbox" disabled /> todo</li>',
    );
    expect(sanitizeDocsHtml('<p>a<input type="text" value="x">b</p>')).toBe('<p>ab</p>');
    expect(sanitizeDocsHtml('<p>a<input type="image" src="https://tracker.example/p">b</p>')).toBe('<p>ab</p>');
    expect(sanitizeDocsHtml('<p>a<input>b</p>')).toBe('<p>ab</p>');
  });

  it('adds no attributes to headings (addHeadingIds matches bare <hN>)', () => {
    expect(sanitizeDocsHtml('<h2 id="x" class="y">T</h2>')).toBe('<h2>T</h2>');
  });

  it('keeps details/summary, safe links and mailto', () => {
    const out = sanitizeDocsHtml(
      '<details><summary>S</summary>b</details><a href="https://x.test">a</a><a href="#s">b</a><a href="o.md">c</a><a href="mailto:a@x.test">d</a>',
    );
    expect(out).toBe(
      '<details><summary>S</summary>b</details><a href="https://x.test">a</a><a href="#s">b</a><a href="o.md">c</a><a href="mailto:a@x.test">d</a>',
    );
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('jsStringLiteral', () => {
  it('returns a JSON literal free of <, >, &, U+2028 and U+2029 that round-trips', () => {
    const input = '</script><x>&' + LS + PS + `'"`;
    const out = jsStringLiteral(input);
    expect(out).not.toMatch(/[<>&]/);
    expect(out.includes(LS)).toBe(false);
    expect(out.includes(PS)).toBe(false);
    expect(out).toContain(BACKSLASH + 'u003C');
    expect(out).not.toContain('&lt;');
    expect(out.startsWith('"')).toBe(true);
    expect(JSON.parse(out)).toBe(input);
  });
});

describe('encodePathSegments', () => {
  it('encodes each segment and keeps separators', () => {
    expect(encodePathSegments('/docs/a b/c&d #1.md')).toBe('/docs/a%20b/c%26d%20%231.md');
  });
});

describe('isInsideRoot', () => {
  const root = path.resolve('/r/docs');
  it.each([
    [path.join(root, 'a', 'b.md'), true],
    [root, true],
    [path.join(root, '..draft.md'), true],
    [path.resolve('/r/docs-evil/x.md'), false],
    [path.join(root, '..', 'x.md'), false],
    [path.resolve('/r'), false],
  ])('%s -> %s', (candidate, expected) => {
    expect(isInsideRoot(root, candidate)).toBe(expected);
  });

  it('treats another drive as outside on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(isInsideRoot('C:\\r\\docs', 'D:\\r\\docs\\a.md')).toBe(false);
  });
});

describe('isRealPathInsideRoot', () => {
  it('follows links: a linked directory pointing outside the root is outside', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realpath-'));
    try {
      fs.mkdirSync(path.join(tmp, 'root', 'inner'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'outside'));
      fs.writeFileSync(path.join(tmp, 'outside', 'x.md'), 'x');
      fs.writeFileSync(path.join(tmp, 'root', 'inner', 'y.md'), 'y');
      fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'root', 'out'), 'junction');
      fs.symlinkSync(path.join(tmp, 'root', 'inner'), path.join(tmp, 'root', 'in'), 'junction');
      const root = path.join(tmp, 'root');
      expect(isInsideRoot(root, path.join(root, 'out', 'x.md'))).toBe(true); // lexical check is fooled
      expect(isRealPathInsideRoot(root, path.join(root, 'out', 'x.md'))).toBe(false);
      expect(isRealPathInsideRoot(root, path.join(root, 'out'))).toBe(false);
      expect(isRealPathInsideRoot(root, path.join(root, 'in', 'y.md'))).toBe(true);
      expect(isRealPathInsideRoot(root, path.join(root, 'inner', 'y.md'))).toBe(true);
      expect(isRealPathInsideRoot(root, path.join(root, 'missing.md'))).toBe(true); // nothing to follow
      fs.symlinkSync(path.join(root, 'selfloop'), path.join(root, 'selfloop'), 'junction');
      expect(isRealPathInsideRoot(root, path.join(root, 'selfloop'))).toBe(false); // ELOOP refuses
      fs.symlinkSync(path.join(tmp, 'gone'), path.join(root, 'dangling'), 'junction');
      expect(isRealPathInsideRoot(root, path.join(root, 'dangling'))).toBe(false); // dangling refuses
      expect(isRealPathInsideRoot(root, path.join(root, '..', 'outside', 'x.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('renderDocLinkList', () => {
  it('escapes labels and encodes hrefs for hostile names', () => {
    const html = renderDocLinkList([{ path: '/docs/a"><img src=x onerror=alert(1)>.md', label: 'a"><img src=x onerror=alert(1)>.md' }]);
    expect(html).not.toContain('<img');
    for (const href of html.match(/href="[^"]*"/g) ?? []) {
      expect(href.slice(6, -1)).not.toContain('"');
    }
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.md</a>');
  });
});
