import { SupplierCentralService } from '../../../../../src/services/SupplierCentralService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { TelemetryService } from '../../../../../src/services/TelemetryService';
import type { DocumentParsingAgent } from '../../../../../src/services/ai/orchestrator/agents/DocumentParsingAgent';
import type { VendorOnboardingAgent } from '../../../../../src/services/ai/orchestrator/agents/VendorOnboardingAgent';

export interface SupplierHarnessOverrides {
  documentParsingAgent?: jest.Mocked<DocumentParsingAgent>;
  vendorOnboardingAgent?: jest.Mocked<VendorOnboardingAgent>;
}

function createMockLogger(): jest.Mocked<Logger> {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } as unknown as jest.Mocked<Logger>;
}

function createMockTelemetryService(): jest.Mocked<TelemetryService> {
  return { recordMetric: jest.fn(), recordEvent: jest.fn(), startSpan: jest.fn(), endSpan: jest.fn() } as unknown as jest.Mocked<TelemetryService>;
}

export function createSupplierCentralService(overrides: SupplierHarnessOverrides = {}) {
  const mockLogger = createMockLogger();
  const mockTelemetryService = createMockTelemetryService();
  const service = new SupplierCentralService(
    mockLogger,
    mockTelemetryService,
    overrides.documentParsingAgent,
    overrides.vendorOnboardingAgent,
  );
  return { service, mockLogger, mockTelemetryService };
}
