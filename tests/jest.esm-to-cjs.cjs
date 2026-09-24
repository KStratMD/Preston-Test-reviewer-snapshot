/* eslint-env node */
/* eslint-disable no-undef */

/**
 * Jest transformer: compile an ESM-only dependency to CommonJS with the TypeScript compiler
 * (already a dev dependency). Scoped by tests/jest.esm-deps.cjs to the packages listed there.
 */
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const out = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        allowJs: true,
        esModuleInterop: true,
        sourceMap: false,
      },
    });
    return { code: out.outputText };
  },
};
