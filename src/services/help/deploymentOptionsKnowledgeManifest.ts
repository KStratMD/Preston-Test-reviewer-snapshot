import type { ArchitectureKnowledgeNode } from './architectureKnowledgeManifest';

export const DEPLOYMENT_OPTIONS_DASHBOARD_SURFACE = 'suitecentral-deployment-options-dashboard';

export type DeploymentOptionsKnowledgeNode = ArchitectureKnowledgeNode;

const reportPath = 'docs/strategic/SUITECENTRAL_2_DEPLOYMENT_OPTIONS.md';
// NOTE: docPaths feed exact-path RAG boosting, and DocumentationIndexer only
// walks docs/ (see DocumentationIndexer.docsPath). A public/ path would never
// be indexed, so the exec-package doc is cited in the report prose instead of
// listed here as an inert docPath.

export const deploymentOptionsKnowledgeNodes: readonly DeploymentOptionsKnowledgeNode[] = [
  {
    id: 'tier-0-observe-assist',
    label: 'Tier 0: Observe / Assist',
    publicSummary:
      'Observe one SyncCentral error/context feed and assist operators without changing the existing production pipeline. Code present today is framed at about 95%; the next proof is Squire activation evidence.',
    internalSummary:
      'Public-safe enrichment only. This node intentionally avoids source-file paths and private tenant detail; answers should stay grounded in the strategic report and proof cards.',
    docPaths: [reportPath, 'docs/review/proof-cards/sync-error-assist.md'],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: ['docs/review/proof-cards/sync-error-assist.md'],
    auditCommands: [],
    relatedNodeIds: ['tier-1-governance-overlay', 'tier-2-enhance-synccentral', 'governance-data-custody'],
    publicQuestionSeeds: [
      'What data does Squire need to provide for Tier 0?',
      'How does observe-only mode avoid changing SyncCentral?',
    ],
    internalQuestionSeeds: [
      'What activation evidence should be captured before moving beyond observe-only?',
      'Which proof-card evidence supports Sync Error Assist for advisory use?',
    ],
  },
  {
    id: 'tier-1-governance-overlay',
    label: 'Tier 1: Governance Overlay',
    publicSummary:
      'Add DLP, audit, lineage, and approval controls around suggestions before deeper embedding. Code present today is framed at about 90%; Squire selects policy settings and reviewer ownership.',
    internalSummary:
      'Public-safe enrichment only. Keep answers focused on governance posture, approval ownership, and evidence capture rather than implementation internals.',
    docPaths: [
      reportPath,
      'docs/review/proof-cards/governance-service.md',
      'docs/review/proof-cards/workflow-central-operator.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/governance-service.md',
      'docs/review/proof-cards/workflow-central-operator.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-0-observe-assist', 'tier-2-enhance-synccentral', 'governance-data-custody'],
    publicQuestionSeeds: [
      'Which approvals are needed before applying an AI suggestion?',
      'What audit evidence should be shown in the pilot?',
    ],
    internalQuestionSeeds: [
      'Which policy choices must Squire make before pilot activation?',
      'How should approval evidence be presented in the first review?',
    ],
  },
  {
    id: 'tier-2-enhance-synccentral',
    label: 'Tier 2: First-to-Bill Wedge',
    publicSummary:
      'Recommended first deployment: enhance one existing Squire SyncCentral account with NetSuite Sync Error AI Assist first, then AI Field Mapping, without replacing SyncCentral. Code present today is framed at about 90%.',
    internalSummary:
      'Public-safe enrichment only. Ground answers in the first-to-bill sequence, saved-hours proof, and activation evidence rather than private pilot data.',
    docPaths: [
      reportPath,
      'docs/review/proof-cards/sync-error-assist.md',
      'docs/review/proof-cards/ai-providers.md',
      'docs/review/proof-cards/governance-service.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/sync-error-assist.md',
      'docs/review/proof-cards/ai-providers.md',
      'docs/review/proof-cards/governance-service.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-0-observe-assist', 'tier-1-governance-overlay', 'squire-product-fit', 'netsuite-path', 'pilot-gates'],
    publicQuestionSeeds: [
      'Why should Sync Error AI Assist come before AI Field Mapping?',
      'What evidence proves the first-to-bill wedge?',
    ],
    internalQuestionSeeds: [
      'Which pilot measures prove saved hours for the first-to-bill wedge?',
      'What should Squire activate first in SyncCentral?',
    ],
  },
  {
    id: 'tier-3-embedded-host',
    label: 'Tier 3: Embedded Host',
    publicSummary:
      'The embedded host path has source/test evidence, but the missing proof is live tenant install evidence. Code present today is framed at about 80%.',
    internalSummary:
      'Public-safe enrichment only. Emphasize the explicit no-live-tenant-install carve-out and the evidence required before calling this deployment-ready.',
    docPaths: [
      reportPath,
      'docs/strategic/NETSUITE_SUITEAPP_READINESS.md',
      'docs/strategic/BUSINESSCENTRAL_DYNAMICS_READINESS.md',
      'docs/review/proof-cards/embedded-platform-adapters.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: ['docs/review/proof-cards/embedded-platform-adapters.md'],
    auditCommands: [],
    relatedNodeIds: ['netsuite-path', 'business-central-path', 'pilot-gates'],
    publicQuestionSeeds: [
      'What does live tenant install proof require?',
      'Which embedded constraints are still unproven?',
    ],
    internalQuestionSeeds: [
      'Which evidence closes the no-live-tenant-install carve-out?',
      'When should Tier 3 follow the Tier 2 pilot?',
    ],
  },
  {
    id: 'tier-4-marketplace-listing',
    label: 'Tier 4: Marketplace Listing',
    publicSummary:
      'Marketplace listing is external validation and packaging, not the first Squire value path. Code present today is framed at about 35%.',
    internalSummary:
      'Public-safe enrichment only. Keep answers tied to packaging, legal/review, and current marketplace-program verification.',
    docPaths: [
      reportPath,
      'docs/strategic/NETSUITE_SUITEAPP_READINESS.md',
      'docs/strategic/BUSINESSCENTRAL_DYNAMICS_READINESS.md',
      'docs/review/proof-cards/netsuite-connector.md',
      'docs/review/proof-cards/business-central-connector.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/netsuite-connector.md',
      'docs/review/proof-cards/business-central-connector.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['netsuite-path', 'business-central-path', 'tier-5-full-native-app'],
    publicQuestionSeeds: [
      'Why is marketplace listing later than the Squire pilot?',
      'Which artifacts would a listing package need?',
    ],
    internalQuestionSeeds: [
      'Which partner-program terms should be re-verified before a listing decision?',
      'What proof is needed before spending effort on marketplace packaging?',
    ],
  },
  {
    id: 'tier-5-full-native-app',
    label: 'Tier 5: Full Native App',
    publicSummary:
      'A full native ERP app is deferred productization. The current repo contributes concepts and host scaffolding, not a finished native SuiteScript or AL product. Code present today is framed at about 10%.',
    internalSummary:
      'Public-safe enrichment only. Answers should make clear this is a later native-product decision, not required for first billing proof.',
    docPaths: [
      reportPath,
      'docs/strategic/NETSUITE_SUITEAPP_READINESS.md',
      'docs/strategic/BUSINESSCENTRAL_DYNAMICS_READINESS.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [],
    auditCommands: [],
    relatedNodeIds: ['tier-4-marketplace-listing', 'netsuite-path', 'business-central-path'],
    publicQuestionSeeds: [
      'What would justify a full native app build?',
      'Which current assets carry over to a native product?',
    ],
    internalQuestionSeeds: [
      'Which native app work is net-new versus reusable from the hosted platform?',
      'What commercial signal should precede a native app build?',
    ],
  },
  {
    id: 'squire-product-fit',
    label: 'Squire Product Fit',
    publicSummary:
      'SyncCentral is the natural Squire starting point because its error-record flow and per-integration mapping work align directly with Sync Error AI Assist and AI Field Mapping.',
    internalSummary:
      'Public-safe enrichment only. Ground answers in Squire product fit, pilot measurement, and the first-to-bill wedge.',
    docPaths: [reportPath, 'docs/review/proof-cards/sync-error-assist.md'],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: ['docs/review/proof-cards/sync-error-assist.md'],
    auditCommands: [],
    relatedNodeIds: ['tier-2-enhance-synccentral', 'pilot-gates'],
    publicQuestionSeeds: [
      'Why is SyncCentral the right Squire starting point?',
      'What should the pilot measure?',
    ],
    internalQuestionSeeds: [
      'How should SyncCentral saved-hours evidence be captured?',
      'Which Squire workflow should anchor the first pilot review?',
    ],
  },
  {
    id: 'netsuite-path',
    label: 'NetSuite Path',
    publicSummary:
      'NetSuite is the strongest first platform path for Squire because the recommended wedge targets NetSuite Sync Error AI Assist and field mapping.',
    internalSummary:
      'Public-safe enrichment only. Keep answers scoped to API/listing, embedded-host, and native SuiteApp tradeoffs in the readiness docs.',
    docPaths: [
      reportPath,
      'docs/strategic/NETSUITE_SUITEAPP_READINESS.md',
      'docs/review/proof-cards/netsuite-connector.md',
      'docs/review/proof-cards/embedded-platform-adapters.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/netsuite-connector.md',
      'docs/review/proof-cards/embedded-platform-adapters.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-2-enhance-synccentral', 'tier-3-embedded-host', 'tier-4-marketplace-listing'],
    publicQuestionSeeds: [
      'Which NetSuite path matches the pilot?',
      'What is not yet proven for a SuiteApp?',
    ],
    internalQuestionSeeds: [
      'Which NetSuite proof should be collected before SuiteApp packaging?',
      'How does the NetSuite path differ between API-first and embedded host?',
    ],
  },
  {
    id: 'business-central-path',
    label: 'Business Central Path',
    publicSummary:
      'Business Central has meaningful readiness but is better treated as a follow-on platform after the SyncCentral NetSuite wedge proves value.',
    internalSummary:
      'Public-safe enrichment only. Distinguish Business Central from broader Dynamics 365, which the report treats as lower readiness.',
    docPaths: [
      reportPath,
      'docs/strategic/BUSINESSCENTRAL_DYNAMICS_READINESS.md',
      'docs/review/proof-cards/business-central-connector.md',
      'docs/review/proof-cards/embedded-platform-adapters.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/business-central-connector.md',
      'docs/review/proof-cards/embedded-platform-adapters.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-3-embedded-host', 'tier-4-marketplace-listing', 'tier-5-full-native-app'],
    publicQuestionSeeds: [
      'Why is Business Central a follow-on platform?',
      'Where does broader Dynamics become different?',
    ],
    internalQuestionSeeds: [
      'Which Business Central proof should follow the NetSuite pilot?',
      'Why should broader Dynamics stay outside the first wedge?',
    ],
  },
  {
    id: 'governance-data-custody',
    label: 'Governance and Data Custody',
    publicSummary:
      'Early tiers preserve Squire as the system of record. SuiteCentral assists, governs, and records evidence using DLP, audit, data custody by reference, human approval, and proof cards.',
    internalSummary:
      'Public-safe enrichment only. Answers should emphasize reference-based custody and operator-in-the-loop controls.',
    docPaths: [
      reportPath,
      'docs/review/proof-cards/governance-service.md',
      'docs/review/proof-cards/workflow-central-operator.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/governance-service.md',
      'docs/review/proof-cards/workflow-central-operator.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-0-observe-assist', 'tier-1-governance-overlay', 'tier-2-enhance-synccentral'],
    publicQuestionSeeds: [
      'How does SuiteCentral avoid hosting ERP data in the early tiers?',
      'Which controls must be enabled for the pilot?',
    ],
    internalQuestionSeeds: [
      'Which custody evidence should be shown during pilot review?',
      'How do approval and audit controls reduce early-tier disruption?',
    ],
  },
  {
    id: 'pilot-gates',
    label: 'Pilot Decision Gates',
    publicSummary:
      'The first review should decide whether the Tier 2 wedge saved enough time to justify deeper embedding, using real error cases, mapping examples, approval traceability, and operator feedback.',
    internalSummary:
      'Public-safe enrichment only. Ground answers in measurable saved-hours evidence and decision gates before deeper platform commitment.',
    docPaths: [
      reportPath,
      'docs/review/proof-cards/sync-error-assist.md',
      'docs/review/proof-cards/governance-service.md',
    ],
    wikiPaths: [],
    sourceFiles: [],
    testFiles: [],
    proofCards: [
      'docs/review/proof-cards/sync-error-assist.md',
      'docs/review/proof-cards/governance-service.md',
    ],
    auditCommands: [],
    relatedNodeIds: ['tier-2-enhance-synccentral', 'tier-3-embedded-host', 'squire-product-fit'],
    publicQuestionSeeds: [
      'What should the pilot review meeting decide?',
      'Which metric proves enough value to go deeper?',
    ],
    internalQuestionSeeds: [
      'What threshold should trigger Tier 3 embedded-host work?',
      'Which saved-hours evidence should be captured for the first billing proof?',
    ],
  },
];

export function getDeploymentOptionsKnowledgeNode(id: string): DeploymentOptionsKnowledgeNode | undefined {
  return deploymentOptionsKnowledgeNodes.find((node) => node.id === id);
}
