import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Request, Response } from 'express';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';
import { DEMO_ANONYMOUS_ATTESTATION } from '../../../../src/middleware/aiProxyPolicyGate';
import { CENTRAL_DEMO_TENANT_ID } from '../../../../src/services/governance/demoTenant';
import {
  resolveCentralActor,
  resolveCentralTenantId,
} from '../../../../src/routes/central/centralTenant';

/**
 * Find reads of `tenantId` taken off the REQUEST rather than through
 * resolveCentralTenantId / resolveCentralActor.
 *
 * AST-based, not regex. Two concrete reasons (Codex review round 3):
 *   - comment/string handling must be lexical. Stripping `//.*$` by regex
 *     truncates at a `//` inside a string literal (`'https://…'`) and can hide
 *     a real read later on that line, and a string that merely CONTAINS
 *     `user.tenantId` would produce a false positive. The parser gets both
 *     right for free.
 *   - a bypass has many spellings. Optional chaining, bracket access, casts,
 *     non-null assertions, and destructuring aliases (`const { user: u } = req`)
 *     all read the same value; a single property-access pattern misses most of
 *     them.
 *
 * Request-rooted names are collected to a fixed point so aliases-of-aliases are
 * covered, and binding patterns are walked RECURSIVELY (nesting hides the read:
 * `const { user: { tenantId } } = req` produces no property access and no
 * top-level `tenantId` element).
 *
 * Residual limitations, stated rather than hidden — the primary defense remains
 * that the helpers are the only sanctioned tenant source:
 *   - intra-file only; a value passed into a function in ANOTHER module is not
 *     followed (a same-file helper whose parameter is named `req`/`request` IS
 *     covered, because those names are request-rooted seeds);
 *   - dynamic key indirection (`const k = 'tenantId'; req.user[k]`) is not
 *     resolved; it needs constant propagation and no handler here does it;
 *   - names are tracked textually, not by lexical symbol, so an inner local
 *     shadowing a request alias is flagged conservatively. That error direction
 *     is chosen on purpose: a false positive is a loud failing test on a
 *     legitimate edit, while scope-accurate tracking that silently misses a
 *     real bypass is the failure that ships. See the pinning test below.
 */
export function findRequestTenantReads(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];
  const requestRooted = new Set<string>(['req', 'request']);

  const unwrap = (node: ts.Expression): ts.Expression => {
    let cur = node;
    for (;;) {
      if (
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isNonNullExpression(cur) ||
        ts.isTypeAssertionExpression(cur) ||
        ts.isSatisfiesExpression(cur)
      ) {
        cur = cur.expression;
        continue;
      }
      return cur;
    }
  };

  // A CallExpression root is deliberately NOT request-rooted: that is the
  // sanctioned path (the helpers return a plain string).
  const isRequestRooted = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return requestRooted.has(expr.text);
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      return isRequestRooted(expr.expression);
    }
    return false;
  };

  /**
   * The destructured KEY being read. Covers `{ tenantId }`,
   * `{ tenantId: alias }`, and the computed-string form
   * `{ ['tenantId']: alias }`.
   */
  const keyOf = (el: ts.BindingElement): string | undefined => {
    const key = el.propertyName ?? el.name;
    if (ts.isIdentifier(key)) return key.text;
    if (ts.isStringLiteralLike(key)) return key.text;
    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)) {
      return key.expression.text;
    }
    return undefined;
  };

  /**
   * Walk a binding pattern destructured from a request-rooted value.
   * RECURSIVE, because nesting hides the read: `const { user: { tenantId } } = req`
   * never produces a property access and its `tenantId` is not a top-level
   * element (Codex review round 4).
   */
  const walkBinding = (
    pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
    onTenantRead: () => void,
  ): void => {
    for (const el of pattern.elements) {
      // Array patterns can carry holes (`const [, second] = xs`).
      if (ts.isOmittedExpression(el)) continue;
      if (keyOf(el) === 'tenantId') onTenantRead();
      if (ts.isIdentifier(el.name)) {
        // Every binding off a request-rooted value is itself request-rooted.
        requestRooted.add(el.name.text);
      } else if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
        walkBinding(el.name, onTenantRead);
      }
    }
  };

  // Phase 1 — collect request-rooted local names to a fixed point.
  for (let pass = 0; pass < 5; pass++) {
    const before = requestRooted.size;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && isRequestRooted(node.initializer)) {
        if (ts.isIdentifier(node.name)) {
          requestRooted.add(node.name.text);
        } else if (
          ts.isObjectBindingPattern(node.name) ||
          ts.isArrayBindingPattern(node.name)
        ) {
          // Name collection only here; the flagging pass reports the reads.
          walkBinding(node.name, () => undefined);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    if (requestRooted.size === before) break;
  }

  const at = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // Phase 2 — flag every read of tenantId off a request-rooted expression.
  const check = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'tenantId' &&
      isRequestRooted(node.expression)
    ) {
      findings.push(`${fileName}:${at(node)} ${node.getText(sf)}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'tenantId' &&
      isRequestRooted(node.expression)
    ) {
      findings.push(`${fileName}:${at(node)} ${node.getText(sf)}`);
    }
    // `const { tenantId } = req.user` and `const { user: { tenantId } } = req`
    // — the value never appears as a property access, so the binding pattern
    // itself has to be inspected, at every depth.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isRequestRooted(node.initializer) &&
      (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
    ) {
      walkBinding(node.name, () => {
        findings.push(`${fileName}:${at(node)} ${node.getText(sf)}`);
      });
    }
    ts.forEachChild(node, check);
  };
  check(sf);

  return findings;
}

function fakeRes(): Response & { statusCode?: number; payload?: unknown } {
  const res = {
    status(code: number) {
      (res as { statusCode?: number }).statusCode = code;
      return res;
    },
    json(body: unknown) {
      (res as { payload?: unknown }).payload = body;
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; payload?: unknown };
}

/** A request the gate admitted through its anonymous demo branch. */
function attestedReq(extra: Record<string, unknown> = {}): Request {
  return { query: {}, [DEMO_ANONYMOUS_ATTESTATION]: true, ...extra } as unknown as Request;
}

describe('resolveCentralTenantId (F5b)', () => {
  it('returns the DEMO tenant (never the system tenant) for a gate-attested anonymous request', () => {
    const res = fakeRes();
    expect(resolveCentralTenantId(attestedReq(), res)).toBe(CENTRAL_DEMO_TENANT_ID);
    expect(resolveCentralTenantId(attestedReq(), res)).not.toBe(SYSTEM_IDENTITY.tenantId);
    expect(res.statusCode).toBeUndefined();
  });

  it('centralTenant.ts no longer references SYSTEM_IDENTITY (F6 prerequisite a)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/routes/central/centralTenant.ts'),
      'utf8',
    );
    expect(src).not.toContain('SYSTEM_IDENTITY');
  });

  it('401s an UNATTESTED credential-free request — this is the removed fallback', () => {
    const res = fakeRes();
    expect(resolveCentralTenantId({ query: {} } as Request, res)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'identity_required' });
  });

  it('returns the verified tenant claim for an authenticated request', () => {
    const req = { query: {}, user: { tenantId: 'tenant-a' } } as unknown as Request;
    expect(resolveCentralTenantId(req, fakeRes())).toBe('tenant-a');
  });

  it('trims a padded tenant claim', () => {
    const req = { query: {}, user: { tenantId: '  tenant-a  ' } } as unknown as Request;
    expect(resolveCentralTenantId(req, fakeRes())).toBe('tenant-a');
  });

  it('prefers the verified claim over a stale attestation', () => {
    const req = attestedReq({ user: { tenantId: 'tenant-a' } });
    expect(resolveCentralTenantId(req, fakeRes())).toBe('tenant-a');
  });

  it('401s an authenticated request whose token carries no tenantId', () => {
    const req = { query: {}, user: { sub: 'u1' } } as unknown as Request;
    const res = fakeRes();
    expect(resolveCentralTenantId(req, res)).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('401s an authenticated request whose tenantId is whitespace only', () => {
    const req = { query: {}, user: { tenantId: '   ' } } as unknown as Request;
    expect(resolveCentralTenantId(req, fakeRes())).toBeNull();
  });

  // F5b-3 (Codex review): demoTenant.ts documents "no JWT is ever minted with
  // this tenantId". Nothing ENFORCED it, so a token carrying the demo tenant
  // would have been accepted — and since anonymous demo readers see that
  // tenant's rows, an authenticated caller could write content every demo
  // visitor then reads. The claim path now refuses it outright.
  it('403s a claim for the reserved demo tenant — it is not a real tenant', () => {
    const req = { query: {}, user: { tenantId: CENTRAL_DEMO_TENANT_ID } } as unknown as Request;
    const res = fakeRes();
    expect(resolveCentralTenantId(req, res)).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: 'reserved_tenant' });
  });

  it('403s a padded claim for the reserved demo tenant (trim happens first)', () => {
    const req = {
      query: {},
      user: { tenantId: `  ${CENTRAL_DEMO_TENANT_ID}  ` },
    } as unknown as Request;
    const res = fakeRes();
    expect(resolveCentralTenantId(req, res)).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('no tenant-aware central router reads a tenantId off the request (the rejection has no bypass)', () => {
    // The 403 above only protects callers that go THROUGH these helpers. A
    // handler reading req.user.tenantId itself would accept a demo-tenant claim
    // again, silently. All four routers currently route every one of their
    // tenant-resolution sites through resolveCentralTenantId /
    // resolveCentralActor; this keeps it that way.
    const routers = [
      'src/routes/financeCentral.ts',
      'src/routes/workflowCentral.ts',
      'src/routes/payment-central/invoices.router.ts',
      'src/routes/supplierCentral.ts',
    ];
    const repoRoot = path.join(__dirname, '../../../..');
    const findings = routers.flatMap((rel) =>
      findRequestTenantReads(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), rel),
    );
    expect(findings).toEqual([]);
  });

  it('still resolves the demo tenant for an attested ANONYMOUS read (no claim presented)', () => {
    // The rejection above must not close the gate-attested demo path, which
    // carries no credential at all.
    const res = fakeRes();
    expect(resolveCentralTenantId(attestedReq(), res)).toBe(CENTRAL_DEMO_TENANT_ID);
    expect(res.statusCode).toBeUndefined();
  });
});

// The guard above is only worth its assertion if the checker itself has teeth,
// so the checker is tested directly against the spellings a bypass could use.
describe('findRequestTenantReads (the no-bypass guard\'s own detector)', () => {
  const flagged: Array<[string, string]> = [
    ['plain property access', 'export function h(req: any) { return req.user.tenantId; }'],
    ['optional chaining', 'export function h(req: any) { return req.user?.tenantId; }'],
    ['non-null assertion', 'export function h(req: any) { return req.user!.tenantId; }'],
    ['bracket access', "export function h(req: any) { return req.user['tenantId']; }"],
    ['cast', 'export function h(req: any) { return (req.user as any).tenantId; }'],
    ['cast on the request', 'export function h(req: any) { return (req as any).user.tenantId; }'],
    ['destructured tenantId', 'export function h(req: any) { const { tenantId } = req.user; return tenantId; }'],
    ['aliased destructure', 'export function h(req: any) { const { user: authUser } = req; return authUser.tenantId; }'],
    ['alias of an alias', 'export function h(req: any) { const { user } = req; const u2 = user; return u2.tenantId; }'],
    ['whole-request alias', 'export function h(req: any) { const r = req; return r.user.tenantId; }'],
    ['tenantContext bridge', 'export function h(req: any) { return req.tenantContext.tenantId; }'],
    [
      'nested destructuring',
      'export function h(req: any) { const { user: { tenantId } } = req; return tenantId; }',
    ],
    [
      'nested destructuring with an alias',
      'export function h(req: any) { const { user: { tenantId: t } } = req; return t; }',
    ],
    [
      'two levels of nesting',
      'export function h(req: any) { const { auth: { user: { tenantId } } } = req; return tenantId; }',
    ],
    [
      'computed string key',
      "export function h(req: any) { const { ['tenantId']: t } = req.user; return t; }",
    ],
    [
      'spread then read',
      'export function h(req: any) { const { ...rest } = req.user; return rest.tenantId; }',
    ],
    [
      'same-file helper taking req',
      'function pick(req: any) { return req.user.tenantId; } export const h = pick;',
    ],
    [
      'object nested under an array pattern',
      'export function h(req: any) { const { auth: [{ user: u }] } = req; return u.tenantId; }',
    ],
    [
      'root array pattern',
      'export function h(req: any) { const [{ user: { tenantId } }] = req; return tenantId; }',
    ],
    [
      'array hole then a rooted binding',
      'export function h(req: any) { const [, { user: u }] = req; return u.tenantId; }',
    ],
  ];

  it.each(flagged)('flags a bypass via %s', (_label, src) => {
    expect(findRequestTenantReads(src, 'synthetic.ts')).not.toEqual([]);
  });

  const clean: Array<[string, string]> = [
    [
      'the sanctioned helper call',
      'export function h(req: any, res: any) { const tenantId = resolveCentralTenantId(req, res); return tenantId; }',
    ],
    [
      'a string literal that merely contains the pattern',
      'export const doc = "read req.user.tenantId only via the helper";',
    ],
    ['a comment mentioning it', 'export const x = 1; // never read req.user.tenantId here'],
    [
      'a URL string before an unrelated statement (regex stripping would truncate here)',
      'export function h() { const u = "https://example.test/x"; return u.length; }',
    ],
    ['tenantId off an unrelated object', 'export function h(row: any) { return row.tenantId; }'],
  ];

  it.each(clean)('does not flag %s', (_label, src) => {
    expect(findRequestTenantReads(src, 'synthetic.ts')).toEqual([]);
  });

  it('conservatively flags a shadowed local that reuses a request-alias name', () => {
    // DELIBERATE, and pinned so it is not mistaken for a bug: names are tracked
    // textually, not by lexical symbol, so an inner `const u = {...}` that
    // shadows an outer request alias is still reported.
    //
    // The bias is intentional for a security guard — this direction of error is
    // a LOUD failing test on a legitimate edit (the dev renames the local, or
    // discovers they really were reading the request), whereas scope-accurate
    // tracking that silently misses a real bypass is the failure that ships.
    // Making it exact needs full symbol resolution (a ts.Program, not a
    // SourceFile) — disproportionate here given the primary defense is that
    // the helpers are the only sanctioned tenant source.
    const shadowed =
      "export function h(req: any) { const { user: u } = req; { const u = { tenantId: 'local' }; return u.tenantId; } }";
    expect(findRequestTenantReads(shadowed, 'synthetic.ts')).not.toEqual([]);
  });
});

describe('resolveCentralActor (F5b)', () => {
  it('returns tenant and user from the verified claim', () => {
    const req = { query: {}, user: { tenantId: 'tenant-a', id: 'user-1' } } as unknown as Request;
    expect(resolveCentralActor(req, fakeRes())).toEqual({ tenantId: 'tenant-a', userId: 'user-1' });
  });

  it('accepts a numeric user id (global Express.User.id is number | string)', () => {
    const req = { query: {}, user: { tenantId: 'tenant-a', id: 42 } } as unknown as Request;
    expect(resolveCentralActor(req, fakeRes())).toEqual({ tenantId: 'tenant-a', userId: '42' });
  });

  it('falls back to sub when id is absent', () => {
    const req = { query: {}, user: { tenantId: 'tenant-a', sub: 'subject-9' } } as unknown as Request;
    expect(resolveCentralActor(req, fakeRes())).toEqual({ tenantId: 'tenant-a', userId: 'subject-9' });
  });

  it('401s a gate-attested anonymous request — writes have no actor', () => {
    const res = fakeRes();
    expect(resolveCentralActor(attestedReq(), res)).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'identity_required' });
  });

  it('401s an authenticated request with a tenant but no usable user id', () => {
    const req = { query: {}, user: { tenantId: 'tenant-a' } } as unknown as Request;
    expect(resolveCentralActor(req, fakeRes())).toBeNull();
  });

  it('403s a WRITE actor claiming the reserved demo tenant', () => {
    // The write path matters more than the read path here: demo-tenant rows are
    // what anonymous visitors render.
    const req = {
      query: {},
      user: { tenantId: CENTRAL_DEMO_TENANT_ID, id: 'user-1' },
    } as unknown as Request;
    const res = fakeRes();
    expect(resolveCentralActor(req, res)).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual({ error: 'reserved_tenant' });
  });

  it('ignores any body-supplied actor (no spoofing surface)', () => {
    const req = {
      query: {},
      user: { tenantId: 'tenant-a', id: 'user-1' },
      body: { startedBy: 'attacker', cancelledBy: 'attacker' },
    } as unknown as Request;
    expect(resolveCentralActor(req, fakeRes())?.userId).toBe('user-1');
  });
});
