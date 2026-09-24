import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../database/types';
import {
  A9_GLOBAL_TIMEOUT_MS,
  A9HarnessError,
  type A9HarnessErrorCode,
  type A9HarnessEnvironment,
  type A9HarnessEvidence,
  A9RailwayHarness,
  parseA9HarnessEnvironment,
  type A9ParticipantRole,
} from '../services/serializedAsset/A9RailwayHarness';

interface A9HarnessRunner {
  initializeParticipant(): Promise<A9ParticipantRole>;
  runParticipant(role: A9ParticipantRole, signal?: AbortSignal): Promise<A9HarnessEvidence>;
}

interface A9HarnessDatabase {
  readonly db: Kysely<Database>;
  close(): Promise<void>;
}

interface A9HarnessCliTimeouts {
  readonly globalTimeoutMs: number;
  readonly hardTimeoutGraceMs: number;
  readonly hardExitEmitFlushMs?: number;
}

const HARD_EXIT_EMIT_FLUSH_MS = 1_000;

export interface A9HarnessCliDependencies {
  createDatabase(databaseUrl: string): Promise<A9HarnessDatabase>;
  createHarness(db: Kysely<Database>, environment: A9HarnessEnvironment): A9HarnessRunner;
  emit(value: unknown): void | Promise<void>;
  forceExit(code: number): void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  timeouts?: A9HarnessCliTimeouts;
}

const DEFAULT_TIMEOUTS: A9HarnessCliTimeouts = {
  globalTimeoutMs: A9_GLOBAL_TIMEOUT_MS,
  hardTimeoutGraceMs: 15_000,
};

function createDefaultDependencies(): A9HarnessCliDependencies {
  return {
    async createDatabase(databaseUrl) {
      const pool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
        options:
          '-c search_path=public -c lock_timeout=10000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
      });
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
      return { db, close: () => db.destroy() };
    },
    createHarness: (db, environment) => new A9RailwayHarness(db, environment, 'postgres'),
    emit: (value) => new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
    }),
    forceExit: (code) => process.exit(code),
  };
}

export async function runA9RailwayHarnessCli(
  input: NodeJS.ProcessEnv = process.env,
  dependencies: A9HarnessCliDependencies = createDefaultDependencies(),
): Promise<number> {
  let connection: A9HarnessDatabase | null = null;
  let gracefulTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeout = false;
  let hardDeadlineResolve: (() => void) | null = null;
  const hardDeadline = new Promise<void>((resolve) => {
    hardDeadlineResolve = resolve;
  });
  const setTimer = dependencies.setTimeoutFn ?? setTimeout;
  const clearTimer = dependencies.clearTimeoutFn ?? clearTimeout;
  const timeouts = dependencies.timeouts ?? DEFAULT_TIMEOUTS;
  let evidence: A9HarnessEvidence | null = null;
  let failureCode: A9HarnessErrorCode | null = null;

  try {
    const environment = parseA9HarnessEnvironment(input);
    connection = await dependencies.createDatabase(environment.databaseUrl);
    const controller = new AbortController();

    gracefulTimer = setTimer(() => controller.abort(), timeouts.globalTimeoutMs);
    hardTimer = setTimer(() => {
      hardTimeout = true;
      // Unblock cleanup immediately; the emit below is best-effort and must
      // never gate the forced exit (a hung stdout writer would otherwise
      // defeat the hard timeout entirely).
      hardDeadlineResolve?.();
      const emitAttempt = Promise.resolve()
        .then(() => dependencies.emit({ type: 'a9_harness_error', code: 'A9_HARD_TIMEOUT' }))
        .catch((): void => undefined);
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const emitFlushDeadline = new Promise<void>((resolve) => {
        flushTimer = setTimer(resolve, timeouts.hardExitEmitFlushMs ?? HARD_EXIT_EMIT_FLUSH_MS);
      });
      void Promise.race([emitAttempt, emitFlushDeadline]).then((): void => {
        if (flushTimer !== null) clearTimer(flushTimer);
        dependencies.forceExit(1);
      });
    }, timeouts.globalTimeoutMs + timeouts.hardTimeoutGraceMs);

    const runner = dependencies.createHarness(connection.db, environment);
    const role = await runner.initializeParticipant();
    if (controller.signal.aborted) throw new A9HarnessError('A9_TIMEOUT');
    evidence = await runner.runParticipant(role, controller.signal);
    if (controller.signal.aborted) throw new A9HarnessError('A9_TIMEOUT');
  } catch (error) {
    failureCode = error instanceof A9HarnessError ? error.code : 'A9_UNEXPECTED_FAILURE';
  } finally {
    if (connection !== null) {
      try {
        const closeResult = await Promise.race([
          connection.close().then(
            () => 'closed' as const,
            () => 'failed' as const,
          ),
          ...(hardTimer === null ? [] : [hardDeadline.then(() => 'hard' as const)]),
        ]);
        if (closeResult === 'failed') failureCode = 'A9_CLEANUP_FAILED';
      } catch {
        failureCode = 'A9_CLEANUP_FAILED';
      }
    }
    if (gracefulTimer !== null) clearTimer(gracefulTimer);
    if (hardTimer !== null) clearTimer(hardTimer);
  }

  if (hardTimeout) return 1;
  if (failureCode !== null) {
    await dependencies.emit({ type: 'a9_harness_error', code: failureCode });
    return 1;
  }
  if (evidence === null) {
    await dependencies.emit({ type: 'a9_harness_error', code: 'A9_UNEXPECTED_FAILURE' });
    return 1;
  }
  await dependencies.emit(evidence);
  return 0;
}

if (require.main === module) {
  void runA9RailwayHarnessCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stdout.write('{"type":"a9_harness_error","code":"A9_UNEXPECTED_FAILURE"}\n');
    process.exitCode = 1;
  });
}
