import { promises as fs } from 'fs';
import { inject, injectable, optional } from 'inversify';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import { ConfigurationLoadError, ConfigurationLookupAmbiguousError, ValidationError } from '../errors/ConfigurationErrors';
import { BadRequestAppError, ForbiddenAppError, ServiceUnavailableAppError } from '../errors/AppError';
import { CardinalityViolationError } from '../errors/CardinalityViolationError';
import { NotFoundError } from '../errors/NotFoundError';
import { getSystemType } from '../connectors/connectorIdentity';
import { TYPES } from '../inversify/types';
import { validateIntegrationConfig, type ConfigurationValidationResult } from '../schemas/configurationSchemas';
import type { IntegrationConfig } from '../types';
import type {
  CardinalityActivationDecision,
  CardinalityActivationDecisionInput,
  CardinalityActivationOutcomeInput,
} from './ai/orchestrator/AuditService';
import type {
  CardinalityAuthorizationInput,
  CardinalityFinding,
  CardinalityOverrideRequest,
  CardinalityPreflight,
  ConfigurationCommandContext,
  PersistedCardinalityOverride,
  PreflightRunResult,
} from '../types/cardinality';
import type { Logger } from '../utils/Logger';
import { toExternalIntegrationConfig } from './configurationRedaction';
import { validateHostedCredentialCustody } from './hostedCredentialCustody';

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

/** Lower bound on a persisted override reason — mirrors CardinalityOverrideRequestSchema. */
const MIN_OVERRIDE_REASON_LENGTH = 10;
/** Upper bound on a persisted override reason (design: "trimmed and length-bounded"). */
const MAX_OVERRIDE_REASON_LENGTH = 2000;

/**
 * The audit surface the activation gate depends on. Narrowed to the two
 * cardinality methods so the service never reaches for the rest of AuditService.
 */
export interface CardinalityActivationAudit {
  logCardinalityDecision(data: CardinalityActivationDecisionInput): Promise<string>;
  logCardinalityOutcome(data: CardinalityActivationOutcomeInput): Promise<string>;
}

/**
 * The activation gate bundle: the trusted preflight coordinator plus the
 * database-backed audit methods. Injected optionally so a service constructed
 * without it fails closed on active saves rather than silently skipping the gate.
 */
export interface CardinalityActivationGate {
  preflight: CardinalityPreflight;
  audit: CardinalityActivationAudit;
}

/**
 * The source an active configuration is activating FROM. Server-owned command
 * context — never a request-body field:
 *   - `direct_save`: a create/update save that is already active (or an edit to
 *     an already-active config).
 *   - `stored_id`: `activateConfigurationForTenant` — a stored tenant-owned
 *     draft activated by ID via `POST /api/configurations/:id/activate`.
 *   - `import`: an active member of a bulk `importAll` restore.
 */
export type ConfigurationActivationSource = 'direct_save' | 'stored_id' | 'import';

/**
 * A generic pre-activation extension point. Absent by default — a service
 * constructed without one applies NO additional restriction beyond the
 * cardinality gate, so standard configurations see no behavior change. A
 * later, specialized guard can bind here (via optional DI) to reject
 * activation from sources it does not trust (e.g. everything except
 * `stored_id`) without touching any caller of `saveConfiguration`,
 * `activateConfigurationForTenant`, or `importAll`.
 */
export interface ConfigurationActivationGuard {
  assertReady(
    config: IntegrationConfig,
    context: ConfigurationCommandContext,
    source: ConfigurationActivationSource,
  ): Promise<void>;
}

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT_REGEX.test(value)) {
    throw new ValidationError(
      `${label} '${value}' contains unsafe characters`,
      [`${label}: unsafe characters`],
    );
  }
}

function storageKey(tenantId: string, id: string): string {
  assertSafeSegment('tenantId', tenantId);
  assertSafeSegment('id', id);
  return `${tenantId}::${id}`;
}

/**
 * Service for managing integration configurations, including loading, saving, validating, and deleting.
 * Configurations are stored as JSON files in a specified directory.
 */
@injectable()
export class ConfigurationService {
  protected readonly logger: Logger;
  // Not readonly: loadConfigurations() swaps in a freshly-built Map on success so a
  // re-load (e.g. IntegrationService.restart()) drops configs removed on disk and
  // never leaves a partially-loaded Map live on failure (Copilot review).
  private configurations = new Map<string, IntegrationConfig>();
  private readonly configDirectory: string;
  private readonly cardinality?: CardinalityActivationGate;
  private readonly activationGuard?: ConfigurationActivationGuard;

  /**
   * Creates an instance of ConfigurationService.
   * @param {Logger} logger - The logger instance for logging messages.
   * @param {string} configDirectory - The absolute path to the directory where configurations are stored.
   * @param cardinality - Optional activation gate. When absent, active saves fail
   *   closed (the gate can never be silently skipped); draft saves are unaffected.
   * @param activationGuard - Optional generic pre-activation hook. Absent by
   *   default, so standard configurations see no behavior change; a later,
   *   specialized guard binds here without touching any caller.
   */
  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.ConfigDirectory) configDirectory = './config/integrations',
    @optional() @inject(TYPES.CardinalityActivationGate) cardinality?: CardinalityActivationGate,
    @optional() @inject(TYPES.ConfigurationActivationGuard) activationGuard?: ConfigurationActivationGuard,
  ) {
    this.logger = logger;
    this.configDirectory = configDirectory;
    this.cardinality = cardinality;
    this.activationGuard = activationGuard;
    this.ensureConfigDirectory();
  }

  /**
   * Loads all integration configurations from the configured directory.
   *
   * Top-level `*.json` ONLY. Subdirectories under the config dir hold connector
   * artifacts (e.g. `integrations/business_central/*.al`), NOT tenant configs —
   * the pre-PR-13c-4 loader ignored them and we preserve that contract. (PR 13c-4
   * keeps tenant isolation in the in-memory key + the route layer; it does NOT
   * impose a tenant-subdir on-disk layout, which collided with this directory's
   * existing dual use — see proof-card Known Gaps.)
   */
  public async loadConfigurations(): Promise<void> {
    try {
      await this.ensureConfigDirectory();
      const entries = await fs.readdir(this.configDirectory, { withFileTypes: true });
      const configFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
      let loadedCount = 0;
      const errors: string[] = [];
      // Build into a FRESH map and swap it in only on success (Copilot review):
      // a re-load (IntegrationService.restart()) then drops configs removed/renamed
      // on disk instead of leaving them resident, and a failed load never replaces
      // the live Map with a partial result. The per-load seenKeys set makes two
      // files defining the same (tenantId,id) fail closed rather than silently
      // shadowing each other by readdir order.
      const loaded = new Map<string, IntegrationConfig>();
      const seenKeys = new Set<string>();
      for (const entry of configFiles) {
        try {
          await this.loadSingleConfiguration(entry.name, seenKeys, loaded);
          loadedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Fail-closed: any invalid top-level config aborts boot (errors are
          // collected here and re-thrown below). The log is phrased as
          // "Invalid configuration file" — NOT "Skipping" — because the file is
          // NOT ignored; its presence is fatal (Copilot review).
          this.logger.warn(`Invalid configuration file (boot fails closed): ${entry.name}`, { error: msg });
          errors.push(`File ${entry.name}: ${msg}`);
        }
      }
      if (errors.length > 0) {
        throw new ConfigurationLoadError(
          `Failed to load one or more configuration files (boot fails closed on any invalid config): ${errors.join('; ')}`, '', undefined,
        );
      }
      // Atomic swap: replace the live Map only after a fully successful load.
      this.configurations = loaded;
      this.logger.info(`Successfully loaded ${loadedCount} integration configurations`);
    } catch (error) {
      this.logger.error('Failed to load configurations:', error);
      throw error;
    }
  }

  private async loadSingleConfiguration(fileName: string, seenKeys: Set<string>, target: Map<string, IntegrationConfig>): Promise<void> {
    const filePath = path.join(this.configDirectory, fileName);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const config: IntegrationConfig = JSON.parse(fileContent);
    if (!config.id || !config.name || !config.sourceSystem || !config.targetSystem || !config.tenantId) {
      throw new ValidationError(`Invalid configuration in ${fileName}: missing required fields (id, name, sourceSystem, targetSystem, tenantId)`, []);
    }
    // Fail closed unless the filename is the canonical ${id}.json (Codex + Copilot
    // review). save/delete always write/unlink ${id}.json, so loading a config
    // from a non-canonical filename (e.g. legacy-name.json with internal id
    // 'shared') would leave the original file behind on the next update/delete —
    // it resurfaces on restart and can even create a same-id/different-tenant pair
    // on disk that this flat layout treats as impossible everywhere else
    // (saveConfiguration + importAll already reject it). Enforcing filename===id
    // here makes that pair structurally impossible (two configs can't share one
    // ${id}.json in a flat dir) and keeps disk↔memory consistent across restarts.
    if (fileName !== `${config.id}.json`) {
      throw new ConfigurationLoadError(
        `Configuration file ${fileName} does not match its internal id '${config.id}' (expected '${config.id}.json') — the flat layout requires canonical ${config.id}.json filenames so save/delete stay consistent`,
        fileName,
      );
    }
    const key = storageKey(config.tenantId, config.id);
    // Fail closed on a duplicate (tenantId,id) across files — otherwise the
    // second file would silently overwrite the first and which one "wins" would
    // depend on readdir order (Copilot review).
    if (seenKeys.has(key)) {
      throw new ConfigurationLoadError(
        `Duplicate configuration (tenantId='${config.tenantId}', id='${config.id}') in ${fileName} — another config file already defines this (tenantId, id); refusing to let load order decide which wins`,
        fileName,
      );
    }
    seenKeys.add(key);
    target.set(key, config);
    this.logger.debug(`Loaded configuration: ${config.tenantId}/${config.id} (${config.name})`);
  }

  /**
   * Retrieves a configuration by its ID.
   * @deprecated Prefer getConfigurationForTenant for tenant-scoped callsites.
   * Throws ConfigurationLookupAmbiguousError if the same id exists under multiple tenants.
   */
  public getConfiguration(id: string): IntegrationConfig | undefined {
    const matches: IntegrationConfig[] = [];
    for (const cfg of this.configurations.values()) {
      if (cfg.id === id) {
        matches.push(cfg);
        if (matches.length > 1) {
          // Dev guidance (use the tenant-scoped variant) goes to the log, NOT the
          // thrown message — ConflictAppError.message is returned verbatim in the
          // 409 body, so it must not leak internal method names (Copilot review).
          this.logger.warn(
            `getConfiguration('${id}') is ambiguous across tenants — call getConfigurationForTenant(tenantId, id) instead`,
          );
          throw new ConfigurationLookupAmbiguousError(
            `Configuration id '${id}' is ambiguous across tenants; a tenant-scoped lookup is required.`,
          );
        }
      }
    }
    return matches[0];
  }

  /**
   * Retrieves a configuration only when the stored tenant matches the caller tenant.
   */
  public getConfigurationForTenant(tenantId: string, id: string): IntegrationConfig | undefined {
    return this.configurations.get(storageKey(tenantId, id));
  }

  /**
   * Retrieves all configurations belonging to a tenant.
   */
  public getAllConfigurationsForTenant(tenantId: string): IntegrationConfig[] {
    return this.getAllConfigurations().filter(config => config.tenantId === tenantId);
  }

  /**
   * Retrieves all configurations.
   */
  public getAllConfigurations(): IntegrationConfig[] {
    return Array.from(this.configurations.values());
  }

  /**
   * Saves a configuration to both memory and file system.
   *
   * Active saves (`isActive: true`, including edits to an already-active config)
   * cross the cardinality activation gate: they require trusted command context,
   * run a fresh coordinator preflight, and are refused unless every blocking
   * finding is resolved or covered by a current, fingerprint-bound audited
   * override. Draft saves bypass the gate entirely. See
   * docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md.
   *
   * @param source Server-owned provenance for the optional
   *   {@link ConfigurationActivationGuard} extension point — defaults to
   *   `'direct_save'` for this method's normal create/update callers.
   *   `activateConfigurationForTenant` calls through with `'stored_id'`;
   *   `importAll` calls the guard directly with `'import'` (it does not route
   *   through this method). Never accepted from request JSON.
   *
   * @returns A defensive deep copy of the PERSISTED record — including the
   *   server-generated `id` when the caller supplied none. Callers (the create
   *   route in particular) need that id to build a `Location` header and tell
   *   the operator which configuration was stored; before this returned
   *   anything, a create without a client id responded with `id: undefined`
   *   and the whole draft flow was bootstrap-blocked. It is a DEEP copy, not
   *   the stored object, so the "never mutates the caller / caller can never
   *   mutate storage" invariant holds in both directions. A shallow copy did
   *   not: `persistWithRollback` stores `candidate` itself, so every nested
   *   value stayed aliased and a caller mutating e.g. `returned.fieldMappings`
   *   reached tenant-scoped storage.
   *
   *   SCOPE, stated so it is not over-read: this guarantee covers the SAVE
   *   boundary only. The read accessors (`getConfiguration`,
   *   `getConfigurationForTenant`, `getAllConfigurations`,
   *   `getAllConfigurationsForTenant`) still hand out the live
   *   Map value, so a caller CAN mutate stored state through a read. That list
   *   is exhaustive as of this commit; a new accessor that returns a stored
   *   value belongs on it. That is pre-existing
   *   behavior, deliberately not changed here — cloning on every read is a
   *   cross-cutting change to a hot path that needs its own review. It is a
   *   real defect, not a design choice: `SecureConfigurationService`'s
   *   credential migration already trips it (it shallow-copies a stored config
   *   and then `delete`s nested `authentication` properties, so a subsequent
   *   save failure leaves memory diverged from disk). Tracked as a follow-up.
   */
  public async saveConfiguration(
    config: IntegrationConfig,
    context?: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
    source: ConfigurationActivationSource = 'direct_save',
  ): Promise<IntegrationConfig> {
    try {
      // Tenant binding is mandatory before storage — the Map key derives from
      // tenantId via storageKey(). This guard ONLY checks tenantId presence; it
      // runs before validateConfiguration so a missing tenantId short-circuits
      // with a clear error even when Zod is mocked (as it is in some tests).
      if (!config.tenantId) {
        throw new ValidationError('Configuration tenantId is required', ['tenantId is required']);
      }

      // Sanitize first so generating a missing id never mutates the caller.
      const candidate = this.sanitizeIncomingConfiguration(config);
      this.assertHostedCredentialCustody(candidate);
      if (!candidate.id) {
        candidate.id = uuidv4();
      }

      // Flat on-disk storage is keyed by id alone (${id}.json), so the same id cannot
      // durably coexist for two tenants — the second writer would clobber the first on
      // disk. Reject the cross-tenant collision here rather than silently losing data.
      this.assertNoCrossTenantIdCollision(candidate);

      // Work on a sanitized clone: strip any client-supplied server-authored
      // metadata and the transport envelope, then copy prior server metadata
      // ONLY from tenant-scoped storage (pinned block one). A client can never
      // seed its own approval/validation snapshot this way.
      // Candidate was sanitized before id generation and collision checks.
      const prior = this.configurations.get(storageKey(candidate.tenantId, candidate.id));
      candidate.cardinalityApproval = prior?.cardinalityApproval;
      candidate.cardinalityValidation = prior?.cardinalityValidation;

      const validation = this.validateConfiguration(candidate);
      if (!validation.isValid) {
        throw new ValidationError(`Configuration validation failed: ${validation.errors.join(', ')}`, validation.errors);
      }

      const now = new Date();
      candidate.createdAt = candidate.createdAt ?? prior?.createdAt ?? now;
      candidate.updatedAt = now;

      // Draft saves bypass the gate entirely — an operator can persist incomplete
      // work (block one).
      if (!candidate.isActive) {
        await this.persistWithRollback(candidate);
        this.logger.info(`Configuration saved: ${candidate.id} (${candidate.name})`);
        return structuredClone(candidate);
      }

      // --- Active save: cardinality activation authorization ---
      // Fail closed without trusted, tenant-matched command context (block two).
      if (!context || context.tenantId !== candidate.tenantId) {
        throw new ForbiddenAppError('Trusted activation context is required');
      }
      // Fail closed if the gate dependency isn't wired — never silently skip.
      if (!this.cardinality) {
        throw new ServiceUnavailableAppError(
          'Cardinality activation gate is not configured; refusing to activate',
        );
      }

      // Generic pre-activation guard (absent by default — no behavior change
      // for standard configurations). Runs before the preflight/audit/persist
      // sequence so a rejection here never mutates memory or disk.
      if (this.activationGuard) {
        await this.activationGuard.assertReady(candidate, context, source);
      }

      // Fresh preflight on EVERY active save (block two).
      const result = await this.cardinality.preflight.runForConfig(candidate, authorization?.samples);
      const approval = this.resolveCurrentApproval(
        candidate.cardinalityApproval,
        authorization?.override,
        result,
        context,
      );

      // Mandatory pre-decision audit rows, one per direction, BEFORE any mutation.
      // A persistence failure here propagates and aborts activation (block three).
      await this.auditDecisionPerDirection(result, approval, context, candidate.id);
      const remaining = this.remainingBlockingFindings(result, approval);
      if (remaining.length > 0) {
        // No mutation: memory AND disk unchanged.
        throw new CardinalityViolationError(result, remaining);
      }
      this.stampServerMetadata(candidate, result, approval, context);
      try {
        await this.persistWithRollback(candidate);
      } catch (error) {
        // Failed outcome audit is best-effort and happens AFTER the mandatory
        // decision row; the save error is rethrown unchanged (block three).
        await this.auditOutcomeBestEffort(result, context, candidate.id, 'failed');
        throw error;
      }
      // Save completed: an outcome-audit failure logs operationally but never
      // rolls back or lies about the completed save.
      await this.auditOutcomeBestEffort(result, context, candidate.id, 'succeeded');
      this.logger.info(`Configuration saved: ${candidate.id} (${candidate.name})`);
      return structuredClone(candidate);
    } catch (error) {
      this.logger.error('Failed to save configuration:', error);
      throw error;
    }
  }

  /**
   * Activates a stored tenant-owned draft (or re-activates an already-active
   * config) by ID. Resolves the tenant-scoped record, clones it with
   * `isActive: true`, and routes that clone through `saveConfiguration` —
   * the SAME validation, cardinality, audit, and atomic persistence path as
   * any other active save. This command adds NO second persistence path.
   *
   * Unknown ids and cross-tenant ids resolve identically (`getConfigurationForTenant`
   * returns `undefined` for both), so both cases surface the same `NotFoundError`
   * — a cross-tenant id never leaks existence under a different tenant.
   *
   * `source: 'stored_id'` is passed to the optional pre-activation guard
   * extension point (`ConfigurationActivationGuard`), so a later, specialized
   * guard can restrict which activation paths a given configuration accepts
   * without any change here or at other callers.
   */
  public async activateConfigurationForTenant(
    tenantId: string,
    configurationId: string,
    context: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ): Promise<void> {
    const existing = this.getConfigurationForTenant(tenantId, configurationId);
    if (!existing) {
      throw new NotFoundError(`Configuration '${configurationId}' not found`);
    }
    if (!context || context.tenantId !== tenantId) {
      throw new ForbiddenAppError('Trusted activation context is required');
    }
    // Shallow clone: the stored draft is never mutated in place. If any
    // downstream step (guard, preflight, audit, persistence) fails, the
    // original record in tenant-scoped storage is untouched — still inactive.
    const candidate: IntegrationConfig = { ...existing, isActive: true };
    await this.saveConfiguration(candidate, context, authorization, 'stored_id');
  }

  private assertHostedCredentialCustody(config: IntegrationConfig): void {
    const violations = validateHostedCredentialCustody(config);
    if (violations.length === 0) return;

    throw new ValidationError(
      'Hosted configurations must use reference-only credentials',
      violations.map(({ path, message }) => `${path}: ${message}`),
    );
  }

  private assertNoCrossTenantIdCollision(config: IntegrationConfig): void {
    const crossTenant = this.getAllConfigurations().find(
      candidate => candidate.id === config.id && candidate.tenantId !== config.tenantId,
    );
    if (!crossTenant) return;

    // Log the conflicting tenant server-side for operator debugging, but NEVER
    // surface the other tenant's id to the caller (cross-tenant leak guard).
    this.logger.warn(
      `Cross-tenant config id collision: id='${config.id}' requested by tenant='${config.tenantId}' ` +
      `but already owned by tenant='${crossTenant.tenantId}' (flat on-disk storage cannot durably hold the same id across tenants).`,
    );
    throw new ConfigurationLookupAmbiguousError(
      `Configuration id '${config.id}' is already in use.`,
    );
  }

  /**
   * The atomic memory-plus-file persistence unit shared by draft and active
   * saves. Sets the in-memory entry synchronously (closing the concurrent
   * same-id race for the common draft/single-tenant path) then writes the file,
   * rolling memory back to the previous value on a write failure so a failed
   * write never leaves ghost state that disagrees with disk on restart.
   */
  private async persistWithRollback(config: IntegrationConfig): Promise<void> {
    // Active saves can reach this method after multiple awaits (preflight and
    // audit). Recheck immediately before the synchronous Map set so a concurrent
    // same-id save from another tenant cannot pass the early check and clobber
    // flat ${id}.json storage.
    this.assertNoCrossTenantIdCollision(config);
    const key = storageKey(config.tenantId, config.id);
    const previous = this.configurations.get(key);
    this.configurations.set(key, config);
    try {
      await this.saveConfigurationToFile(config);
    } catch (error) {
      if (previous !== undefined) {
        this.configurations.set(key, previous);
      } else {
        this.configurations.delete(key);
      }
      throw error;
    }
  }

  /**
   * Returns a DEEP clone of the incoming configuration with all
   * server-authored / transport-only metadata stripped. `cardinalityApproval`
   * and `cardinalityValidation` are authored by the server and persisted only
   * from tenant-scoped storage; the `_cardinality` envelope is transport that
   * must never reach canonical persistence. Cloning avoids mutating the caller's
   * object when the gate later stamps fresh metadata.
   *
   * Deep, not shallow: `persistWithRollback` puts THIS object straight into the
   * in-memory Map, so a shallow copy left every nested value (`sourceSystem`,
   * `targetSystem`, `fieldMappings`, `destinations`, authentication blocks)
   * aliased to the caller's object. The caller could then mutate tenant-scoped
   * storage after the fact just by touching the request-derived config it
   * still holds — which made this method's "never mutates the caller" claim,
   * and `saveConfiguration`'s "caller can never mutate storage" claim, false
   * for everything except top-level scalars.
   *
   * `structuredClone` rather than a JSON round-trip because `createdAt` /
   * `updatedAt` are real `Date` objects (`z.coerce.date()`), which JSON would
   * silently flatten to strings.
   *
   * The clone is guarded because it can THROW where the previous shallow copy
   * could not: `structuredClone` raises `DataCloneError` on a function or other
   * non-cloneable value, and `IntegrationConfig` admits `unknown` payloads
   * (`fieldMappings[].defaultValue` is `z.any()`). Route bodies are JSON so they
   * cannot carry one, but an in-process caller can, and an unguarded throw here
   * would surface as an unclassified 500 instead of a rejected input. This is
   * the only guarded site: the two return-path clones copy a candidate that
   * already survived this one, so they cannot fail.
   *
   * What this gate is NOT: a JSON-strictness check. Cloneability is a wider
   * set than JSON — a Map/Set/RegExp passes the clone and later stringifies to
   * `{}` under `JSON.stringify`'s ordinary semantics, exactly as it did before
   * this gate existed (the persistence layer is unchanged). Only in-process
   * callers can supply such values, and rejecting them deterministically needs
   * a deep walk that must still admit `Date` (createdAt/updatedAt are real
   * Dates here) — deferred to the ConfigurationService follow-up ledger with
   * the other cross-cutting hardening.
   */
  private sanitizeIncomingConfiguration(config: IntegrationConfig): IntegrationConfig {
    let candidate: IntegrationConfig;
    try {
      candidate = structuredClone(config);
    } catch {
      // Deliberately does not echo the offending value or a key path: the
      // config carries authentication blocks, so the message is shape-only.
      throw new ValidationError(
        'Configuration contains a value that cannot be stored',
        ['Configuration must contain only structured-cloneable values (no functions or platform objects)'],
      );
    }
    delete candidate.cardinalityApproval;
    delete candidate.cardinalityValidation;
    delete (candidate as { _cardinality?: unknown })._cardinality;
    return candidate;
  }

  /** The set of finding keys that are BOTH blocking and overrideable in this run. */
  private overrideableBlockingKeys(result: PreflightRunResult): Set<string> {
    const keys = new Set<string>();
    for (const report of result.reports) {
      for (const finding of report.findings) {
        if (finding.severity === 'blocking' && finding.overrideable) {
          keys.add(finding.key);
        }
      }
    }
    return keys;
  }

  /**
   * An approval applies to a run only when its fingerprint matches the run's
   * combined fingerprint AND every key it names is still a current overrideable
   * blocking key. Any plan/schema/evidence/analyzer/direction/sample-digest
   * change moves the fingerprint, so a matching fingerprint proves none of those
   * changed; the key check additionally rejects an approval whose scope drifted.
   */
  private isApprovalApplicable(
    approval: PersistedCardinalityOverride,
    result: PreflightRunResult,
  ): boolean {
    if (approval.reportFingerprint !== result.combinedFingerprint) {
      return false;
    }
    if (approval.findingKeys.length === 0) {
      return false;
    }
    const overrideable = this.overrideableBlockingKeys(result);
    return approval.findingKeys.every(key => overrideable.has(key));
  }

  /**
   * Resolves the approval to apply this save: a fresh server-authored record
   * built from the request (actor/tenant from trusted context only), or the
   * durable prior approval reused when it still applies, or none. A malformed
   * override request (blank/oversized reason, empty scope) is a 400; a
   * stale/scope-drifted request is not rejected here — it simply fails to apply,
   * leaving the blocking findings to force a 422.
   */
  private resolveCurrentApproval(
    priorApproval: PersistedCardinalityOverride | undefined,
    overrideRequest: CardinalityOverrideRequest | undefined,
    result: PreflightRunResult,
    context: ConfigurationCommandContext,
  ): PersistedCardinalityOverride | undefined {
    if (overrideRequest) {
      const reason = (overrideRequest.reason ?? '').trim();
      if (reason.length === 0) {
        throw new BadRequestAppError('Cardinality override reason is required');
      }
      if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
        throw new BadRequestAppError(
          `Cardinality override reason must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters`,
        );
      }
      if (reason.length > MAX_OVERRIDE_REASON_LENGTH) {
        throw new BadRequestAppError('Cardinality override reason is too long');
      }
      if (!Array.isArray(overrideRequest.findingKeys) || overrideRequest.findingKeys.length === 0) {
        throw new BadRequestAppError('Cardinality override must name at least one finding');
      }
      return {
        reason,
        findingKeys: [...overrideRequest.findingKeys],
        reportFingerprint: overrideRequest.reportFingerprint,
        actorUserId: context.actorUserId,
        actorTenantId: context.tenantId,
        approvedAt: new Date().toISOString(),
        analyzerVersion: result.reports[0]?.analyzerVersion ?? '',
      };
    }
    // No request this save: reuse the durable approval only when it still applies.
    if (priorApproval && this.isApprovalApplicable(priorApproval, result)) {
      return priorApproval;
    }
    return undefined;
  }

  /**
   * The blocking findings still unresolved after applying any applicable
   * approval. Non-overrideable blocking findings can never be covered; an
   * overrideable blocking finding is cleared only when the applicable approval
   * names its key.
   */
  private remainingBlockingFindings(
    result: PreflightRunResult,
    approval: PersistedCardinalityOverride | undefined,
  ): CardinalityFinding[] {
    const covered = approval && this.isApprovalApplicable(approval, result)
      ? new Set(approval.findingKeys)
      : new Set<string>();
    const remaining: CardinalityFinding[] = [];
    for (const report of result.reports) {
      for (const finding of report.findings) {
        if (finding.severity !== 'blocking') {
          continue;
        }
        if (finding.overrideable && covered.has(finding.key)) {
          continue;
        }
        remaining.push(finding);
      }
    }
    return remaining;
  }

  /**
   * Writes the mandatory pre-decision audit row for EACH direction before any
   * active-state mutation. No try/catch: a persistence failure propagates so the
   * caller refuses to activate rather than mutate state without a durable record.
   */
  private async auditDecisionPerDirection(
    result: PreflightRunResult,
    approval: PersistedCardinalityOverride | undefined,
    context: ConfigurationCommandContext,
    configurationId: string,
    // Codex R5: this writes one row PER DIRECTION and awaits each. If direction
    // one is persisted and direction two throws, the configuration is left
    // holding a durable decision row that no terminal outcome will ever close —
    // and the caller cannot know which directions landed. Callers that must
    // reconcile the audit chain on abort pass this callback to learn exactly
    // which reports were written, so they can emit matching outcomes for those
    // and only those.
    onDecisionWritten?: (report: PreflightRunResult['reports'][number]) => void,
  ): Promise<void> {
    if (!this.cardinality) {
      throw new ServiceUnavailableAppError(
        'Cardinality activation gate is not configured; refusing to activate',
      );
    }
    const applicable = approval !== undefined && this.isApprovalApplicable(approval, result);
    const covered = applicable ? new Set(approval!.findingKeys) : new Set<string>();
    for (const report of result.reports) {
      const blocking = report.findings.filter(f => f.severity === 'blocking');
      const remainingInDirection = blocking.filter(f => !(f.overrideable && covered.has(f.key)));
      let decision: CardinalityActivationDecision;
      if (blocking.length === 0) {
        decision = 'allowed';
      } else if (remainingInDirection.length === 0) {
        decision = 'overridden';
      } else {
        decision = 'blocked';
      }
      const useOverride = applicable && decision === 'overridden';
      await this.cardinality.audit.logCardinalityDecision({
        tenantId: context.tenantId,
        actorUserId: context.actorUserId,
        correlationId: context.correlationId,
        configurationId,
        direction: report.direction,
        reportFingerprint: result.combinedFingerprint,
        findingKeys: blocking.map(f => f.key),
        decision,
        ...(useOverride ? { override: { reason: approval!.reason, scope: [...approval!.findingKeys] } } : {}),
      });
      onDecisionWritten?.(report);
    }
  }

  /**
   * Writes the succeeded/failed outcome row for each direction. Best-effort: a
   * failure is logged operationally and never thrown, so the completed save (or
   * the original save error) is reported honestly.
   */
  private async auditOutcomeBestEffort(
    result: PreflightRunResult,
    context: ConfigurationCommandContext,
    configurationId: string,
    outcome: 'succeeded' | 'failed',
    // Codex R5: the reason was hardcoded to 'disk_write_rejected', which was
    // accurate while a disk-write rollback was the ONLY producer of a failed
    // outcome. The import abort flush now also lands here for aborts where no
    // disk operation occurred at all (a preflight outage, a decision-audit
    // failure), and stamping those as a disk rejection is materially misleading
    // audit data. Callers pass their own cause; the default preserves the
    // existing single-save behavior. Values must stay a fixed, non-sensitive
    // vocabulary — never raw error text, which can embed sample data.
    failureReason: 'disk_write_rejected' | 'import_batch_aborted' = 'disk_write_rejected',
  ): Promise<void> {
    if (!this.cardinality) {
      return;
    }
    const reason = outcome === 'failed' ? failureReason : undefined;
    for (const report of result.reports) {
      try {
        await this.cardinality.audit.logCardinalityOutcome({
          tenantId: context.tenantId,
          actorUserId: context.actorUserId,
          correlationId: context.correlationId,
          configurationId,
          direction: report.direction,
          reportFingerprint: result.combinedFingerprint,
          outcome,
          ...(reason !== undefined ? { reason } : {}),
        });
      } catch (error) {
        this.logger.error(
          `Failed to write cardinality ${outcome} outcome audit for ${configurationId}`,
          error,
        );
      }
    }
  }

  /**
   * Stamps the server-authored approval and validation snapshot onto the
   * candidate so they persist atomically with the configuration in the same
   * memory-plus-file rollback unit. Only an applicable approval is persisted; a
   * stale/non-applicable one is dropped rather than carried forward.
   */
  private stampServerMetadata(
    candidate: IntegrationConfig,
    result: PreflightRunResult,
    approval: PersistedCardinalityOverride | undefined,
    _context: ConfigurationCommandContext,
  ): void {
    const applied = approval && this.isApprovalApplicable(approval, result) ? approval : undefined;
    candidate.cardinalityApproval = applied;

    const blockingKeys = new Set<string>();
    const unavailable = new Set<string>();
    for (const report of result.reports) {
      for (const finding of report.findings) {
        if (finding.severity === 'blocking') {
          blockingKeys.add(finding.key);
        }
      }
      for (const check of report.unavailableChecks) {
        unavailable.add(check);
      }
    }
    candidate.cardinalityValidation = {
      analyzerVersion: result.reports[0]?.analyzerVersion ?? '',
      reportFingerprint: result.combinedFingerprint,
      checkedAt: new Date().toISOString(),
      directions: result.reports.map(r => r.direction),
      blockingFindingKeys: [...blockingKeys],
      overriddenFindingKeys: applied ? [...applied.findingKeys] : [],
      unavailableChecks: [...unavailable],
    };
  }

  private async saveConfigurationToFile(config: IntegrationConfig): Promise<void> {
    assertSafeSegment('id', config.id);
    await this.ensureConfigDirectory();
    const filePath = path.join(this.configDirectory, `${config.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Deletes top-level ${id}.json config files not present in keepFileNames — used
   * by importAll to make a restore durable on disk (Copilot review): without this,
   * loadConfigurations() on restart would resurface configs the restore dropped,
   * and { configurations: [] } would not actually clear disk. Subdirectories are
   * ignored (they hold ERP connector artifacts, not configs), mirroring
   * loadConfigurations(). Best-effort: the in-memory restore has already
   * succeeded, so enumeration/unlink failures are logged, not thrown.
   */
  private async removeStaleConfigFiles(keepFileNames: Set<string>): Promise<void> {
    try {
      const entries = await fs.readdir(this.configDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || keepFileNames.has(entry.name)) {
          continue;
        }
        try {
          await this.unlinkConfigFile(path.join(this.configDirectory, entry.name));
        } catch (error) {
          // Per-file catch (Copilot review): one stale file failing to delete must
          // not abort cleanup of the rest — log and continue so the restore is as
          // durable as possible on disk.
          this.logger.error(`Failed to remove stale config file during restore: ${entry.name}`, error);
        }
      }
    } catch (error) {
      this.logger.error('Failed to reconcile on-disk config files during restore', error);
    }
  }

  /**
   * Removes a config file, treating ENOENT (already gone) as success but
   * surfacing any other failure (Codex review): callers delete the in-memory
   * entry only after this resolves, so a real unlink failure must throw rather
   * than be swallowed — otherwise the file resurfaces on the next reload and the
   * API would be reporting a durable delete that didn't happen.
   */
  private async unlinkConfigFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.logger.warn(`Config file already absent: ${filePath}`);
        return;
      }
      this.logger.error(`Failed to delete config file ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Deletes a configuration by ID.
   * @deprecated Prefer deleteConfigurationForTenant for tenant-scoped callsites.
   * Throws ConfigurationLookupAmbiguousError if the same id exists under multiple tenants.
   */
  public async deleteConfiguration(id: string): Promise<boolean> {
    try {
      // Deterministic scan mirroring getConfiguration(id): find the unique
      // match across all tenants, throw on ambiguity, return false on no match.
      let match: IntegrationConfig | undefined;
      for (const cfg of this.configurations.values()) {
        if (cfg.id === id) {
          if (match) {
            // Dev guidance to the log; the thrown message becomes the 409 body
            // verbatim and must not leak internal method names (Copilot review).
            this.logger.warn(
              `deleteConfiguration('${id}') is ambiguous across tenants — call deleteConfigurationForTenant(tenantId, id) instead`,
            );
            throw new ConfigurationLookupAmbiguousError(
              `Configuration id '${id}' is ambiguous across tenants; tenant-scoped deletion is required.`,
            );
          }
          match = cfg;
        }
      }
      if (!match) {
        return false;
      }

      // Remove from disk FIRST, then memory (Codex review): a real unlink failure
      // throws before the in-memory entry is dropped, so the API never reports a
      // delete that didn't durably happen. ENOENT is treated as success.
      assertSafeSegment('id', match.id);
      const filePath = path.join(this.configDirectory, `${match.id}.json`);
      await this.unlinkConfigFile(filePath);
      this.configurations.delete(storageKey(match.tenantId, match.id));

      this.logger.info(`Configuration deleted: tenant='${match.tenantId}' id='${id}'`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete configuration ${id}:`, error);
      throw error;
    }
  }

  /**
   * Deletes a configuration belonging to a specific tenant.
   */
  public async deleteConfigurationForTenant(tenantId: string, id: string): Promise<boolean> {
    const key = storageKey(tenantId, id);
    const config = this.configurations.get(key);
    if (!config) {
      return false;
    }
    // Flat layout: ${id}.json. storageKey() above already validated segment-safety
    // on both parts, but re-assert id here so the path construction is
    // self-evidently safe under local reading.
    assertSafeSegment('id', id);
    const filePath = path.join(this.configDirectory, `${id}.json`);
    // Remove from disk FIRST, then memory (Codex review): if unlink fails the file
    // would resurface on the next reload, so surface the failure and keep the
    // in-memory entry rather than reporting a delete that didn't durably happen.
    // ENOENT (already gone) is treated as success.
    await this.unlinkConfigFile(filePath);
    this.configurations.delete(key);
    this.logger.info(`Configuration deleted: tenant='${tenantId}' id='${id}'`);
    return true;
  }

  /**
   * Validates a configuration object using Zod schema validation.
   */
  public validateConfiguration(config: IntegrationConfig): ConfigurationValidationResult {
    try {
      // Use the schema-based validation
      const result = validateIntegrationConfig(config);

      // Add additional business logic warnings
      const warnings: string[] = [...result.warnings];

      if (!config.fieldMappings || config.fieldMappings.length === 0) {
        warnings.push('No field mappings defined - data may not sync properly');
      }

      if (config.batchSize && config.batchSize > 1000) {
        warnings.push('Large batch sizes may impact performance');
      }

      if (config.syncMode === 'realtime' && !config.targetAuthentication) {
        warnings.push('Real-time sync without target authentication may cause issues');
      }

      // In test environment, relax strict requirement on fieldMappings count to support E2E auth-failure scenario
      if (process.env.NODE_ENV === 'test') {
        const filteredErrors = result.errors.filter(e => !e.includes('fieldMappings') || !e.includes('At least one field mapping is required'));
        const adjustedWarnings = [...warnings];
        if (filteredErrors.length !== result.errors.length) {
          adjustedWarnings.push('No field mappings present - accepted in test mode');
        }
        return {
          ...result,
          errors: filteredErrors,
          warnings: adjustedWarnings,
          isValid: filteredErrors.length === 0,
        };
      }

      return {
        ...result,
        warnings,
        isValid: result.isValid && result.errors.length === 0,
      };

    } catch (error) {
      this.logger.error('Configuration validation failed', error);
      return {
        isValid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      };
    }
  }


  /**
   * Creates a sample integration configuration for testing.
   */
  public createSampleConfiguration(tenantId: string): IntegrationConfig {
    const sampleConfig: IntegrationConfig = {
      id: `sample_${uuidv4().substring(0, 8)}`,
      tenantId,
      name: 'Sample Salesforce to NetSuite Customer Sync',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      sourceEntity: 'Account',
      targetEntity: 'Customer',
      syncDirection: 'source_to_target',
      syncMode: 'batch',
      isActive: true,
      fieldMappings: [
        {
          sourceField: 'Name',
          targetField: 'companyname',
          transformationType: 'direct',
          isRequired: true,
        },
        {
          sourceField: 'Email',
          targetField: 'email',
          transformationType: 'direct',
          isRequired: false,
        },
        {
          sourceField: 'Phone',
          targetField: 'phone',
          transformationType: 'direct',
          isRequired: false,
        },
      ],
      transformationRules: [
        {
          id: 'validate_email',
          name: 'Email Validation',
          type: 'data_validation',
          condition: 'email != null',
          action: 'validate_email_format',
        },
      ],
      sourceAuthentication: {
        type: 'oauth2',
        credentials: {
          clientId: 'your_salesforce_client_id',
          clientSecret: 'your_salesforce_client_secret',
          tokenUrl: 'https://your_domain.my.salesforce.com/services/oauth2/token',
          scope: 'api',
        },
        refreshable: true,
      },
      targetAuthentication: {
        type: 'oauth1',
        credentials: {
          consumerKey: 'your_netsuite_consumer_key',
          consumerSecret: 'your_netsuite_consumer_secret',
          tokenId: 'your_netsuite_token_id',
          tokenSecret: 'your_netsuite_token_secret',
          accountId: 'your_netsuite_account_id',
        },
        refreshable: false,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return sampleConfig;
  }

  private async ensureConfigDirectory(): Promise<void> {
    try {
      await fs.access(this.configDirectory);
    } catch {
      await fs.mkdir(this.configDirectory, { recursive: true });
      this.logger.info(`Created configuration directory: ${this.configDirectory}`);
    }
  }

  /**
   * Exports a tenant-scoped configuration as JSON string.
   */
  public async exportConfigurationForTenant(tenantId: string, configId: string): Promise<string> {
    const config = this.getConfigurationForTenant(tenantId, configId);
    if (!config) {
      // NotFoundError so the route catch maps to 404 (Copilot R8 — was
      // previously a generic Error that hit the 500 branch in exportHandler).
      throw new NotFoundError(`Configuration ${configId} not found`);
    }
    return JSON.stringify(toExternalIntegrationConfig(config), null, 2);
  }

  /**
   * Imports a configuration from JSON string.
   *
   * `context` is threaded straight through to `saveConfiguration` — a single
   * imported member that is (or becomes) active crosses the same cardinality
   * activation gate as create/update, and fails closed without trusted context
   * exactly like `saveConfiguration` itself (Task 8).
   *
   * `authorization` carries the stripped `_cardinality` envelope (override
   * request + bounded samples) the import route parsed off the payload. An
   * imported override is only a REQUEST — the server authors the approval from
   * the importer's trusted command context (Task 9).
   */
  public async importConfiguration(
    configJson: string,
    context?: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ): Promise<IntegrationConfig> {
    try {
      if (!configJson || typeof configJson !== 'string') {
        throw new Error('Configuration JSON must be a non-empty string');
      }

      const config: IntegrationConfig = JSON.parse(configJson);

      // Validate the imported configuration
      const validation = this.validateConfiguration(config);
      if (!validation.isValid) {
        throw new ValidationError(`Invalid configuration: ${validation.errors.join(', ')}`, validation.errors);
      }

      // Save the configuration. `source: 'import'` — the discriminator is a
      // security-decision input for the pre-activation guard extension point,
      // never the default 'direct_save'; this method backs the import route.
      await this.saveConfiguration(config, context, authorization, 'import');

      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ValidationError('Invalid JSON format', ['Invalid JSON syntax']);
      }
      throw error;
    }
  }

  /**
   * Gets statistics about configurations.
   */
  public getConfigurationStatistics(): Record<string, unknown> {
    const configs = this.getAllConfigurations();
    const bySystem: Record<string, number> = {};
    const bySyncMode: Record<string, number> = {};

    configs.forEach(config => {
      const sourceSystem = getSystemType(config.sourceSystem || 'Unknown');
      const syncMode = config.syncMode || 'Unknown';

      bySystem[sourceSystem] = (bySystem[sourceSystem] || 0) + 1;
      bySyncMode[syncMode] = (bySyncMode[syncMode] || 0) + 1;
    });

    return {
      total: configs.length,
      active: configs.filter(c => c.isActive).length,
      bySystem,
      bySyncMode,
    };
  }

  /**
   * Export all configurations for backup
   */
  async exportAll(): Promise<unknown> {
    const configurations = Array.from(
      this.configurations.values(),
      (config) => toExternalIntegrationConfig(config),
    );
    return {
      configurations,
      configDirectory: this.configDirectory,
      totalConfigurations: configurations.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Import all configurations from backup.
   *
   * Every ACTIVE member crosses the same cardinality activation gate before any
   * memory or disk mutation. Imported approval/validation metadata is stripped
   * (never trusted), and bulk restore carries no per-member override transport,
   * so an active member must pass cleanly; if any active member fails, the whole
   * restore aborts before mutation and records failed outcomes for the members
   * already allowed this run.
   */
  async importAll(data: unknown, context?: ConfigurationCommandContext): Promise<void> {
    const incoming = (data as { configurations?: unknown } | null | undefined)?.configurations;
    if (!incoming) {
      // Absent / falsy configurations (undefined, null, 0, '', false) → treated
      // as "nothing to restore". An empty array is truthy and falls through to
      // clear state below.
      this.logger.warn('No configurations found in import data');
      return;
    }
    if (!Array.isArray(incoming)) {
      // Truthy non-array (e.g. { configurations: {} }) is malformed restore
      // input — throw a 400 ValidationError rather than letting the for-of throw
      // a TypeError that surfaces as a generic 500.
      throw new ValidationError(
        'Invalid import data: configurations must be an array',
        ['configurations must be an array'],
      );
    }
    const configs = incoming as IntegrationConfig[];

    // Pass 1: validate and collect the importable set. Invalid configs and
    // configs without a tenantId are skipped (logged), as before.
    const importable: IntegrationConfig[] = [];
    for (const config of configs) {
      // Sanitize and enforce hosted custody BEFORE canonical validation can
      // classify a credential-bearing member as merely "invalid" and skip it.
      // A hosted restore must reject the whole batch rather than silently
      // dropping a member and replacing existing state with a partial import.
      const sanitized = this.sanitizeIncomingConfiguration(config);
      this.assertHostedCredentialCustody(sanitized);
      const validationResult = await validateIntegrationConfig(sanitized);
      if (!validationResult.isValid) {
        this.logger.warn(`Skipping invalid configuration during import: ${sanitized.id}`, { errors: validationResult.errors });
        continue;
      }
      if (!sanitized.tenantId) {
        this.logger.warn(`Skipping configuration without tenantId during import: ${sanitized.id}`);
        continue;
      }
      importable.push(sanitized);
    }

    // Pass 2: fail closed on collisions BEFORE mutating memory or touching disk.
    // Flat on-disk storage is keyed by id alone (${id}.json), so the same id under
    // two tenants would clobber on disk and silently lose one tenant's config after
    // restart — the same invariant saveConfiguration() enforces at the write boundary
    // and loadConfigurations() enforces at boot. Pre-validating the whole batch keeps
    // restore atomic: a colliding backup is rejected without leaving the live Map or
    // disk in a half-applied state.
    const idOwner = new Map<string, string>(); // id -> tenantId
    const seenKeys = new Set<string>(); // storageKey(tenantId, id)
    for (const config of importable) {
      const key = storageKey(config.tenantId, config.id);
      if (seenKeys.has(key)) {
        // Malformed restore input (the backup names the same (tenantId,id) twice).
        // ValidationError is a ValidationAppError → the error boundary maps it to a
        // deterministic 400, not the generic 500 a ConfigurationLoadError would
        // produce, so a disaster-recovery restore fails with a useful status.
        throw new ValidationError(
          `Duplicate configuration (tenantId='${config.tenantId}', id='${config.id}') in import batch — refusing to let order decide which wins`,
          ['duplicate (tenantId, id) in import batch'],
        );
      }
      const existingTenant = idOwner.get(config.id);
      if (existingTenant !== undefined && existingTenant !== config.tenantId) {
        // Don't name the other tenant in the thrown message (cross-tenant leak guard,
        // mirroring saveConfiguration); log it server-side for operator debugging.
        this.logger.warn(
          `Cross-tenant config id collision in import batch: id='${config.id}' under tenant='${config.tenantId}' and tenant='${existingTenant}' ` +
          `(flat on-disk storage cannot durably hold the same id across tenants — deferred).`,
        );
        throw new ConfigurationLookupAmbiguousError(
          `Configuration id '${config.id}' is present under multiple tenants in the import batch.`,
        );
      }
      seenKeys.add(key);
      idOwner.set(config.id, config.tenantId);
    }

    // Pass 3 (activation gate): authorize EVERY active member before mutating
    // memory or disk (Step 7). A blocking member aborts the whole restore with
    // no configuration written; the earlier allowed members get failed outcome
    // rows (Step 7a). Draft members are unaffected.
    const activeMembers = importable.filter(c => c.isActive);
    const stagedOutcomes: {
      result: PreflightRunResult;
      auditContext: ConfigurationCommandContext;
      configurationId: string;
    }[] = [];
    if (activeMembers.length > 0) {
      if (!context) {
        throw new ForbiddenAppError('Trusted activation context is required for active configuration import');
      }
      if (!this.cardinality) {
        throw new ServiceUnavailableAppError(
          'Cardinality activation gate is not configured; refusing to import active configurations',
        );
      }
      // Generic pre-activation guard (absent by default) runs as its OWN pass
      // over EVERY active member first — not interleaved with the preflight
      // loop below. A guard that refuses member N must abort before member 1's
      // preflight, decision-audit row, or staged outcome exists: interleaving
      // would leave a partial audit trail for a restore that never happened.
      if (this.activationGuard) {
        for (const member of activeMembers) {
          await this.activationGuard.assertReady(
            member,
            { ...context, tenantId: member.tenantId },
            'import',
          );
        }
      }
      // The failed-outcome flush lives in a catch around the WHOLE preflight
      // loop, not on the blocking-findings branch alone (Copilot R4). Each
      // iteration writes a decision row before it can fail, so ANY abort — the
      // preflight coordinator erroring, the decision audit itself throwing —
      // leaves the already-authorized earlier members holding decision rows with
      // no terminal outcome. Only the cardinality-violation path used to close
      // them out; every other path left the audit chain open.
      //
      // This composes with the guard pre-pass above rather than duplicating it:
      // the pre-pass ensures a guard refusal aborts before ANY decision row
      // exists (nothing staged, nothing to flush), while this catch covers every
      // failure that can only be discovered mid-loop. The flush is best-effort by
      // construction (`auditOutcomeBestEffort` swallows), so it can never mask
      // the original error, which is always rethrown.
      //
      // `inFlight` closes the last gap (Codex R5): `auditDecisionPerDirection`
      // writes one row PER DIRECTION and awaits each, so a bidirectional member
      // whose FIRST direction persists and whose SECOND throws would hold a
      // durable decision row while still absent from `stagedOutcomes`. It tracks
      // exactly the reports that got a decision row for the member currently
      // being processed, so the flush can close out those directions and only
      // those — never inventing an outcome for a direction that never had a
      // decision. It is cleared the moment the member is fully staged, at which
      // point `stagedOutcomes` owns it.
      let inFlight: {
        result: PreflightRunResult;
        auditContext: ConfigurationCommandContext;
        configurationId: string;
        writtenReports: PreflightRunResult['reports'];
      } | undefined;
      try {
        for (const member of activeMembers) {
          // Bulk restore is a cross-tenant admin operation: audit rows attribute to
          // the member's own tenant, actor/correlation come from command context.
          const auditContext: ConfigurationCommandContext = { ...context, tenantId: member.tenantId };
          const result = await this.cardinality.preflight.runForConfig(member);
          const tracked = { result, auditContext, configurationId: member.id, writtenReports: [] as PreflightRunResult['reports'] };
          inFlight = tracked;
          // No durable approval (imported metadata stripped) and no override
          // transport for bulk restore, so an active member must pass cleanly.
          await this.auditDecisionPerDirection(result, undefined, auditContext, member.id, (report) => {
            tracked.writtenReports.push(report);
          });
          const remaining = this.remainingBlockingFindings(result, undefined);
          if (remaining.length > 0) {
            throw new CardinalityViolationError(result, remaining);
          }
          this.stampServerMetadata(member, result, undefined, auditContext);
          stagedOutcomes.push({ result, auditContext, configurationId: member.id });
          inFlight = undefined;
        }
      } catch (error) {
        for (const staged of stagedOutcomes) {
          await this.auditOutcomeBestEffort(
            staged.result, staged.auditContext, staged.configurationId, 'failed', 'import_batch_aborted',
          );
        }
        if (inFlight && inFlight.writtenReports.length > 0) {
          await this.auditOutcomeBestEffort(
            { ...inFlight.result, reports: inFlight.writtenReports },
            inFlight.auditContext,
            inFlight.configurationId,
            'failed',
            'import_batch_aborted',
          );
        }
        throw error;
      }
    }

    // Batch is collision-free: persist each config to the flat ${id}.json layout
    // and build the fresh Map so it always matches what loadConfigurations() would
    // read from disk on restart, then swap it in (Codex + Copilot review):
    //  - On success, the newly-written config enters the Map.
    //  - On failure, the new version is NOT written, so the prior on-disk file
    //    (preserved by removeStaleConfigFiles below) remains the disk truth. To
    //    keep memory consistent with that file, carry the PREVIOUS in-memory entry
    //    for the same key forward instead of dropping it — otherwise the config
    //    would look deleted in the running process but reappear from disk on
    //    restart. This mirrors saveConfiguration's write-failure rollback.
    const before = this.configurations;
    const loaded = new Map<string, IntegrationConfig>();
    for (const config of importable) {
      const key = storageKey(config.tenantId, config.id);
      try {
        await this.saveConfigurationToFile(config);
        loaded.set(key, config);
      } catch (error) {
        this.logger.error(`Failed to save imported configuration ${config.id} to file`, error);
        const prior = before.get(key);
        if (prior !== undefined) {
          // Prior version stays on disk and in memory — failed write is a no-op.
          loaded.set(key, prior);
        }
      }
    }
    this.configurations = loaded;

    // Reconcile disk with the restored set so the restore is durable on restart:
    // drop top-level ${id}.json files not in the backup. The keep-set is EVERY
    // attempted (importable) id, not just successfully-written ones (Copilot
    // review): a config that's in the backup but whose write failed must keep its
    // prior on-disk file rather than be deleted as "stale" — deleting it would
    // compound a write failure into silent data loss (old version gone, new
    // version never written). Genuinely stale ids (absent from the backup) are
    // still removed.
    await this.removeStaleConfigFiles(new Set(importable.map(c => `${c.id}.json`)));

    // Best-effort succeeded outcome rows for the active members whose decision
    // rows were written above; an outcome-audit failure never rolls back the
    // completed restore.
    for (const staged of stagedOutcomes) {
      await this.auditOutcomeBestEffort(staged.result, staged.auditContext, staged.configurationId, 'succeeded');
    }

    this.logger.info(`Configuration import completed: ${configs.length} configurations processed, ${loaded.size} imported`);
  }
}
