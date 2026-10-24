/**
 * PaymentCentral Portal E2E Flow Tests
 *
 * End-to-end tests for complete payment processing workflows:
 * - Transaction → reconciliation → GL posting flow
 * - Complete dunning cycle from overdue detection to resolution
 * - Integration with DunningAgent
 */

import 'reflect-metadata';
import { DunningAgent } from '../../../src/services/ai/orchestrator/agents/DunningAgent';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';
import type { DunningInput } from '../../../src/services/ai/orchestrator/agents/DunningAgent';

describe('PaymentCentral E2E Flow', () => {
  let dunningAgent: DunningAgent;

  beforeAll(() => {
    dunningAgent = new DunningAgent();
  });

  // Base context for agent execution (BaseAgent pattern - two params)
  const baseContext: AgentExecutionContext = {
    sessionId: 'e2e-payment-session',
    userId: 'e2e-payment-user',
    sourceSystem: 'PaymentCentral',
    targetSystem: 'NetSuite',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
  };

  // Standard dunning schedule configuration
  const createSchedule = (collectionsDaysThreshold: number = 60) => ({
    levels: [
      { level: 0, daysOverdue: 1, action: 'reminder' as const, tone: 'friendly' as const, emailTemplateId: 'tpl-friendly' },
      { level: 1, daysOverdue: 15, action: 'reminder' as const, tone: 'neutral' as const, emailTemplateId: 'tpl-neutral' },
      { level: 2, daysOverdue: 30, action: 'warning' as const, tone: 'firm' as const, emailTemplateId: 'tpl-firm' },
      { level: 3, daysOverdue: 45, action: 'final_notice' as const, tone: 'final' as const, emailTemplateId: 'tpl-final' },
      { level: 4, daysOverdue: 60, action: 'collections' as const, tone: 'final' as const, emailTemplateId: 'tpl-collections' },
    ],
    settings: {
      sendEmail: true,
      sendSms: false,
      escalateToCollections: true,
      collectionsDaysThreshold,
    },
  });

  describe('Complete Dunning Cycle', () => {
    it('processes early-stage overdue invoice (gentle reminder)', async () => {
      // Step 1: Invoice just became overdue (5 days)
      const earlyDunningInput: DunningInput = {
        dunningEntry: {
          id: 'dun-001',
          customerId: 'cust-001',
          customerName: 'Reliable Customer Corp',
          customerEmail: 'billing@reliable.com',
          invoiceId: 'INV-2025-001',
          invoiceAmount: 5000,
          amountDue: 5000,
          currency: 'USD',
          daysOverdue: 5,
          currentLevel: 0,
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
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, earlyDunningInput);

      expect(result.success).toBe(true);
      expect(['send_email', 'send_sms', 'skip']).toContain(result.data?.recommendedAction);
      expect(['friendly', 'neutral']).toContain(result.data?.recommendedTone);
      expect(result.data?.generatedMessage).toBeDefined();
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.5);
    });

    it('processes mid-stage overdue invoice (firm reminder)', async () => {
      // Step 2: Invoice overdue for 15 days with one ignored reminder
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
          daysOverdue: 15,
          currentLevel: 1,
          history: [
            {
              timestamp: Date.now() - (10 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder email sent',
            },
          ],
        },
        customerProfile: {
          totalInvoices: 20,
          paidOnTime: 12,
          averagePaymentDays: 45,
          totalRevenue: 100000,
          customerSince: Date.now() - (365 * 24 * 60 * 60 * 1000), // 1 year ago
          previousDunningResponses: 0,
          paymentPlanHistory: false,
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, midDunningInput);

      expect(result.success).toBe(true);
      expect(result.data?.recommendedAction).toBeDefined();
      expect(['neutral', 'firm']).toContain(result.data?.recommendedTone);
    });

    it('processes late-stage overdue invoice (urgent escalation)', async () => {
      // Step 3: Invoice severely overdue (35+ days)
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
          daysOverdue: 35,
          currentLevel: 2,
          history: [
            {
              timestamp: Date.now() - (30 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder email sent',
            },
            {
              timestamp: Date.now() - (20 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'Second reminder email sent',
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
          customerSince: Date.now() - (180 * 24 * 60 * 60 * 1000), // 6 months ago
          previousDunningResponses: 0,
          paymentPlanHistory: false,
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, lateDunningInput);

      expect(result.success).toBe(true);
      expect(result.data?.recommendedAction).toBeDefined();
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeLessThan(0.6);
      expect(result.data?.sentimentAnalysis.churnRisk).toBeGreaterThan(0.2);
    });

    it('processes final notice before collections', async () => {
      // Step 4: Final notice stage (past collections threshold)
      const finalDunningInput: DunningInput = {
        dunningEntry: {
          id: 'dun-004',
          customerId: 'cust-004',
          customerName: 'Delinquent Corp',
          customerEmail: 'ar@delinquent.com',
          invoiceId: 'INV-2025-004',
          invoiceAmount: 15000,
          amountDue: 15000,
          currency: 'USD',
          daysOverdue: 65, // Past 60-day collections threshold
          currentLevel: 3,
          history: [
            { timestamp: Date.now() - (60 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'First reminder' },
            { timestamp: Date.now() - (45 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'Second reminder' },
            { timestamp: Date.now() - (30 * 24 * 60 * 60 * 1000), action: 'phone_call', details: 'Phone call' },
            { timestamp: Date.now() - (15 * 24 * 60 * 60 * 1000), action: 'final_notice', details: 'Final notice sent' },
          ],
        },
        schedule: createSchedule(60),
      };

      const result = await dunningAgent.execute(baseContext, finalDunningInput);

      expect(result.success).toBe(true);
      // Past collections threshold should recommend escalation
      expect(['escalate', 'send_email', 'pause']).toContain(result.data?.recommendedAction);
      expect(['firm', 'final']).toContain(result.data?.recommendedTone);
    });
  });

  describe('Customer Sentiment Scenarios', () => {
    it('handles responsive customer with payment promise', async () => {
      const responsiveInput: DunningInput = {
        dunningEntry: {
          id: 'dun-responsive',
          customerId: 'cust-responsive',
          customerName: 'Responsive Customer',
          customerEmail: 'billing@responsive.com',
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
              details: 'First reminder sent',
              responseReceived: 'Will pay by end of week, arranging funds now',
            },
          ],
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, responsiveInput);

      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.customerSentiment).toBe('positive');
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.5);
    });

    it('handles disputing customer', async () => {
      const disputingInput: DunningInput = {
        dunningEntry: {
          id: 'dun-disputing',
          customerId: 'cust-disputing',
          customerName: 'Disputing Customer',
          customerEmail: 'legal@disputing.com',
          invoiceId: 'INV-2025-D1',
          invoiceAmount: 12000,
          amountDue: 12000,
          currency: 'USD',
          daysOverdue: 20,
          currentLevel: 1,
          history: [
            {
              timestamp: Date.now() - (15 * 24 * 60 * 60 * 1000),
              action: 'customer_response',
              details: 'Customer responded to reminder',
              responseReceived: 'This invoice is wrong, we dispute these charges',
            },
          ],
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, disputingInput);

      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.customerSentiment).toBe('negative');
      // Should recommend pause due to dispute
      expect(result.data?.recommendedAction).toBe('pause');
      expect(result.data?.recommendations.some(r =>
        r.toLowerCase().includes('dispute') || r.toLowerCase().includes('review')
      )).toBe(true);
    });

    it('handles high-value customer with payment history', async () => {
      const highValueInput: DunningInput = {
        dunningEntry: {
          id: 'dun-highvalue',
          customerId: 'cust-highvalue',
          customerName: 'Premium Enterprise Client',
          customerEmail: 'finance@premium.com',
          invoiceId: 'INV-2025-HV1',
          invoiceAmount: 100000,
          amountDue: 100000,
          currency: 'USD',
          daysOverdue: 7,
          currentLevel: 0,
          history: [],
        },
        customerProfile: {
          totalInvoices: 100,
          paidOnTime: 98,
          averagePaymentDays: 25,
          totalRevenue: 2000000, // $2M customer
          customerSince: Date.now() - (1825 * 24 * 60 * 60 * 1000), // 5 years ago
          previousDunningResponses: 5,
          paymentPlanHistory: false,
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, highValueInput);

      expect(result.success).toBe(true);
      // Should treat high-value customers more gently
      expect(result.data?.recommendedTone).toBe('friendly');
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.6);
      expect(result.data?.sentimentAnalysis.churnRisk).toBeLessThan(0.4);
    });
  });

  describe('Escalation Path Recommendations', () => {
    it('recommends appropriate escalation timeline', async () => {
      const escalationInput: DunningInput = {
        dunningEntry: {
          id: 'dun-escalation',
          customerId: 'cust-escalation',
          customerName: 'Escalation Test Corp',
          customerEmail: 'ar@escalation.com',
          invoiceId: 'INV-2025-E1',
          invoiceAmount: 20000,
          amountDue: 20000,
          currency: 'USD',
          daysOverdue: 14,
          currentLevel: 1,
          history: [
            {
              timestamp: Date.now() - (7 * 24 * 60 * 60 * 1000),
              action: 'email_sent',
              details: 'First reminder sent',
            },
          ],
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, escalationInput);

      expect(result.success).toBe(true);
      expect(result.data?.escalationPath).toBeDefined();
      expect(result.data?.escalationPath.nextLevel).toBe(2);
      expect(result.data?.escalationPath.suggestedDate).toBeGreaterThan(Date.now());
    });

    it('handles max escalation level', async () => {
      const maxEscalationInput: DunningInput = {
        dunningEntry: {
          id: 'dun-max-escalation',
          customerId: 'cust-max-escalation',
          customerName: 'Max Escalation Corp',
          customerEmail: 'collections@max.com',
          invoiceId: 'INV-2025-MAX',
          invoiceAmount: 30000,
          amountDue: 30000,
          currency: 'USD',
          daysOverdue: 70, // Past collections threshold
          currentLevel: 4, // Max level
          history: [
            { timestamp: Date.now() - (65 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'First reminder' },
            { timestamp: Date.now() - (50 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'Second reminder' },
            { timestamp: Date.now() - (35 * 24 * 60 * 60 * 1000), action: 'phone_call', details: 'Phone call' },
            { timestamp: Date.now() - (20 * 24 * 60 * 60 * 1000), action: 'final_notice', details: 'Final notice' },
            { timestamp: Date.now() - (10 * 24 * 60 * 60 * 1000), action: 'legal_notice', details: 'Legal notice sent' },
          ],
        },
        schedule: createSchedule(60),
      };

      const result = await dunningAgent.execute(baseContext, maxEscalationInput);

      expect(result.success).toBe(true);
      // At max level, escalation path should recommend collections referral
      expect(result.data?.escalationPath.nextAction).toBe('collections_referral');
      // Past collections threshold should recommend escalate
      expect(['escalate', 'send_email']).toContain(result.data?.recommendedAction);
    });
  });

  describe('Generated Message Quality', () => {
    it('generates personalized message with invoice details', async () => {
      const messageInput: DunningInput = {
        dunningEntry: {
          id: 'dun-message',
          customerId: 'cust-message',
          customerName: 'Message Test Inc',
          customerEmail: 'billing@messagetest.com',
          invoiceId: 'INV-2025-MSG',
          invoiceAmount: 7500,
          amountDue: 7500,
          currency: 'USD',
          daysOverdue: 8,
          currentLevel: 0,
          history: [],
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, messageInput);

      expect(result.success).toBe(true);
      expect(result.data?.generatedMessage).toBeDefined();

      const message = result.data?.generatedMessage;
      expect(message?.subject).toContain('INV-2025-MSG');
      expect(message?.body).toContain('Message Test Inc');
      expect(message?.body).toContain('$7,500');
    });

    it('adjusts message tone based on escalation level', async () => {
      const urgentInput: DunningInput = {
        dunningEntry: {
          id: 'dun-urgent',
          customerId: 'cust-urgent',
          customerName: 'Urgent Case Corp',
          customerEmail: 'urgent@case.com',
          invoiceId: 'INV-2025-URG',
          invoiceAmount: 50000,
          amountDue: 50000,
          currency: 'USD',
          daysOverdue: 45,
          currentLevel: 3,
          history: [
            { timestamp: Date.now() - (40 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'First reminder' },
            { timestamp: Date.now() - (30 * 24 * 60 * 60 * 1000), action: 'email_sent', details: 'Second reminder' },
            { timestamp: Date.now() - (20 * 24 * 60 * 60 * 1000), action: 'phone_call', details: 'Phone call' },
          ],
        },
        schedule: createSchedule(),
      };

      const result = await dunningAgent.execute(baseContext, urgentInput);

      expect(result.success).toBe(true);
      // Level 3 in schedule has 'final' tone
      expect(['firm', 'final', 'neutral']).toContain(result.data?.recommendedTone);

      const message = result.data?.generatedMessage;
      // Final/firm messages should contain stronger language
      const messageText = `${message?.subject} ${message?.body}`.toLowerCase();
      expect(
        messageText.includes('immediate') ||
        messageText.includes('urgent') ||
        messageText.includes('overdue') ||
        messageText.includes('final') ||
        messageText.includes('promptly')
      ).toBe(true);
    });
  });
});
