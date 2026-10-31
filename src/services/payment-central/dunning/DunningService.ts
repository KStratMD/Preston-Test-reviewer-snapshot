import type {
  DunningSchedule,
  DunningEntry,
  DunningAction,
  DunningStatistics,
  DunningEntryFilters,
  DunningEntryListResult,
} from '../../../types/paymentCentral';
import type { DunningOutput } from '../../ai/orchestrator/agents/DunningAgent';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';
import { DunningAgentAdapter } from './DunningAgentAdapter';

/**
 * Service owning dunning schedules, entries, and automation.
 * Delegates all DunningAgent interaction to DunningAgentAdapter.
 */
export class DunningService {
  private dunningSchedules = new Map<string, DunningSchedule>();
  private dunningEntries = new Map<string, DunningEntry>();

  constructor(
    private readonly runtime: PaymentCentralRuntime,
    private readonly adapter: DunningAgentAdapter,
  ) {}

  // ==================== Seeding ====================

  seedDemo(): void {
    this.initializeDunningDemoData();
  }

  // ==================== DUNNING AUTOMATION METHODS ====================

  /**
   * Get all dunning schedules
   */
  async getDunningSchedules(): Promise<DunningSchedule[]> {
    return Array.from(this.dunningSchedules.values());
  }

  /**
   * Get a dunning schedule by ID
   */
  async getDunningSchedule(scheduleId: string): Promise<DunningSchedule | null> {
    return this.dunningSchedules.get(scheduleId) || null;
  }

  /**
   * Create or update a dunning schedule
   */
  async saveDunningSchedule(schedule: Omit<DunningSchedule, 'id' | 'createdAt' | 'updatedAt'>): Promise<DunningSchedule> {
    const id = this.runtime.createId('schedule', 6);
    const now = this.runtime.now();

    const fullSchedule: DunningSchedule = {
      ...schedule,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.dunningSchedules.set(id, fullSchedule);

    this.runtime.logger.info('Dunning schedule created', {
      scheduleId: id,
      name: schedule.name,
      levels: schedule.levels.length,
    });

    return fullSchedule;
  }

  /**
   * Update a dunning schedule
   */
  async updateDunningSchedule(scheduleId: string, updates: Partial<DunningSchedule>): Promise<DunningSchedule | null> {
    const existing = this.dunningSchedules.get(scheduleId);
    if (!existing) {
      return null;
    }

    const updated: DunningSchedule = {
      ...existing,
      ...updates,
      id: scheduleId,
      createdAt: existing.createdAt,
      updatedAt: this.runtime.now(),
    };

    this.dunningSchedules.set(scheduleId, updated);

    this.runtime.logger.info('Dunning schedule updated', { scheduleId });

    return updated;
  }

  /**
   * Delete a dunning schedule
   */
  async deleteDunningSchedule(scheduleId: string): Promise<boolean> {
    const deleted = this.dunningSchedules.delete(scheduleId);
    if (deleted) {
      this.runtime.logger.info('Dunning schedule deleted', { scheduleId });
    }
    return deleted;
  }

  /**
   * Get dunning entries with filtering
   */
  async getDunningEntries(filters: DunningEntryFilters = {}): Promise<DunningEntryListResult> {
    let entries = Array.from(this.dunningEntries.values());

    if (filters.scheduleId) {
      entries = entries.filter(e => e.scheduleId === filters.scheduleId);
    }

    if (filters.status && filters.status.length > 0) {
      entries = entries.filter(e => filters.status!.includes(e.status));
    }

    if (filters.level && filters.level.length > 0) {
      entries = entries.filter(e => filters.level!.includes(e.currentLevel));
    }

    if (filters.daysOverdueMin !== undefined) {
      entries = entries.filter(e => e.daysOverdue >= filters.daysOverdueMin!);
    }

    if (filters.daysOverdueMax !== undefined) {
      entries = entries.filter(e => e.daysOverdue <= filters.daysOverdueMax!);
    }

    if (filters.amountMin !== undefined) {
      entries = entries.filter(e => e.amountDue >= filters.amountMin!);
    }

    if (filters.amountMax !== undefined) {
      entries = entries.filter(e => e.amountDue <= filters.amountMax!);
    }

    if (filters.customerId) {
      entries = entries.filter(e => e.customerId === filters.customerId);
    }

    const totalCount = entries.length;

    // Sort by days overdue descending
    entries.sort((a, b) => b.daysOverdue - a.daysOverdue);

    // Apply pagination
    if (filters.offset !== undefined) {
      entries = entries.slice(filters.offset);
    }

    if (filters.limit !== undefined) {
      entries = entries.slice(0, filters.limit);
    }

    return { entries, totalCount };
  }

  /**
   * Get a single dunning entry by ID
   */
  async getDunningEntry(entryId: string): Promise<DunningEntry | null> {
    return this.dunningEntries.get(entryId) || null;
  }

  /**
   * Analyze a dunning entry with AI (preview mode - no state mutation)
   * Returns AI recommendations without sending or modifying the entry
   */
  async analyzeDunningEntry(entryId: string): Promise<{
    success: boolean;
    message: string;
    aiAnalysis?: DunningOutput;
  }> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry) {
      return { success: false, message: 'Dunning entry not found' };
    }

    const schedule = this.dunningSchedules.get(entry.scheduleId);
    if (!this.runtime.dunningAgent || !schedule) {
      return { success: false, message: 'AI analysis not available (no agent or schedule)' };
    }

    try {
      const output = await this.adapter.analyze(entry, schedule, 'preview');

      if (output) {
        return {
          success: true,
          message: 'AI analysis completed',
          aiAnalysis: output,
        };
      }

      return { success: false, message: 'AI analysis returned no data' };
    } catch (error) {
      this.runtime.logger.warn('DunningAgent analysis failed', {
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: error instanceof Error ? error.message : 'AI analysis failed',
      };
    }
  }

  /**
   * Send a dunning reminder for an entry
   * Uses DunningAgent for AI-powered message generation when available
   */
  async sendDunningReminder(entryId: string): Promise<{
    success: boolean;
    message: string;
    aiAnalysis?: DunningOutput;
  }> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry) {
      return { success: false, message: 'Dunning entry not found' };
    }

    if (entry.status === 'paid' || entry.status === 'cancelled') {
      return { success: false, message: `Cannot send reminder for ${entry.status} entry` };
    }

    // Get the associated schedule for agent input
    const schedule = this.dunningSchedules.get(entry.scheduleId);

    let aiAnalysis: DunningOutput | undefined;
    let emailSubject = `Payment Reminder: Invoice ${entry.invoiceId}`;
    let emailBody = `Manual reminder sent for invoice ${entry.invoiceId}`;
    let tone = 'neutral';

    // Use DunningAgent for AI-powered analysis if available
    if (this.runtime.dunningAgent && schedule) {
      try {
        const output = await this.adapter.analyze(entry, schedule, 'send');

        if (output) {
          aiAnalysis = output;
          emailSubject = aiAnalysis.generatedMessage.subject;
          emailBody = aiAnalysis.generatedMessage.body;
          tone = aiAnalysis.recommendedTone;

          this.runtime.logger.info('DunningAgent analysis completed', {
            entryId,
            recommendedAction: aiAnalysis.recommendedAction,
            recommendedTone: aiAnalysis.recommendedTone,
            paymentLikelihood: aiAnalysis.sentimentAnalysis.paymentLikelihood,
            churnRisk: aiAnalysis.sentimentAnalysis.churnRisk,
          });
        }
      } catch (error) {
        this.runtime.logger.warn('DunningAgent analysis failed, using default message', {
          entryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Record the action with AI analysis metadata
    const action: DunningAction = {
      timestamp: this.runtime.now(),
      level: entry.currentLevel,
      action: 'email_sent',
      details: `Subject: ${emailSubject}\n\n${emailBody}`,
      sentTo: entry.customerEmail,
      ...(aiAnalysis && {
        aiGenerated: true,
        aiTone: tone,
        aiPaymentLikelihood: aiAnalysis.sentimentAnalysis.paymentLikelihood,
        aiChurnRisk: aiAnalysis.sentimentAnalysis.churnRisk,
      }),
    };

    entry.history.push(action);
    entry.status = 'sent';
    entry.nextActionDate = aiAnalysis?.escalationPath.suggestedDate ||
      (this.runtime.now() + 7 * 24 * 60 * 60 * 1000);

    this.dunningEntries.set(entryId, entry);

    this.runtime.logger.info('Dunning reminder sent', {
      entryId,
      invoiceId: entry.invoiceId,
      customerId: entry.customerId,
      level: entry.currentLevel,
      aiPowered: !!aiAnalysis,
      tone,
    });

    return {
      success: true,
      message: `Reminder sent to ${entry.customerEmail}`,
      aiAnalysis,
    };
  }

  /**
   * Pause dunning for an entry
   */
  async pauseDunning(entryId: string, reason: string): Promise<DunningEntry | null> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry) {
      return null;
    }

    entry.status = 'paused';
    entry.history.push({
      timestamp: this.runtime.now(),
      level: entry.currentLevel,
      action: 'paused',
      details: reason,
    });
    entry.nextActionDate = undefined;

    this.dunningEntries.set(entryId, entry);

    this.runtime.logger.info('Dunning paused', { entryId, reason });

    return entry;
  }

  /**
   * Resume dunning for a paused entry
   */
  async resumeDunning(entryId: string): Promise<DunningEntry | null> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry || entry.status !== 'paused') {
      return null;
    }

    entry.status = 'pending';
    entry.nextActionDate = this.runtime.now() + 24 * 60 * 60 * 1000; // Next day

    this.dunningEntries.set(entryId, entry);

    this.runtime.logger.info('Dunning resumed', { entryId });

    return entry;
  }

  /**
   * Mark an entry as paid
   */
  async markDunningPaid(entryId: string, paymentAmount: number): Promise<DunningEntry | null> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry) {
      return null;
    }

    entry.status = 'paid';
    entry.amountDue = 0;
    entry.history.push({
      timestamp: this.runtime.now(),
      level: entry.currentLevel,
      action: 'payment_received',
      details: `Payment of $${(paymentAmount / 100).toFixed(2)} received`,
      amount: paymentAmount,
    });
    entry.nextActionDate = undefined;

    this.dunningEntries.set(entryId, entry);

    this.runtime.logger.info('Dunning entry marked as paid', {
      entryId,
      invoiceId: entry.invoiceId,
      paymentAmount,
    });

    return entry;
  }

  /**
   * Escalate an entry to collections
   */
  async escalateToCollections(entryId: string): Promise<DunningEntry | null> {
    const entry = this.dunningEntries.get(entryId);
    if (!entry) {
      return null;
    }

    entry.status = 'escalated';
    entry.history.push({
      timestamp: this.runtime.now(),
      level: entry.currentLevel,
      action: 'escalated',
      details: 'Escalated to collections agency',
    });

    this.dunningEntries.set(entryId, entry);

    this.runtime.logger.info('Dunning entry escalated to collections', {
      entryId,
      invoiceId: entry.invoiceId,
      amountDue: entry.amountDue,
    });

    return entry;
  }

  /**
   * Get dunning statistics
   */
  async getDunningStatistics(): Promise<DunningStatistics> {
    const entries = Array.from(this.dunningEntries.values());
    const todayStart = new Date(this.runtime.now()).setHours(0, 0, 0, 0);

    // Calculate by level
    const byLevel = new Map<number, { count: number; amount: number }>();
    for (const entry of entries) {
      if (entry.status !== 'paid' && entry.status !== 'cancelled') {
        const current = byLevel.get(entry.currentLevel) || { count: 0, amount: 0 };
        current.count++;
        current.amount += entry.amountDue;
        byLevel.set(entry.currentLevel, current);
      }
    }

    // Calculate by status
    const byStatus = new Map<string, { count: number; amount: number }>();
    for (const entry of entries) {
      const current = byStatus.get(entry.status) || { count: 0, amount: 0 };
      current.count++;
      current.amount += entry.amountDue;
      byStatus.set(entry.status, current);
    }

    // Count today's activities
    let emailsSentToday = 0;
    let paymentsReceivedToday = 0;
    let paymentsReceivedAmount = 0;

    for (const entry of entries) {
      for (const action of entry.history) {
        if (action.timestamp >= todayStart) {
          if (action.action === 'email_sent') {
            emailsSentToday++;
          }
          if (action.action === 'payment_received') {
            paymentsReceivedToday++;
            paymentsReceivedAmount += action.amount || 0;
          }
        }
      }
    }

    // Calculate totals
    const overdueEntries = entries.filter(e => e.status !== 'paid' && e.status !== 'cancelled');
    const paidEntries = entries.filter(e => e.status === 'paid');
    const escalatedEntries = entries.filter(e => e.status === 'escalated');

    const totalOverdueAmount = overdueEntries.reduce((sum, e) => sum + e.amountDue, 0);

    // Calculate average days to payment for paid entries
    let totalDaysToPayment = 0;
    for (const entry of paidEntries) {
      const paidAction = entry.history.find(a => a.action === 'payment_received');
      if (paidAction) {
        totalDaysToPayment += Math.floor((paidAction.timestamp - entry.dueDate) / (24 * 60 * 60 * 1000));
      }
    }

    return {
      totalOverdueInvoices: overdueEntries.length,
      totalOverdueAmount,
      byLevel: Array.from(byLevel.entries()).map(([level, data]) => ({
        level,
        count: data.count,
        amount: data.amount,
      })),
      byStatus: Array.from(byStatus.entries()).map(([status, data]) => ({
        status,
        count: data.count,
        amount: data.amount,
      })),
      recoveryRate: entries.length > 0 ? paidEntries.length / entries.length : 0,
      averageDaysToPayment: paidEntries.length > 0 ? totalDaysToPayment / paidEntries.length : 0,
      escalatedToCollections: escalatedEntries.length,
      emailsSentToday,
      paymentsReceivedToday,
      paymentsReceivedAmount,
    };
  }

  /**
   * Process all pending dunning entries (batch operation)
   * In production, this would be triggered by a scheduled job
   */
  async processPendingDunning(): Promise<{
    processed: number;
    sent: number;
    escalated: number;
    paused: number;
    paymentPlans: number;
  }> {
    const { entries } = await this.getDunningEntries({
      status: ['pending', 'sent'],
    });

    let processed = 0;
    let sent = 0;
    let escalated = 0;
    let paused = 0;
    let paymentPlans = 0;

    const now = this.runtime.now();

    for (const entry of entries) {
      if (entry.nextActionDate && entry.nextActionDate <= now) {
        processed++;

        const schedule = this.dunningSchedules.get(entry.scheduleId);
        if (!schedule) continue;

        // Send reminder and get AI analysis
        const result = await this.sendDunningReminder(entry.id);

        if (result.success && result.aiAnalysis) {
          // Apply AI-recommended actions
          const { recommendedAction, sentimentAnalysis } = result.aiAnalysis;

          switch (recommendedAction) {
            case 'escalate':
              await this.escalateToCollections(entry.id);
              escalated++;
              break;
            case 'pause':
              // High churn risk customer - pause dunning
              await this.pauseDunning(entry.id, `AI recommendation: high churn risk (${(sentimentAnalysis.churnRisk * 100).toFixed(0)}%)`);
              paused++;
              break;
            case 'offer_payment_plan':
              // Record that payment plan was offered
              const updatedEntry = this.dunningEntries.get(entry.id);
              if (updatedEntry) {
                updatedEntry.history.push({
                  timestamp: this.runtime.now(),
                  level: entry.currentLevel,
                  action: 'email_sent',
                  details: 'Payment plan offered per AI recommendation',
                  aiGenerated: true,
                });
                this.dunningEntries.set(entry.id, updatedEntry);
              }
              paymentPlans++;
              sent++;
              break;
            case 'skip':
              // Skip this cycle, don't count as sent
              break;
            default:
              // send_email, send_sms - already handled by sendDunningReminder
              sent++;
          }

          // Advance dunning level based on schedule thresholds (same as non-AI path)
          // This ensures entries progress through levels even when AI is enabled
          if (recommendedAction !== 'escalate' && recommendedAction !== 'pause' && recommendedAction !== 'skip') {
            const nextLevel = schedule.levels.find(l => l.level === entry.currentLevel + 1);
            if (nextLevel && entry.daysOverdue >= nextLevel.daysOverdue) {
              const updatedEntry = this.dunningEntries.get(entry.id);
              if (updatedEntry) {
                updatedEntry.currentLevel = nextLevel.level;
                this.dunningEntries.set(entry.id, updatedEntry);
              }
            }
          }

          // Log high churn risk for monitoring
          if (sentimentAnalysis.churnRisk > 0.7) {
            this.runtime.logger.warn('High churn risk customer in dunning', {
              entryId: entry.id,
              customerId: entry.customerId,
              customerName: entry.customerName,
              churnRisk: sentimentAnalysis.churnRisk,
              paymentLikelihood: sentimentAnalysis.paymentLikelihood,
              recommendedAction,
            });
          }
        } else {
          // Fallback: original logic without AI
          const nextLevel = schedule.levels.find(l => l.level === entry.currentLevel + 1);
          if (nextLevel && entry.daysOverdue >= nextLevel.daysOverdue) {
            entry.currentLevel = nextLevel.level;

            if (nextLevel.action === 'collections') {
              await this.escalateToCollections(entry.id);
              escalated++;
            } else {
              sent++;
            }
          } else {
            sent++;
          }
        }
      }
    }

    this.runtime.logger.info('Pending dunning processed', {
      processed,
      sent,
      escalated,
      paused,
      paymentPlans,
    });

    return { processed, sent, escalated, paused, paymentPlans };
  }

  // ==================== Private helpers ====================

  /**
   * Initialize dunning demo data
   */
  private initializeDunningDemoData(): void {
    // Create default dunning schedule
    const defaultSchedule: DunningSchedule = {
      id: 'schedule_default',
      name: 'Standard Dunning Schedule',
      status: 'active',
      levels: [
        {
          level: 1,
          daysOverdue: 7,
          action: 'reminder',
          emailTemplateId: 'tmpl_friendly_reminder',
          tone: 'friendly',
        },
        {
          level: 2,
          daysOverdue: 14,
          action: 'reminder',
          emailTemplateId: 'tmpl_second_reminder',
          tone: 'neutral',
        },
        {
          level: 3,
          daysOverdue: 30,
          action: 'warning',
          emailTemplateId: 'tmpl_warning',
          tone: 'firm',
          fee: 25,
        },
        {
          level: 4,
          daysOverdue: 45,
          action: 'final_notice',
          emailTemplateId: 'tmpl_final_notice',
          tone: 'final',
          fee: 50,
          interestRate: 1.5,
        },
        {
          level: 5,
          daysOverdue: 60,
          action: 'collections',
          emailTemplateId: 'tmpl_collections',
          tone: 'final',
          fee: 100,
          interestRate: 2.0,
        },
      ],
      filters: {
        minAmount: 100,
      },
      settings: {
        sendEmail: true,
        sendSms: false,
        escalateToCollections: true,
        collectionsDaysThreshold: 60,
        pauseDuringHolidays: true,
        businessHoursOnly: true,
      },
      createdAt: this.runtime.now() - 30 * 24 * 60 * 60 * 1000,
      updatedAt: this.runtime.now(),
    };

    this.dunningSchedules.set(defaultSchedule.id, defaultSchedule);

    // Create sample dunning entries for overdue invoices
    const customerNames = [
      'Acme Corporation', 'TechStart Inc', 'Global Retail LLC',
      'Manufacturing Plus', 'Service Excellence', 'Innovation Labs',
      'Digital Solutions', 'Premier Partners', 'Quality Goods Co',
      'Enterprise Systems',
    ];

    const now = this.runtime.now();
    for (let i = 0; i < 50; i++) {
      const daysOverdue = Math.floor(this.runtime.random() * 90) + 1;
      const dueDate = now - daysOverdue * 24 * 60 * 60 * 1000;
      const invoiceDate = dueDate - 30 * 24 * 60 * 60 * 1000;
      const amount = Math.floor(this.runtime.random() * 10000) + 500;

      // Determine current dunning level based on days overdue
      let currentLevel = 0;
      for (const level of defaultSchedule.levels) {
        if (daysOverdue >= level.daysOverdue) {
          currentLevel = level.level;
        }
      }

      const statuses: DunningEntry['status'][] = ['pending', 'sent', 'responded', 'paid', 'escalated', 'paused'];
      const statusWeights = [0.2, 0.35, 0.1, 0.25, 0.05, 0.05];
      const status = this.weightedRandom(statuses, statusWeights);

      const customerName = customerNames[i % customerNames.length] || 'Unknown Customer';
      const entry: DunningEntry = {
        id: `dun_${this.runtime.now()}_${i}_${this.runtime.random().toString(36).slice(2, 2 + 6)}`,
        scheduleId: defaultSchedule.id,
        invoiceId: `INV-${2026}${String(i + 1).padStart(5, '0')}`,
        customerId: `CUST-${String(i + 1).padStart(4, '0')}`,
        customerEmail: `billing@${customerName.toLowerCase().replace(/\s+/g, '')}.com`,
        customerName,
        invoiceAmount: amount,
        amountDue: status === 'paid' ? 0 : amount,
        currency: 'USD',
        invoiceDate,
        dueDate,
        daysOverdue,
        currentLevel,
        status,
        history: this.generateDunningHistory(currentLevel, invoiceDate),
        nextActionDate: status !== 'paid' && status !== 'cancelled'
          ? now + 7 * 24 * 60 * 60 * 1000
          : undefined,
        paymentLink: `https://pay.example.com/inv/${this.runtime.random().toString(36).slice(2, 2 + 10)}`,
        metadata: {},
      };

      this.dunningEntries.set(entry.id, entry);
    }
  }

  /**
   * Generate sample dunning history based on current level
   */
  private generateDunningHistory(currentLevel: number, invoiceDate: number): DunningAction[] {
    const history: DunningAction[] = [];
    const levelDays = [7, 14, 30, 45, 60];

    for (let level = 1; level <= currentLevel; level++) {
      const levelDaysOverdue = levelDays[level - 1] || level * 7;
      const actionDate = invoiceDate + (30 + levelDaysOverdue) * 24 * 60 * 60 * 1000;

      history.push({
        timestamp: actionDate,
        level,
        action: 'email_sent',
        details: `Level ${level} dunning email sent`,
        sentTo: 'billing@customer.com',
      });

      // Randomly add customer responses
      if (this.runtime.random() > 0.7 && level < currentLevel) {
        history.push({
          timestamp: actionDate + 2 * 24 * 60 * 60 * 1000,
          level,
          action: 'customer_response',
          details: 'Customer acknowledged receipt',
          responseReceived: 'Will process payment by end of week',
        });
      }
    }

    return history;
  }

  private weightedRandom<T>(items: T[], weights: number[]): T {
    const random = this.runtime.random();
    let cumulativeWeight = 0;

    for (let i = 0; i < items.length; i++) {
      cumulativeWeight += weights[i] || 0;
      if (random <= cumulativeWeight) {
        const item = items[i];
        if (item !== undefined) {
          return item;
        }
      }
    }

    const lastItem = items[items.length - 1];
    if (lastItem !== undefined) {
      return lastItem;
    }
    throw new Error('No items available for weighted random selection');
  }
}
