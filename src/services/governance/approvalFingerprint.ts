import { createHmac } from 'node:crypto';

/**
 * Deterministic request fingerprint for pending ownership approvals (A8).
 *
 * Why this exists: `ApprovalQueueService.enqueue`'s ownership arm inserted a
 * fresh row per call, so a caller retried by an outage — or two replicas
 * handling the same governed write — produced N pending approvals for ONE
 * intent. An operator then had to approve or reject each of them, and
 * approving more than one re-dispatched the same mutation more than once.
 *
 * The fingerprint is what makes the enqueue idempotent: identical write intent
 * collapses onto the existing pending row, materially different intent does
 * not. It is an HMAC rather than a plain digest so an attacker who can guess a
 * write intent cannot precompute its fingerprint and probe for, or squat on,
 * an approval that is pending.
 *
 * THE INVARIANT, and the reason this file looks the way it does:
 *
 *     two intents share a fingerprint  IF AND ONLY IF  they persist identically
 *
 * The descriptor reaches storage through `JSON.stringify`, and the resume
 * handler re-dispatches whatever survives that round trip. So the only
 * defensible dedupe criterion is agreement with JSON — anything the round trip
 * erases is already erased from the write that will actually be replayed.
 *
 * An earlier version hand-rolled the traversal and tried to reproduce
 * `JSON.stringify`'s rules itself. Two rounds of adversarial review found
 * collisions in it, both from the same cause — the hand-rolled rules diverged
 * from the real ones. `Object.keys(new Date())` is empty, so every Date, Map
 * and Set canonicalized to `{}` and collided with each other and with a
 * literal `{}`. Fixing that by delegating to `toJSON` introduced a second
 * divergence: `JSON.stringify` applies the hook exactly ONCE per value and
 * then serializes the result structurally, whereas re-applying it recursively
 * made `{toJSON: () => d1}` and `{toJSON: () => d2}` collide for two Dates
 * carrying different own properties.
 *
 * Normalizing through JSON itself makes both classes unrepresentable rather
 * than merely fixed, so there is no second implementation of JSON's semantics
 * here to drift. Do not reintroduce one.
 *
 * This module imports nothing but `node:crypto` — deliberately, and for the
 * same reason `src/utils/tenantId.ts` does (A5): it is reachable from schema
 * and persistence code, and pulling the inversify container into that path
 * would make a pure value function transitively depend on the whole graph.
 * Keep it that way. In particular it must never read `process.env`; the key
 * arrives as bytes from the composition root.
 */

/** Raw byte length of the fingerprint key: 32 bytes, i.e. 64 hex characters. */
export const APPROVAL_FINGERPRINT_KEY_BYTES = 32;

/**
 * Fixed, content-free rejection text. A malformed key is still key material —
 * a near-miss value echoed into an error message or a log line is a leak, so
 * neither this message nor anything derived from it may quote the input.
 */
export const APPROVAL_FINGERPRINT_KEY_ERROR =
  'APPROVAL_FINGERPRINT_HMAC_KEY must be exactly 64 hexadecimal characters (32 bytes)';

/**
 * Fixed, content-free text for intent content that cannot be canonicalized:
 * a cycle, a BigInt, a `toJSON` hook that throws, or a root value JSON drops
 * entirely. The descriptor's `args` is the raw connector mutation payload and
 * is typically PII (decision 8), so the offending value must never reach the
 * message, and the throw site must not be a template that interpolates it.
 */
export const APPROVAL_FINGERPRINT_VALUE_ERROR =
  'approval fingerprint intent contains a value that cannot be canonicalized';

/**
 * Stack guard for the canonical walk. Set far above any realistic connector
 * payload: this exists so a pathological structure fails closed on the fixed
 * message rather than as a `RangeError` whose stack would name descriptor
 * keys, not to impose a business limit on nesting.
 */
const MAX_CANONICAL_DEPTH = 200;

/**
 * The canonical write intent. `descriptor` carries the full write descriptor
 * because the identifying fields alone are not sufficient: every create
 * arrives with the same placeholder `resourceId` (`'new'`), so keying on
 * (tenant, resource) would collapse unrelated creates into a single approval
 * and silently discard real work.
 *
 * The vocabulary fields are ALSO listed explicitly rather than being read back
 * out of `descriptor`. That way a later change to the descriptor's shape
 * cannot quietly drop a dimension out of the dedupe domain.
 */
export interface ApprovalWriteIntent {
  tenantId: string;
  operationType: string;
  resourceType: string;
  resourceId: string;
  callerSystem: string;
  targetSystem: string;
  entity: string;
  operation: string;
  descriptor: unknown;
}

/** What survives a JSON round trip — the only thing `canonicalJson` ever sees. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Stable serialization of an ALREADY JSON-normalized value.
 *
 * The single transformation applied here is recursive key sorting, so object
 * insertion order cannot change the digest. Array order is preserved because
 * it is meaningful in a connector payload, and JSON types are already
 * distinct, so `1`, `'1'`, `true`, `'true'`, `null` and `'null'` stay apart.
 *
 * Total by construction: the input came from `JSON.parse`, so there are no
 * cycles, no `undefined`, no functions, and no non-finite numbers to handle.
 * That is why this function has no try/catch — anything it throws is a bug in
 * this module and should surface as itself.
 */
function canonicalJson(value: JsonValue, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error(APPROVAL_FINGERPRINT_VALUE_ERROR);
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return JSON.stringify(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }

  const record = value as { [key: string]: JsonValue };
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue, depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/**
 * Decodes the configured key. Accepts upper or lower case hex and nothing
 * else — no trimming, because a key with surrounding whitespace is a
 * provisioning mistake that should be corrected rather than silently absorbed.
 *
 * Throws {@link APPROVAL_FINGERPRINT_KEY_ERROR}, which never quotes the input.
 */
export function parseApprovalFingerprintKey(raw: string | undefined | null): Buffer {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(APPROVAL_FINGERPRINT_KEY_ERROR);
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== APPROVAL_FINGERPRINT_KEY_BYTES) {
    throw new Error(APPROVAL_FINGERPRINT_KEY_ERROR);
  }
  return key;
}

/**
 * HMAC-SHA-256 over the canonical intent. Returns 64 lowercase hex characters.
 *
 * The return value is the only thing that leaves this function: the canonical
 * bytes are never logged, returned, or attached to an error, because they are
 * a faithful reconstruction of the descriptor — including its PII.
 */
export function computeApprovalFingerprint(intent: ApprovalWriteIntent, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== APPROVAL_FINGERPRINT_KEY_BYTES) {
    throw new Error(APPROVAL_FINGERPRINT_KEY_ERROR);
  }

  let normalized: JsonValue;
  try {
    // The ONLY place foreign code runs: `toJSON` hooks and property getters on
    // the descriptor. Their errors are payload-controlled — a getter can throw
    // a message containing the PII it was asked for — so they are contained
    // here and re-raised as the fixed text, deliberately without `cause`.
    //
    // Scoped as tightly as possible on purpose: `canonicalJson` below is
    // outside this catch, so a genuine programming error in this module stays
    // diagnosable instead of being masked as bad caller input.
    //
    // The containment covers errors THROWN during normalization; it is not a
    // sandbox. A hook that mutates globals (replacing `JSON.stringify`, say)
    // can still make later code fail in its own way — Codex demonstrated it.
    // That needs executable in-process input rather than attacker-controlled
    // JSON, which is outside this boundary, and the honest statement of the
    // guarantee is this narrower one rather than an absolute claim.
    // The root is an object literal built here, so JSON.stringify either
    // returns a string or throws — it cannot return undefined, and a guard for
    // that would be untestable dead code.
    normalized = JSON.parse(JSON.stringify({
      tenantId: intent.tenantId,
      operationType: intent.operationType,
      resourceType: intent.resourceType,
      resourceId: intent.resourceId,
      callerSystem: intent.callerSystem,
      targetSystem: intent.targetSystem,
      entity: intent.entity,
      operation: intent.operation,
      descriptor: intent.descriptor,
    })) as JsonValue;
  } catch {
    throw new Error(APPROVAL_FINGERPRINT_VALUE_ERROR);
  }

  return createHmac('sha256', key).update(canonicalJson(normalized, 0), 'utf8').digest('hex');
}
