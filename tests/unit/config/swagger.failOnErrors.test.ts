/**
 * Swagger generation must fail on a malformed annotation, not drop the route.
 *
 * `swagger-jsdoc` defaults to `failOnErrors: false`: it prints a report to
 * stdout and returns a spec with the unparseable block silently missing. In a
 * CI log that report scrolls past, and the only visible symptom is an endpoint
 * that is absent from the published API documentation — which reads as "not
 * implemented yet" rather than "the annotation is broken".
 *
 * Measured before this fix: one malformed block in `src/routes/configuration.ts`
 * dropped `POST /api/configurations/{id}/serialized-asset-readiness`, taking the
 * generated spec from 39 paths to 38, with a `YAMLSemanticError` on stdout that
 * nothing consumed. It was the only malformed annotation in the tree.
 *
 * The strongest guard here is not an assertion at all: with `failOnErrors: true`
 * the module throws at import, so any future malformed annotation fails this
 * suite (and every consumer) at load rather than quietly shrinking the spec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSwaggerSpec, swaggerSpec } from '../../../src/config/swagger';

describe('swagger generation is fail-closed', () => {
  it('throws on a malformed annotation instead of dropping the route', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-'));
    const bad = path.join(dir, 'bad.ts');
    // An unquoted `ready: false` inside a plain scalar makes YAML read the
    // description as a nested mapping — the exact shape found in the tree.
    fs.writeFileSync(
      bad,
      '/**\n * @swagger\n * /x:\n *   get:\n *     responses:\n *       200:\n' +
        ' *         description: Readiness result (may be `ready: false` with blockers)\n */\n',
    );
    try {
      expect(() => buildSwaggerSpec({ apis: [bad] })).toThrow(/YAML|mapping|parse/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a well-formed annotation, so the throw above is about the defect and not the harness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swagger-'));
    const good = path.join(dir, 'good.ts');
    fs.writeFileSync(
      good,
      '/**\n * @swagger\n * /x:\n *   get:\n *     responses:\n *       200:\n' +
        " *         description: 'Readiness result (may be `ready: false` with blockers)'\n */\n",
    );
    try {
      const spec = buildSwaggerSpec({ apis: [good] }) as { paths: Record<string, unknown> };
      expect(Object.keys(spec.paths)).toEqual(['/x']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed route annotations all parse, including the one this fix recovered', () => {
    const spec = swaggerSpec as { paths: Record<string, unknown> };
    // Reverting the quoting in configuration.ts drops exactly this path.
    expect(Object.keys(spec.paths)).toContain('/api/configurations/{id}/serialized-asset-readiness');
    // A floor, not an exact count: adding routes is fine, silently losing them is not.
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(39);
  });
});
