/* Custom Jest resolver to support tests relocated under tests/unit
   It falls back to resolving relative imports against src/ when a module cannot be found from tests/ paths.
*/
/* eslint-env node */
/* eslint-disable no-undef */

const path = require('path');

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (err) {
    try {
      // Only attempt remapping for relative imports from tests
      if (request.startsWith('.')) {
        const rootDir = options.rootDir || process.cwd();
        const testsRoot = path.join(rootDir, 'tests', 'unit');
        const fromDir = options.basedir;
        const absoluteAttempt = path.resolve(fromDir, request);
        const relFromTests = path.relative(testsRoot, absoluteAttempt);
        const srcCandidate = path.join(rootDir, 'src', relFromTests);
        return options.defaultResolver(srcCandidate, options);
      }
    } catch (_err2) {
      // Fall through to rethrow original error
    }
    throw err;
  }
};
