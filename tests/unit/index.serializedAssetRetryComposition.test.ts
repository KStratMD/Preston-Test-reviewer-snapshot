/**
 * A9 production-composition guard (Codex round 2 on #1132).
 *
 * The blocker this exists to prevent has now happened twice in this tranche.
 * A6 wired a feature into the image the platform does NOT build; A9 wired the
 * forced-retry service into `RouteSetup` and missed the SEPARATE late mount in
 * `src/index.ts` that production actually uses. In both cases every unit test
 * passed, because the unit tests construct the router directly and never go
 * through the composition root. The result was a feature that returned 503 for
 * every real request while the suite was green.
 *
 * `ServerBootstrap.start()` cannot be reached from an App-boot test, so this
 * follows the established pattern of `f5MountComposition.test.ts` and reads
 * `src/index.ts` as source. It parses rather than string-matches, so
 * reformatting, renamed locals, and reordered properties do not fool it: the
 * assertion is that EVERY `createIntegrationRouter(...)` call in the file
 * passes a `serializedAssetRetryOperations` property.
 *
 * Deliberately a whole-file sweep and not a check of one known call site — a
 * future second mount added without the dependency is the exact regression
 * being guarded, and a single-site check would not see it.
 */

import { readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const INDEX_TS = path.resolve(__dirname, '../../src/index.ts');
const ROUTE_SETUP_TS = path.resolve(__dirname, '../../src/middleware/setup/RouteSetup.ts');

/** Every `createIntegrationRouter(...)` call node in a source file. */
function routerCalls(file: string): ts.CallExpression[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createIntegrationRouter'
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Property names passed in the call's single options-object argument. */
function optionKeys(call: ts.CallExpression): string[] {
  const [arg] = call.arguments;
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return [];
  return arg.properties.flatMap((prop) => {
    if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      ts.isIdentifier(prop.name)
    ) {
      return [prop.name.text];
    }
    return [];
  });
}

describe('A9 production composition — the forced-retry service reaches the real mount', () => {
  it('finds at least one createIntegrationRouter call in src/index.ts', () => {
    // Guards the guard: if the call is renamed or moved, the sweep below would
    // vacuously pass over an empty list.
    expect(routerCalls(INDEX_TS).length).toBeGreaterThan(0);
  });

  it('passes serializedAssetRetryOperations at EVERY call site in src/index.ts', () => {
    const missing = routerCalls(INDEX_TS)
      .map((call, index) => ({ index, keys: optionKeys(call) }))
      .filter(({ keys }) => !keys.includes('serializedAssetRetryOperations'));

    expect(missing).toEqual([]);
  });

  it('passes it at every call site in RouteSetup too', () => {
    // The other mount. It is skipped in production (integrationService is
    // undefined during constructor init), but it is the one the tests drive,
    // so the two must not be allowed to drift apart.
    const calls = routerCalls(ROUTE_SETUP_TS);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(optionKeys(call)).toContain('serializedAssetRetryOperations');
    }
  });

  it('never falls back to the positional single-service form', () => {
    // createIntegrationRouter still accepts a bare IntegrationService for
    // backward compatibility. That overload cannot carry the retry service, so
    // a mount using it silently degrades the feature to 503 — which is exactly
    // how the original blocker presented.
    for (const file of [INDEX_TS, ROUTE_SETUP_TS]) {
      for (const call of routerCalls(file)) {
        const [arg] = call.arguments;
        expect(arg).toBeDefined();
        expect(ts.isObjectLiteralExpression(arg!)).toBe(true);
      }
    }
  });
});
