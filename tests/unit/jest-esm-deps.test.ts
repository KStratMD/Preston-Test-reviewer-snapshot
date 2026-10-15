/**
 * Scope of the Jest ESM-to-CommonJS transform (tests/jest.esm-deps.cjs): exactly the listed
 * ESM-only packages are compiled, wherever they sit in the node_modules tree, and nothing else.
 */
const deps = require('../jest.esm-deps.cjs') as {
  esmDepsTransform: Record<string, string>;
  esmDepsTransformIgnorePatterns: string[];
};

const ignore = new RegExp(deps.esmDepsTransformIgnorePatterns[0]);
const transform = new RegExp(Object.keys(deps.esmDepsTransform)[0]);

/** Jest skips a file matching any ignore pattern; otherwise the first matching transform applies. */
function compiledByEsmTransform(p: string): boolean {
  return !ignore.test(p) && transform.test(p);
}

describe('jest ESM dependency transform scope', () => {
  it.each([
    '/x/node_modules/htmlparser2/dist/index.js',
    '/x/node_modules/htmlparser2/node_modules/entities/dist/decode.js',
    '/x/node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js',
    String.raw`C:\x\node_modules\sanitize-html\node_modules\htmlparser2\dist\index.js`,
    '/x/node_modules/dom-serializer/node_modules/entities/dist/escape.js',
  ])('compiles listed package file %s', p => {
    expect(compiledByEsmTransform(p)).toBe(true);
  });

  it.each([
    '/x/node_modules/express/index.js',
    String.raw`C:\x\node_modules\express\index.js`,
    '/x/node_modules/sanitize-html/index.js',
    '/x/node_modules/@scope/htmlparser2/x.js',
    '/x/node_modules/htmlparser2/node_modules/express/index.js',
    '/x/node_modules/domhandlerx/a.js',
  ])('leaves unlisted package file alone %s', p => {
    expect(compiledByEsmTransform(p)).toBe(false);
  });

  // Asserted on the ignore pattern itself, not through compiledByEsmTransform: unlisted
  // packages never match the transform anyway, so only this proves Jest skips them.
  it.each([
    '/x/node_modules/express/index.js',
    String.raw`C:\x\node_modules\express\index.js`,
    '/x/node_modules/sanitize-html/index.js',
    '/x/node_modules/@types/node/index.d.ts',
    '/x/node_modules/htmlparser2/node_modules/express/index.js',
  ])('ignore pattern matches unlisted package file %s', p => {
    expect(ignore.test(p)).toBe(true);
  });

  it.each([
    '/x/node_modules/htmlparser2/dist/index.js',
    '/x/node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js',
  ])('ignore pattern does not match listed package file %s', p => {
    expect(ignore.test(p)).toBe(false);
  });

  it('does not ignore project source (ts-jest still handles it)', () => {
    expect(ignore.test('/x/src/utils/safeDocsHtml.ts')).toBe(false);
  });
});
