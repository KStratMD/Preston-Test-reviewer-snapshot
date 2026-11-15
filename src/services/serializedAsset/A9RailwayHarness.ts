import { Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '../../database/types';
import { migration as serializedAssetRetryMigration } from '../../database/migrations/063-create-serialized-asset-retry-operations-table';
import {
  SerializedAssetRetryOperationRepository,
  SERIALIZED_ASSET_RETRY_LEASE_MS,
  SERIALIZED_ASSET_RETRY_POLL_MS,
  type SerializedAssetRetryDatabase,
  type RetryOperation,
  type RetryOperationStatus,
} from './SerializedAssetRetryOperationRepository';

export const A9_ACKNOWLEDGEMENT = 'MUTATE_DISPOSABLE_A9_DATABASE';

export const A9_ALLOWED_PUBLIC_TABLES = [
  'a9_harness_guard',
  'a9_harness_participants',
  'a9_harness_events',
  'serialized_asset_retry_operations',
] as const;

export type A9AllowedPublicTable = (typeof A9_ALLOWED_PUBLIC_TABLES)[number];

export const A9_ALLOWED_PUBLIC_RELATION_KINDS = ['r'] as const;

export const A9_GLOBAL_TIMEOUT_MS = SERIALIZED_ASSET_RETRY_LEASE_MS + 90_000;

export type A9HarnessErrorCode =
  | 'A9_ACK_REQUIRED'
  | 'A9_RUN_ID_INVALID'
  | 'A9_ENVIRONMENT_INVALID'
  | 'A9_IDENTIFIER_INVALID'
  | 'A9_GIT_SHA_INVALID'
  | 'A9_DATABASE_URL_INVALID'
  | 'A9_PUBLIC_DOMAIN_FORBIDDEN'
  | 'A9_PROVIDER_CREDENTIAL_FORBIDDEN'
  | 'A9_SCHEMA_REJECTED'
  | 'A9_TOO_MANY_PARTICIPANTS'
  | 'A9_TIMEOUT'
  | 'A9_ASSERTION_FAILED'
  | 'A9_CLEANUP_FAILED'
  | 'A9_UNEXPECTED_FAILURE'
  | 'A9_HARD_TIMEOUT';

export class A9HarnessError extends Error {
  constructor(public readonly code: A9HarnessErrorCode) {
    super(code);
    this.name = 'A9HarnessError';
  }
}

export interface A9HarnessEnvironment {
  readonly acknowledgement: typeof A9_ACKNOWLEDGEMENT;
  readonly runId: string;
  readonly environmentName: string;
  readonly replicaId: string;
  readonly deploymentId: string;
  readonly gitCommitSha: string;
  readonly databaseUrl: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_PATTERN = /^a9-harness-[a-z0-9-]{1,52}$/;
const RAILWAY_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const FORBIDDEN_DATABASE_QUERY_KEYS = new Set([
  'options',
  'search_path',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
]);
const PROVIDER_KEY_PREFIXES = [
  'NETSUITE_',
  'SALESFORCE_',
  'OPENAI_',
  'ANTHROPIC_',
  'OPENROUTER_',
] as const;

function requiredString(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = environment[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function throwInvalid(code: A9HarnessErrorCode): never {
  throw new A9HarnessError(code);
}

function parseDatabaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return throwInvalid('A9_DATABASE_URL_INVALID');
  }

  if (
    !DATABASE_PROTOCOLS.has(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    return throwInvalid('A9_DATABASE_URL_INVALID');
  }

  for (const key of parsed.searchParams.keys()) {
    if (FORBIDDEN_DATABASE_QUERY_KEYS.has(key.toLowerCase())) {
      return throwInvalid('A9_DATABASE_URL_INVALID');
    }
  }
  return parsed;
}

export function parseA9HarnessEnvironment(environment: NodeJS.ProcessEnv): A9HarnessEnvironment {
  if (environment.A9_RAILWAY_HARNESS_ACK !== A9_ACKNOWLEDGEMENT) {
    return throwInvalid('A9_ACK_REQUIRED');
  }

  const runId = requiredString(environment, 'A9_HARNESS_RUN_ID');
  if (!runId || !UUID_PATTERN.test(runId)) return throwInvalid('A9_RUN_ID_INVALID');

  const environmentName = requiredString(environment, 'RAILWAY_ENVIRONMENT_NAME');
  if (!environmentName || environmentName === 'production' || !ENVIRONMENT_PATTERN.test(environmentName)) {
    return throwInvalid('A9_ENVIRONMENT_INVALID');
  }

  const replicaId = requiredString(environment, 'RAILWAY_REPLICA_ID');
  const deploymentId = requiredString(environment, 'RAILWAY_DEPLOYMENT_ID');
  if (!replicaId || !deploymentId || !RAILWAY_IDENTIFIER_PATTERN.test(replicaId) || !RAILWAY_IDENTIFIER_PATTERN.test(deploymentId)) {
    return throwInvalid('A9_IDENTIFIER_INVALID');
  }

  const gitCommitSha = requiredString(environment, 'RAILWAY_GIT_COMMIT_SHA');
  if (!gitCommitSha || !GIT_SHA_PATTERN.test(gitCommitSha)) return throwInvalid('A9_GIT_SHA_INVALID');

  if (Object.prototype.hasOwnProperty.call(environment, 'RAILWAY_PUBLIC_DOMAIN')) {
    return throwInvalid('A9_PUBLIC_DOMAIN_FORBIDDEN');
  }

  if (Object.keys(environment).some((key) => PROVIDER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))) {
    return throwInvalid('A9_PROVIDER_CREDENTIAL_FORBIDDEN');
  }

  const databaseUrl = requiredString(environment, 'DATABASE_URL');
  if (!databaseUrl) return throwInvalid('A9_DATABASE_URL_INVALID');
  parseDatabaseUrl(databaseUrl);

  return {
    acknowledgement: A9_ACKNOWLEDGEMENT,
    runId,
    environmentName,
    replicaId,
    deploymentId,
    gitCommitSha,
    databaseUrl,
  };
}

export type A9DatabaseType = 'sqlite' | 'postgres';
export type A9ParticipantRole = 'A' | 'B';

export interface A9HarnessRuntime {
  readonly now: () => Date;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new A9HarnessError('A9_TIMEOUT'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new A9HarnessError('A9_TIMEOUT'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_RUNTIME: A9HarnessRuntime = {
  now: () => new Date(),
  sleep: sleepWithAbort,
};

const CLAIM_AFTER_LEASE_EXPIRY_MAX_ATTEMPTS = Math.ceil(
  A9_GLOBAL_TIMEOUT_MS / SERIALIZED_ASSET_RETRY_POLL_MS,
);

export async function claimAfterLeaseExpiry<T>(
  claim: () => Promise<T | null>,
  sleep: A9HarnessRuntime['sleep'],
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt < CLAIM_AFTER_LEASE_EXPIRY_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new A9HarnessError('A9_TIMEOUT');
    const claimed = await claim();
    if (claimed !== null) return claimed;
    await sleep(SERIALIZED_ASSET_RETRY_POLL_MS, signal);
  }
  throw new A9HarnessError('A9_TIMEOUT');
}

const HARNESS_EVENT_NAMES = [
  'role_a_claimed',
  'role_b_takeover',
  'role_a_stale_heartbeat_rejected',
  'role_a_stale_complete_rejected',
  'role_b_complete_accepted',
  'role_b_final_verified',
  'role_a_final_verified',
] as const;

type HarnessEventName = (typeof HARNESS_EVENT_NAMES)[number];

interface A9HarnessRow {
  readonly runId: string;
  readonly environmentName: string;
  readonly deploymentId: string;
  readonly gitCommitSha: string;
}

interface A9ParticipantRow extends A9HarnessRow {
  readonly replicaId: string;
  readonly role: A9ParticipantRole;
}

interface A9PublicRelation {
  readonly name: string;
  readonly kind: string;
}

export interface A9HarnessEvidence {
  readonly runId: string;
  readonly environmentName: string;
  readonly deploymentId: string;
  readonly gitCommitSha: string;
  readonly replicaId: string;
  readonly role: A9ParticipantRole;
  readonly operationId: string;
  readonly firstLeaseOwner: string;
  readonly firstFencingToken: number;
  readonly firstLeaseExpiresAt: string;
  readonly successorClaimAt: string;
  readonly successorLeaseOwner: string;
  readonly successorFencingToken: number;
  readonly leaseExpiredBeforeSuccessorClaim: boolean;
  readonly staleHeartbeatAccepted: boolean;
  readonly staleCompleteAccepted: boolean;
  readonly successorCompleteAccepted: boolean;
  readonly finalStatus: RetryOperationStatus;
  readonly finalFencingToken: number;
  readonly events: readonly HarnessEventName[];
}

interface A9EventRecord {
  readonly eventName: HarnessEventName;
  readonly sequence: number;
  readonly role: A9ParticipantRole;
  readonly operationId: string | null;
  readonly status: RetryOperationStatus | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: number | null;
  readonly observedAt: string;
  readonly outcome: boolean | null;
}

interface A9ProtocolContext {
  readonly operationId: string;
  readonly tenantId: string;
  readonly firstLeaseOwner: string;
  readonly firstFencingToken: number;
  readonly firstLeaseExpiresAt: string;
  readonly successorClaimAt: string;
  readonly successorLeaseOwner: string;
  readonly successorFencingToken: number;
}

function schemaRejected(): never {
  throw new A9HarnessError('A9_SCHEMA_REJECTED');
}

function tooManyParticipants(): never {
  throw new A9HarnessError('A9_TOO_MANY_PARTICIPANTS');
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isPostgresBoundedTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '55P03' || code === '57014' || code === '25P03';
}

export class A9RailwayHarness {
  private readonly repository: SerializedAssetRetryOperationRepository;
  private readonly runtime: A9HarnessRuntime;
  private participantRole: A9ParticipantRole | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly environment: A9HarnessEnvironment,
    private readonly dbType: A9DatabaseType,
    runtime: Partial<A9HarnessRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
    const database: SerializedAssetRetryDatabase = { getDatabase: () => this.db };
    this.repository = new SerializedAssetRetryOperationRepository(database, this.runtime.now);
  }

  async initializeParticipant(): Promise<A9ParticipantRole> {
    let role: A9ParticipantRole;
    try {
      role = await this.db.transaction().execute(async (transaction) => {
        if (this.dbType === 'postgres') {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended('preston-a9-harness-init-v1', 0))`.execute(transaction);
          await this.assertEffectivePostgresSchema(transaction);
        }

        const relations = await this.listPublicRelations(transaction);
        if (relations.length === 0) {
          await this.createHarnessSchema(transaction);
        } else {
          this.assertAllowedSchema(relations);
          await this.assertGuard(transaction);
        }

        const participants = await this.readParticipants(transaction);
        const existing = participants.find((participant) => participant.replicaId === this.environment.replicaId);
        if (existing) return existing.role;
        if (participants.length >= 2) return tooManyParticipants();

        const nextRole: A9ParticipantRole = participants.length === 0 ? 'A' : 'B';
        await this.insertParticipant(transaction, nextRole);
        return nextRole;
      });
    } catch (error) {
      if (this.dbType === 'postgres' && isPostgresBoundedTimeout(error)) {
        throw new A9HarnessError('A9_TIMEOUT');
      }
      throw error;
    }
    this.participantRole = role;
    return role;
  }

  async runParticipant(role: A9ParticipantRole, signal?: AbortSignal): Promise<A9HarnessEvidence> {
    if (this.participantRole !== role) throw new A9HarnessError('A9_ASSERTION_FAILED');
    this.assertNotAborted(signal);
    if (role === 'A') return this.runRoleA(signal);
    return this.runRoleB(signal);
  }

  private async runRoleA(signal?: AbortSignal): Promise<A9HarnessEvidence> {
    const context = await this.claimRoleA(signal);
    const takeover = await this.waitForEvent('role_b_takeover', signal);
    const successorContext: A9ProtocolContext = {
      ...context,
      successorClaimAt: takeover.observedAt,
      successorLeaseOwner: takeover.leaseOwner ?? '',
      successorFencingToken: takeover.fencingToken ?? 0,
    };
    await this.proveStaleWrites(successorContext, signal);
    await this.waitForEvent('role_b_final_verified', signal);
    const final = await this.readFinalOperation(successorContext, signal);
    await this.recordEvent('role_a_final_verified', 'A', successorContext, final, true, signal);
    return this.buildEvidence('A', successorContext, final, signal);
  }

  private async runRoleB(signal?: AbortSignal): Promise<A9HarnessEvidence> {
    await this.waitForEvent('role_a_claimed', signal);
    const context = await this.claimRoleB(signal);
    await this.waitForEvent('role_a_stale_heartbeat_rejected', signal);
    await this.waitForEvent('role_a_stale_complete_rejected', signal);

    this.assertNotAborted(signal);
    const accepted = await this.repository.complete({
      id: context.operationId,
      leaseOwner: context.successorLeaseOwner,
      fencingToken: context.successorFencingToken,
      counters: { read: 0, upserted: 0, deferred: 0, quarantined: 0, failed: 0 },
    });
    const final = await this.readFinalOperation(context, signal);
    await this.recordEvent('role_b_complete_accepted', 'B', context, final, accepted, signal);
    if (!accepted) throw new A9HarnessError('A9_ASSERTION_FAILED');
    await this.recordEvent('role_b_final_verified', 'B', context, final, true, signal);
    await this.waitForEvent('role_a_final_verified', signal);
    return this.buildEvidence('B', context, final, signal);
  }

  private async claimRoleA(signal?: AbortSignal): Promise<A9ProtocolContext> {
    this.assertNotAborted(signal);
    const operationId = this.environment.runId;
    const tenantId = `a9-harness-${this.environment.runId}`;
    const reservation = await this.repository.reserve({
      id: operationId,
      tenantId,
      configurationId: 'a9-harness-configuration',
      requesterUserId: 'a9-harness',
      correlationId: this.environment.runId,
    });
    if (reservation.operation.id !== operationId) throw new A9HarnessError('A9_ASSERTION_FAILED');

    this.assertNotAborted(signal);
    const claimed = await this.repository.claimNext(this.environment.replicaId);
    if (
      !claimed ||
      claimed.status !== 'running' ||
      claimed.leaseOwner !== this.environment.replicaId ||
      claimed.fencingToken !== 1 ||
      !claimed.leaseExpiresAt
    ) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    const claimObservedAt = await this.currentDatabaseTime();
    const context: A9ProtocolContext = {
      operationId,
      tenantId,
      firstLeaseOwner: this.environment.replicaId,
      firstFencingToken: claimed.fencingToken,
      firstLeaseExpiresAt: claimed.leaseExpiresAt,
      successorClaimAt: '',
      successorLeaseOwner: '',
      successorFencingToken: 0,
    };
    await this.recordEvent('role_a_claimed', 'A', context, claimed, true, signal, claimObservedAt);
    return context;
  }

  private async claimRoleB(signal?: AbortSignal): Promise<A9ProtocolContext> {
    const claimEvent = await this.waitForEvent('role_a_claimed', signal);
    if (!claimEvent || !claimEvent.operationId || !claimEvent.observedAt) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    const firstLeaseExpiresAt = claimEvent.leaseExpiresAt;
    if (!firstLeaseExpiresAt || !Number.isFinite(Date.parse(firstLeaseExpiresAt))) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    await this.waitUntilLeaseExpiry(firstLeaseExpiresAt, signal);
    const claimed = await claimAfterLeaseExpiry(
      () => this.repository.claimNext(this.environment.replicaId),
      this.runtime.sleep,
      signal,
    );
    if (
      claimed.id !== claimEvent.operationId ||
      claimed.status !== 'running' ||
      claimed.leaseOwner !== this.environment.replicaId ||
      claimed.fencingToken !== 2
    ) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    const successorClaimAt = await this.currentDatabaseTime();
    const context: A9ProtocolContext = {
      operationId: claimed.id,
      tenantId: claimed.tenantId,
      firstLeaseOwner: claimEvent.leaseOwner ?? '',
      firstFencingToken: claimEvent.fencingToken ?? 1,
      firstLeaseExpiresAt,
      successorClaimAt,
      successorLeaseOwner: this.environment.replicaId,
      successorFencingToken: claimed.fencingToken,
    };
    await this.recordEvent('role_b_takeover', 'B', context, claimed, true, signal, successorClaimAt);
    return context;
  }

  private async proveStaleWrites(context: A9ProtocolContext, signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const holder = {
      id: context.operationId,
      leaseOwner: context.firstLeaseOwner,
      fencingToken: context.firstFencingToken,
    };
    const heartbeatAccepted = await this.repository.heartbeat(holder);
    const afterHeartbeat = await this.repository.getById(context.tenantId, context.operationId);
    if (
      heartbeatAccepted ||
      !afterHeartbeat ||
      afterHeartbeat.status !== 'running' ||
      afterHeartbeat.fencingToken !== context.successorFencingToken
    ) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    await this.recordEvent('role_a_stale_heartbeat_rejected', 'A', context, afterHeartbeat, false, signal);

    this.assertNotAborted(signal);
    const completeAccepted = await this.repository.complete({
      ...holder,
      counters: { read: 0, upserted: 0, deferred: 0, quarantined: 0, failed: 0 },
    });
    const afterComplete = await this.repository.getById(context.tenantId, context.operationId);
    if (
      completeAccepted ||
      !afterComplete ||
      afterComplete.status !== 'running' ||
      afterComplete.fencingToken !== context.successorFencingToken
    ) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    await this.recordEvent('role_a_stale_complete_rejected', 'A', context, afterComplete, false, signal);
  }

  private async waitUntil(instant: string, signal?: AbortSignal): Promise<void> {
    const target = Date.parse(instant);
    if (!Number.isFinite(target)) throw new A9HarnessError('A9_ASSERTION_FAILED');
    while (this.runtime.now().getTime() <= target) {
      this.assertNotAborted(signal);
      const remaining = target - this.runtime.now().getTime() + 1;
      await this.runtime.sleep(Math.min(Math.max(remaining, 1), SERIALIZED_ASSET_RETRY_POLL_MS), signal);
    }
  }

  private async waitUntilLeaseExpiry(instant: string, signal?: AbortSignal): Promise<void> {
    if (this.dbType === 'sqlite') {
      await this.waitUntil(instant, signal);
      return;
    }
    const target = Date.parse(instant);
    if (!Number.isFinite(target)) throw new A9HarnessError('A9_ASSERTION_FAILED');
    for (;;) {
      this.assertNotAborted(signal);
      const databaseNow = Date.parse(await this.currentDatabaseTime());
      if (!Number.isFinite(databaseNow)) throw new A9HarnessError('A9_ASSERTION_FAILED');
      if (databaseNow >= target) return;
      await this.runtime.sleep(Math.min(Math.max(target - databaseNow, 1), SERIALIZED_ASSET_RETRY_POLL_MS), signal);
    }
  }

  private async currentDatabaseTime(): Promise<string> {
    if (this.dbType === 'sqlite') return this.runtime.now().toISOString();
    const result = await sql<{ now: Date | string }>`SELECT CURRENT_TIMESTAMP AS now`.execute(this.db);
    const value = result.rows[0]?.now;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    throw new A9HarnessError('A9_ASSERTION_FAILED');
  }

  private async waitForEvent(eventName: HarnessEventName, signal?: AbortSignal): Promise<A9EventRecord> {
    for (;;) {
      this.assertNotAborted(signal);
      const event = await this.readEvent(eventName);
      if (event) return event;
      await this.runtime.sleep(SERIALIZED_ASSET_RETRY_POLL_MS, signal);
    }
  }

  private async readFinalOperation(context: A9ProtocolContext, signal?: AbortSignal): Promise<RetryOperation> {
    this.assertNotAborted(signal);
    const final = await this.repository.getById(context.tenantId, context.operationId);
    if (!final || final.status !== 'succeeded' || final.fencingToken !== context.successorFencingToken) {
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }
    return final;
  }

  private async readEvent(eventName: HarnessEventName): Promise<A9EventRecord | null> {
    const result = await sql<{
      eventName: string;
      sequence: number;
      role: string;
      operationId: string | null;
      status: string | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | string | null;
      fencingToken: number | null;
      observedAt: Date | string;
      outcome: boolean | number | null;
    }>`
      SELECT event_name AS "eventName", sequence, role, operation_id AS "operationId",
             status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
             fencing_token AS "fencingToken",
             observed_at AS "observedAt", outcome
      FROM a9_harness_events
      WHERE run_id = ${this.environment.runId} AND event_name = ${eventName}
    `.execute(this.db);
    const row = result.rows[0];
    if (!row || !HARNESS_EVENT_NAMES.includes(row.eventName as HarnessEventName)) return null;
    return {
      eventName: row.eventName as HarnessEventName,
      sequence: Number(row.sequence),
      role: row.role as A9ParticipantRole,
      operationId: row.operationId,
      status: row.status as RetryOperationStatus | null,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt:
        row.leaseExpiresAt === null
          ? null
          : row.leaseExpiresAt instanceof Date
            ? row.leaseExpiresAt.toISOString()
            : row.leaseExpiresAt,
      fencingToken: row.fencingToken === null ? null : Number(row.fencingToken),
      observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt,
      outcome: row.outcome === null ? null : row.outcome === true || row.outcome === 1,
    };
  }

  private async listEvents(): Promise<readonly HarnessEventName[]> {
    const events = await Promise.all(HARNESS_EVENT_NAMES.map((eventName) => this.readEvent(eventName)));
    return events.filter((event): event is A9EventRecord => event !== null).map((event) => event.eventName);
  }

  private async recordEvent(
    eventName: HarnessEventName,
    role: A9ParticipantRole,
    context: A9ProtocolContext,
    operation: RetryOperation,
    outcome: boolean | null,
    signal?: AbortSignal,
    observedAtOverride?: string,
  ): Promise<void> {
    this.assertNotAborted(signal);
    const sequence = HARNESS_EVENT_NAMES.indexOf(eventName) + 1;
    const storedOutcome = this.dbType === 'sqlite' && outcome !== null ? (outcome ? 1 : 0) : outcome;
    const observedAt = observedAtOverride ?? operation.finishedAt ?? operation.heartbeatAt ?? operation.startedAt ?? operation.createdAt;
    const existing = await this.readEvent(eventName);
    if (existing) {
      if (this.eventMatches(existing, eventName, sequence, role, context, operation, outcome, observedAt)) return;
      throw new A9HarnessError('A9_ASSERTION_FAILED');
    }

    try {
      await sql`
        INSERT INTO a9_harness_events
          (run_id, event_name, sequence, role, operation_id, status, lease_owner,
           lease_expires_at, fencing_token, observed_at, outcome)
        VALUES
          (${this.environment.runId}, ${eventName}, ${sequence}, ${role}, ${context.operationId},
           ${operation.status}, ${operation.leaseOwner}, ${operation.leaseExpiresAt}, ${operation.fencingToken},
           ${observedAt}, ${storedOutcome})
      `.execute(this.db);
    } catch (error) {
      if (!this.isDuplicateEventError(error)) throw error;
      const raced = await this.readEvent(eventName);
      if (!raced || !this.eventMatches(raced, eventName, sequence, role, context, operation, outcome, observedAt)) {
        throw new A9HarnessError('A9_ASSERTION_FAILED');
      }
    }
  }

  private eventMatches(
    existing: A9EventRecord,
    eventName: HarnessEventName,
    sequence: number,
    role: A9ParticipantRole,
    context: A9ProtocolContext,
    operation: RetryOperation,
    outcome: boolean | null,
    observedAt: string,
  ): boolean {
    return (
      existing.eventName === eventName &&
      existing.sequence === sequence &&
      existing.role === role &&
      existing.operationId === context.operationId &&
      existing.status === operation.status &&
      existing.leaseOwner === operation.leaseOwner &&
      existing.leaseExpiresAt === operation.leaseExpiresAt &&
      existing.fencingToken === operation.fencingToken &&
      existing.observedAt === observedAt &&
      existing.outcome === outcome
    );
  }

  private isDuplicateEventError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    const code = (error as { code?: unknown }).code;
    return code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
  }

  private async buildEvidence(
    role: A9ParticipantRole,
    context: A9ProtocolContext,
    final: RetryOperation,
    signal?: AbortSignal,
  ): Promise<A9HarnessEvidence> {
    const takeover = await this.waitForEvent('role_b_takeover', signal);
    const staleHeartbeat = await this.waitForEvent('role_a_stale_heartbeat_rejected', signal);
    const staleComplete = await this.waitForEvent('role_a_stale_complete_rejected', signal);
    const successorComplete = await this.waitForEvent('role_b_complete_accepted', signal);
    const successorClaimAt = takeover.observedAt;
    const leaseExpiredBeforeSuccessorClaim = Date.parse(context.firstLeaseExpiresAt) <= Date.parse(successorClaimAt);
    if (!leaseExpiredBeforeSuccessorClaim) throw new A9HarnessError('A9_ASSERTION_FAILED');
    return {
      runId: this.environment.runId,
      environmentName: this.environment.environmentName,
      deploymentId: this.environment.deploymentId,
      gitCommitSha: this.environment.gitCommitSha,
      replicaId: this.environment.replicaId,
      role,
      operationId: context.operationId,
      firstLeaseOwner: context.firstLeaseOwner,
      firstFencingToken: context.firstFencingToken,
      firstLeaseExpiresAt: context.firstLeaseExpiresAt,
      successorClaimAt,
      successorLeaseOwner: context.successorLeaseOwner,
      successorFencingToken: context.successorFencingToken,
      leaseExpiredBeforeSuccessorClaim,
      staleHeartbeatAccepted: staleHeartbeat.outcome ?? true,
      staleCompleteAccepted: staleComplete.outcome ?? true,
      successorCompleteAccepted: successorComplete.outcome ?? false,
      finalStatus: final.status,
      finalFencingToken: final.fencingToken,
      events: await this.listEvents(),
    };
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new A9HarnessError('A9_TIMEOUT');
  }

  private async listPublicRelations(db: Kysely<Database> | Transaction<Database>): Promise<A9PublicRelation[]> {
    if (this.dbType === 'sqlite') {
      const result = await sql<{ name: string; kind: string }>`
        SELECT name, type AS kind
        FROM sqlite_master
        WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `.execute(db);
      return result.rows.map((row) => ({ name: row.name, kind: row.kind }));
    }

    const result = await sql<{ name: string; kind: string }>`
      SELECT cls.relname AS name, cls.relkind AS kind
      FROM pg_class AS cls
      JOIN pg_namespace AS nsp ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = 'public'
        AND cls.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      ORDER BY cls.relname
    `.execute(db);
    return result.rows.map((row) => ({ name: row.name, kind: row.kind }));
  }

  private assertAllowedSchema(relations: readonly A9PublicRelation[]): void {
    const names = sorted(relations.map((relation) => relation.name));
    const expected = sorted(A9_ALLOWED_PUBLIC_TABLES);
    const expectedKind = this.dbType === 'sqlite' ? 'table' : 'r';
    if (!sameSet(names, expected) || relations.some((relation) => relation.kind !== expectedKind)) schemaRejected();
  }

  private async assertEffectivePostgresSchema(transaction: Transaction<Database>): Promise<void> {
    const result = await sql<{ current_schema: string | null; only_public: boolean }>`
      SELECT current_schema() AS current_schema,
             current_schemas(false) = ARRAY['public']::name[] AS only_public
    `.execute(transaction);
    const row = result.rows[0];
    if (!row || row.current_schema !== 'public' || row.only_public !== true) {
      schemaRejected();
    }
  }

  private async createHarnessSchema(transaction: Transaction<Database>): Promise<void> {
    if (this.dbType === 'sqlite') {
      await sql`
        CREATE TABLE a9_harness_guard (
          run_id TEXT PRIMARY KEY,
          environment_name TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          git_commit_sha TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `.execute(transaction);
      await sql`
        CREATE TABLE a9_harness_participants (
          run_id TEXT NOT NULL,
          replica_id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK (role IN ('A', 'B')),
          environment_name TEXT NOT NULL,
          deployment_id TEXT NOT NULL,
          git_commit_sha TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (run_id, role)
        )
      `.execute(transaction);
      await sql`
        CREATE TABLE a9_harness_events (
          run_id TEXT NOT NULL,
          event_name TEXT PRIMARY KEY CHECK (event_name IN (${sql.join(HARNESS_EVENT_NAMES.map((name) => sql.lit(name)))})),
          sequence INTEGER NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('A', 'B')),
          operation_id TEXT,
          status TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          fencing_token INTEGER,
          observed_at TEXT NOT NULL,
          outcome INTEGER
        )
      `.execute(transaction);
    } else {
      await sql`
        CREATE TABLE a9_harness_guard (
          run_id VARCHAR(64) PRIMARY KEY,
          environment_name VARCHAR(63) NOT NULL,
          deployment_id VARCHAR(128) NOT NULL,
          git_commit_sha CHAR(40) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        )
      `.execute(transaction);
      await sql`
        CREATE TABLE a9_harness_participants (
          run_id VARCHAR(64) NOT NULL,
          replica_id VARCHAR(128) PRIMARY KEY,
          role CHAR(1) NOT NULL CHECK (role IN ('A', 'B')),
          environment_name VARCHAR(63) NOT NULL,
          deployment_id VARCHAR(128) NOT NULL,
          git_commit_sha CHAR(40) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          UNIQUE (run_id, role)
        )
      `.execute(transaction);
      await sql`
        CREATE TABLE a9_harness_events (
          run_id VARCHAR(64) NOT NULL,
          event_name VARCHAR(64) PRIMARY KEY CHECK (event_name IN (${sql.join(HARNESS_EVENT_NAMES.map((name) => sql.lit(name)))})),
          sequence INTEGER NOT NULL UNIQUE,
          role CHAR(1) NOT NULL CHECK (role IN ('A', 'B')),
          operation_id VARCHAR(64),
          status VARCHAR(32),
          lease_owner VARCHAR(128),
          lease_expires_at TIMESTAMPTZ,
          fencing_token BIGINT,
          observed_at TIMESTAMPTZ NOT NULL,
          outcome BOOLEAN
        )
      `.execute(transaction);
    }

    await serializedAssetRetryMigration.run(transaction, this.dbType);
    await this.insertGuard(transaction);
    this.assertAllowedSchema(await this.listPublicRelations(transaction));
  }

  private async insertGuard(transaction: Transaction<Database>): Promise<void> {
    const createdAt = this.runtime.now().toISOString();
    await transaction.insertInto('a9_harness_guard' as never).values({
      run_id: this.environment.runId,
      environment_name: this.environment.environmentName,
      deployment_id: this.environment.deploymentId,
      git_commit_sha: this.environment.gitCommitSha,
      created_at: createdAt,
    } as never).execute();
  }

  private async assertGuard(transaction: Transaction<Database>): Promise<void> {
    const result = await sql<A9HarnessRow>`
      SELECT run_id AS "runId", environment_name AS "environmentName",
             deployment_id AS "deploymentId", git_commit_sha AS "gitCommitSha"
      FROM a9_harness_guard
    `.execute(transaction);
    if (
      result.rows.length !== 1 ||
      result.rows[0].runId !== this.environment.runId ||
      result.rows[0].environmentName !== this.environment.environmentName ||
      result.rows[0].deploymentId !== this.environment.deploymentId ||
      result.rows[0].gitCommitSha !== this.environment.gitCommitSha
    ) {
      schemaRejected();
    }
  }

  private async readParticipants(transaction: Transaction<Database>): Promise<A9ParticipantRow[]> {
    const result = await sql<A9ParticipantRow>`
      SELECT run_id AS "runId", environment_name AS "environmentName",
             deployment_id AS "deploymentId", git_commit_sha AS "gitCommitSha",
             replica_id AS "replicaId", role
      FROM a9_harness_participants
      ORDER BY role
    `.execute(transaction);
    if (result.rows.some((row) =>
      row.runId !== this.environment.runId ||
      row.environmentName !== this.environment.environmentName ||
      row.deploymentId !== this.environment.deploymentId ||
      row.gitCommitSha !== this.environment.gitCommitSha
    )) {
      schemaRejected();
    }
    return result.rows;
  }

  private async insertParticipant(transaction: Transaction<Database>, role: A9ParticipantRole): Promise<void> {
    await sql`
      INSERT INTO a9_harness_participants
        (run_id, replica_id, role, environment_name, deployment_id, git_commit_sha, created_at)
      VALUES
        (${this.environment.runId}, ${this.environment.replicaId}, ${role},
         ${this.environment.environmentName}, ${this.environment.deploymentId},
         ${this.environment.gitCommitSha}, ${this.runtime.now().toISOString()})
    `.execute(transaction);
  }
}
