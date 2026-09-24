import { inject, injectable } from 'inversify';
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../database/DatabaseService';
import type {
  Database,
  EmbeddedRoleGrant,
  NewEmbeddedRoleGrant,
} from '../../database/types';
import type { Logger } from '../../utils/Logger';
import type { EncryptionService } from '../security/EncryptionService';
import { TYPES } from '../../inversify/types';

/**
 * Has this grant's expiry passed?
 *
 * Compares instants, never strings. SQLite stores an ISO string but Postgres
 * returns a Date, and `String(date)` is "Wed Sep 03 2026 ..." — lexically
 * greater than any ISO timestamp. A string comparison therefore reported every
 * expired grant on Postgres as still active, which is the direction that
 * silently keeps a revoked-by-time approver approving.
 *
 * An unparseable value counts as EXPIRED. A grant whose expiry cannot be read
 * is a grant nobody can vouch for, and treating it as live would make a
 * corrupt row more powerful than a well-formed one.
 *
 * Exported for direct testing: SQLite cannot bind a Date, so the Postgres row
 * shape cannot be produced through the repository's own test database, and
 * this predicate is where the security property actually lives.
 */
export function isExpired(expiresAt: Date | string | null, now: Date): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const at = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
  if (Number.isNaN(at)) return true;
  return at <= now.getTime();
}

/** The identity a grant is scoped to. All four parts must match — a grant is not portable. */
export interface GrantKey {
  tenantId: string;
  platform: string;
  platformAccountId: string;
  userId: string;
}

/**
 * Repository for `embedded_role_grants` — the only writer of privileged roles.
 *
 * Before this existed, the host-bootstrap request body was that writer: a body
 * carrying `["admin","approver"]` returned 200 and both governance predicates
 * answered true (measured 2026-09-03). A grant is issued by a Squire operator
 * out of band; a host cannot mint one for itself.
 *
 * Two behaviours are load-bearing and easy to get subtly wrong:
 *
 * `grant()` CLOSES the open row it replaces, in the same transaction as the
 * insert. The unique index is partial over `revoked_at IS NULL`, so an
 * expired-but-unrevoked row still occupies the slot — an insert-only renewal
 * would hit the constraint. Closing it explicitly also keeps the history
 * readable: the superseded row records which grant replaced it.
 *
 * Expiry and revocation are different things. The index only knows about
 * revocation, so every read path filters expiry itself. A row can be open to
 * the database and inactive to authorization at the same time, and that gap is
 * exactly where an expired approver would otherwise keep approving.
 */
@injectable()
export class EmbeddedRoleGrantRepository {
  private readonly db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) dbService: DatabaseService,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.EncryptionService) private readonly encryption: EncryptionService,
  ) {
    this.db = dbService.getDatabase();
  }

  /**
   * Issue a grant, superseding any open grant for the same key and role.
   *
   * Returns the plaintext secret alongside the row. This is the ONLY moment it
   * exists in the clear: it is never logged and never read back, because the
   * column holds ciphertext. The caller (the operator CLI) shows it once and
   * delivers it to the user out of band.
   */
  async grant(
    args: Omit<NewEmbeddedRoleGrant, 'id' | 'granted_at' | 'revoked_at' | 'revoked_by' | 'secret_enc'>,
  ): Promise<{ row: EmbeddedRoleGrant; secret: string }> {
    // 32 bytes base64url — 43 characters, no padding, URL- and header-safe so
    // the user can carry it without re-encoding.
    const secret = randomBytes(32).toString('base64url');
    const secretEnc = await this.encryption.encryptForStorage(secret);

    const row: NewEmbeddedRoleGrant = {
      ...args,
      id: `erg_${randomBytes(12).toString('hex')}`,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      revoked_by: null,
      secret_enc: secretEnc,
    };

    await this.db.transaction().execute(async (trx) => {
      // Close the row this one replaces FIRST. Same transaction as the insert:
      // a close that committed without its replacement would silently strip the
      // user's role.
      await trx
        .updateTable('embedded_role_grants')
        .set({ revoked_at: row.granted_at as string, revoked_by: `replaced:${row.id}` })
        .where('tenant_id', '=', args.tenant_id)
        .where('platform', '=', args.platform)
        .where('platform_account_id', '=', args.platform_account_id)
        .where('user_id', '=', args.user_id)
        .where('role', '=', args.role)
        .where('revoked_at', 'is', null)
        .execute();

      await trx.insertInto('embedded_role_grants').values(row).execute();
    });

    // No secret in the log line, and no secret_enc either — the ciphertext is
    // not sensitive on its own, but logging it invites someone to log the
    // plaintext beside it later.
    this.logger.info('embedded role granted', {
      tenantId: args.tenant_id,
      platform: args.platform,
      platformAccountId: args.platform_account_id,
      userId: args.user_id,
      role: args.role,
      source: args.source,
      grantId: row.id,
    });

    return { row: row as EmbeddedRoleGrant, secret };
  }

  /**
   * The grant if it is open AND unexpired, else null.
   *
   * Includes `secret_enc`, because the assertion path needs it to verify
   * possession. `now` is injectable so expiry can be tested without waiting.
   */
  async getActiveGrant(id: string, now: Date = new Date()): Promise<EmbeddedRoleGrant | null> {
    const grant = await this.db
      .selectFrom('embedded_role_grants')
      .selectAll()
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!grant) return null;
    if (isExpired(grant.expires_at, now)) return null;
    return grant;
  }

  /**
   * Close a grant. Returns false if it was already closed or never existed —
   * the caller can tell "revoked it" from "nothing to revoke" rather than
   * reporting success either way.
   */
  async revoke(id: string, revokedBy: string): Promise<boolean> {
    const result = await this.db
      .updateTable('embedded_role_grants')
      .set({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  /**
   * The roles active for one key, sorted so callers and tests see a stable
   * order. Expired-but-open rows are filtered in code rather than in SQL,
   * because the column is TEXT on SQLite and TIMESTAMPTZ on Postgres and a
   * comparison pushed into the database would mean something different on each.
   */
  async listActiveRoles(key: GrantKey, now: Date = new Date()): Promise<string[]> {
    const rows = await this.db
      .selectFrom('embedded_role_grants')
      .select(['role', 'expires_at'])
      .where('tenant_id', '=', key.tenantId)
      .where('platform', '=', key.platform)
      .where('platform_account_id', '=', key.platformAccountId)
      .where('user_id', '=', key.userId)
      .where('revoked_at', 'is', null)
      .execute();

    return rows
      .filter((r) => !isExpired(r.expires_at, now))
      .map((r) => r.role)
      .sort();
  }
}
