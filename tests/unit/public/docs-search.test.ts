/**
 * R18: the docs search client renders result titles and paths as text. Titles come from doc
 * headings and Postman collections, so markup in them must not reach innerHTML.
 */
const { renderResultsHtml, highlightHtml } = require('../../../public/docs-search.js') as {
  renderResultsHtml: (list: Record<string, unknown>[], q: string) => string;
  highlightHtml: (text: string, q: string) => string;
};

function tags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

describe('docs search client rendering', () => {
  it('escapes a hostile title and keeps the highlight', () => {
    const html = renderResultsHtml(
      [{ title: '<img src=x onerror=alert(1)> guide', path: 'guide.md', score: 1, fuzzy: 2 }],
      'guide',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; <mark>guide</mark>');
    for (const t of tags(html)) expect(t).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('never highlights inside an entity', () => {
    expect(highlightHtml('a<b & c', 'lt')).toBe('a&lt;b &amp; c');
    expect(highlightHtml('a<b & c', 'amp')).toBe('a&lt;b &amp; c');
  });

  it('cannot break out of the href attribute', () => {
    const html = renderResultsHtml([{ title: 't', path: 'a" onmouseover="alert(1).md', score: 1, fuzzy: 1 }], 't');
    const href = html.match(/href="([^"]*)"/)?.[1] ?? '';
    expect(href.startsWith('/docs/')).toBe(true);
    for (const t of tags(html)) expect(t).not.toMatch(/\sonmouseover\s*=/i);
  });

  it('percent-encodes # and ? inside doc file names (Copilot #1343)', () => {
    const html = renderResultsHtml(
      [
        { title: 'a', path: 'a&b #1.md', score: 1, fuzzy: 1 },
        { title: 'b', path: 'dir/what?.md', score: 1, fuzzy: 1 },
      ],
      'zz',
    );
    const hrefs = (html.match(/href="([^"]*)"/g) ?? []).map(h => h.slice(6, -1));
    expect(hrefs).toEqual(['/docs/a%26b%20%231.md', '/docs/dir/what%3F.md']);
  });

  it('splits a Postman result after the collection suffix, not at a # in the file name (Copilot #1343)', () => {
    const html = renderResultsHtml([{ title: 'GET /x', path: 'postman/a#b.postman_collection.json#Folder/Req', score: 1, fuzzy: 1 }], 'zz');
    expect(html).toContain('href="/docs/postman/a%23b.postman_collection.json#Folder/Req"');
  });

  it('keeps the Postman anchor and badge', () => {
    const html = renderResultsHtml([{ title: 'GET /x', path: 'postman/c.postman_collection.json#Folder/Req', score: 1, fuzzy: 1 }], 'x');
    expect(html).toContain('href="/docs/postman/c.postman_collection.json#Folder/Req"');
    expect(html).toContain('POSTMAN');
  });
});
