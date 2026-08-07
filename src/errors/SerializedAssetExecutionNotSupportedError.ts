import { BadRequestAppError } from './AppError';

/**
 * Thrown when a GENERIC (non-specialized) execution path is asked to run an
 * `IntegrationConfig` whose `executionProfile` is `netsuite_serialized_asset`
 * (Task 8 fix, review round two, 2026-07-27 NetSuite serialized-asset sync
 * plan).
 *
 * Decision 1: the profile is a DEDICATED executor (`SerializedAssetSyncService`
 * via `IntegrationService.executeSerializedAssetSync`), never a generic
 * fan-out/cardinality/per-record executor. Every OTHER execution entry point
 * that reaches a connector write — `IntegrationService.
 * syncSingleRecordWithOptionalTenant`, `IntegrationExecutor.executeSync`,
 * `IntegrationExecutor.syncSingleRecord` — refuses a config carrying this
 * profile with this error instead of silently running the generic
 * read-then-write loop against it. That loop calls a generic
 * `create`/`update`, which decision 4 prohibits (the profile requires a
 * native Salesforce External-ID `upsert`; read-then-create is disallowed),
 * never re-evaluates the decision-7 runtime readiness gate, and can carry a
 * serial number into a log/audit surface the decision-8 privacy construction
 * exists to keep it out of. Mitigating this by relying on the config schema
 * (which forbids inline auth beside a managed `secret_manager` reference,
 * usually leaving the connector uninitialized on this path) is NOT a gate —
 * `ConfigurationService.loadConfigurations` restores persisted configs from
 * disk without re-validating them, so nothing actually enforces the schema
 * at read time.
 *
 * Extends `BadRequestAppError` (400) directly so `errorBoundary.ts`'s
 * existing `instanceof BadRequestAppError` branch maps it without adding a
 * new branch there.
 */
export class SerializedAssetExecutionNotSupportedError extends BadRequestAppError {
  constructor(configId: string, operation: string) {
    super(
      `Configuration ${configId} uses the netsuite_serialized_asset execution profile, which does not support ${operation}`,
    );
    this.name = 'SerializedAssetExecutionNotSupportedError';
  }
}
