import { injectable, inject } from 'inversify';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import type {
  ActiveRetryOperationStatus,
  RetryOperation,
  SerializedAssetRetryOperationRepository,
} from './SerializedAssetRetryOperationRepository';
import { isActiveRetryOperationStatus } from './SerializedAssetRetryOperationRepository';

/**
 * A reservation came back with a terminal status, which `reserve` cannot
 * produce: it either inserts an `accepted` row or converges onto an active
 * one. Fixed text, carries no data.
 */
export const RESERVED_OPERATION_NOT_ACTIVE =
  'serialized-asset forced retry reservation returned a non-active operation';

/**
 * The narrow route-facing API for the forced serialized-asset retry (A9).
 *
 * `reserve` is what the HTTP handler now calls instead of running the drain
 * inline. It does the request-time validation that must produce an immediate
 * bounded HTTP error, records a durable operation, and returns — the actual
 * work happens later in `SerializedAssetRetryJob`.
 *
 * The split matters for what a caller can learn. Reservation failures are
 * things the caller asked for wrongly (unknown configuration, wrong execution
 * profile, inactive configuration) and stay synchronous 4xx. Execution failures
 * are things that went wrong afterwards against NetSuite or Salesforce; those
 * become operation STATUS, never a request-time error, so nothing from a
 * connector or a governance refusal is shaped into an HTTP response body.
 */

/**
 * The single thing this service needs from `IntegrationService`, expressed as
 * an interface so the route-facing service does not depend on that class and
 * cannot be tempted into calling its executor. `IntegrationService` satisfies
 * it structurally.
 */
export interface ForcedRetryEligibility {
  /**
   * Throws the same bounded, closed error vocabulary the synchronous route
   * used — `NotFoundError` (404, including cross-tenant), `BadRequestAppError`
   * (400) for a non-serialized-asset profile or an inactive configuration.
   */
  assertForcedRetryEligible(tenantId: string, configurationId: string): void;
}

export interface ReserveForcedRetryArgs {
  tenantId: string;
  configurationId: string;
  /** Verified operator identity from the request. Never caller-supplied. */
  requesterUserId: string;
  correlationId: string;
}

export interface ReservedForcedRetry {
  operationId: string;
  status: ActiveRetryOperationStatus;
  /** True when this call converged onto an operation that already existed. */
  deduplicated: boolean;
}

@injectable()
export class SerializedAssetRetryOperationService {
  constructor(
    @inject(TYPES.SerializedAssetRetryOperationRepository)
    private readonly repo: SerializedAssetRetryOperationRepository,
    @inject(TYPES.IntegrationService)
    private readonly eligibility: ForcedRetryEligibility,
  ) {}

  /**
   * Validate, then durably reserve. Returns the existing operation when one is
   * already live for this configuration rather than starting a second drain of
   * the same backlog — the caller sees one operation id either way, which is
   * what makes a retried request safe.
   */
  async reserve(args: ReserveForcedRetryArgs): Promise<ReservedForcedRetry> {
    // Before the reservation, so an unknown or ineligible configuration never
    // leaves a durable row behind.
    this.eligibility.assertForcedRetryEligible(args.tenantId, args.configurationId);

    const result = await this.repo.reserve({
      id: randomUUID(),
      tenantId: args.tenantId,
      configurationId: args.configurationId,
      requesterUserId: args.requesterUserId,
      correlationId: args.correlationId,
    });

    // Checked, not cast. The narrowing is a real invariant of `reserve`, and
    // if it is ever violated the honest outcome is a 500 rather than a 202
    // carrying a terminal status that the route's contract says cannot appear.
    if (!isActiveRetryOperationStatus(result.operation.status)) {
      throw new Error(RESERVED_OPERATION_NOT_ACTIVE);
    }

    return {
      operationId: result.operation.id,
      status: result.operation.status,
      deduplicated: result.outcome === 'existing',
    };
  }

  /**
   * Tenant- and configuration-scoped status read. Returns null for an unknown
   * operation, one belonging to another tenant, AND one belonging to a
   * different configuration of the same tenant — so the route maps all three
   * to the same 404 and the response cannot be used to probe for the existence
   * of operations the caller has no business seeing through this URL.
   */
  async getStatus(
    tenantId: string,
    configurationId: string,
    operationId: string,
  ): Promise<RetryOperation | null> {
    // Scoped to the configuration in the URL as well as the tenant, so an
    // operation cannot be read through an unrelated integration id.
    return this.repo.getByIdForConfiguration(tenantId, configurationId, operationId);
  }
}
