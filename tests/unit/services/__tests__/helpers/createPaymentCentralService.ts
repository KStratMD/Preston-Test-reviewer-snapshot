/**
 * Reusable harness for PaymentCentralService unit tests.
 * Extracted from InvoiceMatching.test.ts to avoid duplicating mock setup.
 * Each call returns a fresh container — do not share state across tests.
 *
 * The mock DunningAgent returns a properly-shaped AgentResult<DunningOutput>
 * so DunningAgentAdapter.analyze() takes the success branch. Tests that
 * need to exercise the "no agent configured" path should pass
 * { withAgent: false }.
 */

import 'reflect-metadata';
import { Container } from 'inversify';
import { PaymentCentralService } from '../../../../../src/services/PaymentCentralService';
import { TYPES } from '../../../../../src/inversify/types';
import {
  createDeterministicPaymentCentralRuntime,
  type PaymentCentralRuntime,
} from '../../../../../src/services/payment-central/PaymentCentralRuntime';

export interface CreatePaymentCentralServiceOptions {
  /**
   * When false, no DunningAgent binding is added to the container. Use for
   * tests that characterize the "AI unavailable" dunning path. Default: true.
   */
  withAgent?: boolean;
  /**
   * Runtime override. Default: a deterministic runtime (fixed 2024-01-01 now,
   * seeded LCG random) so demo fixtures are byte-identical across test runs.
   * Pass an explicit `PaymentCentralRuntime` to customize, or `null` to fall
   * back to the production `Date.now()` / `Math.random()` runtime.
   */
  runtime?: PaymentCentralRuntime | null;
}

export function createPaymentCentralService(
  options: CreatePaymentCentralServiceOptions = {},
) {
  const withAgent = options.withAgent !== false;

  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };

  const mockTelemetryService = {
    trackEvent: jest.fn(),
    trackMetric: jest.fn(),
    trackError: jest.fn(),
    trackDependency: jest.fn(),
    flush: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
  };

  // AgentResult<DunningOutput>-shaped mock. Matches the contract
  // DunningAgentAdapter.analyze() consumes: result.success + result.data.
  const mockDunningAgent = {
    execute: jest.fn().mockResolvedValue({
      success: true,
      confidence: 0.85,
      reasoning: 'Mock dunning analysis',
      executionTime: 100,
      data: {
        recommendedAction: 'send_email',
        recommendedTone: 'neutral',
        generatedMessage: {
          subject: 'Invoice past due',
          body: 'Mock message body',
          callToAction: 'Please pay now',
        },
        sentimentAnalysis: {
          customerSentiment: 'neutral',
          paymentLikelihood: 0.7,
          churnRisk: 0.3,
        },
        recommendations: [],
        escalationPath: {
          nextLevel: 2,
          nextAction: 'send_email',
          suggestedDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
        },
      },
    }),
  };

  const runtime: PaymentCentralRuntime | null =
    options.runtime === null
      ? null
      : options.runtime ??
        createDeterministicPaymentCentralRuntime(
          mockLogger as unknown as PaymentCentralRuntime['logger'],
          mockTelemetryService as unknown as PaymentCentralRuntime['telemetryService'],
          withAgent ? (mockDunningAgent as unknown as PaymentCentralRuntime['dunningAgent']) : undefined,
        );

  const container = new Container();
  container.bind(TYPES.Logger).toConstantValue(mockLogger);
  container.bind(TYPES.TelemetryService).toConstantValue(mockTelemetryService);
  if (withAgent) {
    container.bind(TYPES.DunningAgent).toConstantValue(mockDunningAgent);
  }
  if (runtime) {
    container.bind<PaymentCentralRuntime>(TYPES.PaymentCentralRuntime).toConstantValue(runtime);
  }
  container.bind<PaymentCentralService>(TYPES.PaymentCentralService).to(PaymentCentralService);

  const service = container.get<PaymentCentralService>(TYPES.PaymentCentralService);

  return { service, mockLogger, mockTelemetryService, mockDunningAgent, runtime };
}
