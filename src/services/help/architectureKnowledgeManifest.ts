export type ArchitectureAudience = 'public' | 'internal';

export interface ArchitectureKnowledgeNode {
  id: string;
  label: string;
  publicSummary: string;
  internalSummary: string;
  docPaths: string[];
  wikiPaths: string[];
  sourceFiles: string[];
  testFiles: string[];
  proofCards: string[];
  auditCommands: string[];
  relatedNodeIds: string[];
  publicQuestionSeeds: string[];
  internalQuestionSeeds: string[];
}

export const architectureKnowledgeNodes: readonly ArchitectureKnowledgeNode[] = [
  {
    id: 'user-operator-surfaces',
    label: 'User & Operator Surfaces',
    publicSummary:
      'Main dashboards, field mapping, executive package views, embedded ERP sidecars, and hosted wiki entry points.',
    internalSummary:
      'Static HTML/JS served from public/ via Express; embedded ERP surfaces use iframe adapters declared in src/embedded/adapters/. ' +
      'The hosted wiki is a Quartz 4.5.2 build deployed to Cloudflare Pages via hosted-deploy.yml. ' +
      'All routes are registered in src/middleware/setup/RouteSetup.ts including the htmlFiles whitelist.',
    docPaths: ['docs/architecture/ARCHITECTURE.md'],
    wikiPaths: ['/wiki/pages/concepts/suitecentral-2-overview.html'],
    sourceFiles: ['src/index.ts', 'src/middleware/setup/RouteSetup.ts'],
    testFiles: [],
    proofCards: ['docs/review/proof-cards/embedded-platform-adapters.md'],
    auditCommands: [],
    relatedNodeIds: ['http-api-edge', 'data-evidence-publishing'],
    publicQuestionSeeds: [
      'Which operator surfaces are production-facing?',
      'How does the hosted wiki relate to the application?',
    ],
    internalQuestionSeeds: [
      'How is the htmlFiles whitelist enforced and where is it declared?',
      'Which embedded adapter files exist and what is the conformance test coverage?',
    ],
  },
  {
    id: 'http-api-edge',
    label: 'HTTP/API Edge',
    publicSummary:
      'Express route setup, auth and tenant context, AI proxy routes, WorkflowCentral routes, configuration APIs, and gateway policy surfaces.',
    internalSummary:
      'RouteSetup.ts mounts all route families; optionalAuthMiddleware wires Bearer JWT extraction globally on /api/*. ' +
      'Production AI is exclusively /api/ai/proxy/* (governed); legacy /api/ai/* issues 301 redirects. ' +
      'Tenant context is established via extractIdentityContext(req) reading req.auth → req.user → req.tenantContext.',
    docPaths: ['docs/architecture/MCP-GATEWAY-ARCHITECTURE.md'],
    wikiPaths: ['/wiki/pages/concepts/nl-action-gate.html'],
    sourceFiles: [
      'src/middleware/setup/RouteSetup.ts',
      'src/middleware/auth.ts',
      'src/services/governance/identityContext.ts',
    ],
    testFiles: [
      'tests/unit/middleware/authentication.test.ts',
      'tests/integration/IdentityPropagation.test.ts',
    ],
    proofCards: [],
    auditCommands: [
      'npm run audit-identity-header-reads',
      'npm run audit-tenant-isolation-invariant',
    ],
    relatedNodeIds: ['user-operator-surfaces', 'core-application-services', 'governance-safety'],
    publicQuestionSeeds: [
      'Where is tenant context established?',
      'Which API routes participate in governance?',
    ],
    internalQuestionSeeds: [
      'How does optionalAuthMiddleware populate req.user.tenantId from a Bearer JWT?',
      'Which route families are mounted in RouteSetup and what order do they register?',
    ],
  },
  {
    id: 'core-application-services',
    label: 'Core Application Services',
    publicSummary:
      'Integration orchestration, configuration, WorkflowCentral execution, ownership resolution, approval queues, audit logging, and module metrics.',
    internalSummary:
      'WorkflowCentralService orchestrates durable task execution with a tagged-union payload model (external_reference vs ephemeral_hosted). ' +
      'ConfigurationService keys IntegrationConfig by (tenantId, id) with flat on-disk JSON storage. ' +
      'ApprovalQueueService is DB-durable (governance_approvals table); the synchronous policy gate is the inline path; the queue is the deferred-approval path.',
    docPaths: ['docs/architecture/source-of-truth-model.md'],
    wikiPaths: ['/wiki/pages/concepts/production-proof.html'],
    sourceFiles: [
      'src/services/WorkflowCentralService.ts',
      'src/middleware/rbac.ts',
      'src/middleware/tenantStatusGate.ts',
    ],
    testFiles: [
      'tests/unit/services/__tests__/WorkflowCentralService.test.ts',
      'tests/unit/services/governance/ApprovalQueueService.test.ts',
      'tests/integration/workflow-central-audit-key-backcompat.test.ts',
    ],
    proofCards: [
      'docs/review/proof-cards/workflow-central-operator.md',
      'docs/review/proof-cards/flow-templates.md',
      'docs/review/proof-cards/audit-service.md',
    ],
    auditCommands: [
      'npm run audit-flow-templates',
      'npm run audit-governance-posture-reads',
    ],
    relatedNodeIds: [
      'http-api-edge',
      'governance-safety',
      'ai-intelligence',
      'connector-integration-layer',
    ],
    publicQuestionSeeds: [
      'What services form the core runtime?',
      'How are approval queues and audits connected?',
    ],
    internalQuestionSeeds: [
      'What is the WorkflowPayload tagged union and when is ephemeral_hosted allowed?',
      'How does ConfigurationService avoid cross-tenant config collisions with a flat on-disk store?',
    ],
  },
  {
    id: 'ai-intelligence',
    label: 'AI & Intelligence',
    publicSummary:
      'Provider selection, AI configuration, task-aware providers, multi-agent orchestration, and the RAG/help knowledge base.',
    internalSummary:
      'Supported providers: OpenAI (gpt-5.4-mini default), Anthropic/Claude (claude-haiku-4-5 default, Sonnet 4.6 upgrade), OpenRouter (50+ models, free tier), LMStudio (local; WSL-aware base URL). ' +
      'All AI provider calls are governed via /api/ai/proxy/* with synchronous DLP and policy gating. ' +
      'HelpChatService uses DocumentationKnowledgeBase for RAG over indexed repo docs; DocumentationIndexer builds the in-memory index.',
    docPaths: [
      'docs/architecture/AI-SYSTEMS-COMPARISON.md',
      'docs/features/help-chat-system.md',
    ],
    wikiPaths: ['/wiki/pages/concepts/embedded-intelligence.html'],
    sourceFiles: [
      'src/services/help/HelpChatService.ts',
      'src/services/help/DocumentationKnowledgeBase.ts',
      'src/routes/help.ts',
    ],
    testFiles: [
      'tests/unit/services/help/HelpChatService.test.ts',
      'tests/unit/services/help/DocumentationKnowledgeBaseExtended.test.ts',
    ],
    proofCards: [
      'docs/review/proof-cards/ai-providers.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['http-api-edge', 'governance-safety', 'core-application-services'],
    publicQuestionSeeds: [
      'Which AI providers are supported?',
      'How does the help knowledge base answer questions?',
    ],
    internalQuestionSeeds: [
      'How does AIProviderFactory select among OpenAI, Anthropic, OpenRouter, and LMStudio?',
      'What indexing strategy does DocumentationKnowledgeBase use for RAG retrieval?',
    ],
  },
  {
    id: 'governance-safety',
    label: 'Governance & Safety',
    publicSummary:
      'Governance checkpoints for policy, PII detection, outbound governance, tenant isolation, approval queues, and audit redaction.',
    internalSummary:
      'DLPService registers 14 PII patterns (6 field-gated, 8 unconditional) scanned on every AI and connector egress path via OutboundGovernanceService. ' +
      'GovernanceService.getPostureForTenant reads 4 tenant_configurations keys (allow_pii, block_on_detection, auto_redact, pii_types_csv) cached 60s with fail-closed default. ' +
      'TenantLifecycleService enforces 4 tenant states (active/suspended/disabled/trial_expired) via tenantStatusGate middleware; state transitions auto-revoke embedded session tokens.',
    docPaths: ['docs/architecture/PRODUCTION-VS-DEMO-GUIDE.md'],
    wikiPaths: ['/wiki/pages/concepts/production-vs-demo.html'],
    sourceFiles: [
      'src/services/security/DLPService.ts',
      'src/services/governance/OutboundGovernanceService.ts',
      'src/services/governance/identityContext.ts',
      'src/services/tenants/TenantLifecycleService.ts',
      'src/middleware/tenantStatusGate.ts',
    ],
    testFiles: [
      'tests/unit/services/security/DLPService.test.ts',
      'tests/unit/services/governance/OutboundGovernanceService.posture.test.ts',
      'tests/unit/middleware/tenantStatusGate.test.ts',
      'tests/integration/MCPAutoRedact.fixture.test.ts',
    ],
    proofCards: [
      'docs/review/proof-cards/dlp-service.md',
      'docs/review/proof-cards/governance-service.md',
      'docs/review/proof-cards/guarded-write-ownership-enforcement.md',
      'docs/review/proof-cards/sync-error-assist.md',
    ],
    auditCommands: [
      'npm run audit-status-claims',
      'npm run audit-governance-posture-reads',
      'npm run audit-secret-key-encryption',
      'npm run audit-tenant-isolation-invariant',
    ],
    relatedNodeIds: ['http-api-edge', 'core-application-services', 'connector-integration-layer'],
    publicQuestionSeeds: [
      'What prevents unsafe AI or data actions?',
      'Where does human approval happen?',
    ],
    internalQuestionSeeds: [
      'Which of the 14 DLP patterns are field-gated and why does field-gating matter for MCP tool results?',
      'How does OutboundGovernanceService structurally enforce egress scanning at all four chokepoints?',
    ],
  },
  {
    id: 'connector-integration-layer',
    label: 'Connector & Integration Layer',
    publicSummary:
      'Connector registry, base connector telemetry, production connector partition, beta/demo connectors, and external ERP/CRM systems.',
    internalSummary:
      'connectorRegistry.ts is the single source of truth (ADR-015): 5 production (NetSuite, Salesforce, Business Central, HubSpot, ShipStation), 1 beta (Oracle), 11 demo-mode, 1 stub (PayQuicker). ' +
      'Factory closures encapsulate constructor shapes; ConnectorManager.createConnector() and IntegrationService.getConnector() read the registry. ' +
      'CI gate audit-status-claims --check-wired-connectors enforces registry↔AST↔proof-card consistency.',
    docPaths: ['docs/architecture/PRODUCTION-VS-DEMO-GUIDE.md'],
    wikiPaths: ['/wiki/pages/concepts/production-proof.html'],
    sourceFiles: [
      'src/connectors/connectorRegistry.ts',
    ],
    testFiles: [
      'tests/unit/connectors/connectorRegistry.test.ts',
      'tests/integration/connectors.integration.test.ts',
    ],
    proofCards: [
      'docs/review/proof-cards/netsuite-connector.md',
      'docs/review/proof-cards/salesforce-connector.md',
      'docs/review/proof-cards/business-central-connector.md',
      'docs/review/proof-cards/hubspot-connector.md',
      'docs/review/proof-cards/shipstation-connector.md',
      'docs/review/proof-cards/oracle-connector.md',
    ],
    auditCommands: [
      'npm run audit-status-claims',
      'npm run audit-proof-cards',
    ],
    relatedNodeIds: [
      'core-application-services',
      'governance-safety',
      'data-evidence-publishing',
    ],
    publicQuestionSeeds: [
      'Which connectors are production, beta, demo, or stub?',
      'What is the connector registry source of truth?',
    ],
    internalQuestionSeeds: [
      'How does the factory closure pattern in connectorRegistry.ts handle five different constructor shapes?',
      'What does the audit-status-claims --check-wired-connectors gate verify and when does it exit non-zero?',
    ],
  },
  {
    id: 'data-evidence-publishing',
    label: 'Data, Evidence, and Publishing',
    publicSummary:
      'Runtime stores, metrics generation, drift guard, proof cards, reviewer mirror, NotebookLM Drive sync, OneDrive package, wiki build, and hosted deploy.',
    internalSummary:
      'metrics.json is the canonical evidence artifact stamped by npm run metrics:generate after a full test+coverage run; verify-metrics enforces freshness in CI. ' +
      'The reviewer mirror (KStratMD/Preston-Test-reviewer-snapshot) is force-pushed on every main push via reviewer-mirror.yml; check-mirror-reproducibility gates ensure mirror-shipped tests pass from the snapshot. ' +
      'NotebookLM Drive sync pushes 27 canonical sources as Google Docs; auto-sync is unreliable so scripts/notebooklm-refresh-sources.py force-refreshes per source.',
    docPaths: ['docs/INDEX.md'],
    wikiPaths: ['/wiki/pages/concepts/canonical-metrics.html'],
    sourceFiles: [],
    testFiles: [
      'tests/e2e/wiki/ai-bundle.spec.ts',
    ],
    proofCards: [
      'docs/review/proof-cards/strategic-positioning.md',
    ],
    auditCommands: [
      'npm run audit-status-claims',
      'npm run audit-proof-cards',
      'npm run audit-mirror-reproducibility',
    ],
    relatedNodeIds: ['user-operator-surfaces', 'connector-integration-layer'],
    publicQuestionSeeds: [
      'How does documentation evidence get published?',
      'Which artifacts feed NotebookLM and the wiki?',
    ],
    internalQuestionSeeds: [
      'What is the allowlist mechanism that decides which files ship in the reviewer mirror?',
      'How does the mirror reproducibility gate detect tests that depend on non-mirrored files?',
    ],
  },
];

export function getArchitectureKnowledgeNode(id: string): ArchitectureKnowledgeNode | undefined {
  return architectureKnowledgeNodes.find((node) => node.id === id);
}
