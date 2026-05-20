/**
 * AI Dunning Agent
 *
 * Intelligent dunning automation with sentiment-aware collection communications.
 * Analyzes customer payment history and communication patterns to generate
 * personalized, effective dunning messages.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import { BaseAgent, BaseAgentConfig } from '../BaseAgent';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema
} from '../interfaces';
import { logger, type Logger } from '../../../../utils/Logger';

// Input/Output interfaces
export interface DunningInput {
  dunningEntry: {
    id: string;
    customerId: string;
    customerName: string;
    customerEmail: string;
    invoiceId: string;
    invoiceAmount: number;
    amountDue: number;
    currency: string;
    daysOverdue: number;
    currentLevel: number;
    history: DunningHistoryItem[];
  };
  customerProfile?: {
    totalInvoices: number;
    paidOnTime: number;
    averagePaymentDays: number;
    totalRevenue: number;
    customerSince: number;
    previousDunningResponses: number;
    paymentPlanHistory: boolean;
  };
  schedule: {
    levels: DunningLevelConfig[];
    settings: {
      sendEmail: boolean;
      sendSms: boolean;
      escalateToCollections: boolean;
      collectionsDaysThreshold: number;
    };
  };
}

interface DunningHistoryItem {
  timestamp: number;
  action: string;
  details: string;
  responseReceived?: string;
}

interface DunningLevelConfig {
  level: number;
  daysOverdue: number;
  action: 'reminder' | 'warning' | 'final_notice' | 'collections';
  tone: 'friendly' | 'neutral' | 'firm' | 'final';
  emailTemplateId: string;
}

export interface DunningOutput {
  recommendedAction: 'send_email' | 'send_sms' | 'escalate' | 'pause' | 'skip' | 'offer_payment_plan';
  recommendedTone: 'friendly' | 'neutral' | 'firm' | 'final';
  generatedMessage: {
    subject: string;
    body: string;
    callToAction: string;
  };
  sentimentAnalysis: {
    customerSentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
    paymentLikelihood: number; // 0-1
    churnRisk: number; // 0-1
  };
  recommendations: string[];
  escalationPath: {
    nextLevel: number;
    nextAction: string;
    suggestedDate: number;
  };
}

/**
 * AI Dunning Agent - Sentiment-aware collection automation
 */
export class DunningAgent extends BaseAgent {
  private static readonly AGENT_CONFIG: BaseAgentConfig = {
    name: 'DunningAgent',
    version: '1.0.0',
    capabilities: [
      'sentiment_analysis',
      'payment_prediction',
      'message_generation',
      'escalation_planning',
      'churn_risk_assessment'
    ],
    dependencies: [],
    maxExecutionTime: 15000,
    confidenceThreshold: 0.6
  };

  constructor(providedLogger?: Logger) {
    super(DunningAgent.AGENT_CONFIG, providedLogger || logger);
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {
        type: 'object',
        properties: {
          dunningEntry: { type: 'object', required: true },
          customerProfile: { type: 'object', required: false },
          schedule: { type: 'object', required: true }
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          recommendedAction: { type: 'string' },
          recommendedTone: { type: 'string' },
          generatedMessage: { type: 'object' },
          sentimentAnalysis: { type: 'object' },
          recommendations: { type: 'array' },
          escalationPath: { type: 'object' }
        }
      },
      capabilities: this.capabilities,
      resourceRequirements: {
        maxMemory: 256,
        maxExecutionTime: 15000
      }
    };
  }

  protected async validateInputInternal(input: unknown): Promise<boolean> {
    const data = input as DunningInput;

    if (!data.dunningEntry?.id || !data.dunningEntry?.customerId) {
      return false;
    }

    if (!data.schedule?.levels || data.schedule.levels.length === 0) {
      return false;
    }

    return true;
  }

  protected async executeInternal(
    context: AgentExecutionContext,
    input: unknown
  ): Promise<AgentResult<DunningOutput>> {
    const data = input as DunningInput;
    const { dunningEntry, customerProfile, schedule } = data;

    this.logger.info('DunningAgent executing', {
      customerId: dunningEntry.customerId,
      daysOverdue: dunningEntry.daysOverdue,
      currentLevel: dunningEntry.currentLevel
    });

    // Step 1: Analyze customer sentiment from history
    const sentimentAnalysis = this.analyzeCustomerSentiment(dunningEntry, customerProfile);

    // Step 2: Calculate payment likelihood and churn risk
    const paymentLikelihood = this.calculatePaymentLikelihood(dunningEntry, customerProfile);
    const churnRisk = this.calculateChurnRisk(dunningEntry, customerProfile, sentimentAnalysis.customerSentiment);

    // Step 3: Determine recommended action and tone
    const { recommendedAction, recommendedTone } = this.determineActionAndTone(
      dunningEntry,
      customerProfile,
      sentimentAnalysis.customerSentiment,
      paymentLikelihood,
      churnRisk,
      schedule
    );

    // Step 4: Generate personalized message
    const generatedMessage = this.generateMessage(
      dunningEntry,
      recommendedTone,
      paymentLikelihood
    );

    // Step 5: Plan escalation path
    const escalationPath = this.planEscalation(
      dunningEntry,
      schedule,
      paymentLikelihood
    );

    // Step 6: Generate recommendations
    const recommendations = this.generateRecommendations(
      dunningEntry,
      customerProfile,
      sentimentAnalysis.customerSentiment,
      paymentLikelihood,
      churnRisk
    );

    // Calculate confidence based on data quality
    const confidence = this.calculateConfidence([
      { factor: 'history_depth', value: Math.min(dunningEntry.history.length / 5, 1), weight: 0.3 },
      { factor: 'profile_completeness', value: customerProfile ? 0.9 : 0.5, weight: 0.3 },
      { factor: 'payment_likelihood_certainty', value: paymentLikelihood > 0.3 && paymentLikelihood < 0.7 ? 0.6 : 0.9, weight: 0.2 },
      { factor: 'days_overdue_clarity', value: dunningEntry.daysOverdue > 0 ? 1 : 0.5, weight: 0.2 }
    ]);

    const output: DunningOutput = {
      recommendedAction,
      recommendedTone,
      generatedMessage,
      sentimentAnalysis: {
        customerSentiment: sentimentAnalysis.customerSentiment,
        paymentLikelihood,
        churnRisk
      },
      recommendations,
      escalationPath
    };

    const reasoning = this.mergeReasoning([
      `Customer ${dunningEntry.customerName} is ${dunningEntry.daysOverdue} days overdue`,
      `Sentiment analysis indicates ${sentimentAnalysis.customerSentiment} customer disposition`,
      `Payment likelihood: ${(paymentLikelihood * 100).toFixed(0)}%, Churn risk: ${(churnRisk * 100).toFixed(0)}%`,
      `Recommended action: ${recommendedAction} with ${recommendedTone} tone`,
      `Next escalation: Level ${escalationPath.nextLevel} in ${Math.ceil((escalationPath.suggestedDate - Date.now()) / (24 * 60 * 60 * 1000))} days`
    ]);

    return this.createSuccessResult(output, confidence, reasoning);
  }

  private analyzeCustomerSentiment(
    dunningEntry: DunningInput['dunningEntry'],
    customerProfile?: DunningInput['customerProfile']
  ): { customerSentiment: 'positive' | 'neutral' | 'negative' | 'unknown'; signals: string[] } {
    const signals: string[] = [];
    let sentimentScore = 0;

    // Analyze history for response patterns
    const responses = dunningEntry.history.filter(h => h.responseReceived);
    if (responses.length > 0) {
      // Check for positive responses (payment promises, engagement)
      const positiveResponses = responses.filter(r =>
        r.responseReceived?.toLowerCase().includes('pay') ||
        r.responseReceived?.toLowerCase().includes('arrange') ||
        r.responseReceived?.toLowerCase().includes('soon')
      );

      if (positiveResponses.length > 0) {
        sentimentScore += 2;
        signals.push('Customer has responded positively to previous communications');
      }

      // Check for negative responses (disputes, complaints)
      const negativeResponses = responses.filter(r =>
        r.responseReceived?.toLowerCase().includes('dispute') ||
        r.responseReceived?.toLowerCase().includes('wrong') ||
        r.responseReceived?.toLowerCase().includes('cancel')
      );

      if (negativeResponses.length > 0) {
        sentimentScore -= 2;
        signals.push('Customer has raised disputes or complaints');
      }
    }

    // Analyze customer profile if available
    if (customerProfile) {
      // Good payment history
      if (customerProfile.totalInvoices > 0) {
        const onTimeRate = customerProfile.paidOnTime / customerProfile.totalInvoices;
        if (onTimeRate > 0.8) {
          sentimentScore += 1;
          signals.push('Customer has strong payment history');
        } else if (onTimeRate < 0.5) {
          sentimentScore -= 1;
          signals.push('Customer has poor payment history');
        }
      }

      // Long-term customer
      const customerAgeYears = (Date.now() - customerProfile.customerSince) / (365 * 24 * 60 * 60 * 1000);
      if (customerAgeYears > 2) {
        sentimentScore += 1;
        signals.push('Long-term customer relationship');
      }

      // Previous dunning responses
      if (customerProfile.previousDunningResponses > 0) {
        sentimentScore += 0.5;
        signals.push('Customer has engaged with previous dunning');
      }
    }

    // Determine sentiment category
    let customerSentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
    if (signals.length === 0) {
      customerSentiment = 'unknown';
    } else if (sentimentScore > 1) {
      customerSentiment = 'positive';
    } else if (sentimentScore < -1) {
      customerSentiment = 'negative';
    } else {
      customerSentiment = 'neutral';
    }

    return { customerSentiment, signals };
  }

  private calculatePaymentLikelihood(
    dunningEntry: DunningInput['dunningEntry'],
    customerProfile?: DunningInput['customerProfile']
  ): number {
    let likelihood = 0.5; // Start neutral

    // Factor 1: Days overdue (longer = less likely)
    if (dunningEntry.daysOverdue < 15) {
      likelihood += 0.2;
    } else if (dunningEntry.daysOverdue < 30) {
      likelihood += 0.1;
    } else if (dunningEntry.daysOverdue > 60) {
      likelihood -= 0.2;
    } else if (dunningEntry.daysOverdue > 90) {
      likelihood -= 0.3;
    }

    // Factor 2: Amount (smaller amounts more likely to be paid)
    if (dunningEntry.amountDue < 100) {
      likelihood += 0.1;
    } else if (dunningEntry.amountDue > 10000) {
      likelihood -= 0.1;
    }

    // Factor 3: Customer profile
    if (customerProfile) {
      // Past payment reliability
      if (customerProfile.totalInvoices > 0) {
        const reliability = customerProfile.paidOnTime / customerProfile.totalInvoices;
        likelihood += (reliability - 0.5) * 0.3;
      }

      // Customer value (high-value customers often prioritize payments)
      if (customerProfile.totalRevenue > 50000) {
        likelihood += 0.05;
      }

      // Payment plan history (willing to work with company)
      if (customerProfile.paymentPlanHistory) {
        likelihood += 0.1;
      }
    }

    // Factor 4: Response history in this dunning cycle
    const hasResponded = dunningEntry.history.some(h => h.responseReceived);
    if (hasResponded) {
      likelihood += 0.15;
    }

    return Math.max(0, Math.min(1, likelihood));
  }

  private calculateChurnRisk(
    dunningEntry: DunningInput['dunningEntry'],
    customerProfile: DunningInput['customerProfile'] | undefined,
    sentiment: 'positive' | 'neutral' | 'negative' | 'unknown'
  ): number {
    let risk = 0.3; // Base risk

    // Sentiment impact
    switch (sentiment) {
      case 'negative':
        risk += 0.3;
        break;
      case 'neutral':
        risk += 0.1;
        break;
      case 'positive':
        risk -= 0.1;
        break;
    }

    // Aggressive dunning increases churn risk
    if (dunningEntry.currentLevel >= 3) {
      risk += 0.15;
    }

    // Days overdue impact
    if (dunningEntry.daysOverdue > 60) {
      risk += 0.1;
    }

    // Customer value mitigates (valuable customers less likely to churn over small issues)
    if (customerProfile?.totalRevenue && customerProfile.totalRevenue > 100000) {
      risk -= 0.1;
    }

    // Long-term customers have switching costs
    if (customerProfile?.customerSince) {
      const yearsAsCustomer = (Date.now() - customerProfile.customerSince) / (365 * 24 * 60 * 60 * 1000);
      if (yearsAsCustomer > 3) {
        risk -= 0.1;
      }
    }

    return Math.max(0, Math.min(1, risk));
  }

  private determineActionAndTone(
    dunningEntry: DunningInput['dunningEntry'],
    customerProfile: DunningInput['customerProfile'] | undefined,
    sentiment: 'positive' | 'neutral' | 'negative' | 'unknown',
    paymentLikelihood: number,
    churnRisk: number,
    schedule: DunningInput['schedule']
  ): { recommendedAction: DunningOutput['recommendedAction']; recommendedTone: DunningOutput['recommendedTone'] } {
    // Find current level config
    const currentLevelConfig = schedule.levels.find(l => l.level === dunningEntry.currentLevel);
    const baseTone = currentLevelConfig?.tone || 'neutral';

    // Adjust tone based on sentiment and risk
    let recommendedTone: DunningOutput['recommendedTone'] = baseTone;

    // If high churn risk and positive/neutral sentiment, soften tone
    if (churnRisk > 0.5 && (sentiment === 'positive' || sentiment === 'neutral')) {
      if (baseTone === 'firm') recommendedTone = 'neutral';
      if (baseTone === 'final') recommendedTone = 'firm';
    }

    // If negative sentiment, be more professional/neutral
    if (sentiment === 'negative') {
      recommendedTone = 'neutral';
    }

    // Determine action
    let recommendedAction: DunningOutput['recommendedAction'] = 'send_email';

    // Skip if very recent action
    const lastAction = dunningEntry.history[dunningEntry.history.length - 1];
    if (lastAction && Date.now() - lastAction.timestamp < 3 * 24 * 60 * 60 * 1000) {
      recommendedAction = 'skip';
    }

    // Offer payment plan for high churn risk customers with payment likelihood
    if (churnRisk > 0.6 && paymentLikelihood > 0.3 && dunningEntry.amountDue > 500) {
      recommendedAction = 'offer_payment_plan';
    }

    // Escalate if past collections threshold
    if (dunningEntry.daysOverdue > schedule.settings.collectionsDaysThreshold &&
        schedule.settings.escalateToCollections) {
      recommendedAction = 'escalate';
    }

    // Pause if customer has disputed
    const hasDispute = dunningEntry.history.some(h =>
      h.action === 'customer_response' &&
      h.responseReceived?.toLowerCase().includes('dispute')
    );
    if (hasDispute) {
      recommendedAction = 'pause';
    }

    return { recommendedAction, recommendedTone };
  }

  private generateMessage(
    dunningEntry: DunningInput['dunningEntry'],
    tone: DunningOutput['recommendedTone'],
    paymentLikelihood: number
  ): DunningOutput['generatedMessage'] {
    const { customerName, invoiceId, amountDue, currency, daysOverdue } = dunningEntry;
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountDue);

    const toneTemplates = {
      friendly: {
        subject: `Friendly reminder: Invoice ${invoiceId} payment`,
        opening: `Hi ${customerName},\n\nWe hope this message finds you well. We wanted to reach out regarding invoice ${invoiceId}.`,
        body: `We noticed that payment of ${formattedAmount} is now ${daysOverdue} days past due. We understand that things can get busy, and sometimes payments slip through the cracks.`,
        cta: 'We would greatly appreciate if you could arrange payment at your earliest convenience.'
      },
      neutral: {
        subject: `Payment reminder: Invoice ${invoiceId}`,
        opening: `Dear ${customerName},\n\nThis is a reminder regarding your outstanding invoice ${invoiceId}.`,
        body: `The amount of ${formattedAmount} is currently ${daysOverdue} days overdue. Please review the attached invoice details.`,
        cta: 'Please arrange payment or contact us if you have any questions about this invoice.'
      },
      firm: {
        subject: `Urgent: Overdue payment required - Invoice ${invoiceId}`,
        opening: `Dear ${customerName},\n\nWe are writing to follow up on the outstanding balance for invoice ${invoiceId}.`,
        body: `Despite our previous reminders, the payment of ${formattedAmount} remains ${daysOverdue} days overdue. We must receive payment promptly to avoid further action.`,
        cta: 'Please make payment immediately or contact our accounts team to discuss payment arrangements.'
      },
      final: {
        subject: `Final Notice: Immediate payment required - Invoice ${invoiceId}`,
        opening: `Dear ${customerName},\n\nThis is our final notice regarding the severely overdue invoice ${invoiceId}.`,
        body: `The outstanding balance of ${formattedAmount} is now ${daysOverdue} days past due. Failure to resolve this matter may result in further collection actions and potential service disruption.`,
        cta: 'Please remit payment immediately. If payment has already been sent, please contact us with the transaction details.'
      }
    };

    const template = toneTemplates[tone];

    // Add payment plan suggestion for high-value receivables
    let additionalInfo = '';
    if (amountDue > 1000 && paymentLikelihood < 0.6) {
      additionalInfo = '\n\nIf you are experiencing temporary financial difficulties, please contact us to discuss potential payment arrangements.';
    }

    return {
      subject: template.subject,
      body: `${template.opening}\n\n${template.body}${additionalInfo}\n\n${template.cta}\n\nBest regards,\nAccounts Receivable Team`,
      callToAction: template.cta
    };
  }

  private planEscalation(
    dunningEntry: DunningInput['dunningEntry'],
    schedule: DunningInput['schedule'],
    paymentLikelihood: number
  ): DunningOutput['escalationPath'] {
    const currentLevel = dunningEntry.currentLevel;

    // Find next level
    const nextLevelConfig = schedule.levels.find(l => l.level === currentLevel + 1);

    if (!nextLevelConfig) {
      // Already at max level, suggest collections
      return {
        nextLevel: currentLevel,
        nextAction: 'collections_referral',
        suggestedDate: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
      };
    }

    // Calculate days until next level
    const daysUntilNextLevel = nextLevelConfig.daysOverdue - dunningEntry.daysOverdue;

    // Adjust timing based on payment likelihood
    let adjustedDays = daysUntilNextLevel;
    if (paymentLikelihood < 0.3) {
      adjustedDays = Math.max(3, daysUntilNextLevel - 5); // Escalate faster for unlikely payers
    } else if (paymentLikelihood > 0.7) {
      adjustedDays = daysUntilNextLevel + 5; // Give more time for likely payers
    }

    return {
      nextLevel: nextLevelConfig.level,
      nextAction: nextLevelConfig.action,
      suggestedDate: Date.now() + adjustedDays * 24 * 60 * 60 * 1000
    };
  }

  private generateRecommendations(
    dunningEntry: DunningInput['dunningEntry'],
    customerProfile: DunningInput['customerProfile'] | undefined,
    sentiment: 'positive' | 'neutral' | 'negative' | 'unknown',
    paymentLikelihood: number,
    churnRisk: number
  ): string[] {
    const recommendations: string[] = [];

    // Payment likelihood recommendations
    if (paymentLikelihood > 0.7) {
      recommendations.push('High payment likelihood - maintain positive relationship with friendly follow-up');
    } else if (paymentLikelihood < 0.3) {
      recommendations.push('Low payment likelihood - consider early escalation or payment plan negotiation');
    }

    // Churn risk recommendations
    if (churnRisk > 0.5) {
      recommendations.push('Elevated churn risk - balance collection efforts with customer retention');
      if (customerProfile?.totalRevenue && customerProfile.totalRevenue > 10000) {
        recommendations.push('High-value customer - consider account manager involvement');
      }
    }

    // Sentiment-based recommendations
    if (sentiment === 'negative') {
      recommendations.push('Negative customer sentiment detected - review for legitimate disputes before continuing');
    } else if (sentiment === 'positive') {
      recommendations.push('Positive engagement history - personalized outreach may be effective');
    }

    // Amount-based recommendations
    if (dunningEntry.amountDue > 5000) {
      recommendations.push('Large outstanding amount - consider structured payment plan offer');
    }

    // History-based recommendations
    if (dunningEntry.history.length === 0) {
      recommendations.push('First dunning contact - use friendly initial approach');
    } else if (dunningEntry.history.length > 5) {
      recommendations.push('Extended dunning cycle - escalation or alternative approach recommended');
    }

    // Customer profile recommendations
    if (customerProfile?.paymentPlanHistory) {
      recommendations.push('Customer has honored payment plans previously - payment plan likely to succeed');
    }

    return recommendations;
  }
}
