import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { LineageRepository } from './LineageRepository';
import type { LineageEventView } from './LineageTypes';

@injectable()
export class LineageQueryService {
  constructor(@inject(TYPES.LineageRepository) private readonly repo: LineageRepository) {}

  async chainForRecord(input: {
    tenantId: string;
    system: string;
    entityType: string;
    entityId: string;
  }): Promise<LineageEventView[]> {
    const seed = await this.repo.findLatestChainForRecord(input);
    if (!seed) return [];
    return this.repo.listChain(input.tenantId, seed.chainId);
  }

  async findRecentReciprocalActivity(input: {
    tenantId: string;
    callerSystem: string;
    targetSystem: string;
    entityType: string;
    entityId: string;
    withinMs: number;
  }): Promise<{ chainId: string; occurredAt: string }[]> {
    return this.repo.findReciprocalChainSeeds(input);
  }
}
