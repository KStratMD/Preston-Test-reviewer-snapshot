/* eslint-env node */
/* eslint-disable no-undef */

/**
 * ESM-only runtime dependencies that Jest (on Node 22) cannot `require`.
 *
 * Production loads them through Node's require(esm); Jest's module runtime does not, so these
 * packages are compiled to CommonJS by tests/jest.esm-to-cjs.cjs. Today they are the
 * htmlparser2 family pulled in by sanitize-html (src/utils/safeDocsHtml.ts). Spread
 * `esmDepsTransform` into a config's `transform` and use `esmDepsTransformIgnorePatterns` as its
 * `transformIgnorePatterns`.
 */
// The full ESM-only set reachable from sanitize-html 2.17.7 (walked 2026-09-22). `entities` 8
// is nested under htmlparser2 and dom-serializer; the top-level `entities` 4 used by other
// packages is CommonJS and passes through the transform unchanged.
const ESM_ONLY_PACKAGES = [
  'htmlparser2',
  'domhandler',
  'domutils',
  'dom-serializer',
  'domelementtype',
  'entities',
];

const group = ESM_ONLY_PACKAGES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const SEP = '[\\\\/]';
const SEGMENT = '[^\\\\/]+';

module.exports = {
  ESM_ONLY_PACKAGES,
  esmDepsTransform: {
    [`${SEP}node_modules${SEP}(${group})${SEP}.+\\.js$`]: '<rootDir>/tests/jest.esm-to-cjs.cjs',
  },
  // Skip transforming a node_modules file unless the package that OWNS it (the segment after
  // the LAST node_modules, scoped names included) is listed, so a listed package nested under
  // an unlisted one (e.g. sanitize-html/node_modules/htmlparser2) is still compiled.
  esmDepsTransformIgnorePatterns: [
    `${SEP}node_modules${SEP}(?!(?:${group})${SEP})(?:@${SEGMENT}${SEP})?${SEGMENT}${SEP}(?!(?:.*${SEP})?node_modules${SEP})`,
  ],
};
