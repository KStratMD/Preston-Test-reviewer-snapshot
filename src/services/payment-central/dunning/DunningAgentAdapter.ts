import type { DunningEntry, DunningSchedule } from '../../../types/paymentCentral';
import type { DunningInput, DunningOutput } from '../../ai/orchestrator/agents/DunningAgent';
import type { AgentExecutionContext } from '../../ai/orchestrator/interfaces';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';

/**
 * Adapter that encapsulates all interaction with DunningAgent.
 * DunningService calls this adapter; this file is the sole place that
 * instantiates and calls DunningAgent. (DunningService imports the
 * `DunningOutput` type alone for return-type annotations on its public methods.)
 */
export class DunningAgentAdapter {
  constructor(private readonly runtime: PaymentCentralRuntime) {}

  /**
   * Build the DunningInput, call the agent, and return the normalized output.
   *
   * @param mode 'preview' for analyzeDunningEntry (read-only), 'send' for sendDunningReminder.
   *
   * Note: The two call sites in the original facade had a subtle difference in how they
   * mapped DunningAction.responseReceived:
   *   - analyze path: `h.responseReceived || h.customerResponse`
   *   - send path:    `h.customerResponse`
   * The adapter preserves both behaviours via the `mode` parameter.
   *
   * Returns null when the agent is unavailable or the schedule is missing.
   */
  async analyze(
    entry: DunningEntry,
    schedule: DunningSchedule,
    mode: 'preview' | 'send',
  ): Promise<DunningOutput | null> {
    if (!this.runtime.dunningAgent) {
      return null;
    }

    const agentInput: DunningInput = {
      dunningEntry: {
        id: entry.id,
        customerId: entry.customerId,
        customerName: entry.customerName,
        customerEmail: entry.customerEmail,
        invoiceId: entry.invoiceId,
        invoiceAmount: entry.invoiceAmount,
        amountDue: entry.amountDue,
        currency: entry.currency,
        daysOverdue: entry.daysOverdue,
        currentLevel: entry.currentLevel,
        history: entry.history.map(h => ({
          timestamp: h.timestamp,
          action: h.action,
          details: h.details || '',
          responseReceived: mode === 'preview'
            ? (h.responseReceived || h.customerResponse)
            : h.customerResponse,
        })),
      },
      schedule: {
        levels: schedule.levels.map(l => ({
          level: l.level,
          daysOverdue: l.daysOverdue,
          action: l.action as 'reminder' | 'warning' | 'final_notice' | 'collections',
          tone: l.tone as 'friendly' | 'neutral' | 'firm' | 'final',
          emailTemplateId: l.emailTemplateId,
        })),
        settings: {
          sendEmail: schedule.settings.sendEmail,
          sendSms: schedule.settings.sendSms,
          escalateToCollections: schedule.settings.escalateToCollections,
          collectionsDaysThreshold: schedule.settings.collectionsDaysThreshold || 90,
        },
      },
    };

    const sessionId = mode === 'preview'
      ? `dunning-analyze-${entry.id}-${this.runtime.now()}`
      : `dunning-${entry.id}-${this.runtime.now()}`;

    const context: AgentExecutionContext = {
      sessionId,
      userId: 'system',
      correlationId: entry.id,
    };

    const result = await this.runtime.dunningAgent.execute(context, agentInput);

    if (result.success && result.data) {
      return result.data as DunningOutput;
    }

    return null;
  }
}
