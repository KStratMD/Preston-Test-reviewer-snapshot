import type { Logger } from '../../utils/Logger';
import type { TelemetryService } from '../TelemetryService';
import type { DocumentParsingAgent } from '../ai/orchestrator/agents/DocumentParsingAgent';
import type { VendorOnboardingAgent } from '../ai/orchestrator/agents/VendorOnboardingAgent';

export interface SupplierCentralRuntime {
  logger: Logger;
  telemetryService: TelemetryService;
  documentParsingAgent?: DocumentParsingAgent;
  vendorOnboardingAgent?: VendorOnboardingAgent;
  now(): number;
  random(): number;
  createId(prefix: string): string;
  wait(ms: number): Promise<void>;
}

export function createSupplierCentralRuntime(args: {
  logger: Logger;
  telemetryService: TelemetryService;
  documentParsingAgent?: DocumentParsingAgent;
  vendorOnboardingAgent?: VendorOnboardingAgent;
}): SupplierCentralRuntime {
  const runtime: SupplierCentralRuntime = {
    logger: args.logger,
    telemetryService: args.telemetryService,
    documentParsingAgent: args.documentParsingAgent,
    vendorOnboardingAgent: args.vendorOnboardingAgent,
    now: () => Date.now(),
    random: () => Math.random(),
    createId: (prefix) => `${prefix}_${runtime.now()}_${runtime.random().toString(36).slice(2, 11)}`,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return runtime;
}
