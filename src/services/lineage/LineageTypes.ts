export type LineageEventType =
  | 'source_read'
  | 'transform'
  | 'governance_decision'
  | 'target_write';

export interface LineageEventInput {
  tenantId: string;
  chainId: string;
  sequence: number;
  eventType: LineageEventType;
  sourceSystem?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  targetSystem?: string | null;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  templateId?: string | null;
  correlationId: string;
  governanceResult?: string | null;
  payloadHash?: string | null;
  metadata: Record<string, unknown>;
  occurredAtOverride?: string;
}

export interface LineageEventView {
  id: string;
  tenantId: string;
  chainId: string;
  sequence: number;
  eventType: LineageEventType;
  sourceSystem: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  targetSystem: string | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
  templateId: string | null;
  correlationId: string;
  governanceResult: string | null;
  payloadHash: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface LineageChainSeed {
  chainId: string;
  occurredAt: string;
}
