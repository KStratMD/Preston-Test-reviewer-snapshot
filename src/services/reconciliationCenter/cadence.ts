import type { ReconciliationSchedulesTable } from '../../database/types';

export type ReconciliationCadence = ReconciliationSchedulesTable['cadence']; // 'hourly' | 'daily' | 'weekly'

const CADENCE_MS: Record<ReconciliationCadence, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Normalize an ISO string OR a Date (Postgres TIMESTAMP reads can be Date) to epoch ms. */
function toEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Advance `next_run_at` from the PRIOR scheduled time (not from `now`) so
 * hourly/daily schedules don't drift after slow/delayed ticks. Advances by
 * whole cadence steps until strictly in the future — catch-up is skipped, not
 * replayed (a schedule several intervals stale lands on the next boundary, not
 * `now + step`). Accepts string OR Date so it is correct across the SQLite
 * (string) and Postgres (possibly Date) drivers.
 */
export function computeNextRunAt(
  previousNextRunAt: string | Date,
  now: string | Date,
  cadence: ReconciliationCadence,
): string {
  const step = CADENCE_MS[cadence];
  let next = toEpochMs(previousNextRunAt);
  const nowMs = toEpochMs(now);
  if (Number.isNaN(next) || Number.isNaN(nowMs)) {
    throw new Error(`computeNextRunAt: invalid date (prev=${String(previousNextRunAt)}, now=${String(now)})`);
  }
  do {
    next += step;
  } while (next <= nowMs);
  return new Date(next).toISOString();
}
