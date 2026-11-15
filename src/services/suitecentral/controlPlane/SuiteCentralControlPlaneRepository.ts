import { injectable, inject } from 'inversify';
import { sql, type Kysely, type Updateable } from 'kysely';
import type { DatabaseService } from '../../../database/DatabaseService';
import { TYPES } from '../../../inversify/types';
import type {
  Database,
  SuiteCentralEnvironmentsTable,
} from '../../../database/types';
import { uuidv4 } from '../../../utils/uuid';
import {
  SuiteCentralConflictError,
  SuiteCentralNotFoundError,
} from './errors';
import type {
  AllowedHostView,
  CreateAllowedHostInput,
  CreateCredentialInput,
  CreateEnvironmentInput,
  CreateTemplateInput,
  CredentialMetadataRow,
  CredentialProfileView,
  EnvironmentView,
  MonitoringConfigView,
  TemplateView,
  UpdateEnvironmentPatch,
  UpsertMonitoringInput,
} from './domain';

/**
 * Durable, tenant-scoped persistence for the SuiteCentral control plane.
 *
 * Tenant isolation is enforced at TWO layers: the schema (composite
 * `(tenant_id, id)` keys + FKs, migration 057) AND here — every resource
 * predicate includes `tenant_id`. The only tenantless methods are the
 * platform-scoped allowed-host operations. Optimistic concurrency uses the
 * `version` column: an update with a stale `expectedVersion` affects zero rows
 * and raises `SuiteCentralConflictError`.
 *
 * Secrets are never stored or returned — credential rows carry only a
 * deterministic `secretRef`; client views expose `secretConfigured` only.
 */
/**
 * Dialect-agnostic detection of a UNIQUE-constraint violation: better-sqlite3
 * reports "UNIQUE constraint failed …"; PostgreSQL (pg) uses SQLSTATE 23505.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /unique constraint failed/i.test(message);
}

@injectable()
export class SuiteCentralControlPlaneRepository {
  private readonly db: Kysely<Database>;
  private readonly dbType: 'sqlite' | 'postgres';

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
    this.dbType = databaseService.getDbType();
  }

  // ----- dialect helpers ---------------------------------------------------

  private now(): string {
    return new Date().toISOString();
  }

  private toDbJson(value: unknown): object | string | null {
    if (value == null) return null;
    return this.dbType === 'sqlite' ? JSON.stringify(value) : (value as object);
  }

  private fromDbJson<T>(value: unknown, fallback: T): T {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private toDbBool(value: boolean): boolean | number {
    return this.dbType === 'sqlite' ? (value ? 1 : 0) : value;
  }

  /**
   * Run an insert and translate a UNIQUE-constraint violation (duplicate name /
   * hostname, or a concurrent create) into a typed `SuiteCentralConflictError`
   * instead of leaking a raw driver error. Other errors propagate unchanged.
   */
  private async insertOrConflict(exec: Promise<unknown>, code: string, message: string): Promise<void> {
    try {
      await exec;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new SuiteCentralConflictError(code, message);
      }
      throw err;
    }
  }

  private toIso(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  // ----- environments ------------------------------------------------------

  private mapEnvironment(row: Record<string, unknown>): EnvironmentView {
    const r = row;
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      baseUrl: String(r.base_url),
      environmentTier: r.environment_tier as EnvironmentView['environmentTier'],
      apiVersion: r.api_version == null ? null : String(r.api_version),
      timeoutMs: Number(r.timeout_ms),
      retryAttempts: Number(r.retry_attempts),
      rateLimitConfig: this.fromDbJson<Record<string, unknown> | null>(r.rate_limit_config, null),
      securityConfig: this.fromDbJson<Record<string, unknown> | null>(r.security_config, null),
      featureConfig: this.fromDbJson<Record<string, unknown> | null>(r.feature_config, null),
      version: Number(r.version),
      createdBy: r.created_by == null ? null : String(r.created_by),
      updatedBy: r.updated_by == null ? null : String(r.updated_by),
      createdAt: this.toIso(r.created_at) ?? '',
      updatedAt: this.toIso(r.updated_at) ?? '',
    };
  }

  /**
   * Insert an environment under a CALLER-allocated id, like
   * {@link createCredentialMetadata}. The service allocates first so the audit
   * `resourceId` can be that opaque id rather than the caller-supplied name —
   * `audit_logs.resource_id` is not DLP-scanned (only `details` is), so a name
   * used there would be untrusted text in a durable, ungoverned column.
   */
  async createEnvironment(
    tenantId: string,
    id: string,
    input: CreateEnvironmentInput,
    actorUserId: string,
  ): Promise<EnvironmentView> {
    const now = this.now();
    await this.insertOrConflict(
      this.db
        .insertInto('suitecentral_environments')
        .values({
          id,
          tenant_id: tenantId,
          name: input.name,
          base_url: input.baseUrl,
          environment_tier: input.environmentTier ?? 'sandbox',
          api_version: input.apiVersion ?? null,
          timeout_ms: input.timeoutMs ?? 30000,
          retry_attempts: input.retryAttempts ?? 3,
          rate_limit_config: this.toDbJson(input.rateLimitConfig),
          security_config: this.toDbJson(input.securityConfig),
          feature_config: this.toDbJson(input.featureConfig),
          version: 1,
          created_by: actorUserId,
          updated_by: actorUserId,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      'environment_name_conflict',
      'An environment with this name already exists for the tenant.',
    );
    const created = await this.findEnvironment(tenantId, id);
    if (!created) throw new SuiteCentralNotFoundError('environment_not_found', 'Environment not found after create.');
    return created;
  }

  async listEnvironments(tenantId: string): Promise<EnvironmentView[]> {
    const rows = await this.db
      .selectFrom('suitecentral_environments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('name', 'asc')
      .execute();
    return rows.map((r) => this.mapEnvironment(r as unknown as Record<string, unknown>));
  }

  async findEnvironment(tenantId: string, environmentId: string): Promise<EnvironmentView | undefined> {
    const row = await this.db
      .selectFrom('suitecentral_environments')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', environmentId)
      .executeTakeFirst();
    return row ? this.mapEnvironment(row as unknown as Record<string, unknown>) : undefined;
  }

  async updateEnvironment(
    tenantId: string,
    environmentId: string,
    expectedVersion: number,
    patch: UpdateEnvironmentPatch,
    actorUserId: string,
  ): Promise<EnvironmentView> {
    const set: Updateable<SuiteCentralEnvironmentsTable> = { updated_by: actorUserId, updated_at: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.baseUrl !== undefined) set.base_url = patch.baseUrl;
    if (patch.environmentTier !== undefined) set.environment_tier = patch.environmentTier;
    if (patch.apiVersion !== undefined) set.api_version = patch.apiVersion;
    if (patch.timeoutMs !== undefined) set.timeout_ms = patch.timeoutMs;
    if (patch.retryAttempts !== undefined) set.retry_attempts = patch.retryAttempts;
    if (patch.rateLimitConfig !== undefined) set.rate_limit_config = this.toDbJson(patch.rateLimitConfig);
    if (patch.securityConfig !== undefined) set.security_config = this.toDbJson(patch.securityConfig);
    if (patch.featureConfig !== undefined) set.feature_config = this.toDbJson(patch.featureConfig);

    const result = await this.db
      .updateTable('suitecentral_environments')
      .set((eb) => ({ ...set, version: eb('version', '+', 1) }))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', environmentId)
      .where('version', '=', expectedVersion)
      .executeTakeFirst();

    if (!result.numUpdatedRows || Number(result.numUpdatedRows) === 0) {
      await this.assertExistsOrConflict(tenantId, environmentId, 'environment');
    }
    const updated = await this.findEnvironment(tenantId, environmentId);
    if (!updated) throw new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.');
    return updated;
  }

  private async assertExistsOrConflict(tenantId: string, environmentId: string, kind: string): Promise<never> {
    const exists = await this.findEnvironment(tenantId, environmentId);
    if (exists) {
      throw new SuiteCentralConflictError('version_conflict', `Stale ${kind} version; reload and retry.`);
    }
    throw new SuiteCentralNotFoundError(`${kind}_not_found`, `${kind} not found.`);
  }

  // ----- credential profiles (metadata only) -------------------------------

  private mapCredentialMetadata(row: Record<string, unknown>): CredentialMetadataRow {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      environmentId: String(row.environment_id),
      name: String(row.name),
      clientId: String(row.client_id),
      secretRef: String(row.secret_ref),
      companyId: row.company_id == null ? null : String(row.company_id),
      scopes: this.fromDbJson<string[]>(row.scopes, []),
      isActive: !!row.is_active,
      rotatedAt: this.toIso(row.rotated_at),
      lastUsedAt: this.toIso(row.last_used_at),
      version: Number(row.version),
    };
  }

  private toCredentialView(meta: CredentialMetadataRow): CredentialProfileView {
    return {
      id: meta.id,
      environmentId: meta.environmentId,
      name: meta.name,
      clientId: meta.clientId,
      companyId: meta.companyId,
      scopes: meta.scopes,
      isActive: meta.isActive,
      secretConfigured: meta.secretRef.length > 0,
      rotatedAt: meta.rotatedAt,
      lastUsedAt: meta.lastUsedAt,
      version: meta.version,
    };
  }

  /**
   * Insert credential metadata under a profile id the CALLER allocated.
   *
   * The id is not generated here on purpose. `secretRef` is a deterministic
   * function of `(tenantId, profileId)` (see `SuiteCentralSecretStore.referenceFor`),
   * and the secret must be stored BEFORE this row exists — so that a failed
   * insert leaves an orphaned secret to clean up rather than a row pointing at a
   * secret that was never written. A caller therefore cannot derive a matching
   * ref unless it knows the id up front. If this method minted its own id, every
   * ref would be derived from a different id than the one persisted, and
   * `SuiteCentralSecretStore.resolve` would reject it with
   * `secret_reference_mismatch` on first use.
   */
  async createCredentialMetadata(
    tenantId: string,
    profileId: string,
    input: CreateCredentialInput,
    secretRef: string,
    actorUserId: string,
  ): Promise<CredentialProfileView> {
    const id = profileId;
    const now = this.now();
    await this.insertOrConflict(
      this.db
        .insertInto('suitecentral_credential_profiles')
        .values({
          id,
          tenant_id: tenantId,
          environment_id: input.environmentId,
          name: input.name,
          client_id: input.clientId,
          secret_ref: secretRef,
          company_id: input.companyId ?? null,
          scopes: this.toDbJson(input.scopes ?? []),
          is_active: this.toDbBool(true),
          rotated_at: now,
          last_used_at: null,
          version: 1,
          created_by: actorUserId,
          updated_by: actorUserId,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      'credential_name_conflict',
      'A credential profile with this name already exists for the environment.',
    );
    const meta = await this.findCredentialMetadata(tenantId, id);
    if (!meta) throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found after create.');
    return this.toCredentialView(meta);
  }

  async findCredentialMetadata(tenantId: string, profileId: string): Promise<CredentialMetadataRow | undefined> {
    const row = await this.db
      .selectFrom('suitecentral_credential_profiles')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', profileId)
      .executeTakeFirst();
    return row ? this.mapCredentialMetadata(row as unknown as Record<string, unknown>) : undefined;
  }

  async listCredentials(tenantId: string, environmentId: string): Promise<CredentialProfileView[]> {
    const rows = await this.db
      .selectFrom('suitecentral_credential_profiles')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('environment_id', '=', environmentId)
      .orderBy('name', 'asc')
      .execute();
    return rows.map((r) => this.toCredentialView(this.mapCredentialMetadata(r as unknown as Record<string, unknown>)));
  }

  async rotateCredentialMetadata(
    tenantId: string,
    profileId: string,
    expectedVersion: number,
    actorUserId: string,
    secretRef: string,
    rotatedAt: string,
  ): Promise<CredentialProfileView> {
    const result = await this.db
      .updateTable('suitecentral_credential_profiles')
      .set((eb) => ({
        secret_ref: secretRef,
        rotated_at: rotatedAt,
        updated_by: actorUserId,
        updated_at: this.now(),
        version: eb('version', '+', 1),
      }))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', profileId)
      .where('version', '=', expectedVersion)
      .executeTakeFirst();
    if (!result.numUpdatedRows || Number(result.numUpdatedRows) === 0) {
      const exists = await this.findCredentialMetadata(tenantId, profileId);
      if (exists) throw new SuiteCentralConflictError('version_conflict', 'Stale credential version; reload and retry.');
      throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
    }
    const meta = await this.findCredentialMetadata(tenantId, profileId);
    if (!meta) throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
    return this.toCredentialView(meta);
  }

  async deleteCredentialMetadata(tenantId: string, profileId: string, expectedVersion: number): Promise<void> {
    const result = await this.db
      .deleteFrom('suitecentral_credential_profiles')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', profileId)
      .where('version', '=', expectedVersion)
      .executeTakeFirst();
    if (!result.numDeletedRows || Number(result.numDeletedRows) === 0) {
      const exists = await this.findCredentialMetadata(tenantId, profileId);
      if (exists) throw new SuiteCentralConflictError('version_conflict', 'Stale credential version; reload and retry.');
      throw new SuiteCentralNotFoundError('credential_not_found', 'Credential not found.');
    }
  }

  // ----- templates ---------------------------------------------------------

  private mapTemplate(row: Record<string, unknown>): TemplateView {
    return {
      id: String(row.id),
      tenantId: row.tenant_id == null ? null : String(row.tenant_id),
      name: String(row.name),
      description: row.description == null ? null : String(row.description),
      sourceSystem: String(row.source_system),
      targetEntities: this.fromDbJson<unknown[]>(row.target_entities, []),
      fieldMappings: this.fromDbJson<Record<string, unknown>>(row.field_mappings, {}),
      businessRules: this.fromDbJson<unknown[]>(row.business_rules, []),
      syncSettings: this.fromDbJson<Record<string, unknown>>(row.sync_settings, {}),
      version: Number(row.version),
      builtIn: false,
    };
  }

  /** Insert a template under a CALLER-allocated id — see {@link createEnvironment}. */
  async createTemplate(
    tenantId: string,
    id: string,
    input: CreateTemplateInput,
    actorUserId: string,
  ): Promise<TemplateView> {
    const now = this.now();
    await this.insertOrConflict(
      this.db
        .insertInto('suitecentral_templates')
        .values({
          id,
          tenant_id: tenantId,
          name: input.name,
          description: input.description ?? null,
          source_system: input.sourceSystem,
          target_entities: this.toDbJson(input.targetEntities ?? []),
          field_mappings: this.toDbJson(input.fieldMappings ?? {}),
          business_rules: this.toDbJson(input.businessRules ?? []),
          sync_settings: this.toDbJson(input.syncSettings ?? {}),
          version: 1,
          created_by: actorUserId,
          updated_by: actorUserId,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      'template_name_conflict',
      'A template with this name already exists for the tenant.',
    );
    const created = await this.findTemplate(tenantId, id);
    if (!created) throw new SuiteCentralNotFoundError('template_not_found', 'Template not found after create.');
    return created;
  }

  async listTemplates(tenantId: string, sourceSystem?: string): Promise<TemplateView[]> {
    let query = this.db
      .selectFrom('suitecentral_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (sourceSystem !== undefined) query = query.where('source_system', '=', sourceSystem);
    const rows = await query.orderBy('name', 'asc').execute();
    return rows.map((r) => this.mapTemplate(r as unknown as Record<string, unknown>));
  }

  async findTemplate(tenantId: string, templateId: string): Promise<TemplateView | undefined> {
    const row = await this.db
      .selectFrom('suitecentral_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    return row ? this.mapTemplate(row as unknown as Record<string, unknown>) : undefined;
  }

  // ----- monitoring --------------------------------------------------------

  private mapMonitoring(row: Record<string, unknown>): MonitoringConfigView {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      environmentId: String(row.environment_id),
      enabled: !!row.enabled,
      intervalMs: Number(row.interval_ms),
      thresholds: this.fromDbJson<Record<string, unknown> | null>(row.thresholds, null),
      version: Number(row.version),
    };
  }

  /**
   * Tenant-scoped read of one environment's monitoring config. Returns
   * `undefined` when absent OR when the row belongs to another tenant, so a
   * cross-tenant id is indistinguishable from a missing one and leaks no
   * existence.
   */
  async findMonitoringConfig(
    tenantId: string,
    environmentId: string,
  ): Promise<MonitoringConfigView | undefined> {
    const row = await this.db
      .selectFrom('suitecentral_monitoring_configs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    return row ? this.mapMonitoring(row as unknown as Record<string, unknown>) : undefined;
  }

  /**
   * CAS upsert of a monitoring config. `expectedVersion` guards concurrent
   * writes exactly like environments/credentials: pass `0` to create (fails
   * with a conflict if a row already exists), or the current version to update
   * (fails with `SuiteCentralConflictError` if another writer moved it first).
   */
  async upsertMonitoringConfig(
    tenantId: string,
    environmentId: string,
    input: UpsertMonitoringInput,
    actorUserId: string,
    expectedVersion: number,
  ): Promise<MonitoringConfigView> {
    const existing = await this.db
      .selectFrom('suitecentral_monitoring_configs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    const now = this.now();
    if (existing) {
      // Preserve existing interval/thresholds when the caller omits them —
      // a partial update must not silently reset unspecified fields.
      const result = await this.db
        .updateTable('suitecentral_monitoring_configs')
        .set((eb) => {
          const patch: Updateable<Database['suitecentral_monitoring_configs']> = {
            enabled: this.toDbBool(input.enabled),
            updated_by: actorUserId,
            updated_at: now,
          };
          if (input.intervalMs !== undefined) patch.interval_ms = input.intervalMs;
          if (input.thresholds !== undefined) patch.thresholds = this.toDbJson(input.thresholds);
          return { ...patch, version: eb('version', '+', 1) };
        })
        .where('tenant_id', '=', tenantId)
        .where('environment_id', '=', environmentId)
        .where('version', '=', expectedVersion)
        .executeTakeFirst();
      if (!result.numUpdatedRows || Number(result.numUpdatedRows) === 0) {
        throw new SuiteCentralConflictError('version_conflict', 'Stale monitoring-config version; reload and retry.');
      }
    } else {
      if (expectedVersion !== 0) {
        throw new SuiteCentralConflictError('version_conflict', 'Monitoring config does not exist; expected version must be 0 to create.');
      }
      await this.db
        .insertInto('suitecentral_monitoring_configs')
        .values({
          id: uuidv4(),
          tenant_id: tenantId,
          environment_id: environmentId,
          enabled: this.toDbBool(input.enabled),
          interval_ms: input.intervalMs ?? 300000,
          thresholds: this.toDbJson(input.thresholds),
          version: 1,
          created_by: actorUserId,
          updated_by: actorUserId,
          created_at: now,
          updated_at: now,
        })
        .execute()
        .catch((err: unknown) => {
          // Two callers can both see no existing row and race the insert; the
          // loser trips uq_suitecentral_monitoring_tenant_environment. Surface
          // that as the same typed conflict rather than a raw driver error.
          if (isUniqueConstraintViolation(err)) {
            throw new SuiteCentralConflictError('version_conflict', 'Monitoring config already exists for this environment (concurrent create).');
          }
          throw err;
        });
    }
    const row = await this.db
      .selectFrom('suitecentral_monitoring_configs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    if (!row) throw new SuiteCentralNotFoundError('monitoring_not_found', 'Monitoring config not found after upsert.');
    return this.mapMonitoring(row as unknown as Record<string, unknown>);
  }

  /**
   * PLATFORM-SCOPED, INTENTIONALLY TENANTLESS. Feeds the global monitoring
   * scheduler (PR-A5), which must see every tenant's enabled monitors to
   * dispatch per-tenant polling. It returns `tenantId` on each row precisely so
   * the scheduler re-scopes work to a single tenant downstream — isolation is
   * preserved by the caller, not by hiding rows here. Grouped with the
   * allowed-host methods as the deliberate platform-scoped exceptions to the
   * tenant-first rule; never call it from a tenant-facing request path.
   */
  async listEnabledMonitoringConfigs(): Promise<{ tenantId: string; environmentId: string; intervalMs: number }[]> {
    // Filter enabled in JS rather than SQL: `enabled` is stored as 0/1 in
    // SQLite and boolean in Postgres, and better-sqlite3 cannot bind a JS
    // boolean into a WHERE parameter — a dialect-safe pushdown isn't worth the
    // risk for this small per-environment config table.
    const rows = await this.db
      .selectFrom('suitecentral_monitoring_configs')
      .select(['tenant_id', 'environment_id', 'interval_ms', 'enabled'])
      .execute();
    return rows
      .filter((r) => !!(r as Record<string, unknown>).enabled)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return { tenantId: String(row.tenant_id), environmentId: String(row.environment_id), intervalMs: Number(row.interval_ms) };
      });
  }

  // ----- allowed hosts (platform-scoped, tenantless) -----------------------

  private mapAllowedHost(row: Record<string, unknown>): AllowedHostView {
    return {
      id: String(row.id),
      hostname: String(row.hostname),
      allowedPorts: this.fromDbJson<number[]>(row.allowed_ports, []),
      status: row.status as AllowedHostView['status'],
      justification: row.justification == null ? null : String(row.justification),
      createdBy: row.created_by == null ? null : String(row.created_by),
      updatedBy: row.updated_by == null ? null : String(row.updated_by),
      createdAt: this.toIso(row.created_at) ?? '',
      updatedAt: this.toIso(row.updated_at) ?? '',
    };
  }

  async listAllowedHosts(): Promise<AllowedHostView[]> {
    const rows = await this.db.selectFrom('suitecentral_allowed_hosts').selectAll().orderBy('hostname', 'asc').execute();
    return rows.map((r) => this.mapAllowedHost(r as unknown as Record<string, unknown>));
  }

  async findActiveAllowedHost(hostname: string, port: number): Promise<AllowedHostView | undefined> {
    // Hostnames are globally unique, so this resolves to a single row rather
    // than an in-memory scan. Match on LOWER(hostname) so the lookup is
    // case-insensitive and uses the LOWER(hostname) unique index that migration
    // 057 builds on BOTH engines (SQLite expression index / Postgres functional
    // index).
    const canonical = hostname.trim().toLowerCase();
    const row = await this.db
      .selectFrom('suitecentral_allowed_hosts')
      .selectAll()
      .where(sql<string>`LOWER(hostname)`, '=', canonical)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) return undefined;
    const host = this.mapAllowedHost(row as unknown as Record<string, unknown>);
    // Fail-closed: the requested port must be EXPLICITLY allowlisted. An entry
    // with no ports matches nothing (an empty list is never a wildcard).
    return host.allowedPorts.includes(port) ? host : undefined;
  }

  /** Insert an allowed host under a CALLER-allocated id — see {@link createEnvironment}. */
  async createAllowedHost(
    id: string,
    input: CreateAllowedHostInput,
    actorUserId: string,
  ): Promise<AllowedHostView> {
    const now = this.now();
    await this.insertOrConflict(
      this.db
        .insertInto('suitecentral_allowed_hosts')
        .values({
          id,
          hostname: input.hostname.trim().toLowerCase(),
          // Default to HTTPS (443) rather than an empty list — with fail-closed
          // matching, an empty list would make the host unreachable.
          allowed_ports: this.toDbJson(input.allowedPorts && input.allowedPorts.length > 0 ? input.allowedPorts : [443]),
          status: 'active',
          justification: input.justification ?? null,
          created_by: actorUserId,
          updated_by: actorUserId,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      'allowed_host_conflict',
      'An allowed host with this name already exists.',
    );
    const row = await this.db.selectFrom('suitecentral_allowed_hosts').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new SuiteCentralNotFoundError('allowed_host_not_found', 'Allowed host not found after create.');
    return this.mapAllowedHost(row as unknown as Record<string, unknown>);
  }

  async revokeAllowedHost(hostId: string, actorUserId: string): Promise<AllowedHostView> {
    const result = await this.db
      .updateTable('suitecentral_allowed_hosts')
      .set({ status: 'revoked', updated_by: actorUserId, updated_at: this.now() })
      .where('id', '=', hostId)
      .executeTakeFirst();
    if (!result.numUpdatedRows || Number(result.numUpdatedRows) === 0) {
      throw new SuiteCentralNotFoundError('allowed_host_not_found', 'Allowed host not found.');
    }
    const row = await this.db.selectFrom('suitecentral_allowed_hosts').selectAll().where('id', '=', hostId).executeTakeFirst();
    if (!row) throw new SuiteCentralNotFoundError('allowed_host_not_found', 'Allowed host not found.');
    return this.mapAllowedHost(row as unknown as Record<string, unknown>);
  }
}
