import type { Request } from 'express';

/**
 * Operator override — bypasses the guardedWrite ownership block for authenticated
 * callers that hold the governance_override role and supply an explicit reason
 * header. The audit row carries the reason for forensic review.
 *
 * Wired into HubSpot routes in PR 13c-1 (Task 1). Other operator-driven routes
 * should adopt the same helper rather than re-implementing the role+header check.
 *
 * Silent-drop semantics: if either the role check OR the reason validation
 * fails, the function returns `undefined` and the caller passes no `override`
 * to guardedWrite — the default block fires (same 409 as a non-privileged
 * caller). This avoids a 4xx surface that would tell unauthorized callers the
 * override mechanism exists.
 */

export const GOVERNANCE_OVERRIDE_ROLE = 'governance_override';

export const OVERRIDE_REASON_HEADER = 'x-governance-override-reason';

const MAX_REASON_LENGTH = 500;

/**
 * Returns a valid override iff:
 *   1. req.user.roles includes 'governance_override', AND
 *   2. X-Governance-Override-Reason header is present, non-empty after trim,
 *      and ≤ 500 chars.
 *
 * Reads req.user via the augmented Express type from src/types/express.d.ts
 * (the single source of truth for req.user). No import of the private
 * AuthenticatedUser interface from authentication.ts.
 */
export function extractOperatorOverride(
  req: Request,
): { permitted: true; reason: string } | undefined {
  const roles = req.user?.roles ?? [];
  if (!roles.includes(GOVERNANCE_OVERRIDE_ROLE)) return undefined;

  const raw = req.header(OVERRIDE_REASON_HEADER);
  if (!raw) return undefined;
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) return undefined;

  return { permitted: true, reason };
}
