import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import type { Logger } from '../../utils/Logger';
import { TYPES } from '../../inversify/types';

/**
 * The replay ledger for user assertions.
 *
 * This is a table of its own rather than a column on `embedded_sessions`
 * because the guest teardown deletes the session row on `pagehide`
 * (`src/routes/embedded/sessionTeardownRouter.ts`). A nonce stored on the
 * session would vanish with it, and the same assertion could be replayed for
 * the rest of the ±300 s skew window. A replay ledger that dies with the
 * session is not a replay ledger.
 *
 * `consume` is INSERT-FIRST on purpose. The primary key is what decides
 * uniqueness, so two concurrent bootstraps presenting the same nonce cannot
 * both succeed — the loser gets a constraint violation rather than losing a
 * check-then-insert race. Nothing here reads before writing.
 */
@injectable()
export class UserAssertionNonceRepository {
  private readonly db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) dbService: DatabaseService,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {
    this.db = dbService.getDatabase();
  }

  /**
   * Spend a nonce. Returns true if it was fresh, false if it had already been
   * used — which the caller must treat as a replay.
   *
   * Only a uniqueness violation returns false. Any other database failure is
   * rethrown, because "the ledger is broken" and "this nonce is spent" are
   * different facts and collapsing them would let a failing database quietly
   * turn into a permissive one.
   */
  async consume(nonce: string, grantId: string, now: Date = new Date()): Promise<boolean> {
    try {
      await this.db
        .insertInto('embedded_user_assertion_nonces')
        .values({ nonce, grant_id: grantId, used_at: now.toISOString() })
        .execute();
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.warn('embedded user assertion nonce replayed', { grantId });
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete ledger rows older than `olderThan`. Called by the retention job;
   * the cutoff is far beyond the assertion skew window, so a purged row can no
   * longer be replayed by any assertion that would still pass the timestamp
   * check.
   */
  async purgeOlderThan(olderThan: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('embedded_user_assertion_nonces')
      .where('used_at', '<', olderThan.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

/**
 * Recognise a uniqueness violation across the two backends this runs on.
 * Matched on message text because better-sqlite3 caches its error constructor
 * process-globally, so `instanceof` misfires across Jest VM realms — the same
 * reason the migration tests avoid `.rejects.toThrow()`.
 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /UNIQUE constraint failed/i.test(message) ||
    /duplicate key value violates unique constraint/i.test(message) ||
    /PRIMARY KEY/i.test(message)
  );
}
