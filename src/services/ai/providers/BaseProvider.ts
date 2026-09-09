import { injectable } from 'inversify';
import { Logger } from '../../../utils/Logger';
import { OutboundGovernanceService, OutboundContext } from '../../governance/OutboundGovernanceService';
import { GovernanceBlockedError, PendingApprovalError } from '../../governance/OutboundGovernanceErrors';

@injectable()
export abstract class BaseProvider {
  constructor(
    protected readonly logger: Logger,
    protected readonly outboundGovernance: OutboundGovernanceService
  ) {
    if (!outboundGovernance) {
      throw new Error('OutboundGovernanceService is required for AI provider outbound protection');
    }
  }

  /**
   * Secure wrapper around fetch that enforces outbound DLP policies.
   * Only use this for model inference endpoints that receive prompts/user-data.
   * Do NOT use this for discovery endpoints (like getAvailableModels).
   *
   * @param url The endpoint URL
   * @param body The parsed JSON body object (not stringified)
   * @param init Request initialization options (method, headers, signal, etc.)
   * @param ctx The governance context for this request
   * @returns A raw Response object. Callers handle .ok checks and JSON parsing.
   */
  protected async sendRequest(
    url: string,
    body: Record<string, unknown>,
    init: Omit<RequestInit, 'body'>,
    ctx: OutboundContext
  ): Promise<Response> {
    const decision = await this.outboundGovernance.validateAIProviderRequest(body, ctx);

    // Check Option A (Queue mode) first
    if (decision.approvalRequired) {
      throw new PendingApprovalError(decision);
    }

    // Check Option B (Block mode) second
    if (!decision.approved) {
      throw new GovernanceBlockedError(decision);
    }

    body = (decision.redactedPayload as Record<string, unknown>) ?? body;

    return fetch(url, {
      ...init,
      body: JSON.stringify(body),
    });
  }
}
