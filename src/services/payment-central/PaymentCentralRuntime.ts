import type { Logger } from '../../utils/Logger';
import type { TelemetryService } from '../TelemetryService';
import type { DunningAgent } from '../ai/orchestrator/agents/DunningAgent';

export interface PaymentCentralRuntime {
  logger: Logger;
  telemetryService: TelemetryService;
  dunningAgent?: DunningAgent;
  now(): number;
  random(): number;
  /**
   * Build an entity id of shape `${prefix}_${Date.now()}_${randomSuffix}`.
   * Default `suffixLength` is 9 to match the dominant pattern in the original
   * facade. Sub-services moving these legacy methods MUST pass `6` to preserve
   * the existing id shape:
   *   - `saveDunningSchedule` (Task 5)
   *   - GL journal-entry creation (Task 6, ~line 2009 of the original facade)
   *   - `createPostingBatch` (Task 6)
   * All other production callsites used 9 chars and need no override.
   */
  createId(prefix: string, suffixLength?: number): string;
}

export function createPaymentCentralRuntime(
  logger: Logger,
  telemetryService: TelemetryService,
  dunningAgent?: DunningAgent,
): PaymentCentralRuntime {
  // createId references runtime.now() / runtime.random() via the returned
  // object so that any override of those methods AFTER construction (e.g.
  // `runtime.now = () => fakedTime` in a test) also affects id generation.
  const runtime: PaymentCentralRuntime = {
    logger,
    telemetryService,
    dunningAgent,
    now: () => Date.now(),
    random: () => Math.random(),
    createId: (prefix, suffixLength = 9) =>
      `${prefix}_${runtime.now()}_${runtime.random().toString(36).slice(2, 2 + suffixLength)}`,
  };
  return runtime;
}

export interface DeterministicRuntimeOptions {
  /** Fixed epoch millis returned by `now()`. Default: 2024-01-01T00:00:00Z. */
  fixedNow?: number;
  /** PRNG seed for `random()`. Same seed + same call count → identical sequence. */
  seed?: number;
}

/**
 * Build a PaymentCentralRuntime with reproducible `now()` and `random()` so
 * demo seeding (processor IDs, transaction IDs, dunning fixtures, etc.)
 * produces byte-identical state across test runs. Use from test helpers
 * only — production code must continue to use `createPaymentCentralRuntime`.
 */
export function createDeterministicPaymentCentralRuntime(
  logger: Logger,
  telemetryService: TelemetryService,
  dunningAgent?: DunningAgent,
  options: DeterministicRuntimeOptions = {},
): PaymentCentralRuntime {
  const fixedNow = options.fixedNow ?? Date.UTC(2024, 0, 1);
  let state = (options.seed ?? 1) >>> 0;
  // Numerical Recipes LCG — small, deterministic, no dependencies.
  const lcg = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const runtime: PaymentCentralRuntime = {
    logger,
    telemetryService,
    dunningAgent,
    now: () => fixedNow,
    random: lcg,
    createId: (prefix, suffixLength = 9) =>
      `${prefix}_${runtime.now()}_${runtime.random().toString(36).slice(2, 2 + suffixLength)}`,
  };
  return runtime;
}
