import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { DemoModeService } from '../DemoModeService';
import type { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import type { NewAuditLog } from '../../database/types';

export interface AdminDemoModeInput {
  enabled: boolean;
  actorUserId: string;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Coordinates the audited, platform-admin demo-mode mutation:
 *   1. persist a change-attempt audit row (fail-closed — a failed attempt
 *      audit blocks the mutation),
 *   2. flip the process-global demo-mode flag,
 *   3. persist a success or a sanitized-failure audit row.
 *
 * The demo-mode flag is a process-global runtime setting, so its audit rows
 * are tenant-scoped to 'global'. Thrown errors are never copied into audit
 * details; a stable sanitized code is recorded instead.
 */
@injectable()
export class AdminDemoModeService {
  constructor(
    @inject(TYPES.DemoModeService) private readonly demoMode: DemoModeService,
    @inject(TYPES.AuditLogRepository) private readonly audit: AuditLogRepository,
  ) {}

  async setDemoMode(input: AdminDemoModeInput): Promise<{ enabled: boolean }> {
    const previous = await this.demoMode.getDemoMode();

    const record = (
      action: string,
      result: 'success' | 'failure',
      errorMessage: string | null,
    ): Promise<unknown> => {
      const row: NewAuditLog = {
        tenant_id: 'global',
        user_id: input.actorUserId,
        action,
        resource_type: 'runtime_setting',
        resource_id: 'demo_mode',
        old_values: { enabled: previous },
        new_values: { enabled: input.enabled },
        details: { correlationId: input.correlationId, accessMode: 'platform_admin' },
        result,
        error_message: errorMessage,
        duration_ms: null,
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent ?? null,
      };
      return this.audit.create(row);
    };

    await record('settings.demo_mode.change_attempt', 'success', null);
    try {
      await this.demoMode.setDemoMode(input.enabled, { userId: input.actorUserId });
    } catch (error) {
      await record('settings.demo_mode.change_failed', 'failure', 'demo_mode_update_failed');
      // Throw a sanitized error so a raw message (which could carry secrets) is
      // never surfaced to the client or the terminal error handler's log line.
      // The original is preserved as `cause` for controlled diagnostics.
      throw new Error('demo_mode_update_failed', { cause: error });
    }
    await record('settings.demo_mode.change_succeeded', 'success', null);
    return { enabled: input.enabled };
  }
}
