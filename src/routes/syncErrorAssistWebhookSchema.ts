// src/routes/syncErrorAssistWebhookSchema.ts
import { z } from 'zod';
import type { WebhookPayload } from '../services/syncErrorAssist/types';
// R19-4 / Copilot-PR766 — Import the canonical system-identity sentinel from its allowlisted
// home. The CI gate `scripts/check-system-identity-isolation.mjs` enforces that the literal
// `"__system__"` string can only appear in `src/services/governance/identityContext.ts`;
// declaring `RESERVED_TENANT_SENTINEL = '__system__'` here would fail that gate. Importing
// `SYSTEM_IDENTITY` and referencing `SYSTEM_IDENTITY.tenantId` keeps the literal in one place
// and prevents future drift.
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

export const MAX_SOURCE_PAYLOAD_BYTES = 32 * 1024;   // gotcha #38 (UTF-8 byte length)
export const MAX_SOURCE_PAYLOAD_DEPTH = 6;           // gotcha #39

export const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;       // canonical (tenantIsolation.ts:61)
export const ERROR_RECORD_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

// R19-4 — Reserved tenant sentinel. `SYSTEM_IDENTITY.tenantId` is reserved by
// `identityContext.ts` for SYSTEM_IDENTITY (background workers, internal callers). Routes
// that go through `tenantIsolation` middleware reject this sentinel before reaching the
// handler, but the SuiteCentral webhook bypasses that middleware (HMAC auth, not
// session/JWT auth). Without an explicit guard here, a misprovisioned `tenant_configurations`
// row keyed by the sentinel would route an attacker-signed webhook into SYSTEM_IDENTITY's
// audit + cost-tracking bucket, confusing tenant isolation and inflating system metrics.
// Guard at BOTH the schema (rejects the body's `tenantId` field) and the route (rejects
// the `x-suitecentral-key-id` header before HMAC lookup, since the header would also be
// used to look up the system secret).
//
// Re-exported below for the route handler under the historical name `RESERVED_TENANT_SENTINEL`
// (kept for plan/spec readability — value is `SYSTEM_IDENTITY.tenantId`, NOT a fresh literal).
export const RESERVED_TENANT_SENTINEL = SYSTEM_IDENTITY.tenantId;

/**
 * R11-2 / gotcha #39 — iterative depth walk with early bound exit.
 *
 * Arrays + objects are depth-1 containers; primitives + null are depth-0.
 * Empty container is depth-1 (the container itself).
 *
 * R19-1 — Iterative (not recursive). A valid JSON body under the 256KB raw cap can contain
 * thousands of nested arrays/objects — `JSON.parse` accepts them, but a recursive `objectDepth`
 * would throw `RangeError: Maximum call stack size exceeded` BEFORE Zod's `.refine` can run,
 * surfacing the Zod refinement failure as an Express-level 500 instead of the canonical 400
 * `invalid_payload`. That contradicts the stated nested-object DoS defense and breaks the
 * spec §6 contract that schema rejection always returns 400. The iterative form short-circuits
 * once depth exceeds the cap, returning `MAX_SOURCE_PAYLOAD_DEPTH + 1` so the `.refine` still
 * rejects. The exact returned value above the cap is irrelevant — only the `<=` predicate
 * inside the refine consumes it.
 *
 * Uses an explicit `{ node, depth }` stack instead of structuredClone-based traversal because
 * (a) `JSON.parse` output is plain data (no cycles, no class instances), (b) per-frame
 * allocation cost is dominated by the cap-exit shortcut, and (c) `for...of` on `Object.values`
 * keeps the hot path identical to the recursive form's algorithmic complexity (O(n) nodes).
 */
export function objectDepth(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0;
  const cap = MAX_SOURCE_PAYLOAD_DEPTH;
  const stack: { node: unknown; depth: number }[] = [{ node: v, depth: 1 }];
  let maxSeen = 1;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxSeen) {
      maxSeen = depth;
      if (maxSeen > cap) return cap + 1;        // short-circuit: cap-exceeded answer is all the caller needs
    }
    if (node === null || typeof node !== 'object') continue;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return maxSeen;
}

/**
 * Typed `z.ZodType<WebhookPayload>` so that any future drift between the runtime schema and
 * the compile-time WebhookPayload interface (defined in services/syncErrorAssist/types.ts via
 * Task 2) is a compile error rather than a silent runtime/type mismatch.
 */
export const WebhookPayloadSchema: z.ZodType<WebhookPayload> = z.object({
  // R19-4 — Refine rejects the reserved `__system__` sentinel even though it matches the
  // regex's allowed charset. The sentinel is reserved for internal SYSTEM_IDENTITY use only;
  // any external-origin webhook claiming it must be rejected as `invalid_payload`.
  tenantId: z.string().regex(TENANT_ID_REGEX).refine(
    (v) => v !== RESERVED_TENANT_SENTINEL,
    { message: 'tenantId cannot be the reserved system sentinel' },
  ),
  errorRecordId: z.string().regex(ERROR_RECORD_ID_REGEX),
  lastModified: z.string().datetime(),
  errorType: z.string().min(1).max(64),
  errorMessage: z.string().max(8192),
  sourcePayload: z.record(z.string(), z.unknown()).optional()
    // R20-1 — `superRefine` runs depth-cap FIRST, then byte-cap. The iterative `objectDepth`
    // (R19-1) is RangeError-safe, but `JSON.stringify` is still recursive — it would throw on
    // a 5K-level nested payload BEFORE the chained `.refine()` could run the depth check,
    // re-introducing the exact RangeError class R19-1 closed. Using `superRefine` (single
    // refine with sequenced ctx.addIssue calls) lets depth short-circuit and skip stringify
    // for over-depth inputs. The byte-cap refine itself wraps `JSON.stringify` in try/catch
    // as a last-resort guard (e.g., circular reference somehow surviving JSON.parse — should
    // be impossible since JSON.parse never produces cycles, but the catch is cheap defense).
    .superRefine((v, ctx) => {
      if (v === undefined) return;
      if (objectDepth(v) > MAX_SOURCE_PAYLOAD_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sourcePayload exceeds depth ${MAX_SOURCE_PAYLOAD_DEPTH}`,
        });
        return;   // skip stringify — over-depth value would RangeError JSON.stringify
      }
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(v), 'utf8');
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sourcePayload not JSON-serializable',
        });
        return;
      }
      if (bytes > MAX_SOURCE_PAYLOAD_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sourcePayload exceeds 32KB serialized cap',
        });
      }
    }),
  attemptCount: z.number().int().nonnegative().optional(),
});
