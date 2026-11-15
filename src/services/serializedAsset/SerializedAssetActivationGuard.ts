import { ConflictAppError, ServiceUnavailableAppError } from '../../errors/AppError';
import type {
  ConfigurationActivationGuard,
  ConfigurationActivationSource,
} from '../ConfigurationService';
import type {
  SerializedAssetReadinessBlocker,
  SerializedAssetReadinessEvaluator,
} from './SerializedAssetReadinessService';
import type { ConfigurationCommandContext } from '../../types/cardinality';
import type { IntegrationConfig } from '../../types';

/**
 * The specialized pre-activation guard bound to prerequisite C's
 * `ConfigurationActivationGuard` extension point (Task 6, 2026-07-27 NetSuite
 * serialized-asset sync plan).
 *
 * `source` is SERVER-OWNED provenance supplied by `ConfigurationService` — it
 * is never a request-body field — and the rules per source are exact
 * (decisions 6 and 7):
 *
 *   - `direct_save` — an ACTIVE specialized create/update is refused with
 *     `stored_activation_required`. Specialized DRAFTS stay saveable, so the
 *     operator's normal authoring loop is untouched, and STANDARD
 *     configurations are not affected at all.
 *   - `import` — any ACTIVE specialized member is refused with the same code.
 *     `ConfigurationService.importAll` calls every active member's guard before
 *     it runs a single cardinality preflight, writes memory or disk, or records
 *     an outcome, so the restore stays all-or-nothing: the operator imports the
 *     member inactive and activates it by stored ID afterwards.
 *   - `stored_id` — the only path that can activate. Live readiness runs here,
 *     BEFORE the cardinality preflight and before atomic persistence, and a
 *     blocker is non-overrideable: the cardinality override envelope authorizes
 *     cardinality findings only and can never reach this decision.
 *
 * Readiness is evaluated against the configuration `ConfigurationService`
 * resolved from tenant-scoped storage, never against request content.
 */

export type SerializedAssetActivationBlockedCode = 'stored_activation_required' | 'readiness_blocked';

/**
 * 409: the configuration is not in a state that permits activation. Extends
 * `ConflictAppError` so that ANY route that ends up propagating it (rather than
 * handling it explicitly) still degrades to a sane, non-leaking 409 through the
 * error boundary instead of a generic 500.
 */
export class SerializedAssetActivationBlockedError extends ConflictAppError {
  public readonly code: SerializedAssetActivationBlockedCode;
  public readonly blockers: readonly SerializedAssetReadinessBlocker[];

  constructor(
    code: SerializedAssetActivationBlockedCode,
    message: string,
    blockers: readonly SerializedAssetReadinessBlocker[] = [],
  ) {
    super(message);
    this.code = code;
    // Frozen copy: the blocker list is a response payload, and a caller must
    // not be able to mutate the recorded reason after the refusal.
    this.blockers = Object.freeze(blockers.map((blocker) => ({ ...blocker })));
  }

  public toResponseBody(): {
    error: string;
    code: SerializedAssetActivationBlockedCode;
    message: string;
    blockers: SerializedAssetReadinessBlocker[];
  } {
    return {
      error: 'serialized_asset_activation_blocked',
      code: this.code,
      message: this.message,
      blockers: this.blockers.map((blocker) => ({ ...blocker })),
    };
  }
}

/** True only for a configuration that declares the specialized execution profile. */
function isSerializedAssetConfig(config: IntegrationConfig): boolean {
  return config.executionProfile === 'netsuite_serialized_asset';
}

export class SerializedAssetActivationGuard implements ConfigurationActivationGuard {
  /**
   * @param readiness Optional ONLY so a partially-wired container fails closed
   *   loudly (503) instead of throwing at construction and taking the whole
   *   configuration surface — including standard configurations — down with it.
   *   A missing evaluator can never become an implicit allow: see `assertReady`.
   */
  constructor(private readonly readiness?: SerializedAssetReadinessEvaluator) {}

  async assertReady(
    config: IntegrationConfig,
    _context: ConfigurationCommandContext,
    source: ConfigurationActivationSource,
  ): Promise<void> {
    // Standard configurations: no behavior change whatsoever.
    if (!isSerializedAssetConfig(config)) return;
    // Drafts stay saveable/importable from every source. (ConfigurationService
    // only invokes the guard for active saves; this is defense in depth for any
    // future caller.)
    if (!config.isActive) return;

    if (source === 'direct_save' || source === 'import') {
      throw new SerializedAssetActivationBlockedError(
        'stored_activation_required',
        'A netsuite_serialized_asset configuration can only be activated through POST /api/configurations/:id/activate, after it has been saved as an inactive draft',
      );
    }

    // source === 'stored_id': the only activation path, and the only place
    // live readiness runs.
    if (!this.readiness) {
      throw new ServiceUnavailableAppError(
        'NetSuite serialized-asset activation readiness is not configured; refusing to activate',
      );
    }

    // A readiness failure it could not determine (e.g. a tenant-setting storage
    // outage) throws ServiceUnavailableAppError from inside evaluate() and is
    // deliberately NOT caught here — an undeterminable gate must surface as 503,
    // never as an activation.
    const result = await this.readiness.evaluate(config);
    if (!result.ready) {
      throw new SerializedAssetActivationBlockedError(
        'readiness_blocked',
        'NetSuite serialized-asset activation readiness failed; resolve every blocker and retry',
        result.blockers,
      );
    }
  }
}
