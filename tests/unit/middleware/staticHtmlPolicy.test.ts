import {
  isAllowedStaticHtmlPath,
  denyUnlistedHtml,
  denyStaticHtmlOnAliasMount,
  STATIC_HTML_DIRECTORY_ALLOWLIST,
} from '../../../src/middleware/staticHtmlPolicy';

// A deliberately small whitelist: these tests pin the policy, not the real list.
// It carries one nested entry because the production whitelist enumerates 66 of
// them, and a directory-only rule would silently deny every one.
const whitelist = new Set(['index.html', 'api-docs.html', 'vendor-portal/index.html']);

describe('isAllowedStaticHtmlPath', () => {
  it('allows whitelisted top-level pages, matching case-insensitively', () => {
    expect(isAllowedStaticHtmlPath('/index.html', whitelist)).toBe(true);
    expect(isAllowedStaticHtmlPath('/INDEX.HTML', whitelist)).toBe(true);
  });

  it('denies top-level pages that are not whitelisted', () => {
    expect(isAllowedStaticHtmlPath('/customer-payment-portal.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/metrics-viewer.html', whitelist)).toBe(false);
  });

  it('allows a nested page named in the whitelist', () => {
    expect(isAllowedStaticHtmlPath('/vendor-portal/index.html', whitelist)).toBe(true);
  });

  it('denies a nested page that is neither whitelisted nor under an allowlisted directory', () => {
    expect(isAllowedStaticHtmlPath('/payment-portal/index.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/anything/else.html', whitelist)).toBe(false);
  });

  it('allows everything under an allowlisted directory', () => {
    expect(STATIC_HTML_DIRECTORY_ALLOWLIST.has('wiki')).toBe(true);
    expect(isAllowedStaticHtmlPath('/wiki/pages/entities/squire.html', whitelist)).toBe(true);
  });

  it('judges a directory request as the index page it would resolve to', () => {
    // Without this, the extension test lets a directory slip past and
    // express.static serves or redirects to its index.html.
    expect(isAllowedStaticHtmlPath('/vendor-portal/', whitelist)).toBe(true);
    expect(isAllowedStaticHtmlPath('/vendor-portal', whitelist)).toBe(true);
    expect(isAllowedStaticHtmlPath('/payment-portal/', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/payment-portal', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/wiki/', whitelist)).toBe(true);
  });

  it('denies CSP-routed embedded pages so they fall through to their route handler', () => {
    // Serving these statically would drop the frame-ancestors header.
    expect(isAllowedStaticHtmlPath('/embedded/approvals.html', whitelist)).toBe(false);
  });

  it('rejects traversal and never touches non-HTML paths', () => {
    expect(isAllowedStaticHtmlPath('/../index.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/js/app.js', whitelist)).toBe(true);
    expect(isAllowedStaticHtmlPath('/assets/app.css', whitelist)).toBe(true);
  });
});

describe('denyUnlistedHtml', () => {
  it('calls next() for a denied HTML path and delegates otherwise', () => {
    const staticHandler = jest.fn((_req, _res, next) => next());
    const wrapped = denyUnlistedHtml(staticHandler as never, whitelist);
    const next = jest.fn();

    wrapped({ method: 'GET', path: '/secret.html' } as never, {} as never, next);
    expect(staticHandler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    wrapped({ method: 'GET', path: '/index.html' } as never, {} as never, next);
    expect(staticHandler).toHaveBeenCalledTimes(1);
  });

  it('passes non-GET/HEAD requests straight through', () => {
    const staticHandler = jest.fn((_req, _res, next) => next());
    const wrapped = denyUnlistedHtml(staticHandler as never, whitelist);
    wrapped({ method: 'POST', path: '/secret.html' } as never, {} as never, jest.fn());
    expect(staticHandler).toHaveBeenCalledTimes(1);
  });
});

describe('isAllowedStaticHtmlPath: encoded and malformed paths', () => {
  // express.static decodes before resolving a file, so a policy that judges the
  // raw path lets "/metrics-viewer.%68tml" through as a non-HTML asset and
  // serve-static then serves metrics-viewer.html. Verified live before the fix:
  // that URL returned 200 for a deliberately unlisted page.
  it('denies an unlisted page reached through a percent-encoded extension', () => {
    expect(isAllowedStaticHtmlPath('/metrics-viewer.%68tml', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/metrics-viewer.%48TML', whitelist)).toBe(false);
  });

  it('allows a whitelisted page reached through a percent-encoded extension', () => {
    expect(isAllowedStaticHtmlPath('/index.%68tml', whitelist)).toBe(true);
  });

  it('denies encoded traversal that would borrow an allowlisted directory', () => {
    expect(isAllowedStaticHtmlPath('/wiki/%2e%2e/metrics-viewer.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/wiki/../metrics-viewer.html', whitelist)).toBe(false);
  });

  it('fails closed on a malformed escape sequence', () => {
    expect(isAllowedStaticHtmlPath('/%E0%A4%A.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('/%zz.html', whitelist)).toBe(false);
  });

  it('treats backslashes and doubled slashes as the separators they resolve to', () => {
    expect(isAllowedStaticHtmlPath('/wiki\\..\\metrics-viewer.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('//metrics-viewer.html', whitelist)).toBe(false);
    expect(isAllowedStaticHtmlPath('//index.html', whitelist)).toBe(true);
  });
});

describe('denyStaticHtmlOnAliasMount', () => {
  // /vendor and /webfonts strip their own prefix, so whitelist keys (relative to
  // public/) cannot match there. They deny HTML outright and let it fall through
  // to the guarded root mount, where the full path is checked.
  const run = (method: string, path: string) => {
    const staticHandler = jest.fn((_req, _res, next) => next());
    const next = jest.fn();
    denyStaticHtmlOnAliasMount(staticHandler as never)({ method, path } as never, {} as never, next);
    return { staticHandler, next };
  };

  it('denies HTML, however it is spelled', () => {
    for (const p of ['/debug.html', '/debug.htm', '/DEBUG.HTML', '/debug.%68tml', '/sub/']) {
      const { staticHandler, next } = run('GET', p);
      expect(staticHandler).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('still serves the assets these mounts exist for', () => {
    for (const p of ['/jquery.min.js', '/fa-solid-900.woff2', '/style.css']) {
      const { staticHandler } = run('GET', p);
      expect(staticHandler).toHaveBeenCalledTimes(1);
    }
  });

  it('fails closed on a malformed escape sequence', () => {
    const { staticHandler, next } = run('GET', '/%zz.js');
    expect(staticHandler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
