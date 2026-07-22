/* eslint-env node */
/* eslint-disable no-undef */

/**
 * Jest Core Coverage Configuration (Phase 5b)
 *
 * Narrowly-scoped coverage profile for the 15 load-bearing files behind the
 * Phase 4 proof cards. Both `testMatch` AND `collectCoverageFrom` are
 * restricted: testMatch enumerates only the test files that exercise the 15
 * production files, and collectCoverageFrom restricts measurement to those
 * production files. The result is a fast, deterministic measurement that
 * produces identical numbers locally and in CI — required for the per-file
 * ratchet to be load-bearing across environments.
 *
 * Why narrow testMatch (Codex review of PR #696):
 *   1. The broad CI config (jest.ci.config.cjs) already runs the full unit
 *      suite via `npm run test:coverage:ci`. Re-running it here just to
 *      restrict coverage measurement would double Jest runtime in the
 *      ci-minimal.yml job (15-min timeout would not absorb that).
 *   2. Stamping `.core-coverage-budget.json` from a different test set than
 *      CI runs creates a guaranteed first-PR failure: the strict ratchet
 *      fails on BOTH regression and improvement, and there is no
 *      "follow-up PR" path because this PR can't merge to begin with.
 *
 * The targeted set was derived empirically by running the full unit suite
 * locally (with --testPathIgnorePatterns="aiProxyRoutes" to work around the
 * pre-existing WSL2 DLOPEN crash) and recording which test files contributed
 * any coverage to the 15 production files. New tests for these files should
 * be added to this list explicitly so they are picked up by the ratchet.
 *
 * The per-file ratchet lives in `.core-coverage-budget.json` and is enforced
 * by `scripts/check-core-coverage-budget.mjs` (mirrors `.strict-null-budget`).
 *
 * Extends: jest.base.config.cjs
 * @type {import('jest').Config}
 */
const baseConfig = require('./jest.base.config.cjs');

module.exports = {
  ...baseConfig,
  testMatch: [
    // Connector unit tests
    '<rootDir>/tests/unit/__tests__/BusinessCentralConnector.test.ts',
    '<rootDir>/tests/unit/__tests__/NetSuiteConnector.test.ts',
    '<rootDir>/tests/unit/__tests__/OracleConnector.test.ts',
    '<rootDir>/tests/unit/__tests__/SalesforceConnector.test.ts',
    '<rootDir>/tests/unit/connectors.unit.test.ts',
    '<rootDir>/tests/unit/connectors/__tests__/NetSuiteConnectorDemoMode.test.ts',
    '<rootDir>/tests/unit/connectors/__tests__/OracleConnectorDemoMode.test.ts',
    // Connector outbound DLP governance tests (exercises write paths on production connectors)
    '<rootDir>/tests/unit/connectors/ConnectorOutboundGovernance.test.ts',
    // Connector contract tests (HubSpot/NetSuite/ShipStation)
    '<rootDir>/tests/unit/contract/HubSpotConnector.contract.test.ts',
    '<rootDir>/tests/unit/contract/NetSuiteConnector.contract.test.ts',
    '<rootDir>/tests/unit/contract/ShipStationConnector.contract.test.ts',
    // Pagination tests that exercise HubSpot/ShipStation connectors
    '<rootDir>/tests/unit/routes/__tests__/hubSpot.pagination.test.ts',
    '<rootDir>/tests/unit/routes/__tests__/shipStation.pagination.test.ts',
    // MCP aggregator + governance + DLP + AI provider factories
    '<rootDir>/tests/unit/__tests__/services/mcp/MCPAggregatorService.test.ts',
    '<rootDir>/tests/unit/__tests__/services/mcp/MCPAggregatorService.posture.test.ts',
    '<rootDir>/tests/unit/__tests__/services/mcp/MCPGatewayGoldenTranscript.test.ts',
    '<rootDir>/tests/unit/routes/__tests__/mcpRouter.test.ts',
    '<rootDir>/tests/unit/services/ai/orchestrator/GovernanceService.commit2.test.ts',
    '<rootDir>/tests/unit/services/ai/orchestrator/GovernanceService.coverage.test.ts',
    '<rootDir>/tests/unit/services/ai/orchestrator/GovernanceService.tenantPosture.test.ts',
    '<rootDir>/tests/unit/services/ai/providers/OutboundGovernance.test.ts',
    '<rootDir>/tests/unit/services/ai/providers/ProviderFactories.test.ts',
    '<rootDir>/tests/unit/services/governance/OutboundGovernanceService.test.ts',
    '<rootDir>/tests/unit/services/governance/OutboundGovernanceService.posture.test.ts',
    '<rootDir>/tests/unit/services/governance/handlers/OwnershipResumeHandler.test.ts',
    '<rootDir>/tests/unit/services/governance/operatorOverride.test.ts',
    // PR 13c-2 Task 3: encrypted WriteDescriptor storage helper
    '<rootDir>/tests/unit/services/governance/writeDescriptorEncryption.test.ts',
    '<rootDir>/tests/unit/services/security/DLPService.test.ts',
    '<rootDir>/tests/unit/services/security/findingsRiskClassifier.test.ts',
    // OAuth1 signing primitive
    '<rootDir>/tests/unit/utils/oauth1Helper.test.ts',
    // Sync error assist service tests
    '<rootDir>/tests/unit/database/repositories/TenantConfigurationRepository.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/SyncErrorAssistDailyJob.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/SyncErrorAssistRepository.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/SyncErrorAssistService.test.ts',
    // PR 17c webhook ingest surface (verifier + Zod schema + extracted service methods)
    '<rootDir>/tests/unit/middleware/syncErrorAssistWebhook.test.ts',
    '<rootDir>/tests/unit/routes/syncErrorAssistWebhookSchema.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/processClaimedRecord.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/sanitizeSourcePayloadForPrompt.test.ts',
    '<rootDir>/tests/unit/services/syncErrorAssist/normalizeErrorRecordForPrompt.test.ts',
    // PR 6 (financeCentral operator promotion): durable approval state machine
    '<rootDir>/tests/unit/services/financeCentral/FinanceCentralRepository.test.ts',
    '<rootDir>/tests/unit/services/financeCentral/FinanceCentralOperatorService.test.ts',
    // PR-OP-2 (workflowCentral operator promotion): durable task state machine
    '<rootDir>/tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/WorkflowEngineService.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/WorkflowCentralOperatorService.test.ts',
    // PR-OP-3 (workflowCentral instance durability): typed errors + config + metrics + readiness gate
    '<rootDir>/tests/unit/services/workflowCentral/errors.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/config.test.ts',
    // Phase 1 governance-without-hosting-data (ADR-019): payload contract + resolver + cache + backfill derivation
    '<rootDir>/tests/unit/services/workflowCentral/payload/WorkflowPayload.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/payload/errors.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/payload/WorkflowPayloadResolver.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/payload/WorkflowPayloadResolver.posture.test.ts',
    '<rootDir>/tests/unit/services/workflowCentral/payload/WorkflowPayloadCache.test.ts',
    '<rootDir>/tests/unit/services/WorkflowCentralService.redactCancellationReason.posture.test.ts',
    '<rootDir>/tests/unit/scripts/backfill-workflow-payload-refs.test.ts',
    // C1: ephemeral-payload retention reaper
    '<rootDir>/tests/unit/services/workflowCentral/WorkflowPayloadRetentionJob.test.ts',
    // PR 14 narrowed: FlowExecutor + governed flow template DSL
    '<rootDir>/tests/unit/flows/templates/FlowExecutor.test.ts',
    // PR 13: ownership pre-flight in FlowExecutor (exercises the new ownership block)
    '<rootDir>/tests/unit/flows/templates/FlowExecutor.ownership.test.ts',
    // Cost Transparency (PR 21)
    '<rootDir>/tests/unit/services/cost/modelPricing.test.ts',
    '<rootDir>/tests/unit/services/cost/CostTransparencyRepository.test.ts',
    '<rootDir>/tests/unit/services/cost/CostTransparencyService.test.ts',
    '<rootDir>/tests/unit/services/cost/CostTransparencyDailyJob.test.ts',
    '<rootDir>/tests/unit/routes/costTransparencyRoutes.test.ts',
    // Reconciliation Center (PR 11)
    '<rootDir>/tests/unit/services/reconciliationCenter/ReconciliationCenterService.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/ReconciliationExceptionRepository.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/ReconciliationScheduleJob.test.ts',
    '<rootDir>/tests/unit/routes/reconciliationCenterRoutes.test.ts',
    // Reconciliation Center — cadence handler (NetSuite <-> BC invoices)
    '<rootDir>/tests/unit/services/reconciliationCenter/ReconciliationScheduleRepository.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/money.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/cadence.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/invoiceComparison.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/reconcilers/ReconcilerRegistry.test.ts',
    '<rootDir>/tests/unit/services/reconciliationCenter/reconcilers/NetSuiteBusinessCentralInvoiceReconciler.test.ts',
    // Record-Level Lineage (PR 12)
    '<rootDir>/tests/unit/database/migrations/049-create-lineage-events-table.test.ts',
    '<rootDir>/tests/unit/services/lineage/LineageRepository.test.ts',
    // PR 13: findReciprocalChainSeeds (new repo method exercised by detectLoop)
    '<rootDir>/tests/unit/services/lineage/LineageRepository.findReciprocalChainSeeds.test.ts',
    '<rootDir>/tests/unit/services/lineage/LineageRecorder.test.ts',
    '<rootDir>/tests/unit/services/lineage/LineageQueryService.test.ts',
    '<rootDir>/tests/unit/routes/lineageRoutes.test.ts',
    '<rootDir>/tests/unit/routes/embedded/embeddedLineageRouter.test.ts',
    '<rootDir>/tests/unit/routes/embedded/embeddedReconciliationRouter.test.ts',
    // PR 13b: guardedWrite chokepoint + WriteBlockedError hierarchy + audit widening + 409 middleware
    '<rootDir>/tests/unit/governance/sourceOfTruth/guardedWrite.test.ts',
    '<rootDir>/tests/unit/governance/sourceOfTruth/ConflictResolutionPolicy.errorHierarchy.test.ts',
    '<rootDir>/tests/unit/governance/sourceOfTruth/OwnershipResolver.queueRequired.test.ts',
    '<rootDir>/tests/unit/middleware/governance/approvalQueueErrorHandler.writeBlocked.test.ts',
    '<rootDir>/tests/unit/services/ai/orchestrator/AuditService.logGovernanceCheck.test.ts',
    // PR 13b Task 29: operator-dashboard read API + queryGovernanceChecks
    '<rootDir>/tests/unit/services/ai/orchestrator/AuditService.queryGovernanceChecks.test.ts',
    '<rootDir>/tests/unit/routes/governance/operationsRouter.test.ts',
    // PR 13c-3: direct unit coverage for the _governanceAuth role helpers
    // (ADMIN_ROLES / hasAdminRole / requireAdminRole added in R0 alongside
    // APPROVER_ROLES). Restores the Phase-5b coverage floor — integration
    // tests go through validateGuestContext mocks that short-circuit these
    // helpers, so direct function-level coverage requires this entry.
    '<rootDir>/tests/unit/routes/governance/_governanceAuth.test.ts',
    // PR 13b Task 32: integration tests for guardedWrite e2e + FlowExecutor unification.
    // Listed here (not just in the smoke list) so the Phase-5b core-coverage ratchet
    // picks up coverage from FlowExecutor + guardedWrite + ConflictResolutionPolicy
    // exercised by these flows.
    '<rootDir>/tests/integration/guardedWrite.endToEnd.test.ts',
    '<rootDir>/tests/integration/FlowExecutor.guardedWriteUnification.test.ts',
    '<rootDir>/tests/unit/routes/hubSpot.test.ts',
    // Task 10: tenant/governance ratchet expansion
    '<rootDir>/tests/unit/middleware/tenantStatusGate.test.ts',
    '<rootDir>/tests/unit/middleware/tenantIsolation.test.ts',
    '<rootDir>/tests/unit/services/tenants/TenantLifecycleService.test.ts',
    '<rootDir>/tests/unit/services/governance/identityContext.test.ts',
    '<rootDir>/tests/unit/services/governance/ApprovalQueueService.test.ts',
    // PR-G (C2): security-critical surfaces previously tested but absent from
    // the core ratchet — the dedicated suites now run in the core profile so
    // their per-file floors are real, not source-only near-zeros.
    '<rootDir>/tests/unit/services/security/EncryptionServiceExtended.test.ts',
    '<rootDir>/tests/unit/services/security/NERService.test.ts',
    '<rootDir>/tests/unit/services/governance/ApprovalQueueRepository.test.ts',
    '<rootDir>/tests/unit/services/governance/ApprovalResumeWorker.test.ts',
    '<rootDir>/tests/unit/services/governance/resolveActor.test.ts',
    '<rootDir>/tests/unit/services/governance/approvalModeStartupGuard.test.ts',
    '<rootDir>/tests/unit/services/tenants/TenantLifecycleRepository.test.ts',
    '<rootDir>/tests/unit/middleware/authentication.test.ts',
    '<rootDir>/tests/unit/middleware/rbac.test.ts',
    '<rootDir>/tests/unit/middleware/governanceMiddleware.test.ts',
    '<rootDir>/tests/unit/middleware/embeddedAuthMiddleware.test.ts'
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage-core',
  coverageReporters: ['text', 'json-summary'],
  collectCoverageFrom: [
    // 6 connectors (5 production + Oracle beta — Phase 3 partition)
    'src/connectors/NetSuiteConnector.ts',
    'src/connectors/SalesforceConnector.ts',
    'src/connectors/BusinessCentralConnector.ts',
    'src/connectors/HubSpotConnector.ts',
    'src/connectors/ShipStationConnector.ts',
    'src/connectors/OracleConnector.ts',
    // Security + governance
    'src/services/security/DLPService.ts',
    'src/services/security/findingsRiskClassifier.ts',
    'src/services/ai/orchestrator/GovernanceService.ts',
    'src/services/governance/OutboundGovernanceService.ts',
    // MCP aggregation (the auto-redact path)
    'src/services/mcp/MCPAggregatorService.ts',
    // 4 AI providers + the router
    'src/services/ai/providers/OpenAIProvider.ts',
    'src/services/ai/providers/ClaudeProvider.ts',
    'src/services/ai/providers/OpenRouterProvider.ts',
    'src/services/ai/providers/LMStudioProvider.ts',
    'src/services/ai/providers/IntelligentProviderRouter.ts',
    // OAuth1 signing primitive (proof that NetSuite isn't faking)
    'src/utils/oauth1Helper.ts',
    // Sync error assist service (database + service layer)
    'src/database/repositories/TenantConfigurationRepository.ts',
    'src/services/syncErrorAssist/SyncErrorAssistDailyJob.ts',
    'src/services/syncErrorAssist/SyncErrorAssistRepository.ts',
    'src/services/syncErrorAssist/SyncErrorAssistService.ts',
    // PR 17c webhook ingest surface
    'src/middleware/syncErrorAssistWebhook.ts',
    'src/routes/syncErrorAssistWebhookSchema.ts',
    // PR 6 (financeCentral operator promotion): durable approval state machine
    'src/services/financeCentral/FinanceCentralRepository.ts',
    'src/services/financeCentral/FinanceCentralOperatorService.ts',
    // PR-OP-2 (workflowCentral operator promotion): durable task state machine
    'src/services/workflowCentral/WorkflowCentralRepository.ts',
    'src/services/workflowCentral/WorkflowEngineService.ts',
    'src/services/workflowCentral/WorkflowCentralOperatorService.ts',
    // PR-OP-3 (workflowCentral instance durability): typed errors + config + metrics + readiness gate
    'src/services/workflowCentral/errors.ts',
    'src/services/workflowCentral/config.ts',
    'src/services/workflowCentral/metrics.ts',
    'src/middleware/workflowCentralReady.ts',
    // Phase 1 governance-without-hosting-data (ADR-019): payload contract + resolver + cache + backfill derivation
    'src/services/workflowCentral/payload/WorkflowPayload.ts',
    'src/services/workflowCentral/payload/errors.ts',
    'src/services/workflowCentral/payload/WorkflowPayloadResolver.ts',
    'src/services/workflowCentral/payload/WorkflowPayloadCache.ts',
    'src/services/workflowCentral/payload/backfillDerivation.ts',
    // C1: ephemeral-payload retention reaper (sweeps expired ephemeral_hosted payloads)
    'src/services/workflowCentral/WorkflowPayloadRetentionJob.ts',
    // PR 14 narrowed: FlowExecutor (the governance-completing slice)
    'src/flows/templates/FlowExecutor.ts',
    // Cost Transparency (PR 21)
    'src/services/cost/modelPricing.ts',
    'src/services/cost/CostTransparencyRepository.ts',
    'src/services/cost/CostTransparencyService.ts',
    'src/services/cost/CostTransparencyDailyJob.ts',
    'src/routes/costTransparencyRoutes.ts',
    // Reconciliation Center (PR 11)
    'src/services/reconciliationCenter/ReconciliationCenterService.ts',
    'src/services/reconciliationCenter/ReconciliationExceptionRepository.ts',
    'src/services/reconciliationCenter/ReconciliationScheduleJob.ts',
    'src/routes/reconciliationCenterRoutes.ts',
    // Reconciliation Center — cadence handler (NetSuite <-> BC invoices)
    'src/services/reconciliationCenter/ReconciliationScheduleRepository.ts',
    'src/services/reconciliationCenter/money.ts',
    'src/services/reconciliationCenter/cadence.ts',
    'src/services/reconciliationCenter/invoiceComparison.ts',
    'src/services/reconciliationCenter/reconcilers/Reconciler.ts',
    'src/services/reconciliationCenter/reconcilers/NetSuiteBusinessCentralInvoiceReconciler.ts',
    // Record-Level Lineage (PR 12)
    'src/database/migrations/049-create-lineage-events-table.ts',
    'src/services/lineage/LineageTypes.ts',
    'src/services/lineage/LineageRepository.ts',
    'src/services/lineage/LineageRecorder.ts',
    'src/services/lineage/LineageQueryService.ts',
    'src/routes/lineageRoutes.ts',
    'src/routes/embedded/embeddedLineageRouter.ts',
    'src/routes/embedded/embeddedReconciliationRouter.ts',
    // PR 13b: guardedWrite chokepoint + WriteBlockedError hierarchy
    'src/governance/sourceOfTruth/guardedWrite.ts',
    'src/governance/sourceOfTruth/ConflictResolutionPolicy.ts',
    // PR 13b Task 28: detectLoop helper + connector recordType mapping
    'src/governance/sourceOfTruth/connectorRecordType.ts',
    // PR 13b Stage B: post-approval write dispatcher
    'src/services/governance/handlers/OwnershipResumeHandler.ts',
    // PR 13c-2 Task 3: encrypted args envelope persisted in governance_approvals.write_descriptor
    'src/services/governance/writeDescriptorEncryption.ts',
    // PR 13b Task 29: operator-dashboard read API
    'src/routes/governance/operationsRouter.ts',
    'src/routes/governance/_governanceAuth.ts',
    // Task 10: tenant/governance ratchet expansion
    'src/middleware/tenantStatusGate.ts',
    'src/middleware/tenantIsolation.ts',
    'src/services/tenants/TenantLifecycleService.ts',
    'src/services/governance/identityContext.ts',
    'src/services/governance/ApprovalQueueService.ts',
    // PR-G (C2): security-critical files previously tested but absent from
    // the ratchet — one file could regress toward 0% unnoticed under the
    // broad profile's global threshold. Dedicated suites added to testMatch
    // in the same PR so the stamped floors are real.
    'src/services/security/EncryptionService.ts',
    'src/services/security/NERService.ts',
    'src/services/governance/ApprovalQueueRepository.ts',
    'src/services/governance/ApprovalResumeWorker.ts',
    'src/services/governance/resolveActor.ts',
    'src/services/governance/approvalModeStartupGuard.ts',
    'src/services/tenants/TenantLifecycleRepository.ts',
    'src/middleware/authentication.ts',
    'src/middleware/rbac.ts',
    'src/middleware/governanceMiddleware.ts',
    'src/middleware/embeddedAuthMiddleware.ts',
    'src/services/governance/operatorOverride.ts'
  ]
  // Note: NO coverageThreshold here. Per-file enforcement is the ratchet's job
  // (scripts/check-core-coverage-budget.mjs reads coverage-core/coverage-summary.json
  // and compares against .core-coverage-budget.json). This matches the
  // .strict-null-budget pattern: a single dedicated check, not a Jest threshold.
};
