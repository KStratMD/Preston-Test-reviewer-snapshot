/**
 * DunningAgent Unit Tests
 *
 * Tests for the AI Dunning Agent - sentiment-aware collection automation
 */

import { DunningAgent, DunningInput, DunningOutput } from '../../../src/services/ai/orchestrator/agents/DunningAgent';
import { Logger } from '../../../src/utils/Logger';
import type { AgentExecutionContext } from '../../../src/services/ai/orchestrator/interfaces';

describe('DunningAgent', () => {
  const logger = new Logger('DunningAgentTest');
  const agent = new DunningAgent(logger);

  const baseContext: AgentExecutionContext = {
    sessionId: 'test-session',
    userId: 'tester',
    sourceSystem: 'PaymentCentral',
    targetSystem: 'CustomerComms',
    confidenceThreshold: 0.5,
    maxExecutionTime: 15000
  };

  const baseSchedule: DunningInput['schedule'] = {
    levels: [
      { level: 1, daysOverdue: 7, action: 'reminder', tone: 'friendly', emailTemplateId: 'tpl-1' },
      { level: 2, daysOverdue: 14, action: 'warning', tone: 'neutral', emailTemplateId: 'tpl-2' },
      { level: 3, daysOverdue: 30, action: 'final_notice', tone: 'firm', emailTemplateId: 'tpl-3' },
      { level: 4, daysOverdue: 60, action: 'collections', tone: 'final', emailTemplateId: 'tpl-4' }
    ],
    settings: {
      sendEmail: true,
      sendSms: false,
      escalateToCollections: true,
      collectionsDaysThreshold: 90
    }
  };

  describe('Schema Validation', () => {
    it('returns valid agent schema', () => {
      const schema = agent.getSchema();
      expect(schema).toBeDefined();
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.outputSchema.type).toBe('object');
      expect(schema.capabilities).toContain('sentiment_analysis');
      expect(schema.capabilities).toContain('payment_prediction');
      expect(schema.capabilities).toContain('message_generation');
    });
  });

  describe('Input Validation', () => {
    it('rejects input without dunning entry', async () => {
      const input = { schedule: baseSchedule };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(false);
    });

    it('rejects input without schedule levels', async () => {
      const input = {
        dunningEntry: {
          id: 'dun-1',
          customerId: 'cust-1',
          customerName: 'Test Customer',
          customerEmail: 'test@example.com',
          invoiceId: 'inv-1',
          invoiceAmount: 1000,
          amountDue: 1000,
          currency: 'USD',
          daysOverdue: 15,
          currentLevel: 1,
          history: []
        },
        schedule: { levels: [], settings: baseSchedule.settings }
      };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(false);
    });

    it('accepts valid dunning input', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-1',
          customerId: 'cust-1',
          customerName: 'Test Customer',
          customerEmail: 'test@example.com',
          invoiceId: 'INV-12345',
          invoiceAmount: 1500,
          amountDue: 1500,
          currency: 'USD',
          daysOverdue: 15,
          currentLevel: 1,
          history: []
        },
        schedule: baseSchedule
      };
      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('Sentiment Analysis', () => {
    it('returns positive sentiment for customers with good payment history', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-1',
          customerId: 'cust-1',
          customerName: 'Reliable Customer',
          customerEmail: 'reliable@example.com',
          invoiceId: 'INV-001',
          invoiceAmount: 500,
          amountDue: 500,
          currency: 'USD',
          daysOverdue: 10,
          currentLevel: 1,
          history: [
            { timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'Initial reminder', responseReceived: 'Will pay soon' }
          ]
        },
        customerProfile: {
          totalInvoices: 50,
          paidOnTime: 48,
          averagePaymentDays: 5,
          totalRevenue: 75000,
          customerSince: Date.now() - 3 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 2,
          paymentPlanHistory: false
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.customerSentiment).toBe('positive');
    });

    it('returns negative sentiment for customers with disputes', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-2',
          customerId: 'cust-2',
          customerName: 'Disputing Customer',
          customerEmail: 'dispute@example.com',
          invoiceId: 'INV-002',
          invoiceAmount: 2000,
          amountDue: 2000,
          currency: 'USD',
          daysOverdue: 30,
          currentLevel: 2,
          history: [
            { timestamp: Date.now() - 20 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'First reminder' },
            { timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, action: 'customer_response', details: 'Customer replied', responseReceived: 'I dispute this invoice, wrong amount charged' }
          ]
        },
        customerProfile: {
          totalInvoices: 10,
          paidOnTime: 4,
          averagePaymentDays: 25,
          totalRevenue: 15000,
          customerSince: Date.now() - 1 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 0,
          paymentPlanHistory: false
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.customerSentiment).toBe('negative');
    });
  });

  describe('Payment Likelihood', () => {
    it('calculates higher likelihood for short overdue with good history', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-3',
          customerId: 'cust-3',
          customerName: 'Good Customer',
          customerEmail: 'good@example.com',
          invoiceId: 'INV-003',
          invoiceAmount: 500,
          amountDue: 500,
          currency: 'USD',
          daysOverdue: 10,
          currentLevel: 1,
          history: [
            { timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'Reminder', responseReceived: 'Will arrange payment' }
          ]
        },
        customerProfile: {
          totalInvoices: 20,
          paidOnTime: 19,
          averagePaymentDays: 7,
          totalRevenue: 30000,
          customerSince: Date.now() - 2 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 1,
          paymentPlanHistory: false
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeGreaterThan(0.6);
    });

    it('calculates lower likelihood for long overdue with no response', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-4',
          customerId: 'cust-4',
          customerName: 'Silent Customer',
          customerEmail: 'silent@example.com',
          invoiceId: 'INV-004',
          invoiceAmount: 5000,
          amountDue: 5000,
          currency: 'USD',
          daysOverdue: 75,
          currentLevel: 3,
          history: [
            { timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'First reminder' },
            { timestamp: Date.now() - 45 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'Second reminder' },
            { timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, action: 'warning_sent', details: 'Warning notice' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.paymentLikelihood).toBeLessThan(0.5);
    });
  });

  describe('Churn Risk Assessment', () => {
    it('returns higher churn risk for negative sentiment and aggressive dunning', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-5',
          customerId: 'cust-5',
          customerName: 'At-Risk Customer',
          customerEmail: 'atrisk@example.com',
          invoiceId: 'INV-005',
          invoiceAmount: 3000,
          amountDue: 3000,
          currency: 'USD',
          daysOverdue: 45,
          currentLevel: 3,
          history: [
            { timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, action: 'customer_response', details: 'Angry response', responseReceived: 'This is wrong, I want to cancel my service' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.churnRisk).toBeGreaterThan(0.5);
    });

    it('returns lower churn risk for valuable long-term customers', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-6',
          customerId: 'cust-6',
          customerName: 'VIP Customer',
          customerEmail: 'vip@example.com',
          invoiceId: 'INV-006',
          invoiceAmount: 1000,
          amountDue: 1000,
          currency: 'USD',
          daysOverdue: 15,
          currentLevel: 1,
          history: []
        },
        customerProfile: {
          totalInvoices: 100,
          paidOnTime: 95,
          averagePaymentDays: 10,
          totalRevenue: 250000,
          customerSince: Date.now() - 5 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 5,
          paymentPlanHistory: true
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.sentimentAnalysis.churnRisk).toBeLessThan(0.4);
    });
  });

  describe('Message Generation', () => {
    it('generates friendly message for first reminder', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-7',
          customerId: 'cust-7',
          customerName: 'New Overdue',
          customerEmail: 'newoverdue@example.com',
          invoiceId: 'INV-007',
          invoiceAmount: 750,
          amountDue: 750,
          currency: 'USD',
          daysOverdue: 8,
          currentLevel: 1,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.generatedMessage.subject).toContain('INV-007');
      expect(result.data?.generatedMessage.body).toContain('New Overdue');
      expect(result.data?.generatedMessage.body.toLowerCase()).toContain('appreciate');
    });

    it('generates firm message for late-stage dunning', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-8',
          customerId: 'cust-8',
          customerName: 'Late Stage Customer',
          customerEmail: 'late@example.com',
          invoiceId: 'INV-008',
          invoiceAmount: 2500,
          amountDue: 2500,
          currency: 'USD',
          daysOverdue: 35,
          currentLevel: 3,
          history: [
            { timestamp: Date.now() - 28 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'First' },
            { timestamp: Date.now() - 21 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'Second' },
            { timestamp: Date.now() - 14 * 24 * 60 * 60 * 1000, action: 'warning_sent', details: 'Warning' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.generatedMessage.subject.toLowerCase()).toContain('urgent');
    });

    it('includes payment plan offer for high-value overdue invoices', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-9',
          customerId: 'cust-9',
          customerName: 'High Value Customer',
          customerEmail: 'highvalue@example.com',
          invoiceId: 'INV-009',
          invoiceAmount: 15000,
          amountDue: 15000,
          currency: 'USD',
          daysOverdue: 45,
          currentLevel: 2,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.generatedMessage.body.toLowerCase()).toContain('payment arrangement');
    });
  });

  describe('Action Recommendations', () => {
    it('recommends pause for disputed invoices', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-10',
          customerId: 'cust-10',
          customerName: 'Dispute Customer',
          customerEmail: 'dispute2@example.com',
          invoiceId: 'INV-010',
          invoiceAmount: 1200,
          amountDue: 1200,
          currency: 'USD',
          daysOverdue: 20,
          currentLevel: 2,
          history: [
            { timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000, action: 'customer_response', details: 'Dispute filed', responseReceived: 'I dispute this charge' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendedAction).toBe('pause');
    });

    it('recommends escalation for severely overdue accounts', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-11',
          customerId: 'cust-11',
          customerName: 'Delinquent Customer',
          customerEmail: 'delinquent@example.com',
          invoiceId: 'INV-011',
          invoiceAmount: 5000,
          amountDue: 5000,
          currency: 'USD',
          daysOverdue: 100,
          currentLevel: 4,
          history: [
            { timestamp: Date.now() - 90 * 24 * 60 * 60 * 1000, action: 'final_notice', details: 'Final notice sent' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendedAction).toBe('escalate');
    });

    it('recommends payment plan for high churn risk customers', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-12',
          customerId: 'cust-12',
          customerName: 'Churn Risk Customer',
          customerEmail: 'churnrisk@example.com',
          invoiceId: 'INV-012',
          invoiceAmount: 3000,
          amountDue: 3000,
          currency: 'USD',
          daysOverdue: 45,
          currentLevel: 2,
          history: [
            { timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, action: 'customer_response', details: 'Response', responseReceived: 'Having cash flow issues, will try to pay soon' }
          ]
        },
        customerProfile: {
          totalInvoices: 30,
          paidOnTime: 25,
          averagePaymentDays: 12,
          totalRevenue: 50000,
          customerSince: Date.now() - 2 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 1,
          paymentPlanHistory: true
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      // Should recommend payment plan due to high churn risk + payment likelihood + high amount
      expect(['offer_payment_plan', 'send_email']).toContain(result.data?.recommendedAction);
    });

    it('recommends skip if action was taken too recently', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-13',
          customerId: 'cust-13',
          customerName: 'Recent Action Customer',
          customerEmail: 'recent@example.com',
          invoiceId: 'INV-013',
          invoiceAmount: 800,
          amountDue: 800,
          currency: 'USD',
          daysOverdue: 12,
          currentLevel: 1,
          history: [
            { timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000, action: 'reminder_sent', details: 'Just sent yesterday' }
          ]
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendedAction).toBe('skip');
    });
  });

  describe('Escalation Planning', () => {
    it('plans next escalation level correctly', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-14',
          customerId: 'cust-14',
          customerName: 'Escalation Test',
          customerEmail: 'escalation@example.com',
          invoiceId: 'INV-014',
          invoiceAmount: 1500,
          amountDue: 1500,
          currency: 'USD',
          daysOverdue: 18,
          currentLevel: 2,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.escalationPath.nextLevel).toBe(3);
      expect(result.data?.escalationPath.nextAction).toBe('final_notice');
    });

    it('suggests collections referral at max level', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-15',
          customerId: 'cust-15',
          customerName: 'Max Level Customer',
          customerEmail: 'maxlevel@example.com',
          invoiceId: 'INV-015',
          invoiceAmount: 8000,
          amountDue: 8000,
          currency: 'USD',
          daysOverdue: 80,
          currentLevel: 4,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.escalationPath.nextAction).toBe('collections_referral');
    });
  });

  describe('Recommendations Generation', () => {
    it('generates relevant recommendations based on customer data', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-16',
          customerId: 'cust-16',
          customerName: 'Recommendation Test',
          customerEmail: 'recommend@example.com',
          invoiceId: 'INV-016',
          invoiceAmount: 6000,
          amountDue: 6000,
          currency: 'USD',
          daysOverdue: 25,
          currentLevel: 2,
          history: []
        },
        customerProfile: {
          totalInvoices: 40,
          paidOnTime: 38,
          averagePaymentDays: 8,
          totalRevenue: 120000,
          customerSince: Date.now() - 4 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 2,
          paymentPlanHistory: true
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      expect(result.data?.recommendations).toBeDefined();
      expect(result.data?.recommendations.length).toBeGreaterThan(0);
      // Should mention payment plan history
      const hasPaymentPlanRec = result.data?.recommendations.some(r =>
        r.toLowerCase().includes('payment plan')
      );
      expect(hasPaymentPlanRec).toBe(true);
    });

    it('recommends first contact approach for new dunning cycles', async () => {
      const input: DunningInput = {
        dunningEntry: {
          id: 'dun-17',
          customerId: 'cust-17',
          customerName: 'First Contact',
          customerEmail: 'firstcontact@example.com',
          invoiceId: 'INV-017',
          invoiceAmount: 400,
          amountDue: 400,
          currency: 'USD',
          daysOverdue: 8,
          currentLevel: 1,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, input);
      expect(result.success).toBe(true);
      const hasFirstContactRec = result.data?.recommendations.some(r =>
        r.toLowerCase().includes('first')
      );
      expect(hasFirstContactRec).toBe(true);
    });
  });

  describe('Confidence Calculation', () => {
    it('returns higher confidence with complete customer profile', async () => {
      const inputWithProfile: DunningInput = {
        dunningEntry: {
          id: 'dun-18a',
          customerId: 'cust-18a',
          customerName: 'Profile Customer',
          customerEmail: 'profile@example.com',
          invoiceId: 'INV-018A',
          invoiceAmount: 1000,
          amountDue: 1000,
          currency: 'USD',
          daysOverdue: 15,
          currentLevel: 1,
          history: [
            { timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, action: 'reminder', details: 'Sent' },
            { timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, action: 'response', details: 'Got response', responseReceived: 'OK' }
          ]
        },
        customerProfile: {
          totalInvoices: 50,
          paidOnTime: 45,
          averagePaymentDays: 10,
          totalRevenue: 80000,
          customerSince: Date.now() - 3 * 365 * 24 * 60 * 60 * 1000,
          previousDunningResponses: 3,
          paymentPlanHistory: true
        },
        schedule: baseSchedule
      };

      const inputWithoutProfile: DunningInput = {
        dunningEntry: {
          id: 'dun-18b',
          customerId: 'cust-18b',
          customerName: 'No Profile Customer',
          customerEmail: 'noprofile@example.com',
          invoiceId: 'INV-018B',
          invoiceAmount: 1000,
          amountDue: 1000,
          currency: 'USD',
          daysOverdue: 15,
          currentLevel: 1,
          history: []
        },
        schedule: baseSchedule
      };

      const resultWithProfile = await agent.execute(baseContext, inputWithProfile);
      const resultWithoutProfile = await agent.execute(baseContext, inputWithoutProfile);

      expect(resultWithProfile.success).toBe(true);
      expect(resultWithoutProfile.success).toBe(true);
      expect(resultWithProfile.confidence).toBeGreaterThan(resultWithoutProfile.confidence);
    });
  });

  describe('Currency Formatting', () => {
    it('formats amounts correctly for different currencies', async () => {
      const inputEUR: DunningInput = {
        dunningEntry: {
          id: 'dun-19',
          customerId: 'cust-19',
          customerName: 'Euro Customer',
          customerEmail: 'euro@example.com',
          invoiceId: 'INV-019',
          invoiceAmount: 1500,
          amountDue: 1500,
          currency: 'EUR',
          daysOverdue: 10,
          currentLevel: 1,
          history: []
        },
        schedule: baseSchedule
      };

      const result = await agent.execute(baseContext, inputEUR);
      expect(result.success).toBe(true);
      // EUR formatting should contain the euro symbol or "EUR"
      expect(result.data?.generatedMessage.body).toMatch(/€|EUR/);
    });
  });
});
