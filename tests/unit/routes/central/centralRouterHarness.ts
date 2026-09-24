import express from 'express';
import { DEMO_ANONYMOUS_ATTESTATION } from '../../../../src/middleware/aiProxyPolicyGate';

/**
 * Stand-in for createDemoFamilyPolicyGate's anonymous demo branch. Attests
 * ONLY safe methods: every F5b demo allowlist is GET/HEAD, so attesting a
 * POST here would test a state the real gate can never produce.
 *
 * DELIBERATELY BROADER THAN THE PRODUCTION ALLOWLISTS on the read side: it
 * attests any GET/HEAD, including paths the real gate would refuse (only
 * /dashboard-class reads are allowlisted in production). That is the point —
 * these are HANDLER-contract tests ("attested anonymous → system tenant" is
 * a property of the handler, whatever the path), while the real admission
 * surface is pinned separately by centralFamiliesPolicyGate.routes.test.ts
 * (non-allowlisted reads 401 even in a demo runtime, per family and per
 * retired path) and f5bFamiliesProductionWiring.routes.test.ts (real App
 * mounts). Do not read an attested test here as evidence a path is
 * anonymously reachable in production.
 */
export function attestReadsOnly(headerName = 'x-test-demo'): express.RequestHandler {
  return (req, _res, next) => {
    if (req.headers[headerName] === '1' && (req.method === 'GET' || req.method === 'HEAD')) {
      (req as unknown as Record<string, unknown>)[DEMO_ANONYMOUS_ATTESTATION] = true;
    }
    next();
  };
}
