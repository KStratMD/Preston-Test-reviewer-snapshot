/**
 * DunningAgent Integration Tests
 *
 * Integration tests for DunningAgent workflows:
 * - Complete dunning cycle from overdue detection to resolution
 * - Customer sentiment analysis and recommendations
 * - Message generation quality
 * - Escalation path management
 */

import 'reflect-metadata';
import { DunningAgent } from '../../../src/services/ai/orchestrator/agents/DunningAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';
import type { DunningInput, DunningOutput } from '../../../src/services/ai/orchestrator/agents/DunningAgent';

describe('DunningAgent Integration Tests', () => {
  let dunningAgent: DunningAgent;

  beforeAll(() => {
    dunningAgent = new DunningAgent();
  });

  // Helper to create execution context
  const createContext = (): AgentExecutionContext => ({
    sessionId: `integration-dunning-session-${Date.now()}`,
    userId: 'integration-test-user',
    correlationId: `integration-dunning-correlation-${Date.now()}`,
    maxExecutionTime: 30000, // 30 second timeout
    confidenceThreshold: 0.5,
    sourceSystem: 'PaymentCentral',
    targetSystem: 'DunningAgent',
  });

  // Standard dunning schedule for tests
  const standardSchedule: DunningInput['schedule'] = {
    levels: [
      { level: 1, daysOverdue: 7, action: 'reminder', tone: 'friendly', emailTemplateId: 'tmpl-friendly-1' },
      { level: 2, daysOverdue: 14, action: 'warning', tone: 'neutral', emailTemplateId: 'tmpl-neutral-1' },
      { level: 3, daysOverdue: 30, action: 'final_notice', tone: 'firm', emailTemplateId: 'tmpl-firm-1' },
      { level: 4, daysOverdue: 45, action: 'collections', tone: 'final', emailTemplateId: 'tmpl-final-1' },
    ],
    settings: {
      sendEmail: true,
      sendSms: false,
      escalateToCollections: true,
      collectionsDaysThreshold: 60,
    },
  };

  describe('Complete Dunning Cycle', () => {
    it('processes early-stage overdue invoice (gentle reminder)', async () => {
      const earlyDunningInput: DunningInput = {
        dunningEntry: {
          id: 'dun-001',
          customerId: 'cust-001',
          customerName: 'Reliable Customer Corp',
          customerEmail: 'ar@reliable.com',
          invoiceId: 'INV-2025-001',
          invoiceAmount: 5000,
          amountDue: 5000,
          currency: 'USD',
          daysOverdue: 5,
          currentLevel: 1,
          history: [],
        },
        customerProfile: {
          totalInvoices: 50,
          paidOnTime: 48,
          averagePaymentDays: 28,
          totalRevenue: 500000,
          customerSince: Date.now() - (730 * 24 * 60 * 60 * 1000), // 2 years ago
          previousDunningResponses: 2,
          paymentPlanHistory: false,
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), earlyDunningInput);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const output = result.data as DunningOutput;
      expect(['send_email', 'skip']).toContain(output.recommendedAction);
      expect(['friendly', 'neutral']).toContain(output.recommendedTone);
      expect(output.generatedMessage).toBeDefined();
      expect(output.generatedMessage.subject).toBeTruthy();
      expect(output.generatedMessage.body).toBeTruthy();
      expect(output.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.5);
    });

    it('processes mid-stage overdue invoice (firm reminder)', async () => {
      const midDunningInput: DunningInput = {
        dunningEntry: {
          id: 'dun-002',
          customerId: 'cust-002',
          customerName: 'Slow Payer Inc',
          customerEmail: 'accounts@slowpayer.com',
          invoiceId: 'INV-2025-002',
          invoiceAmount: 10000,
          amountDue: 10000,
          currency: 'USD',
          daysOverdue: 20,
          currentLevel: 2,
          history: [
            {
              timestamp: Date.now() - (10 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder sent',
            },
          ],
        },
        customerProfile: {
          totalInvoices: 20,
          paidOnTime: 12,
          averagePaymentDays: 45,
          totalRevenue: 100000,
          customerSince: Date.now() - (365 * 24 * 60 * 60 * 1000),
          previousDunningResponses: 0,
          paymentPlanHistory: false,
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), midDunningInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(['send_email', 'escalate']).toContain(output.recommendedAction);
      expect(['neutral', 'firm']).toContain(output.recommendedTone);
    });

    it('processes late-stage overdue invoice (urgent escalation)', async () => {
      const lateDunningInput: DunningInput = {
        dunningEntry: {
          id: 'dun-003',
          customerId: 'cust-003',
          customerName: 'Problem Account LLC',
          customerEmail: 'billing@problem.com',
          invoiceId: 'INV-2025-003',
          invoiceAmount: 25000,
          amountDue: 25000,
          currency: 'USD',
          daysOverdue: 40,
          currentLevel: 3,
          history: [
            {
              timestamp: Date.now() - (35 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder sent',
            },
            {
              timestamp: Date.now() - (25 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'Second reminder sent',
            },
            {
              timestamp: Date.now() - (10 * 24 * 60 * 60 * 1000),
              action: 'phone_call',
              details: 'Phone call attempted - no answer',
            },
          ],
        },
        customerProfile: {
          totalInvoices: 10,
          paidOnTime: 3,
          averagePaymentDays: 60,
          totalRevenue: 50000,
          customerSince: Date.now() - (180 * 24 * 60 * 60 * 1000),
          previousDunningResponses: 0,
          paymentPlanHistory: false,
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), lateDunningInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(['send_email', 'escalate']).toContain(output.recommendedAction);
      expect(output.sentimentAnalysis.paymentLikelihood).toBeLessThan(0.7);
    });
  });

  describe('Customer Sentiment Scenarios', () => {
    it('handles responsive customer with payment promise', async () => {
      const responsiveInput: DunningInput = {
        dunningEntry: {
          id: 'dun-responsive',
          customerId: 'cust-responsive',
          customerName: 'Responsive Customer',
          customerEmail: 'pay@responsive.com',
          invoiceId: 'INV-2025-R1',
          invoiceAmount: 8000,
          amountDue: 8000,
          currency: 'USD',
          daysOverdue: 10,
          currentLevel: 1,
          history: [
            {
              timestamp: Date.now() - (5 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'Initial reminder sent',
              responseReceived: 'Will pay by end of week, arranging funds now',
            },
          ],
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), responsiveInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(output.sentimentAnalysis.customerSentiment).toBe('positive');
      expect(output.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.5);
    });

    it('handles high-value customer with excellent history', async () => {
      const highValueInput: DunningInput = {
        dunningEntry: {
          id: 'dun-highvalue',
          customerId: 'cust-highvalue',
          customerName: 'Premium Enterprise Client',
          customerEmail: 'ap@premium.com',
          invoiceId: 'INV-2025-HV1',
          invoiceAmount: 100000,
          amountDue: 100000,
          currency: 'USD',
          daysOverdue: 7,
          currentLevel: 1,
          history: [],
        },
        customerProfile: {
          totalInvoices: 100,
          paidOnTime: 98,
          averagePaymentDays: 25,
          totalRevenue: 2000000,
          customerSince: Date.now() - (1825 * 24 * 60 * 60 * 1000), // 5 years
          previousDunningResponses: 5,
          paymentPlanHistory: false,
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), highValueInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(output.recommendedTone).toBe('friendly');
      expect(output.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.7);
      expect(output.sentimentAnalysis.churnRisk).toBeLessThan(0.5);
    });
  });

  describe('Escalation Path Recommendations', () => {
    it('recommends appropriate escalation timeline', async () => {
      const escalationInput: DunningInput = {
        dunningEntry: {
          id: 'dun-escalation',
          customerId: 'cust-escalation',
          customerName: 'Escalation Test Corp',
          customerEmail: 'billing@escalation.com',
          invoiceId: 'INV-2025-E1',
          invoiceAmount: 20000,
          amountDue: 20000,
          currency: 'USD',
          daysOverdue: 14,
          currentLevel: 2,
          history: [
            {
              timestamp: Date.now() - (7 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder sent',
            },
          ],
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), escalationInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(output.escalationPath).toBeDefined();
      expect(output.escalationPath.nextLevel).toBeGreaterThan(2);
      expect(output.escalationPath.suggestedDate).toBeGreaterThan(Date.now());
    });
  });

  describe('Generated Message Quality', () => {
    it('generates personalized message with invoice details', async () => {
      const messageInput: DunningInput = {
        dunningEntry: {
          id: 'dun-message',
          customerId: 'cust-message',
          customerName: 'Message Test Inc',
          customerEmail: 'ar@messagetest.com',
          invoiceId: 'INV-2025-MSG',
          invoiceAmount: 7500,
          amountDue: 7500,
          currency: 'USD',
          daysOverdue: 8,
          currentLevel: 1,
          history: [],
        },
        schedule: standardSchedule,
      };

      const result = await dunningAgent.execute(createContext(), messageInput);

      expect(result.success).toBe(true);
      const output = result.data as DunningOutput;
      expect(output.generatedMessage).toBeDefined();
      expect(output.generatedMessage.subject).toBeTruthy();
      expect(output.generatedMessage.body).toBeTruthy();
      expect(output.generatedMessage.callToAction).toBeTruthy();
    });
  });
});
