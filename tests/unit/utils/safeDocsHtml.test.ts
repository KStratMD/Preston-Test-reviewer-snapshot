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

  // GHSA-x3q4-9hxx-gx8m (fixed in sanitize-html 2.18.0): the parser closes <noscript> implicitly on an
  // ancestor's end tag, but a browser keeps treating everything up to </noscript as raw text.
  it('keeps discarding noscript content after an implied close', () => {
    const out = sanitizeDocsHtml(
      '<p><noscript></p><img src="https://img.shields.io/x.svg" alt="LEAK" onerror="alert(1)">SECRET<script>alert(1)</script></noscript>after',
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('LEAK');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('onerror');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('after');
  });

  // Variant of the same advisory that sanitize-html 2.18.x does NOT fix: htmlparser2 reads `<![CDATA[`..`]]>`
  // as one opaque section, but a browser reads `<![CDATA[` outside foreign content as a bogus comment that
  // ends at the FIRST `>`, so the `<noscript>` inside it is a real (hidden-content) element to the browser.
  describe('parser-disagreement constructs (CDATA, bogus comments, processing instructions)', () => {
    const IMG = '<img src="https://img.shields.io/x.svg" alt="LEAK" onerror="alert(1)">';
    const LINK = '<a href="https://example.test">LEAK</a>';

    function expectNoLeak(out: string): void {
      expect(out).not.toMatch(/<a[\s>]/i);
      expect(out).not.toMatch(/<img/i);
      expect(out).not.toContain('LEAK');
      expect(out).not.toContain('onerror');
      expect(out).not.toMatch(/<noscript|<script/i);
      expect(out).toContain('<p>Hi</p>');
      expect(out).toContain('after');
    }

    it('does not leak content hidden behind a CDATA-opened noscript', () => {
      const out = sanitizeDocsHtml(`<p>Hi</p><![CDATA[ x > <noscript>]]>${LINK}${IMG}</noscript>after`);
      expectNoLeak(out);
      expect(sanitizeDocsHtml(out)).toBe(out);
    });

    it('removes the markup swallowed by a bare CDATA bogus comment', () => {
      const out = sanitizeDocsHtml(`<p>Hi</p><![CDATA[${IMG}]]>after`);
      expectNoLeak(out);
    });

    it('does not leak when the CDATA variant sits inside other discard tags', () => {
      for (const tag of ['iframe', 'style', 'textarea', 'xmp', 'object']) {
        const out = sanitizeDocsHtml(`<p>Hi</p><${tag}><![CDATA[ x > <noscript>]]>${LINK}${IMG}</noscript></${tag}>after`);
        expectNoLeak(out);
      }
      // svg is foreign content: CDATA there is real CDATA, and an <img> start tag BREAKS OUT of svg (HTML spec),
      // so a browser really renders this image outside the svg. The faithful reading survives the allowlist:
      // allowlisted https host, event handler gone, svg and its anchor gone.
      const svg = sanitizeDocsHtml(`<p>Hi</p><svg><![CDATA[ x > <noscript>]]>${LINK}${IMG}</noscript></svg>after`);
      expect(svg).toBe('<p>Hi</p><img src="https://img.shields.io/x.svg" alt="LEAK" />after');
    });

    it('does not leak through bogus-comment tricks', () => {
      const cases = [
        `<!--> <noscript> -->${LINK}${IMG}</noscript>`,
        `<!---> <noscript> -->${LINK}${IMG}</noscript>`,
        `<!-- x --!> <noscript> -->${LINK}${IMG}</noscript>`,
        `<!DOCTYPE x > <noscript>]]>${LINK}${IMG}</noscript>`,
        `<!x > <noscript>>${LINK}${IMG}</noscript>`,
        `<<!-- y -->![CDATA[ x > <noscript>]]>${LINK}${IMG}</noscript>`,
      ];
      for (const c of cases) expectNoLeak(sanitizeDocsHtml(`<p>Hi</p>${c}after`));
    });

    it('does not leak through processing instructions', () => {
      const out = sanitizeDocsHtml(`<p>Hi</p><? x > <noscript>?>${LINK}${IMG}</noscript>after`);
      expectNoLeak(out);
    });

    const loadMarked = (): { parse(s: string): string } =>
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js')).marked;

    describe.each(['<!--x-->', '<!x>', '<?x>', '<![CDATA[x>'])('splice %s', (splice) => {
      it('does not synthesize a noscript end tag', () => {
        const marked = loadMarked();
        const raw = `<div>\n<noscript></no${splice}script>${LINK}${IMG}</noscript>after\n</div>`;
        expect(marked.parse(raw)).toBe(raw); // marked passes the HTML block through verbatim
        const out = sanitizeDocsHtml(marked.parse(raw));
        expect(out).toBe('<div>\nafter\n</div>');
      });

      it.each(['script', 'textarea'])('does not synthesize a %s end tag', (tag) => {
        const half = Math.floor(tag.length / 2);
        const raw = `<p>Hi</p><${tag}></${tag.slice(0, half)}${splice}${tag.slice(half)}>${LINK}${IMG}</${tag}>after`;
        expectNoLeak(sanitizeDocsHtml(raw));
      });
    });

    it('does not turn text separated by a comment into an anchor', () => {
      const out = sanitizeDocsHtml('<p>Hi</p><<!--x-->a href="https://example.test">LEAK</a>after');
      expect(out).not.toMatch(/<a[\s>]/i);
      expect(out).toContain('<p>Hi</p>');
      expect(out).toContain('after');
    });

    it('preserves construct-like text inside quoted attributes', () => {
      expect(sanitizeDocsHtml('<a title="keep <!x> here" href="/x">label</a>'))
        .toBe('<a title="keep &lt;!x&gt; here" href="/x">label</a>');
      expect(sanitizeDocsHtml('<img src="/x" alt="keep <!unfinished">'))
        .toBe('<img src="/x" alt="keep &lt;!unfinished" />');
    });

    it('keeps browser-visible text after a bare CDATA bogus comment', () => {
      // A browser ends the bogus comment at the first ">", so the text after it is real text.
      expect(sanitizeDocsHtml('<p>Hi</p><![CDATA[<a href=x>LEAK</a>]]>after')).toBe('<p>Hi</p>LEAK]]&gt;after');
    });

    // The P1 families the reviewer found against the hand-rolled scanner, plus the rest of the same class:
    // every input here makes htmlparser2 and a browser disagree about where markup begins.
    const R = LINK + IMG;
    const C = `<![CDATA[ x > <noscript>]]>${R}</noscript>after`;
    const DOTTED_I = String.fromCharCode(0x130); // U+0130: its lowercase form changes the string length

    it.each([
      ['quote inside an unquoted attribute value', `<div x=a">${C}`],
      ['U+0130 before a raw-text tag (lowercasing shifts offsets)', `${DOTTED_I}<script></script>${C}`],
      ['invalid end-tag opener </1', `</1${C}`],
      ['invalid end-tag opener </!', `</!${C}`],
      ['invalid end-tag opener </?', `</?${C}`],
      ['invalid end-tag opener "</ "', `</ ${C}`],
      ['empty end tag </>', `</>${C}`],
      ['unterminated start tag', `<p>Hi</p><div ${C}`],
      ['script double-escape', `<script><!--<script></script><![CDATA[ x > ${R}]]></script>after`],
    ])('does not leak: %s', (_name, input) => {
      const out = sanitizeDocsHtml(input);
      expect(out).not.toMatch(/<a[\s>]/i);
      expect(out).not.toMatch(/<img/i);
      expect(out).not.toContain('LEAK');
      expect(out).not.toContain('onerror');
      expect(out).not.toMatch(/<noscript|<script/i);
      expect(out).toContain('after');
    });

    it('treats </noscript with trailing space or slash as a real end tag, exactly as a browser does', () => {
      // In RAWTEXT, "</noscript" followed by whitespace or "/" closes the element, so what follows is live
      // browser content. It passes the allowlist (no handler, no anchor), it is not hidden content.
      // Asserting the reading, not just the absence of danger.
      for (const closer of ['</noscript ', '</noscript/']) {
        const out = sanitizeDocsHtml(`<noscript>${closer}${R}</noscript>after`);
        expect(out).not.toContain('onerror');
        expect(out).not.toMatch(/<noscript|<script/i);
        expect(out).toContain('<img src="https://img.shields.io/x.svg" alt="LEAK" />');
        expect(out).toContain('after');
      }
    });

    it('drops <plaintext> and everything after it', () => {
      expect(sanitizeDocsHtml(`<p>Hi</p><plaintext>${R}`)).toBe('<p>Hi</p>');
    });

    it('does not leak CDATA inside nested svg and math foreign content', () => {
      const out = sanitizeDocsHtml(
        `<p>Hi</p><math><mrow><svg><![CDATA[ x > <noscript>]]><title>${LINK}</title></noscript></svg></mrow></math>after`,
      );
      expect(out).toBe('<p>Hi</p>after');
      expect(sanitizeDocsHtml('<svg><g><![CDATA[ <script>alert(1)</script> ]]></g></svg><p>ok</p>')).toBe('<p>ok</p>');
    });

    it('keeps > inside quoted attribute values', () => {
      expect(sanitizeDocsHtml('<a title="x > y" href="/x">l</a>')).toBe('<a title="x &gt; y" href="/x">l</a>');
      expect(sanitizeDocsHtml('<a title=\'<noscript>\' href="/x">l</a>')).toBe('<a title="&lt;noscript&gt;" href="/x">l</a>');
    });

    it('drops attributes and elements with non-identifier names', () => {
      expect(sanitizeDocsHtml('<a hr"ef=1 =x href="/ok" "q=1>z</a>')).toBe('<a href="/ok">z</a>');
      expect(sanitizeDocsHtml('<a$b href=x>t</a$b><x"y>q</x"y>')).toBe('tq');
    });

    it('renders a document with ordinary comments and inline HTML as before', () => {
      const html = '<h1>T</h1>\n<!-- note -->\n<p>a <b>b</b> <code>c</code> <a href="/x">d</a><br></p>\n<!-- end -->\n';
      expect(sanitizeDocsHtml(html)).toBe('<h1>T</h1>\n\n<p>a <b>b</b> <code>c</code> <a href="/x">d</a><br /></p>\n\n');
    });

    it('fails closed on absurd nesting instead of recursing', () => {
      // A surviving prefix proves the abort: without a cap these would return '<p>before</p>'.
      expect(sanitizeDocsHtml('<p>before</p>' + '<div>'.repeat(600) + 'x')).toBe('');
      expect(sanitizeDocsHtml('<p>before</p>' + '<template>'.repeat(600) + 'x')).toBe('');
      expect(sanitizeDocsHtml('<p>before</p>' + '<template>'.repeat(2000) + 'x')).toBe('');
      expect(sanitizeDocsHtml('<p>before</p>' + '<template><div>'.repeat(300) + 'x')).toBe('');
      expect(sanitizeDocsHtml('<div>'.repeat(300) + 'x' + '</div>'.repeat(300))).toContain('x'); // realistic depth still renders
    });

    // Resource bounds. parse5 is quadratic on several shapes (deep nesting, wide adoption-agency moves, foster
    // parenting, thousands of attributes on one tag), so the guarantee is NOT "linear": it is bounded work per
    // input byte under fixed limits (attribute tokens per tag, depth, adapter work budget), failing closed to ''
    // when one is exceeded. These shapes took seconds on the unguarded parser. Assertions are on the outcome,
    // which is deterministic; the printed times are evidence only.
    describe('bounded work on quadratic shapes', () => {
      it('keeps a long quoted value and attributes around it', () => {
        expect(sanitizeDocsHtml('<a title="' + 'word '.repeat(1000) + '" href="/x">t</a>')).toContain('href="/x"');
      });

      const attrs = (n: number): string => Array.from({ length: n }, (_v, i) => `a${i}`).join(' ');
      const timed = (label: string, input: string): string => {
        const t0 = Date.now();
        const out = sanitizeDocsHtml(input);
        console.log(`${label}: ${Date.now() - t0}ms`); // eslint-disable-line no-console
        return out;
      };

      it('fails closed on 64000 attributes on one start tag, however they are separated', () => {
        expect(timed('start spaced', '<p>before</p><p ' + attrs(64_000) + '>ok')).toBe('');
        expect(timed('start quoted no-space', '<p>before</p><p ' + Array.from({ length: 64_000 }, (_v, i) => `a${i}="x"`).join('') + '>ok')).toBe('');
        expect(timed('start slash', '<p>before</p><p ' + Array.from({ length: 64_000 }, (_v, i) => `a${i}`).join('/') + '>ok')).toBe('');
      });

      it('fails closed on attributes on an end tag', () => {
        expect(timed('end tag', '<p>before</p></p ' + attrs(64_000) + '>after')).toBe('');
      });

      it('is not fooled by a stray quote or a comment before the attributes', () => {
        expect(timed('stray quote', '<p>before</p><p =" ' + attrs(64_000) + '>ok')).toBe('');
        expect(timed('comment quote', '<p>before</p><!-- <p a=" --><p ' + attrs(64_000) + '>ok')).toBe('');
      });

      it('charges adoptAttributes against the work budget', () => {
        const input = '<p>before</p>' + Array.from({ length: 10_000 }, (_v, i) => `<html a${i}=x>`).join('') + '<p>ok';
        expect(timed('adoptAttributes', input)).toBe('');
      });

      it('enforces the per-tag cap exactly', () => {
        expect(sanitizeDocsHtml('<p ' + attrs(256) + '>ok')).toBe('<p>ok</p>');
        expect(sanitizeDocsHtml('<p ' + attrs(257) + '>ok')).toBe('');
        expect(sanitizeDocsHtml('<p ' + Array.from({ length: 250 }, (_v, i) => `a${i}="x"`).join('') + '>ok')).toBe('<p>ok</p>');
      });

      it('64000 duplicate attributes are cheap and render (duplicates are dropped, so the recorded count stays at one)', () => {
        // Outcome is time-independent: parse5 keeps the first `a`, so attrs.length never nears the cap, and
        // 64000 hook units fit inside the 4-per-byte budget for this 128000-byte input.
        expect(timed('duplicates', '<p ' + 'a '.repeat(64_000) + '>ok')).toBe('<p>ok</p>');
      });

      it('charges attribute bytes copied by formatting reconstruction (long attribute, many paragraphs)', () => {
        const n = 10_000;
        const input = '<p>before</p><p><a title="' + 'x'.repeat(n) + '">x</p>' + '<p>x</p>'.repeat(n);
        expect(timed('reconstruction', input)).toBe('');
        const ok = sanitizeDocsHtml('<p><a href="/docs/some/long/path">x</p>' + '<p>y</p>'.repeat(20));
        expect(ok).toContain('href="/docs/some/long/path"');
      });

      it('charges long tag-name reads on unmatched foreign end tags', () => {
        const mk = (n: number): string => '<p>before</p><svg><x' + 'İ'.repeat(n) + '>' + '</z>'.repeat(n);
        expect(timed('foreign end tags', mk(16_000))).toBe('');
        // The svg subtree is pruned and the unmatched end tags are ignored, leaving only the paragraph.
        expect(sanitizeDocsHtml(mk(10))).toBe('<p>before</p>');
      });

      it('accepts a long href reconstructed across a few paragraphs but still rejects heavy amplification', () => {
        const href = '/docs/' + 'x'.repeat(750);
        // 20 reconstructions copy ~15,000 attribute bytes: inside the 100,000-unit base plus 4 per input char.
        expect(sanitizeDocsHtml('<p><a href="' + href + '">x</p>' + '<p>y</p>'.repeat(20))).toContain(`href="${href}"`);
        // 2,000 reconstructions copy ~1.5M bytes against a budget of about 100,000 + 4 * 17,000 input chars.
        expect(sanitizeDocsHtml('<p>before</p><p><a href="' + href + '">x</p>' + '<p>y</p>'.repeat(2_000))).toBe('');
      });

      it('charges every tag token for the stack and formatting-list scans parse5 does', () => {
        const N = 100_000;
        const pre = '<p>before</p>';
        const kebab = 'İ'.repeat(14);
        expect(timed('short foreign names', pre + '<svg>' + ('<x' + kebab + '>').repeat(500) + '</z>'.repeat(N))).toBe('');
        expect(timed('span stack + end tags', pre + '<span>'.repeat(500) + '</div>'.repeat(N))).toBe('');
        const bs = Array.from({ length: 450 }, (_v, i) => `<b a=${i}>`).join('');
        expect(timed('formatting list + end tags', pre + bs + '</i>'.repeat(N))).toBe('');
        expect(timed('span stack + select', pre + '<span>'.repeat(500) + '<select></select>'.repeat(N))).toBe('');
        expect(timed('formatting list + b a=q', pre + bs + '<b a=q></b>'.repeat(N))).toBe('');
      });

      it('charges character tokens and formatting-attribute comparisons', () => {
        const pre = '<p>before</p>';
        expect(timed('character tokens', pre + '<b>' + '<span>'.repeat(500) + 'x '.repeat(200_000))).toBe('');
        const attrs = Array.from({ length: 63 }, (_v, i) => `a${i}`).join(' ');
        const bs = Array.from({ length: 450 }, (_v, i) => `<b ${attrs} z=${i}>`).join('');
        expect(timed('noahs ark', pre + bs + `<b ${attrs} z=q></b>`.repeat(1_134))).toBe('');
      });

      it('renders deeply nested lists with long prose and a code block (the newest formatting entry is the current node)', () => {
        const open = '<ul><li>'.repeat(20);
        const close = '</li></ul>'.repeat(20);
        const sentence = 'This guide explains how to set up the service and check that it is ready to use.';
        const prose = sanitizeDocsHtml(open + `<p>${Array(5).fill(sentence).join(' ')}</p>
`.repeat(250) + close);
        expect(prose).toContain(sentence);
        // <code> is an active formatting element, so this exercises the newest-entry rule (130,384 bytes).
        const line = 'for (let i = 0; i < n; i++) { sum += items[i]; }\n';
        const block = open + '<pre><code>' + line.replaceAll('<', '&lt;').repeat(2_500) + '</code></pre>' + close;
        expect(sanitizeDocsHtml(block)).toContain('sum += items[i]');
      });

      it('character tokens under a deep stack with no formatting element are cheap (observed outcome recorded)', () => {
        // Without an active formatting element, characters never trigger reconstruction, so each costs 1 unit
        // and this input (400 KB, inside the 4-per-char budget) renders.
        const out = timed('characters, no <b>', '<p>before</p>' + '<span>'.repeat(500) + 'x '.repeat(200_000));
        expect(out).toContain('<p>before</p>');
      });

      it('character tokens whose newest formatting entry is the current node are cheap', () => {
        // b is older but code, the newest entry, is the current node: reconstruction returns at once.
        const out = timed('characters under <b><span>*500<code>', '<p>before</p><b>' + '<span>'.repeat(500) + '<code>' + 'x '.repeat(200_000));
        expect(out).toContain('<p>before</p>');
      });

      it('still renders a deep-ish realistic document inside the budget', () => {
        expect(sanitizeDocsHtml('<div>'.repeat(30) + '<p>x</p>'.repeat(5_000) + '</div>'.repeat(30))).toContain('<p>x</p>');
      });

      it('charges MathML annotation-xml integration-point checks', () => {
        const mk = (n: number): string =>
          '<p>before</p><math><annotation-xml encoding="' + 'İ'.repeat(n) + '">' + '<x></x>'.repeat(n) + '</annotation-xml></math><p>ok';
        expect(timed('integration point', mk(10_000))).toBe('');
        expect(sanitizeDocsHtml(mk(10))).toBe('<p>before</p><p>ok</p>');
      });

      it('does not blank a document for one large attribute value', () => {
        const out = sanitizeDocsHtml('<p>keep</p><img src="data:image/png;base64,' + 'A'.repeat(200_000) + '" alt="x">');
        expect(out).toContain('<p>keep</p>');
      });

      it('does not blank a document for tag-like text inside a comment', () => {
        expect(sanitizeDocsHtml('<p>Documentation</p><!-- Example query: <search ' + 'word '.repeat(300) + ' -->')).toBe('<p>Documentation</p>');
      });

      it('fails closed on adoption-agency child transfers (140 ms to 1 s before, quadratic)', () => {
        const input = '<p>before</p><b><div>' + '<i>x</i>'.repeat(64_000) + '</b></div>';
        const t0 = Date.now();
        expect(sanitizeDocsHtml(input)).toBe('');
        console.log(`adoption 64000: ${Date.now() - t0}ms`); // eslint-disable-line no-console
      });

      it('fails closed on wide foster parenting (1.9 s before)', () => {
        const t0 = Date.now();
        expect(sanitizeDocsHtml('<p>before</p><table>' + 'x<b>y</b>'.repeat(60_000))).toBe('');
        expect(sanitizeDocsHtml('<p>before</p><table>' + '<div>x</div>'.repeat(100_000) + '</table>')).toBe('');
        console.log(`foster: ${Date.now() - t0}ms`); // eslint-disable-line no-console
      });

      it('fails closed on deep-and-wide input instead of paying the depth walk on every node', () => {
        expect(sanitizeDocsHtml('<p>before</p>' + '<div>'.repeat(400) + '<p>x'.repeat(100_000))).toBe('');
      });

      it('still renders realistic wide documents inside the budget', () => {
        const rows = '<tr><td>a</td><td>b</td></tr>'.repeat(5000);
        expect(sanitizeDocsHtml(`<table><tbody>${rows}</tbody></table>`)).toContain('<td>b</td>');
        const items = '<li>item <a href="/x">link</a></li>'.repeat(5000);
        expect(sanitizeDocsHtml(`<ul>${items}</ul>`)).toContain('<li>item <a href="/x">link</a></li>');
      });
    });

    it('survives a mis-nested anchor/table fixture with no dangerous output (not idempotent, recorded)', () => {
      const out = sanitizeDocsHtml('<a href=/outer><table><x><a href=/inner>IN</a></x></table>OUT</a>');
      expect(out).toBe('<a href="/outer"><a href="/inner">IN</a><table></table></a>OUT');
      for (const t of tags(out)) expect(t).toMatch(/^<(a href="\/(outer|inner)"|\/?a|table|\/table)/);
      // The first pass keeps the browser-built tree with a nested anchor; re-sanitising re-parses that
      // string and splits the anchors, so the function is NOT idempotent on this input. It settles at once.
      const again = sanitizeDocsHtml(out);
      expect(again).toBe('<a href="/outer"></a><a href="/inner">IN</a><table></table>OUT');
      expect(sanitizeDocsHtml(again)).toBe(again);
    });

    describe.each([
      ['"<" and "!>" flood', (n: number) => '<'.repeat(Math.floor(n / 3)) + '!>'.repeat(Math.floor(n / 3))],
      ['flat sibling paragraphs', (n: number) => '<p>x'.repeat(Math.floor(n / 4))],
      ['flat list items', (n: number) => '<li>x'.repeat(Math.floor(n / 5))],
      ['inline text and bold runs', (n: number) => 'hello & <b>world</b> '.repeat(Math.floor(n / 22))],
      ['tables', (n: number) => '<table><tr><td>x</td></tr></table>'.repeat(Math.floor(n / 35))],
      ['unclosed distinct formatting elements', (n: number) => Array.from({ length: Math.floor(n / 12) }, (_v, i) => `<b a=${i}>`).join('')],
      ['unclosed nested templates', (n: number) => '<template>'.repeat(Math.floor(n / 10))],
    ])('%s', (name, make) => {
      it('50 KB and 500 KB stay within the coarse time bounds', () => {
        const time = (n: number): number => {
          const input = make(n);
          const t0 = process.hrtime.bigint();
          sanitizeDocsHtml(input);
          return Number(process.hrtime.bigint() - t0) / 1e6;
        };
        time(5_000); // warm-up
        const small = time(50_000);
        const large = time(500_000);
        // eslint-disable-next-line no-console
        console.log(`linearity ${name}: 50KB ${small.toFixed(0)}ms, 500KB ${large.toFixed(0)}ms`);
        expect(small).toBeLessThan(2000);
        expect(large).toBeLessThan(5000);
      });
    });

    it('still drops well-formed HTML comments and keeps text around them', () => {
      const out = sanitizeDocsHtml('<p>a</p><!-- markdownlint-disable --><p>b</p>');
      expect(out).toBe('<p>a</p><p>b</p>'); // parse5 drops the comment node outright (no placeholder space)
    });

    it('keeps a Markdown code block containing a literal CDATA section as visible escaped text', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marked } = require(path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js'));
      const html: string = marked.parse('Before\n\n```html\n<![CDATA[x]]>\n```\n\nInline `<![CDATA[y]]>` text.\n');
      expect(html).toContain('&lt;![CDATA[x]]&gt;'); // positive control: marked escaped it
      const out = sanitizeDocsHtml(html);
      expect(out).toContain('&lt;![CDATA[x]]&gt;');
      expect(out).toContain('&lt;![CDATA[y]]&gt;');
      expect(out).toContain('Before');
    });
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
