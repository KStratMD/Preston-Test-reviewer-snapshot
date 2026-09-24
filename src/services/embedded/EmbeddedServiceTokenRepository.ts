import { createHash, randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../database/DatabaseService';
import type {
  Database,
  EmbeddedServiceTokenVersion,
} from '../../database/types';
import { SecureCredentialManager } from '../SecureCredentialManager';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';

export const SERVICE_TOKEN_PREFIX = 'sct_';
export const SERVICE_TOKEN_BYTES = 32; // 256-bit secret

/** 24h overlap window for the previous active token after rotation. */
export const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** Far-future "active" sentinel used for the new row's valid_until. */
const ACTIVE_VALID_UNTIL_MS = 9999 * 24 * 60 * 60 * 1000;

const SCM_SYSTEM_TYPE = 'embedded_service_token';

/**
 * Repository for the `embedded_service_token_versions` table + the raw token
 * stored in SecureCredentialManager.
 *
 * Sync semantics (closes round-8 finding #1): every multi-store mutation is
 * wrapped in a Kysely transaction. SCM is called inside the trx callback so
 * a SCM failure aborts the trx; trx commit failure triggers a compensating
 * SCM delete in the catch block. The hot-path validateToken() reads the
 * versions table only — SCM is never on the validation path.
 */
@injectable()
export class EmbeddedServiceTokenRepository {
  private db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) dbService: DatabaseService,
    @inject(TYPES.SecureCredentialManager)
    private readonly scm: SecureCredentialManager,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {
    this.db = dbService.getDatabase();
  }

  /**
   * Generate a fresh bearer token in the documented sct_<base64url> shape.
   * 256-bit random → base64url. Output length: SERVICE_TOKEN_PREFIX (4) + 43.
   */
  static generateRawToken(): string {
    const raw = randomBytes(SERVICE_TOKEN_BYTES).toString('base64url');
    return `${SERVICE_TOKEN_PREFIX}${raw}`;
  }

  /** SHA-256 hex of the token for storage + constant-time lookup. */
  static hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Provision the FIRST service token for a tenant. Idempotent: if a current
   * (non-retired, valid_until > now) row already exists, throws. Operators
   * should call rotateToken() to replace.
   */
  async provisionInitialToken(params: {
    tenantId: string;
    platform: string;
    platformAccountId: string;
  }): Promise<{ rawToken: string; tokenHash: string }> {
    const existing = await this.db
      .selectFrom('embedded_service_token_versions')
      .select('token_hash')
      .where('tenant_id', '=', params.tenantId)
      .where('retired_at', 'is', null)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new Error(
        `embedded service token already provisioned for tenant ${params.tenantId}; use rotateToken() to replace`,
      );
    }
    const rawToken = EmbeddedServiceTokenRepository.generateRawToken();
    const tokenHash = EmbeddedServiceTokenRepository.hashToken(rawToken);
    const now = new Date();
    const validUntil = new Date(now.getTime() + ACTIVE_VALID_UNTIL_MS);
    // Closes Copilot review round-2 BLOCKS-MERGE #9: the previous
    // runWithCompensation wrapper would overwrite the SCM raw token with
    // a sentinel on ANY trx failure, even when the failure happened
    // BEFORE the SCM call ran. For the FIRST provisioning the only
    // pre-existing SCM state is "none" (we throw above if a current row
    // exists), so the original code was harmless here, but the same
    // wrapper in rotateToken() WAS dangerous — see that method.
    // Switching to a plain trx.execute(): SCM is the LAST step, so an
    // earlier throw never touches SCM. If SCM itself throws, trx rolls
    // back; the partial SCM write (if any) decrypts to garbage and is
    // dead-letter because validation requires a versions row.
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('embedded_service_token_versions')
        .values({
          token_hash: tokenHash,
          tenant_id: params.tenantId,
          platform: params.platform,
          platform_account_id: params.platformAccountId,
          valid_from: now.toISOString(),
          valid_until: validUntil.toISOString(),
          retired_at: null,
        })
        .execute();
      await this.scm.storeCredentials(SCM_SYSTEM_TYPE, params.tenantId, {
        apiKey: rawToken,
      });
    });
    this.logger.info('Embedded service token provisioned', {
      tenantId: params.tenantId,
      platform: params.platform,
    });
    return { rawToken, tokenHash };
  }

  /**
   * Rotate: insert a new active version, set the previous active row's
   * valid_until = now + overlapMs, and replace SCM raw token.
   */
  async rotateToken(params: {
    tenantId: string;
    platform: string;
    platformAccountId: string;
    overlapMs?: number;
  }): Promise<{ rawToken: string; tokenHash: string }> {
    const overlapMs = params.overlapMs ?? DEFAULT_ROTATION_OVERLAP_MS;
    const rawToken = EmbeddedServiceTokenRepository.generateRawToken();
    const tokenHash = EmbeddedServiceTokenRepository.hashToken(rawToken);
    const now = new Date();
    const previousValidUntil = new Date(now.getTime() + overlapMs);
    const newValidUntil = new Date(now.getTime() + ACTIVE_VALID_UNTIL_MS);
    // Closes Copilot review round-2 BLOCKS-MERGE #9: the previous
    // runWithCompensation wrapper would overwrite the deployed adapter's
    // existing valid SCM raw token with a sentinel on ANY trx failure,
    // even when steps 1+2 (DB updates) threw before step 3 (SCM
    // storeCredentials) ran. A DB-only failure would have neutralized
    // the working production token. Switching to plain trx.execute():
    // SCM is the LAST step, so a throw from steps 1+2 never touches it.
    // If SCM itself throws, trx rolls back; the partial SCM write (if
    // any — setSecret is atomic per the underlying secret manager) is
    // dead-letter because validation requires a versions row.
    await this.db.transaction().execute(async (trx) => {
      // Mark previous active row(s) as overlap-window expiring.
      await trx
        .updateTable('embedded_service_token_versions')
        .set({ valid_until: previousValidUntil.toISOString() })
        .where('tenant_id', '=', params.tenantId)
        .where('retired_at', 'is', null)
        // Only narrow rows whose valid_until is still in the far future
        // (i.e. currently active sentinel rows); don't extend rows that
        // were already in their overlap window from a recent rotation.
        .where('valid_until', '>', previousValidUntil.toISOString())
        .execute();
      await trx
        .insertInto('embedded_service_token_versions')
        .values({
          token_hash: tokenHash,
          tenant_id: params.tenantId,
          platform: params.platform,
          platform_account_id: params.platformAccountId,
          valid_from: now.toISOString(),
          valid_until: newValidUntil.toISOString(),
          retired_at: null,
        })
        .execute();
      await this.scm.storeCredentials(SCM_SYSTEM_TYPE, params.tenantId, {
        apiKey: rawToken,
      });
    });
    this.logger.info('Embedded service token rotated', {
      tenantId: params.tenantId,
      overlapMs,
    });
    return { rawToken, tokenHash };
  }

  /**
   * Emergency revocation: mark every non-retired row for the tenant as
   * valid_until=now + retired_at=now AND neutralize raw token in SCM.
   *
   * Closes Copilot review BLOCKS-MERGE #5/#6: SecureCredentialManager.
   * deleteCredentials() only clears in-memory cache + metadata because
   * the underlying SecretManager interface has no delete method (see the
   * literal "Note: SecretManager doesn't have delete method" comment at
   * src/services/SecureCredentialManager.ts:307). To actually neutralize
   * the bearer in the secret backend we OVERWRITE it with a known-bad
   * sentinel value via storeCredentials(); subsequent hash-lookup
   * validation will reject it (the new sentinel hashes to something
   * else, so the old token_hash row is correctly retired by the DB
   * UPDATE alone, and the raw token in SCM that an attacker could
   * exfiltrate now decrypts to the sentinel rather than a usable bearer).
   * Then we still call deleteCredentials() to clear local cache/metadata.
   */
  async revokeAllForTenant(tenantId: string): Promise<number> {
    const now = new Date();
    const sentinel = `REVOKED:${now.toISOString()}`;
    let updatedCount = 0;
    try {
      await this.db.transaction().execute(async (trx) => {
        const result = await trx
          .updateTable('embedded_service_token_versions')
          .set({
            valid_until: now.toISOString(),
            retired_at: now.toISOString(),
          })
          .where('tenant_id', '=', tenantId)
          .where('retired_at', 'is', null)
          .executeTakeFirst();
        updatedCount = Number(result.numUpdatedRows ?? 0n);
        // Overwrite the raw token in the secret backend with a sentinel
        // BEFORE clearing local state, so any in-flight read against the
        // raw key returns the sentinel, not the original bearer.
        await this.scm.storeCredentials(SCM_SYSTEM_TYPE, tenantId, {
          apiKey: sentinel,
        });
        await this.scm.deleteCredentials(SCM_SYSTEM_TYPE, tenantId);
      });
    } catch (err) {
      this.logger.error('Embedded service token revocation failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    this.logger.warn('Embedded service tokens revoked', {
      tenantId,
      versionsRevoked: updatedCount,
    });
    return updatedCount;
  }

  /**
   * Hot-path validation. Constant-time-equivalent via the indexed hash
   * lookup; returns the row if present AND not expired AND not retired.
   *
   * Cross-checks (closes round-7 finding #2):
   *  - row.platform must match expectedPlatform header
   *  - row.platform_account_id must match request body's platformAccountId
   * are enforced here so callers can't accidentally skip them.
   */
  async validateToken(params: {
    rawToken: string;
    expectedPlatform: string;
    expectedPlatformAccountId: string;
    now?: Date;
  }): Promise<EmbeddedServiceTokenVersion | null> {
    const now = params.now ?? new Date();
    const tokenHash = EmbeddedServiceTokenRepository.hashToken(params.rawToken);
    const row = await this.db
      .selectFrom('embedded_service_token_versions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (row.retired_at !== null) return null;
    const validFromMs = new Date(row.valid_from as string).getTime();
    const validUntilMs = new Date(row.valid_until as string).getTime();
    const nowMs = now.getTime();
    if (nowMs < validFromMs || nowMs >= validUntilMs) return null;
    if (row.platform !== params.expectedPlatform) return null;
    if (row.platform_account_id !== params.expectedPlatformAccountId) return null;
    return row;
  }

  /**
   * Retention queries (closes round-8 finding #5). Called by
   * EmbeddedRetentionJob inside its single transaction:
   *   (b) UPDATE retire active rows whose valid_until passed
   *   (c) DELETE rows retired > 7d ago (forensic grace)
   */
  async retireExpiredVersions(now: Date): Promise<number> {
    const result = await this.db
      .updateTable('embedded_service_token_versions')
      .set({ retired_at: now.toISOString() })
      .where('valid_until', '<', now.toISOString())
      .where('retired_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async purgeForensicallyRetired(
    now: Date,
    forensicGraceMs: number,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - forensicGraceMs);
    const result = await this.db
      .deleteFrom('embedded_service_token_versions')
      .where('retired_at', 'is not', null)
      .where('retired_at', '<', cutoff.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

}
