# Proof Card: Audit Service

**Status:** production
**Last verified:** 2026-05-03 · PR 4A2 local verification

## Claim

`AuditService` persists AI orchestration, governance, and data-access audit events to the `audit_logs` table with non-null tenant attribution. Before audit event details are stored, `OutboundGovernanceService.validateAuditLogPayload()` redacts or omits unsafe details so audit persistence does not become a PII exfiltration path.

## Source

- Implementation: `src/services/ai/orchestrator/AuditService.ts`
- Persistence mapper: `src/services/ai/orchestrator/AuditPersistenceMapper.ts`
- Repository: `src/database/repositories/AuditLogRepository.ts`
- Schema hardening: `src/database/migrations/031-harden-audit-logs-for-persistence.ts`
- DI binding: `src/inversify/inversify.config.ts`
- Governance guard: `src/services/governance/OutboundGovernanceService.ts`

## Tests

- Migration: `tests/unit/database/migrations/audit-logs-persistence.test.ts`
- Repository: `tests/unit/database/repositories/AuditLogRepository.auditPersistence.test.ts`
- Service persistence and DLP: `tests/unit/services/ai/AuditService.persistence.test.ts`
- Existing behavior coverage: `tests/unit/services/ai/AuditServiceExtended.test.ts`

## Live vs Fixture

- Durable store wired? **Yes** — `AuditService.storeAuditLog()` inserts rows into `audit_logs` through `AuditLogRepository`.
- Tenant attribution enforced? **Yes** — migration makes `tenant_id` non-null and new writes use either caller tenant context or `SYSTEM_IDENTITY.tenantId`.
- Audit details DLP wired? **Yes** — `validateAuditLogPayload()` runs before `details` persistence.
- Demo-mode branch? **No** — persistence path is the production service path bound to `TYPES.AuditService`.

## Known Gaps

- Some callers still lack verified tenant identity and therefore use the explicit `__system__` sentinel. Route-level auth retrofit remains separate from audit durability.
- The older `src/services/AuditService.ts` is not the production compliance audit service. It should be removed or converted in a cleanup PR if it starts gaining call sites.

## Verification

```bash
npm run typecheck
npx jest --config=jest.ci.config.cjs tests/unit/database/migrations/audit-logs-persistence.test.ts tests/unit/database/repositories/AuditLogRepository.auditPersistence.test.ts tests/unit/services/ai/AuditService.persistence.test.ts --runInBand
npm run audit-proof-cards
```
