import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import type { AllTelemetryEvents } from '../domain/telemetry/events';

export interface DLQMessage {
  id: string;
  flowId: string;
  messageId: string;
  originalPayload: unknown;
  errorCode: string;
  errorMessage: string;
  errorDetails?: {
    stack?: string;
    context?: Record<string, unknown>;
    systemResponse?: unknown;
  };
  retryCount: number;
  maxRetries: number;
  firstFailureTime: number;
  lastAttemptTime: number;
  nextRetryTime?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceSystem: string;
  targetSystem: string;
  recordType: string;
  processingStage: 'authentication' | 'validation' | 'transformation' | 'transmission' | 'confirmation';
  businessImpact: {
    affectedRecords: number;
    estimatedRevenueLoss?: number;
    customerImpact?: string;
    urgency: 'low' | 'medium' | 'high' | 'critical';
  };
  status: 'pending' | 'retrying' | 'failed' | 'resolved' | 'ignored';
  tags: string[];
  assignedTo?: string;
  resolution?: {
    resolvedBy: string;
    resolvedAt: number;
    resolution: string;
    actionsTaken: string[];
  };
}

export interface DLQAnalytics {
  summary: {
    totalMessages: number;
    pendingMessages: number;
    failedMessages: number;
    resolvedMessages: number;
    criticalMessages: number;
    avgResolutionTime: number;
  };
  errorPatterns: {
    errorCode: string;
    errorType: string;
    count: number;
    percentage: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    suggestedAction: string;
  }[];
  systemBreakdown: {
    system: string;
    totalErrors: number;
    criticalErrors: number;
    avgRetries: number;
    successRate: number;
  }[];
  timeAnalysis: {
    peakErrorHours: number[];
    errorsByDay: { date: string; count: number; severity: string }[];
    mttr: number; // Mean Time To Resolution
    mtbf: number; // Mean Time Between Failures
  };
}

export interface DLQFilter {
  severity?: string[];
  status?: string[];
  sourceSystem?: string[];
  targetSystem?: string[];
  errorCode?: string[];
  dateRange?: { start: number; end: number };
  assignedTo?: string;
  tags?: string[];
  businessImpact?: string[];
}

/**
 * Dead Letter Queue Service manages failed integration messages
 * and provides analytics for proactive failure resolution
 */
@injectable()
export class DLQService {
  private messages: Map<string, DLQMessage> = new Map<string, DLQMessage>();
  private messagesByFlow: Map<string, Set<string>> = new Map<string, Set<string>>();
  private messagesBySystem: Map<string, Set<string>> = new Map<string, Set<string>>();
  private messagesByError: Map<string, Set<string>> = new Map<string, Set<string>>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
  ) {
    this.logger.info('DLQService initialized');
  }

  /**
   * Add a failed message to the DLQ
   */
  async addMessage(message: Omit<DLQMessage, 'id' | 'firstFailureTime'>): Promise<string> {
    try {
      const id = `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
      const dlqMessage: DLQMessage = {
        ...message,
        id,
        firstFailureTime: Date.now(),
        lastAttemptTime: Date.now(),
      };

      this.messages.set(id, dlqMessage);

      // Index for quick lookups
      this.addToIndex(this.messagesByFlow, message.flowId, id);
      this.addToIndex(this.messagesBySystem, `${message.sourceSystem}-${message.targetSystem}`, id);
      this.addToIndex(this.messagesByError, message.errorCode, id);

      // Record telemetry event
      const telemetryEvent: AllTelemetryEvents = {
        id: `dlq_created_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
        timestamp: Date.now(),
        type: 'DLQMessageCreated',
        flowId: message.flowId,
        messageId: message.messageId,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage,
        retryCount: message.retryCount,
        payloadSize: JSON.stringify(message.originalPayload).length,
        metadata: {
          severity: message.severity,
          sourceSystem: message.sourceSystem,
          targetSystem: message.targetSystem,
          recordType: message.recordType,
          processingStage: message.processingStage,
          businessImpact: message.businessImpact,
        },
      };

      await this.telemetryService.recordEvent(telemetryEvent);

      this.logger.warn('Message added to DLQ', {
        messageId: id,
        flowId: message.flowId,
        errorCode: message.errorCode,
        severity: message.severity,
        retryCount: message.retryCount,
      });

      return id;
    } catch (error) {
      this.logger.error('Failed to add message to DLQ', { error, messageId: message.messageId });
      throw error;
    }
  }

  /**
   * Get DLQ messages with filtering and pagination
   */
  async getMessages(
    filter: DLQFilter = {},
    limit = 50,
    offset = 0
  ): Promise<{ messages: DLQMessage[]; totalCount: number }> {
    try {
      let filteredMessages = Array.from(this.messages.values());

      // Apply filters
      if (filter.severity && filter.severity.length > 0) {
        filteredMessages = filteredMessages.filter(m => filter.severity!.includes(m.severity));
      }

      if (filter.status && filter.status.length > 0) {
        filteredMessages = filteredMessages.filter(m => filter.status!.includes(m.status));
      }

      if (filter.sourceSystem && filter.sourceSystem.length > 0) {
        filteredMessages = filteredMessages.filter(m => filter.sourceSystem!.includes(m.sourceSystem));
      }

      if (filter.targetSystem && filter.targetSystem.length > 0) {
        filteredMessages = filteredMessages.filter(m => filter.targetSystem!.includes(m.targetSystem));
      }

      if (filter.errorCode && filter.errorCode.length > 0) {
        filteredMessages = filteredMessages.filter(m => filter.errorCode!.includes(m.errorCode));
      }

      if (filter.dateRange) {
        filteredMessages = filteredMessages.filter(m => 
          m.firstFailureTime >= filter.dateRange!.start && 
          m.firstFailureTime <= filter.dateRange!.end
        );
      }

      if (filter.assignedTo) {
        filteredMessages = filteredMessages.filter(m => m.assignedTo === filter.assignedTo);
      }

      if (filter.tags && filter.tags.length > 0) {
        filteredMessages = filteredMessages.filter(m => 
          m.tags.some(tag => filter.tags!.includes(tag))
        );
      }

      if (filter.businessImpact && filter.businessImpact.length > 0) {
        filteredMessages = filteredMessages.filter(m => 
          filter.businessImpact!.includes(m.businessImpact.urgency)
        );
      }

      const totalCount = filteredMessages.length;

      // Sort by severity and time (most critical and recent first)
      filteredMessages.sort((a, b) => {
        const severityOrder = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
        const aSeverity = severityOrder[a.severity] || 0;
        const bSeverity = severityOrder[b.severity] || 0;
        
        if (aSeverity !== bSeverity) {
          return bSeverity - aSeverity; // Higher severity first
        }
        
        return b.lastAttemptTime - a.lastAttemptTime; // More recent first
      });

      // Apply pagination
      const messages = filteredMessages.slice(offset, offset + limit);

      return { messages, totalCount };
    } catch (error) {
      this.logger.error('Failed to get DLQ messages', { error, filter });
      throw error;
    }
  }

  /**
   * Retry a failed message
   */
  async retryMessage(messageId: string): Promise<{ success: boolean; newRetryTime?: number }> {
    try {
      const message = this.messages.get(messageId);
      if (!message) {
        throw new Error(`DLQ message not found: ${messageId}`);
      }

      if (message.status === 'resolved' || message.status === 'ignored') {
        throw new Error(`Cannot retry message with status: ${message.status}`);
      }

      if (message.retryCount >= message.maxRetries) {
        throw new Error(`Message has exceeded maximum retry attempts (${message.maxRetries})`);
      }

      // Update message status
      message.retryCount++;
      message.lastAttemptTime = Date.now();
      message.status = 'retrying';

      // Calculate next retry time with exponential backoff
      const backoffMultiplier = Math.min(Math.pow(2, message.retryCount), 300); // Max 5 minutes
      message.nextRetryTime = Date.now() + (backoffMultiplier * 1000);

      // Record telemetry event
      const telemetryEvent: AllTelemetryEvents = {
        id: `retry_scheduled_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
        timestamp: Date.now(),
        type: 'RetryScheduled',
        flowId: message.flowId,
        messageId: message.messageId,
        retryCount: message.retryCount,
        scheduleDelayMs: backoffMultiplier * 1000,
        nextAttemptAt: message.nextRetryTime,
        metadata: {
          errorCode: message.errorCode,
          severity: message.severity,
          maxRetries: message.maxRetries,
        },
      };

      await this.telemetryService.recordEvent(telemetryEvent);

      this.logger.info('Message retry scheduled', {
        messageId,
        retryCount: message.retryCount,
        nextRetryTime: message.nextRetryTime,
      });

      // Simulate actual retry logic (in production, this would trigger the actual retry)
      setTimeout(async () => {
        await this.processRetry(messageId);
      }, backoffMultiplier * 1000);

      return { 
        success: true, 
        newRetryTime: message.nextRetryTime 
      };
    } catch (error) {
      this.logger.error('Failed to retry DLQ message', { error, messageId });
      throw error;
    }
  }

  /**
   * Mark a message as resolved
   */
  async resolveMessage(messageId: string, resolution: {
    resolvedBy: string;
    resolution: string;
    actionsTaken: string[];
  }): Promise<void> {
    try {
      const message = this.messages.get(messageId);
      if (!message) {
        throw new Error(`DLQ message not found: ${messageId}`);
      }

      message.status = 'resolved';
      message.resolution = {
        ...resolution,
        resolvedAt: Date.now(),
      };

      // Record telemetry event
      const telemetryEvent: AllTelemetryEvents = {
        id: `dlq_resolved_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
        timestamp: Date.now(),
        type: 'DLQMessageReplayed',
        flowId: message.flowId,
        messageId: message.messageId,
        success: true,
        retryCount: message.retryCount,
        metadata: {
          resolvedBy: resolution.resolvedBy,
          resolution: resolution.resolution,
          actionsTaken: resolution.actionsTaken,
          resolutionTime: Date.now() - message.firstFailureTime,
        },
      };

      await this.telemetryService.recordEvent(telemetryEvent);

      this.logger.info('DLQ message resolved', {
        messageId,
        resolvedBy: resolution.resolvedBy,
        resolutionTime: Date.now() - message.firstFailureTime,
      });
    } catch (error) {
      this.logger.error('Failed to resolve DLQ message', { error, messageId });
      throw error;
    }
  }

  /**
   * Generate DLQ analytics
   */
  async getAnalytics(timeRangeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<DLQAnalytics> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;

      const messages = Array.from(this.messages.values())
        .filter(m => m.firstFailureTime >= startTime && m.firstFailureTime <= endTime);

      // Summary statistics
      const summary = {
        totalMessages: messages.length,
        pendingMessages: messages.filter(m => m.status === 'pending').length,
        failedMessages: messages.filter(m => m.status === 'failed').length,
        resolvedMessages: messages.filter(m => m.status === 'resolved').length,
        criticalMessages: messages.filter(m => m.severity === 'critical').length,
        avgResolutionTime: this.calculateAvgResolutionTime(messages),
      };

      // Error pattern analysis
      const errorCounts = new Map<string, number>();
      const errorTypes = new Map<string, string>();
      
      messages.forEach(m => {
        errorCounts.set(m.errorCode, (errorCounts.get(m.errorCode) || 0) + 1);
        errorTypes.set(m.errorCode, this.categorizeError(m.errorCode));
      });

      const errorPatterns = Array.from(errorCounts.entries())
        .map(([errorCode, count]) => ({
          errorCode,
          errorType: errorTypes.get(errorCode) || 'Unknown',
          count,
          percentage: (count / messages.length) * 100,
          trend: this.calculateTrend(errorCode, messages) as 'increasing' | 'decreasing' | 'stable',
          suggestedAction: this.getSuggestedAction(errorCode),
        }))
        .sort((a, b) => b.count - a.count);

      // System breakdown
      const systemStats = new Map<string, { total: number; critical: number; retries: number[] }>();
      
      messages.forEach(m => {
        const key = `${m.sourceSystem}-${m.targetSystem}`;
        const stats = systemStats.get(key) || { total: 0, critical: 0, retries: [] };
        stats.total++;
        if (m.severity === 'critical') stats.critical++;
        stats.retries.push(m.retryCount);
        systemStats.set(key, stats);
      });

      const systemBreakdown = Array.from(systemStats.entries()).map(([system, stats]) => {
        const avgRetries = stats.retries.reduce((sum, r) => sum + r, 0) / stats.retries.length;
        const successRate = ((stats.total - stats.critical) / stats.total) * 100;
        
        return {
          system,
          totalErrors: stats.total,
          criticalErrors: stats.critical,
          avgRetries,
          successRate,
        };
      });

      // Time analysis
      const timeAnalysis = {
        peakErrorHours: this.calculatePeakErrorHours(messages),
        errorsByDay: this.calculateErrorsByDay(messages),
        mttr: this.calculateMTTR(messages), // Mean Time To Resolution
        mtbf: this.calculateMTBF(messages), // Mean Time Between Failures
      };

      return {
        summary,
        errorPatterns,
        systemBreakdown,
        timeAnalysis,
      };
    } catch (error) {
      this.logger.error('Failed to generate DLQ analytics', { error });
      throw error;
    }
  }

  /**
   * Get message by ID
   */
  async getMessage(messageId: string): Promise<DLQMessage | null> {
    return this.messages.get(messageId) || null;
  }

  /**
   * Bulk operations
   */
  async bulkRetry(messageIds: string[]): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> {
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const messageId of messageIds) {
      try {
        await this.retryMessage(messageId);
        succeeded.push(messageId);
      } catch (error) {
        failed.push({
          id: messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return { succeeded, failed };
  }

  // Private helper methods
  private addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
    if (!index.has(key)) {
      index.set(key, new Set<string>());
    }
    index.get(key)!.add(value);
  }

  private async processRetry(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message) return;

    // Simulate retry logic - in production, this would attempt actual message processing
    const success = Math.random() > 0.3; // 70% success rate for demo

    if (success) {
      message.status = 'resolved';
      message.resolution = {
        resolvedBy: 'system',
        resolvedAt: Date.now(),
        resolution: 'Automatic retry successful',
        actionsTaken: ['Message retried', 'Processing completed successfully'],
      };

      // Record successful retry
      const telemetryEvent: AllTelemetryEvents = {
        id: `dlq_replayed_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
        timestamp: Date.now(),
        type: 'DLQMessageReplayed',
        flowId: message.flowId,
        messageId: message.messageId,
        success: true,
        retryCount: message.retryCount,
        metadata: {
          automaticRetry: true,
          resolutionTime: Date.now() - message.firstFailureTime,
        },
      };

      await this.telemetryService.recordEvent(telemetryEvent);
    } else {
      message.status = message.retryCount >= message.maxRetries ? 'failed' : 'pending';
    }
  }

  private calculateAvgResolutionTime(messages: DLQMessage[]): number {
    const resolvedMessages = messages.filter(m => m.status === 'resolved' && m.resolution);
    if (resolvedMessages.length === 0) return 0;

    const totalTime = resolvedMessages.reduce((sum, m) => {
      return sum + (m.resolution!.resolvedAt - m.firstFailureTime);
    }, 0);

    return totalTime / resolvedMessages.length;
  }

  private categorizeError(errorCode: string): string {
    if (errorCode.includes('AUTH') || errorCode.includes('401') || errorCode.includes('403')) {
      return 'Authentication';
    }
    if (errorCode.includes('NETWORK') || errorCode.includes('TIMEOUT') || errorCode.includes('CONNECTION')) {
      return 'Network';
    }
    if (errorCode.includes('VALIDATION') || errorCode.includes('400')) {
      return 'Validation';
    }
    if (errorCode.includes('RATE_LIMIT') || errorCode.includes('429')) {
      return 'Rate Limiting';
    }
    if (errorCode.includes('SERVER') || errorCode.includes('500')) {
      return 'Server Error';
    }
    return 'Business Logic';
  }

  private calculateTrend(errorCode: string, messages: DLQMessage[]): string {
    // Simple trend calculation based on recent vs older occurrences
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const twoDaysAgo = now - (2 * 24 * 60 * 60 * 1000);

    const recentCount = messages.filter(m => 
      m.errorCode === errorCode && m.firstFailureTime >= oneDayAgo
    ).length;
    
    const olderCount = messages.filter(m => 
      m.errorCode === errorCode && m.firstFailureTime >= twoDaysAgo && m.firstFailureTime < oneDayAgo
    ).length;

    if (recentCount > olderCount * 1.2) return 'increasing';
    if (recentCount < olderCount * 0.8) return 'decreasing';
    return 'stable';
  }

  private getSuggestedAction(errorCode: string): string {
    const suggestions: Record<string, string> = {
      'AUTH_FAILED': 'Check API credentials and token expiration',
      'NETWORK_TIMEOUT': 'Increase timeout settings or check network connectivity',
      'RATE_LIMIT_EXCEEDED': 'Implement exponential backoff or reduce request frequency',
      'VALIDATION_ERROR': 'Review data format and required fields',
      'SERVER_ERROR': 'Check target system health and contact vendor if persistent',
    };

    return suggestions[errorCode] || 'Review error details and contact system administrator';
  }

  private calculatePeakErrorHours(messages: DLQMessage[]): number[] {
    const hourCounts = new Array(24).fill(0);
    
    messages.forEach(m => {
      const hour = new Date(m.firstFailureTime).getHours();
      hourCounts[hour]++;
    });

    // Return hours with above-average error counts
    const avgCount = hourCounts.reduce((sum, count) => sum + count, 0) / 24;
    return hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter(({ count }) => count > avgCount)
      .map(({ hour }) => hour);
  }

  private calculateErrorsByDay(messages: DLQMessage[]): { date: string; count: number; severity: string }[] {
    const dayStats = new Map<string, { count: number; severities: string[] }>();

    for (const m of messages) {
      const t = m.firstFailureTime;
      if (typeof t !== 'number' || !isFinite(t)) continue;
      const dateObj = new Date(t);
      if (isNaN(dateObj.getTime())) continue; // Skip invalid dates

      const date: string = dateObj.toISOString().slice(0, 10);
      if (date.length !== 10) continue;

      let stats = dayStats.get(date);
      if (!stats) {
        stats = { count: 0, severities: [] };
        dayStats.set(date, stats);
      }

      stats.count += 1;
      if (m.severity) stats.severities.push(m.severity);
    }

    return Array.from(dayStats.entries()).map(([dateKey, stats]) => {
      const criticalCount = stats.severities.filter(s => s === 'critical').length;
      const highCount = stats.severities.filter(s => s === 'high').length;

      let severity: 'low' | 'high' | 'critical' = 'low';
      if (criticalCount > 0) severity = 'critical';
      else if (highCount > stats.count * 0.3) severity = 'high';

      return { date: dateKey, count: stats.count, severity };
    });
  }

  private calculateMTTR(messages: DLQMessage[]): number {
    const resolvedMessages = messages.filter(m => m.status === 'resolved' && m.resolution);
    if (resolvedMessages.length === 0) return 0;

    const totalResolutionTime = resolvedMessages.reduce((sum, m) => {
      return sum + (m.resolution!.resolvedAt - m.firstFailureTime);
    }, 0);

    return totalResolutionTime / resolvedMessages.length;
  }

  private calculateMTBF(messages: DLQMessage[]): number {
    if (messages.length < 2) return 0;

    const sortedMessages = messages.sort((a, b) => a.firstFailureTime - b.firstFailureTime);
    let totalTimeBetweenFailures = 0;
    
    for (let i = 1; i < sortedMessages.length; i++) {
      const currentMessage = sortedMessages[i];
      const previousMessage = sortedMessages[i - 1];
      if (currentMessage && previousMessage) {
        totalTimeBetweenFailures += currentMessage.firstFailureTime - previousMessage.firstFailureTime;
      }
    }

    return totalTimeBetweenFailures / (messages.length - 1);
  }

  /**
   * Get queue status for disaster recovery integration
   */
  async getQueueStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'critical' | 'unknown';
    message?: string;
    metrics?: Record<string, unknown>;
  }> {
    const analytics = await this.getAnalytics();
    const { totalMessages, pendingMessages, failedMessages } = analytics.summary;
    
    if (totalMessages === 0) {
      return { 
        status: 'healthy', 
        message: 'No messages in queue',
        metrics: { totalMessages: 0, pendingMessages: 0, failedMessages: 0 }
      };
    }
    
    const criticalMessages = Array.from(this.messages.values())
      .filter(m => m.severity === 'critical').length;
    const highPriorityMessages = Array.from(this.messages.values())
      .filter(m => m.severity === 'high').length;
    
    if (criticalMessages > 0) {
      return { 
        status: 'critical', 
        message: `${criticalMessages} critical messages in queue`,
        metrics: {
          totalMessages,
          pendingMessages,
          failedMessages,
          criticalMessages,
          highPriorityMessages
        }
      };
    } else if (highPriorityMessages > 5 || pendingMessages > 100) {
      return { 
        status: 'degraded', 
        message: `${highPriorityMessages} high priority messages, ${pendingMessages} pending`,
        metrics: {
          totalMessages,
          pendingMessages,
          failedMessages,
          criticalMessages,
          highPriorityMessages
        }
      };
    } else {
      return { 
        status: 'healthy', 
        message: `${pendingMessages} pending messages`,
        metrics: {
          totalMessages,
          pendingMessages,
          failedMessages,
          criticalMessages,
          highPriorityMessages
        }
      };
    }
  }

  /**
   * Export DLQ messages for backup
   */
  async exportMessages(): Promise<unknown> {
    const messages = Array.from(this.messages.values());
    const messagesByFlow = Object.fromEntries(
      Array.from(this.messagesByFlow.entries()).map(([key, value]) => [key, Array.from(value)])
    );
    const messagesBySystem = Object.fromEntries(
      Array.from(this.messagesBySystem.entries()).map(([key, value]) => [key, Array.from(value)])
    );
    
    return {
      messages,
      messagesByFlow,
      messagesBySystem,
      totalMessages: messages.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Import DLQ messages from backup
   */
  async importMessages(data: unknown): Promise<void> {
    if ((data as any).messages) {
      this.messages.clear();
      this.messagesByFlow.clear();
      this.messagesBySystem.clear();
      
      for (const message of (data as any).messages) {
        this.messages.set(message.id, message);
        this.addToIndex(this.messagesByFlow, message.flowId, message.id);
        this.addToIndex(this.messagesBySystem, `${message.sourceSystem}-${message.targetSystem}`, message.id);
      }
    }
    
    this.logger.info(`DLQ messages imported successfully: ${(data as any).messages?.length || 0} messages`);
  }

  /**
   * Process failed messages (for disaster recovery auto-remediation)
   */
  async processFailedMessages(): Promise<void> {
    const failedMessages = Array.from(this.messages.values())
      .filter(m => m.status === 'failed' && m.retryCount < m.maxRetries);
    
    this.logger.info(`Processing ${failedMessages.length} failed messages for disaster recovery`);
    
    for (const message of failedMessages) {
      try {
        await this.retryMessage(message.id);
        this.logger.debug(`Retried failed message: ${message.id}`);
      } catch (error) {
        this.logger.error(`Failed to retry message ${message.id}`, error);
      }
    }
    
    this.logger.info('Failed message processing completed');
  }
}