import { inject, injectable, optional } from 'inversify';
import { createHash, randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../DatabaseService';
import type { SecretManager } from '../../services/SecretManager';
import type { Logger } from '../../utils/Logger';

// KMS Tier-C — encrypted-row decryption is wired through SecretManager.
// Naming scheme: `tenant-config-<sha256(tenantId)[:16]>-<sha256(settingKey)[:16]>`
// — Azure Key Vault-safe (`[0-9a-zA-Z-]+`, 47 chars: `tenant-config-` (14) + 16-hex + `-` + 16-hex), AWS/HashiCorp/env compatible.
// PII-free in the *secret-manager backend* (no tenant IDs or setting keys
// in the secret name, so an Azure / AWS / Vault audit trail can't be used
// to enumerate tenants). Internal application-log entries on decrypt
// failure DO include `{ tenantId, settingKey }` — those are operator-
// debugging context and stay inside the application's own audit
// boundary, not exposed to the secret backend.
// Encrypted writes require SECRET_MANAGER_PROVIDER ∈ {aws, azure, hashicorp};
// `env` rejects `setSecret`. Tests inject a mock SecretManager.
function hashPart(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function buildSecretName(tenantId: string, settingKey: string): string {
  return `tenant-config-${hashPart(tenantId)}-${hashPart(settingKey)}`;
}

/**
 * Thrown by `getSecretString` when a secret-bearing setting is stored
 * with `is_encrypted=false`. A typed class — not a plain Error — so
 * callers can `instanceof`-discriminate the plaintext-misconfig case
 * from infra errors (DB outages, SecretManager throws, etc.) without
 * regex-matching the message string. Per
 * `feedback_copilot_typed_error_pressure` in operator memory: default
 * to typed error classes from the start so each HTTP-status path
 * (plaintext → 401, infra → 500) discriminates on type, not message.
 */
export class PlaintextSecretError extends Error {
  readonly tenantId: string;
  readonly settingKey: string;
  constructor(tenantId: string, settingKey: string) {
    super(
      `tenant_configurations.${settingKey} for tenant ${tenantId} must be stored with is_encrypted=true; the secret-bearing read path refuses to return plaintext values`,
    );
    this.name = 'PlaintextSecretError';
    this.tenantId = tenantId;
    this.settingKey = settingKey;
  }
}

@injectable()
export class TenantConfigurationRepository {
  constructor(
    @inject(TYPES.DatabaseService) private db: DatabaseService,
    @inject(TYPES.SecretManager) private secretManager: SecretManager,
    @optional() @inject(TYPES.Logger) private logger?: Logger,
  ) {}

  /** Strict — returns true only when resolved value === 'true'. Routes through
   *  getString so encrypted rows decrypt via SecretManager. */
  async getBoolean(tenantId: string, settingKey: string): Promise<boolean> {
    const value = await this.getString(tenantId, settingKey);
    return value === 'true';
  }

  /** Plaintext-only boolean read for callers that need fail-closed semantics
   *  to distinguish "absent / explicitly false" from "infra failure". The
   *  default `getString` path silently turns SecretManager failures (and
   *  deterministic-name mismatches) on encrypted rows into `null`, which
   *  `getBoolean` then collapses to `false`. For a feature gate that opens
   *  policy access, that collapse would translate an infra outage into a
   *  silent policy denial. This method rejects encrypted rows so callers
   *  can store the gate as plaintext (boolean feature toggles have no
   *  legitimate need to be encrypted) and trust that any non-false return
   *  is the real value.
   *
   *  Throws on encrypted rows. Lets DB infra errors propagate unchanged.
   *  Missing row → false (absent setting = deny).
   *  Plaintext row → `setting_value === 'true'`. */
  async getBooleanStrict(tenantId: string, settingKey: string): Promise<boolean> {
    const row = await this.db.getDatabase()
      .selectFrom('tenant_configurations')
      .select(['setting_value', 'is_encrypted'])
      .where('tenant_id', '=', tenantId)
      .where('setting_key', '=', settingKey)
      .executeTakeFirst();
    if (!row) return false;
    if (row.is_encrypted) {
      throw new Error(
        `tenant_configurations.${settingKey} for tenant ${tenantId} must be stored as plaintext for the strict-read path; encrypted rows would collapse SecretManager outages into false/deny per the standard getString contract`,
      );
    }
    return row.setting_value === 'true';
  }

  /** Returns parsed integer or null on missing/non-numeric. Routes through
   *  getString so encrypted rows decrypt via SecretManager. */
  async getInt(tenantId: string, settingKey: string): Promise<number | null> {
    const value = await this.getString(tenantId, settingKey);
    if (value === null) return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) return null;
    return parsed;
  }

  /** Returns setting_value, decrypting via SecretManager when is_encrypted=true.
   *  Fail-closed: missing row → null; SecretManager throws → null + error log
   *  (preserves the null-on-no-secret contract; never returns the secret reference). */
  async getString(tenantId: string, settingKey: string): Promise<string | null> {
    const row = await this.db.getDatabase()
      .selectFrom('tenant_configurations')
      .select(['setting_value', 'is_encrypted'])
      .where('tenant_id', '=', tenantId)
      .where('setting_key', '=', settingKey)
      .executeTakeFirst();
    if (!row) return null;
    return this.resolveStringForRow(tenantId, settingKey, row);
  }

  /** Encrypted-only string read for secret-bearing settings (HMAC signing
   *  secrets, API keys, OAuth tokens, etc.). The string-side analog of
   *  `getBooleanStrict`: callers that store known-sensitive values must
   *  persist them with `is_encrypted=true` so the at-rest posture matches
   *  the threat model. A row stored plaintext throws — surfacing the
   *  misconfiguration loudly rather than returning a cleartext secret to
   *  the caller.
   *
   *  Missing row → null (legitimate "not configured yet" case).
   *  Plaintext row → throws.
   *  Encrypted row → resolves through `resolveStringForRow` so the
   *    name-mismatch guard, SecretManager-throws-returns-null, and
   *    anti-exfiltration semantics match `getString` for the encrypted
   *    branch.
   *
   *  SecretManager MUST NOT be consulted on the plaintext-throw path —
   *  symmetric to `getBooleanStrict`'s "do not consult SecretManager"
   *  invariant. The throw tells the caller "this row's at-rest posture
   *  is wrong"; a successful backend lookup on a misconfigured row
   *  would mask the misconfiguration. */
  async getSecretString(tenantId: string, settingKey: string): Promise<string | null> {
    const row = await this.db.getDatabase()
      .selectFrom('tenant_configurations')
      .select(['setting_value', 'is_encrypted'])
      .where('tenant_id', '=', tenantId)
      .where('setting_key', '=', settingKey)
      .executeTakeFirst();
    if (!row) return null;
    if (!row.is_encrypted) {
      throw new PlaintextSecretError(tenantId, settingKey);
    }
    return this.resolveStringForRow(tenantId, settingKey, row);
  }

  /** Resolve a tenant_configurations row's `setting_value`, decrypting via
   *  SecretManager when is_encrypted=true. Same fail-closed and anti-
   *  exfiltration semantics as `getString` (mismatch between stored value
   *  and the deterministic name → null + error log; SecretManager throws →
   *  null + error log).
   *
   *  Callers that already have the row data (e.g. from a batched discovery
   *  query in the scheduler) can use this to avoid the redundant per-row
   *  DB read that `getString()` would perform. Codex R7.1 + Copilot R8.1
   *  motivated this split — the scheduler's per-encrypted-tenant cost was
   *  previously (1 outer query + 1 getString re-query + 1 SecretManager
   *  call); the helper drops the middle re-query.
   */
  async resolveStringForRow(
    tenantId: string,
    settingKey: string,
    row: { setting_value: string; is_encrypted: boolean },
  ): Promise<string | null> {
    if (row.is_encrypted) {
      // Never trust the DB-stored `setting_value` as the secret-manager
      // lookup name — a corrupted or tampered row could redirect the lookup
      // to an attacker-chosen secret (and SecretManager's env-provider
      // fallback could turn that into env-var exfiltration). Recompute
      // the deterministic name from (tenantId, settingKey) and use THAT
      // for the lookup. Mismatch between stored and computed is a row-
      // integrity signal — log + return null without consulting the
      // backend.
      const expectedName = buildSecretName(tenantId, settingKey);
      if (row.setting_value !== expectedName) {
        // Log only a non-reversible digest of the actual value, never the
        // raw bytes. Codex P1 reproducer: a corrupted/legacy row could
        // contain raw secret material (e.g. an un-migrated plaintext
        // bearer), and emitting `actualSettingValue: row.setting_value`
        // verbatim would leak that secret into the structured log.
        // sha256[:16] gives the operator enough signal to compare two
        // mismatches without exposing the underlying string.
        // Logger.error signature is (message, error?, metadata). Metadata
        // is the THIRD arg; the second arg is reserved for an Error
        // instance (attached to context.error if instanceof Error, else
        // dropped). Passing structured metadata as the 2nd arg would
        // silently lose it in production. No Error available on this
        // mismatch path → pass `undefined`. (Copilot R10 — affected
        // every logger.error call in this file.)
        this.logger?.error(
          'tenant_configurations row setting_value mismatches deterministic secret name (possible row corruption or tampering)',
          undefined,
          {
            tenantId,
            settingKey,
            expectedSecretName: expectedName,
            actualValueDigestSha256: hashPart(row.setting_value),
            actualValueLength: row.setting_value.length,
          },
        );
        return null;
      }
      try {
        const secret = await this.secretManager.getSecret(expectedName);
        return secret.value;
      } catch (err) {
        // Decrypt-failure path: pass the caught error as the 2nd arg so
        // Logger.error attaches the stack to context.error; structured
        // metadata goes in the 3rd arg.
        this.logger?.error(
          'failed to decrypt tenant_configurations row via SecretManager',
          err,
          { tenantId, settingKey },
        );
        return null;
      }
    }
    return row.setting_value;
  }

  /** Boolean coercion variant of `resolveStringForRow` — same semantics as
   *  `getBoolean()` (only `'true'` counts as true) but accepts a pre-fetched
   *  row so the caller avoids an extra DB query. */
  async resolveBooleanForRow(
    tenantId: string,
    settingKey: string,
    row: { setting_value: string; is_encrypted: boolean },
  ): Promise<boolean> {
    const value = await this.resolveStringForRow(tenantId, settingKey, row);
    return value === 'true';
  }

  /** Writes a tenant configuration row. When isEncrypted=true, the plaintext is
   *  stored in SecretManager under a deterministic name (built from hashed
   *  tenantId+settingKey); only the name is persisted in setting_value.
   *  SecretManager.setSecret runs first; if it throws, no DB row is written.
   *  Tradeoff: a successful setSecret followed by a DB failure leaves an orphan
   *  secret in the backend — acceptable for Tier-C scope (orphan-sweep is a
   *  future follow-up). */
  async upsert(
    tenantId: string,
    settingKey: string,
    settingValue: string,
    options?: { isEncrypted?: boolean },
  ): Promise<void> {
    // Pass real boolean/Date values; matches DemoModeService/UserSettingsService.
    // DatabaseService.ts:108-113 adapts boolean→0/1 and Date→ISO at the SQLite driver
    // layer; Postgres accepts native types directly.
    const now = new Date();
    const isEncrypted = options?.isEncrypted ?? false;

    let valueToStore = settingValue;
    if (isEncrypted) {
      const secretName = buildSecretName(tenantId, settingKey);
      await this.secretManager.setSecret(secretName, settingValue);
      valueToStore = secretName;
    }

    await this.db.getDatabase()
      .insertInto('tenant_configurations')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        setting_key: settingKey,
        setting_value: valueToStore,
        is_encrypted: isEncrypted,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'setting_key']).doUpdateSet({
        setting_value: valueToStore,
        is_encrypted: isEncrypted,
        updated_at: now,
      }))
      .execute();
  }
}
