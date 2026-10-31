import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../database/DatabaseService';
import type {
  Database,
  EmbeddedSession,
  NewEmbeddedSession,
} from '../../database/types';
import type { Logger } from '../../utils/Logger';
import { TYPES } from '../../inversify/types';

/**
 * Repository for the `embedded_sessions` table.
 *
 * Backs the host-bootstrap → guest context-fetch handshake plus the
 * sendBeacon teardown path. EmbeddedRetentionJob consumes `deleteExpired`.
 */
@injectable()
export class EmbeddedSessionRepository {
  private db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) dbService: DatabaseService,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {
    this.db = dbService.getDatabase();
  }

  async createSession(row: NewEmbeddedSession): Promise<void> {
    await this.db.insertInto('embedded_sessions').values(row).execute();
    this.logger.debug('Embedded session created', {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      platform: row.platform,
    });
  }

  async findSession(sessionId: string): Promise<EmbeddedSession | undefined> {
    return this.db
      .selectFrom('embedded_sessions')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
  }

  async deleteSession(sessionId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('embedded_sessions')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  /**
   * Update the bound csrf_token + expires_at on context.refresh. Returns true
   * iff the row existed AND the optional `whereLastRotationBefore` guard
   * matched (used to atomically enforce the MIN_ROTATION_INTERVAL_MS throttle
   * — closes Copilot review round-3 race condition: two concurrent refresh
   * requests could both pass the throttle check and both call rotateSession;
   * whichever lost the race would receive a csrfToken that was already
   * invalid in the DB. The atomic UPDATE guards against this — only ONE of
   * the two concurrent UPDATEs will match the WHERE clause, the other gets
   * 0 rows updated and returns false so the caller can return 429).
   */
  async rotateSession(
    sessionId: string,
    newCsrfToken: string,
    newExpiresAt: Date | string,
    whereLastRotationBefore?: Date,
  ): Promise<boolean> {
    let query = this.db
      .updateTable('embedded_sessions')
      .set({
        csrf_token: newCsrfToken,
        expires_at: newExpiresAt,
        last_rotation_at: new Date(),
      })
      .where('session_id', '=', sessionId);
    if (whereLastRotationBefore !== undefined) {
      // Match rows where last_rotation_at IS NULL (never rotated) OR is
      // older than the cutoff. Concurrent rotators all see the same prior
      // state; only one's UPDATE will write and the others see 0 affected.
      query = query.where((eb) =>
        eb.or([
          eb('last_rotation_at', 'is', null),
          eb('last_rotation_at', '<', whereLastRotationBefore.toISOString()),
        ]),
      );
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n) > 0;
  }

  /**
   * Delete sessions whose expires_at fell more than `graceMs` milliseconds
   * ago. Returns the row count for retention-job logging.
   */
  async deleteExpired(now: Date, graceMs: number): Promise<number> {
    const cutoff = new Date(now.getTime() - graceMs);
    const result = await this.db
      .deleteFrom('embedded_sessions')
      .where('expires_at', '<', cutoff.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }
}
