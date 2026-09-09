// PR 13c-2 Task 3 — encrypt args before they touch
// `governance_approvals.write_descriptor`.
//
// `WriteDescriptor.args` is the raw connector mutation payload (contact
// email, address, etc. — PII). The operator approvals API returns
// `PersistedApproval` rows verbatim, so persisting plaintext args leaks PII
// into the operator surface. PR 13b avoided this by fail-closing the
// queue path via `QueueForHumanNotYetSafeError`. PR 13c-2 lifts the
// fail-closed by wrapping args in AES-256-GCM via the existing global
// `EncryptionService` (same key + AAD as AI-provider API keys).
//
// Storage shape — single nullable `write_descriptor` TEXT column:
//
//   {
//     "version": 1,
//     "targetSystemId": "hubspot",
//     "operation": "create",
//     "entityType": "Contact",
//     "ownership": { ... },                       // plaintext (manifest vocabulary, queryable)
//     "integrationConfigId": "cfg-uuid",          // optional, plaintext (UUID, not PII)
//     "argsEncrypted": { encryptedText, iv, authTag, algorithm }
//   }
//
// Integrity binding (Copilot R3 on PR #853): AES-256-GCM authenticates only
// the ciphertext + AAD; the plaintext metadata fields (targetSystemId,
// operation, entityType, ownership, integrationConfigId) are persisted
// outside the encrypted envelope and would not be detected by
// EncryptionService.decrypt() if a DB-tier attacker mutated them — and the
// resume handler would dispatch using the tampered metadata.
//
// To bind plaintext metadata to the encrypted blob, the cleartext that goes
// INTO encryption is `{args, metadataDigest}` where `metadataDigest` is the
// SHA-256 of a canonical-JSON serialization of every plaintext metadata
// field (version, targetSystemId, operation, entityType, ownership,
// integrationConfigId). On decrypt we recompute the digest from the
// PERSISTED plaintext metadata and compare against the digest INSIDE the
// AES-GCM-authenticated cleartext. Any mismatch surfaces as
// `metadata_tampered`, fail-closed. This catches tamper without requiring
// a per-call AAD parameter on EncryptionService (which is shared with the
// AI-provider API-key encryption path; broadening that signature has
// blast radius outside this PR's scope).
//
// `version: 1` is forward-compat — if/when per-tenant envelope encryption
// ships (separate hardening lift, currently out of scope per PR 13c plan),
// readers can branch on version: 2.
//
// Trust model: identical blast radius to existing AI-provider API-key
// encryption. Compromising `AI_CONFIG_ENCRYPTION_KEY` exposes queued
// descriptors AND queued connector credentials — same envelope, same key.

import { createHash } from 'crypto';
import type { EncryptionService, EncryptedData } from '../security/EncryptionService';
import type { WriteDescriptor, WriteOperation } from '../../governance/sourceOfTruth/guardedWrite';

const CURRENT_VERSION = 1 as const;

/**
 * Concrete shape persisted into `governance_approvals.write_descriptor`.
 * Manifest vocabulary fields stay plaintext so the operator approval UI can
 * filter by `targetSystem`, `operation`, etc. Only `args` is encrypted.
 */
export interface EncryptedWriteDescriptorPayload {
  version: 1;
  targetSystemId: string;
  operation: WriteOperation;
  entityType: string;
  ownership: WriteDescriptor['ownership'];
  integrationConfigId?: string;
  argsEncrypted: EncryptedData;
}

/** Single typed error class — callers `instanceof`-discriminate from other failures.
 *
 * Code semantics:
 *   - `serialize_failed`: `JSON.stringify` on the caller-supplied
 *     `WriteDescriptor.args` threw (circular reference, BigInt, etc.). Surfaces
 *     a caller-side input bug — distinct from `encrypt_failed` so operators can
 *     route the alert correctly (Copilot R0 on PR #853).
 *   - `encrypt_failed`: `EncryptionService.encrypt()` itself threw — key
 *     misconfiguration or cipher-level failure, NOT a caller input issue.
 *   - `unknown_version`: persisted payload's `version` field is not 1.
 *   - `shape_invalid`: persisted payload's structural shape is wrong (missing
 *     fields, wrong types).
 *   - `decrypt_failed`: `EncryptionService.decrypt()` threw OR the recovered
 *     plaintext is not valid JSON — both flag a tampered ciphertext or
 *     key-mismatched row.
 *   - `metadata_tampered`: the digest recomputed from the persisted plaintext
 *     metadata (version, targetSystemId, operation, entityType, ownership,
 *     integrationConfigId) does not match the digest embedded inside the
 *     AES-GCM-authenticated cleartext. A DB-tier attacker mutated a plaintext
 *     field after encryption; refuse to dispatch. Copilot R3 on PR #853.
 */
export class WriteDescriptorEncryptionError extends Error {
  readonly code:
    | 'unknown_version'
    | 'shape_invalid'
    | 'decrypt_failed'
    | 'encrypt_failed'
    | 'serialize_failed'
    | 'metadata_tampered';
  constructor(code: WriteDescriptorEncryptionError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'WriteDescriptorEncryptionError';
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Canonical JSON of the plaintext metadata fields, then SHA-256.
 *
 * Canonicalization rules:
 *   - Field order is FIXED by the manual object-literal construction below
 *     (NOT `JSON.stringify(obj)` on a shared object — V8's object-key-order
 *     guarantees apply only to non-numeric string keys, and we don't want
 *     to depend on engine-specific behavior here).
 *   - `integrationConfigId` is OMITTED entirely when undefined (vs. present
 *     with `null`) — present-but-undefined and absent-entirely must hash
 *     identically so the encrypt/decrypt round-trip is stable.
 *   - `ownership` is hashed as JSON.stringify of an object built with the
 *     same canonical key order.
 */
function metadataDigest(input: {
  version: number;
  targetSystemId: string;
  operation: WriteOperation;
  entityType: string;
  ownership: WriteDescriptor['ownership'];
  integrationConfigId?: string;
}): string {
  const canonicalOwnership = {
    entity: input.ownership.entity,
    declaredOwner: input.ownership.declaredOwner,
    callerSystem: input.ownership.callerSystem,
    targetSystem: input.ownership.targetSystem,
  };
  const parts: [string, unknown][] = [
    ['version', input.version],
    ['targetSystemId', input.targetSystemId],
    ['operation', input.operation],
    ['entityType', input.entityType],
    ['ownership', canonicalOwnership],
  ];
  if (input.integrationConfigId !== undefined) {
    parts.push(['integrationConfigId', input.integrationConfigId]);
  }
  const canonical = JSON.stringify(parts);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function encryptDescriptor(
  d: WriteDescriptor,
  enc: EncryptionService,
): Promise<EncryptedWriteDescriptorPayload> {
  // Bind plaintext metadata to the ciphertext (Copilot R3 on PR #853): the
  // encrypted cleartext is `{args, metadataDigest}` where metadataDigest is
  // the SHA-256 of canonical-JSON of every plaintext metadata field that
  // will be persisted at the top level. Any DB-tier mutation of those
  // plaintext fields will fail to match the digest on decrypt.
  const digest = metadataDigest({
    version: CURRENT_VERSION,
    targetSystemId: d.targetSystemId,
    operation: d.operation,
    entityType: d.entityType,
    ownership: d.ownership,
    integrationConfigId: d.integrationConfigId,
  });

  // Stringify OUTSIDE the encryption try/catch so non-serializable args
  // (circular refs, BigInt, functions, symbols at any depth) surface as
  // `serialize_failed` rather than being misreported as an EncryptionService
  // failure. Copilot R0 on PR #853.
  //
  // Copilot R7 on PR #853: a plain `JSON.stringify` would silently DROP
  // nested non-JSON values — `{a: () => {}}` becomes `{}` while still
  // retaining the top-level `"args"` key. The post-hoc check below only
  // catches the top-level case. Use a replacer that throws on any function
  // / symbol / BigInt at any depth so the failure surfaces here as
  // `serialize_failed` rather than persisting a silently-lossy payload.
  //
  // Copilot R8 on PR #853: `undefined` semantics are NOT symmetric across
  // positions. In an object property, `JSON.stringify` drops the key
  // (`{a:undefined}` → `{}`) which preserves the round-trip invariant for
  // absent values. In an array element, it silently converts to `null`
  // (`[undefined]` → `[null]`), corrupting the resumed write. Fail-close
  // when undefined appears in an array position; permit it for object
  // properties and the top-level args slot. The replacer is a regular
  // function (not an arrow) so the parent context arrives via `this`.
  function reject(this: unknown, key: string, value: unknown): unknown {
    if (value === undefined) {
      if (Array.isArray(this)) {
        throw new TypeError(
          `non-JSON value 'undefined' at array index '${key}' — JSON.stringify silently converts to null, refusing to persist a lossy descriptor`,
        );
      }
      return value;
    }
    const t = typeof value;
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      throw new TypeError(
        `non-JSON value of type ${t} at JSON path key='${key}' — JSON.stringify would silently drop it, refusing to persist a lossy descriptor`,
      );
    }
    return value;
  }
  let plaintext: string;
  try {
    plaintext = JSON.stringify({ args: d.args, metadataDigest: digest }, reject);
  } catch (cause) {
    throw new WriteDescriptorEncryptionError(
      'serialize_failed',
      'encryptDescriptor: JSON.stringify({args, metadataDigest}) failed — args contains a non-JSON-serializable value (circular ref, BigInt, function, symbol at any depth, or undefined in an array position)',
      cause,
    );
  }
  // Defense in depth: the replacer above should have caught any top-level
  // function/symbol/BigInt as a thrown TypeError, but keep this post-hoc
  // check for the still-relevant edge case where a user-provided getter
  // returns an unrepresentable value silently. `args === undefined` is the
  // intentional "absent" case and JSON.stringify drops the key naturally —
  // round-trip-compatible with deserialization.
  if (d.args !== undefined && !plaintext.includes('"args"')) {
    throw new WriteDescriptorEncryptionError(
      'serialize_failed',
      'encryptDescriptor: JSON.stringify silently dropped d.args — args is a non-JSON value (function / symbol)',
    );
  }
  let argsEncrypted: EncryptedData;
  try {
    argsEncrypted = await enc.encrypt(plaintext);
  } catch (cause) {
    throw new WriteDescriptorEncryptionError(
      'encrypt_failed',
      'encryptDescriptor: EncryptionService.encrypt() failed',
      cause,
    );
  }

  const payload: EncryptedWriteDescriptorPayload = {
    version: CURRENT_VERSION,
    targetSystemId: d.targetSystemId,
    operation: d.operation,
    entityType: d.entityType,
    ownership: d.ownership,
    argsEncrypted,
  };
  if (d.integrationConfigId !== undefined) {
    payload.integrationConfigId = d.integrationConfigId;
  }
  return payload;
}

export async function decryptDescriptor(
  payload: unknown,
  enc: EncryptionService,
): Promise<WriteDescriptor> {
  if (!isPayloadShape(payload)) {
    throw new WriteDescriptorEncryptionError(
      'shape_invalid',
      'decryptDescriptor: payload does not match EncryptedWriteDescriptorPayload shape',
    );
  }
  if (payload.version !== CURRENT_VERSION) {
    throw new WriteDescriptorEncryptionError(
      'unknown_version',
      `decryptDescriptor: unknown version ${String(payload.version)} (expected ${CURRENT_VERSION})`,
    );
  }

  let plaintext: string;
  try {
    plaintext = await enc.decrypt(payload.argsEncrypted);
  } catch (cause) {
    throw new WriteDescriptorEncryptionError(
      'decrypt_failed',
      'decryptDescriptor: EncryptionService.decrypt() failed (key mismatch, tampered ciphertext, or shape error)',
      cause,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    throw new WriteDescriptorEncryptionError(
      'decrypt_failed',
      'decryptDescriptor: decrypted plaintext is not valid JSON',
      cause,
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new WriteDescriptorEncryptionError(
      'decrypt_failed',
      'decryptDescriptor: decrypted plaintext is not an object (expected {args, metadataDigest})',
    );
  }
  const parsedObj = parsed as Record<string, unknown>;
  if (typeof parsedObj.metadataDigest !== 'string') {
    throw new WriteDescriptorEncryptionError(
      'decrypt_failed',
      'decryptDescriptor: decrypted plaintext is missing metadataDigest — row was encrypted by a pre-PR-13c-2 producer or the cleartext was truncated',
    );
  }

  // Recompute the digest from the PERSISTED plaintext metadata and compare
  // against the digest bound INSIDE the AES-GCM-authenticated cleartext.
  // Mismatch → DB-tier tamper with the plaintext fields. Copilot R3 on PR #853.
  const expectedDigest = metadataDigest({
    version: payload.version,
    targetSystemId: payload.targetSystemId,
    operation: payload.operation,
    entityType: payload.entityType,
    ownership: payload.ownership,
    integrationConfigId: payload.integrationConfigId,
  });
  if (parsedObj.metadataDigest !== expectedDigest) {
    throw new WriteDescriptorEncryptionError(
      'metadata_tampered',
      'decryptDescriptor: metadata-digest mismatch — a plaintext field on the persisted EncryptedWriteDescriptorPayload was modified after encryption. Refusing to dispatch.',
    );
  }

  // `args` may be undefined when the original descriptor's args was
  // undefined — JSON.stringify drops undefined-valued properties, so
  // `parsedObj.args` will be absent. That's the symmetric round-trip
  // shape, not an error.
  const args: unknown = parsedObj.args;

  const result: WriteDescriptor = {
    targetSystemId: payload.targetSystemId,
    operation: payload.operation,
    entityType: payload.entityType,
    args,
    ownership: payload.ownership,
  };
  if (payload.integrationConfigId !== undefined) {
    result.integrationConfigId = payload.integrationConfigId;
  }
  return result;
}

function isPayloadShape(p: unknown): p is EncryptedWriteDescriptorPayload {
  if (p === null || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  if (
    typeof r.version !== 'number' ||
    typeof r.targetSystemId !== 'string' ||
    typeof r.operation !== 'string' ||
    typeof r.entityType !== 'string' ||
    typeof r.ownership !== 'object' || r.ownership === null ||
    typeof r.argsEncrypted !== 'object' || r.argsEncrypted === null
  ) {
    return false;
  }
  // Validate `argsEncrypted` matches the EncryptionService.EncryptedData
  // shape: `algorithm` is required by `EncryptionService.decrypt()` (it
  // explicitly throws `Unsupported encryption algorithm: <missing>` if
  // absent), so include it in the structural guard so the failure surfaces
  // as `shape_invalid` rather than the less actionable decrypt-side error.
  // Copilot R1 on PR #853.
  const enc = r.argsEncrypted as Record<string, unknown>;
  if (
    typeof enc.encryptedText !== 'string' ||
    typeof enc.iv !== 'string' ||
    typeof enc.authTag !== 'string' ||
    typeof enc.algorithm !== 'string'
  ) {
    return false;
  }
  // Validate `ownership` carries the four required SourceSystem/CallerSystem
  // string fields. The resume handler reads each verbatim into the audit
  // row, so a malformed ownership block would otherwise persist
  // `undefined`-valued audit data. Same Copilot R1 cluster.
  const own = r.ownership as Record<string, unknown>;
  if (
    typeof own.entity !== 'string' ||
    typeof own.declaredOwner !== 'string' ||
    typeof own.callerSystem !== 'string' ||
    typeof own.targetSystem !== 'string'
  ) {
    return false;
  }
  // Optional `integrationConfigId` — when present, must be a string.
  if (r.integrationConfigId !== undefined && typeof r.integrationConfigId !== 'string') {
    return false;
  }
  return true;
}
