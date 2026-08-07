import type { MigrationModule } from './index';
import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';

/**
 * Migration 061 — delete the legacy `*-central` demo fixtures owned by the
 * system tenant (PR-F5b-3).
 *
 * The demo fixtures moved onto CENTRAL_DEMO_TENANT_ID
 * (src/services/governance/demoTenant.ts). This is a re-key implemented as
 * delete-and-reseed rather than an UPDATE: finance's uniqueness key is
 * (tenant_id, approval_id), so re-keying in place could collide with rows the
 * boot seed had already written under the demo tenant. Deleting has no
 * collision math at all — migrations run BEFORE the boot seed pass, which
 * recreates every row under the demo tenant in the same startup.
 *
 * The id lists are FROZEN literals. Migrations are immutable history, so they
 * must not import from the live seed modules (whose fixtures may evolve);
 * these are exactly the ids the pre-F5b-3 seeds ever wrote. The tenant comes
 * from the imported SYSTEM_IDENTITY constant — the '__system__' literal is
 * forbidden outside identityContext.ts
 * (scripts/check-system-identity-isolation.mjs).
 *
 * Surgical by construction: a WHERE on (tenant_id, fixed demo id) cannot match
 * a real system-tenant row, and cannot match another tenant's row that happens
 * to share a demo id. Idempotent — a second run matches nothing.
 *
 * Irreversible by design (and the MigrationModule contract has no down()): the
 * deleted rows are demo fixtures the boot seed recreates. Dev-only side
 * effects, disclosed in the F5b-3 design doc: mutated demo state resets, and
 * workflow_central_activity_logs rows referencing the deleted demo instances
 * become orphans (cosmetic; no FK constraints). Real production never held
 * these rows — the seeds always skipped production.
 */
const DEMO_INSTANCE_IDS = ['INST-1000', 'INST-1001', 'INST-1002'];
const DEMO_TASK_IDS = ['WCTASK-demo-001', 'WCTASK-demo-002', 'WCTASK-demo-003'];
const DEMO_APPROVAL_IDS = [
  'appr-001', 'appr-002', 'appr-003', 'appr-004', 'appr-005', 'appr-006',
  'appr-007', 'appr-008', 'appr-009', 'appr-010', 'appr-011', 'appr-012',
];

export const migration: MigrationModule = {
  name: 'delete_system_tenant_demo_fixtures',
  async run(db) {
    const systemTenant = SYSTEM_IDENTITY.tenantId;

    await db
      .deleteFrom('workflow_central_tasks')
      .where('tenant_id', '=', systemTenant)
      .where('id', 'in', DEMO_TASK_IDS)
      .execute();

    await db
      .deleteFrom('workflow_central_instances')
      .where('tenant_id', '=', systemTenant)
      .where('id', 'in', DEMO_INSTANCE_IDS)
      .execute();

    await db
      .deleteFrom('finance_central_approvals')
      .where('tenant_id', '=', systemTenant)
      .where('approval_id', 'in', DEMO_APPROVAL_IDS)
      .execute();
  },
};
