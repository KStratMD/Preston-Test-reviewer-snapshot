// Provider interfaces and lightweight mock implementations for dashboard parity
export interface QueueStatsProvider {
  getQueues(): Promise<{ name: string; waiting: number; active: number; failed: number; completed: number; retryable: number; }[]>;
}
export interface TraceProvider {
  getRecentSpans(): Promise<{ traceId: string; spanId: string; parentSpanId: string | null; name: string; durationMs: number; status: string; timestamp: string; attributes: Record<string,string>; }[]>;
}
export interface CredentialSummaryProvider {
  getSummary(): Promise<{ totalStored: number; providers: { type: string; count: number; lastRotation: string; }[]; encryption: { algorithm: string; keyRotationDays: number } }>;
}

// Mock implementations (no external dependencies)
export class MockQueueStatsProvider implements QueueStatsProvider {
  async getQueues() {
    const queues = ['sync-customer','sync-order','webhook-dispatch'];
    return queues.map(q => ({
      name: q,
      waiting: Math.floor(Math.random()*5),
      active: Math.floor(Math.random()*3),
      failed: Math.random()<0.2 ? Math.floor(Math.random()*2) : 0,
      completed: Math.floor(Math.random()*500) + 50,
      retryable: Math.floor(Math.random()*3),
    }));
  }
}
export class MockTraceProvider implements TraceProvider {
  async getRecentSpans() {
    return Array.from({ length: 5 }).map((_ , i) => ({
      traceId: Math.random().toString(16).slice(2, 18),
      spanId: Math.random().toString(16).slice(2, 10),
      parentSpanId: null as string | null,
      name: ['GET /api/configurations','POST /api/integrations/:id/test','GET /metrics'][i % 3] as string,
      durationMs: Number((Math.random()*80+10).toFixed(2)),
      status: 'OK',
      timestamp: new Date(Date.now() - i * 60000).toISOString(),
      attributes: { service: 'integration-hub', env: process.env.NODE_ENV || 'dev' },
    }));
  }
}
export class MockCredentialSummaryProvider implements CredentialSummaryProvider {
  async getSummary() {
    return {
      totalStored: 4,
      providers: [
        { type: 'salesforce', count: 1, lastRotation: '2025-08-01T00:00:00Z' },
        { type: 'netsuite', count: 1, lastRotation: '2025-08-05T00:00:00Z' },
        { type: 'dynamics365', count: 1, lastRotation: '2025-08-15T00:00:00Z' },
        { type: 'sap', count: 1, lastRotation: '2025-08-18T00:00:00Z' },
      ],
      encryption: { algorithm: 'aes-256-gcm', keyRotationDays: 90 },
    };
  }
}

export function createMockProviders() {
  return {
    queueProvider: new MockQueueStatsProvider(),
    traceProvider: new MockTraceProvider(),
    credentialProvider: new MockCredentialSummaryProvider(),
  };
}
