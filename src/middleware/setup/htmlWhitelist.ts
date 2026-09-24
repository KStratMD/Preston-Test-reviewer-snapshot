// src/middleware/setup/htmlWhitelist.ts
/**
 * The single list of HTML pages `express.static` may serve from `public/`.
 *
 * This list used to live inside `RouteSetup.setupStaticHtmlRoutes()`, where it
 * only decided which pages got no-cache headers. It is now also the allowlist
 * enforced by `denyUnlistedHtml` (src/middleware/staticHtmlPolicy.ts): a page
 * absent from here is not served, so adding an entry publishes that page.
 *
 * Entries are paths relative to `public/`, so nested pages carry their
 * directory. The one directory served in bulk (`wiki/`) is allowlisted in
 * staticHtmlPolicy.ts instead, with its reason.
 *
 * Kept as a plain array literal because scripts/check-html-whitelist-sync.mjs
 * parses this file textually to prove the list and the files on disk agree.
 *
 * Deliberately NOT listed, though the files exist on disk:
 *   metrics-viewer.html  - internal metrics view, no reason to be public
 *   vendor-portal.html   - superseded by vendor-portal/index.html, which is listed
 * Both were previously reachable through the EXEMPT bypass in the sync gate,
 * which this change retires.
 */
export const htmlFiles = [
  'index.html',
  'admin-templates.html',
  'Integration-Command-Center.html',
  'ai-agents-dashboard.html',
  'ai-features-dashboard.html',
  'ai-configuration-dashboard.html',
  'ai-field-mapping-editor.html',
  'ai-usage-dashboard.html',  // Added 2025-10-28: UI HTML audit fix
  'enterprise-features.html',
  'advanced-field-mapping-editor.html',
  'ai-mapping-center.html',
  'api-docs.html',
  'connector-ecosystem.html',
  'data-migration.html',
  'debug-modal.html',
  'disaster-recovery.html',
  'dlq-management.html',
  // Legacy executive pages moved to _archive - removed from whitelist 2026-01-18
  'help-chat-widget.html',
  'integration-dashboard-enhanced.html',
  'integration-wizard-5step.html',
  'integration-wizard-enhanced.html',  // Added 2025-10-28: UI HTML audit fix
  // 'interactive-mindmap.html' - moved to _archive 2026-01-18
  'AI-Integrated-Mapping-Studio.html',
  'metrics.html',
  'offline.html',  // Added 2025-10-28: UI HTML audit fix (PWA offline page)
  'predictive-analytics-dashboard.html',
  'roi-calculator.html',
  'roi-dashboard.html',
  'suitecentral-integration-hub.html',  // Added 2025-10-28: UI HTML audit fix
  'suitecentral-production.html',
  'SuiteCentral-BusinessCentral-Integration-hub.html',
  'system-status.html',
  'vendor-portal/index.html',  // Added 2026-01-08: VendorCentral Portal (Phase 1)
  'payment-portal/index.html',  // Added 2026-01-08: PaymentCentral Portal (Phase 2)
  'portal-central-dashboard.html',  // Added 2026-02-21: Portal Central canonical alias -> payment-portal/index
  'payment-portal/invoices.html',  // Added 2026-01-09: Invoice Matching Dashboard (Phase 6)
  'customer-central-360.html',  // Added 2026-01-09: Customer 360 AI Dashboard
  'quality-central.html',  // Added 2026-01-10: QualityCentral (Quality Inspections)
  'payout-central.html',  // Added 2026-01-10: PayoutCentral (Affiliate Payouts)
  'installer-central.html',  // Added 2026-01-10: InstallerCentral (Installer Network)
  'service-central.html',  // Added 2026-01-10: ServiceCentral (Field Service)
  'inventory-central.html',  // Added 2026-01-10: InventoryCentral (Inventory Tracking)
  'finance-central.html',  // Added 2026-01-10: FinanceCentral (Financial Consolidation)
  // PR-J (B7): live sub-directory demo pages, added so the startup
  // existence warning covers them (the whitelist-sync gate audits only
  // top-level public/*.html; these were served solely via root static
  // with no inventory entry).
  'squire-v2-media-demo/for-leadership.html',
  'squire-v2-media-demo/read/business-case.html',
  'sync-error-assist.html',  // Added 2026-05-13: SyncErrorAssist operator queue (Wave 2)
  'governance-operations.html',  // Added 2026-05-25: PR 13b Direct-Write Ownership Enforcement operator dashboard
  'code-architecture-dashboard.html',  // Added 2026-06-12: Architecture Knowledge Assistant Dashboard
  'suitecentral-deployment-options-dashboard.html',  // Added 2026-06-13: Deployment Options Knowledge Dashboard
  'contract-central.html',  // Added 2026-01-10: ContractCentral (Contract Lifecycle)
  'components/document-sidecar.html',  // Added 2026-01-13: Universal Document Sidecar
  'components/context-sidecar.html',  // Added 2026-01-13: Context Sidecar Component
  'mdm-central.html',  // Added 2026-01-14: Golden Record MDM Dashboard
  'payout-central-dashboard.html',  // Added 2026-01-18: PayoutCentral Dashboard
  // Executive Hub pages (2026-01-18)
  'executive/executive-hub.html',
  'executive/financial-dashboard.html',
  'executive/demo-center.html',
  'executive/resources.html',
  'executive/strategic-position.html',
  'executive/technical-proof.html',
  // Squire Executive Package v2 (2026-01-18)
  'Squire-Executive-Package-v2/00-EXECUTIVE-OUTCOMES-STANDALONE.html',
  'Squire-Executive-Package-v2/01-EXECUTIVE-SUMMARY.html',
  'Squire-Executive-Package-v2/01-EXECUTIVE-SUMMARY-STANDALONE.html',
  'Squire-Executive-Package-v2/02-COMPLETE-FEATURES.html',
  'Squire-Executive-Package-v2/02-COMPLETE-FEATURES-STANDALONE.html',
  'Squire-Executive-Package-v2/03-ONE-PAGER-STANDALONE.html',
  'Squire-Executive-Package-v2/04-ROI-CALCULATOR-STANDALONE.html',
  'Squire-Executive-Package-v2/05-TECHNICAL-PROOF-STANDALONE.html',
  'Squire-Executive-Package-v2/06-INVESTMENT-PROPOSAL-STANDALONE.html',
  'Squire-Executive-Package-v2/07-BUSINESS-CASE-STANDALONE.html',
  'Squire-Executive-Package-v2/08-INFOGRAPHIC-COMPLETE.html',
  'Squire-Executive-Package-v2/09-CLAIM-PROOF-MATRIX-STANDALONE.html',
  'Squire-Executive-Package-v2/10-ROLE-BRIEF-CFO-STANDALONE.html',
  'Squire-Executive-Package-v2/11-ROLE-BRIEF-CTO-STANDALONE.html',
  'Squire-Executive-Package-v2/12-ROLE-BRIEF-COO-STANDALONE.html',
  'Squire-Executive-Package-v2/13-PILOT-30-60-90-STANDALONE.html',
  'Squire-Executive-Package-v2/14-DEMO-PREFLIGHT-STANDALONE.html',
  'Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html',
  'Squire-Executive-Package-v2/16-PILOT-DECISION-MEMO-STANDALONE.html',
  'Squire-Executive-Package-v2/17-PERSONAL-WALKTHROUGH-SCRIPT-STANDALONE.html',
  'Squire-Executive-Package-v2/18-LIVE-DEMO-SETUP-STANDALONE.html',
  'Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html',
  'Squire-Executive-Package-v2/20-NO-SERVER-MINI-PACK-STANDALONE.html',
  'Squire-Executive-Package-v2/21-OBJECTIONS-ANSWERS-STANDALONE.html',
  'Squire-Executive-Package-v2/22-MODULE-LIBRARY-STANDALONE.html',
  'Squire-Executive-Package-v2/23-ENGINEERING-SCALE-QUALITY-STANDALONE.html',
  'Squire-Executive-Package-v2/index.html',
  'Squire-Executive-Package-v2/MINDMAP-ARCHITECTURE-STANDALONE.html',
  'Squire-Executive-Package-v2/MINDMAP-BENEFITS-STANDALONE.html',
  // Squire v2 Media Demo (2026-02-11)
  'squire-v2-media-demo/index.html',
  'squire-v2-media-demo/oracle-comparison.html',
  'squire-v2-media-demo/watch/storyboard.html',
  'squire-v2-media-demo/watch/scenes/scene1-problem-visual.html',
  'squire-v2-media-demo/watch/scenes/scene6-nl-action-gate-visual.html',
  'squire-v2-media-demo/watch/scenes/scene7-opportunity-visual.html',
  'squire-v2-media-demo/watch/videos/index.html',
  'squire-v2-media-demo/watch/videos/player.html',
  'squire-v2-media-demo/watch/videos/transcripts.html',
  'squire-v2-media-demo/click/demo-guide.html',
  'squire-v2-media-demo/click/setup.html',
  'squire-v2-media-demo/read/executive-summary.html',
  'squire-v2-media-demo/read/competitive-diff.html',
  'squire-v2-media-demo/read/talking-points.html',
  'squire-v2-media-demo/read/risks-mitigations.html',
  'squire-v2-media-demo/read/elevator-pitch.html',
  'squire-v2-media-demo/read/roi-calculator.html',
  'squire-v2-media-demo/read/context-sidecar-proof.html',
  'squire-v2-media-demo/read/mcp-proof-console.html',
  'squire-v2-media-demo/read/mcp-positioning-diagram.html',
  'squire-v2-media-demo/read/suiteapp-badge-readiness.html',
  'squire-v2-media-demo/read/engineering-scale.html',
  'Squire-Executive-Package-v2/28-PACKAGE-GUIDE-STANDALONE.html',
  // SOC 2 Compliance Dashboard (2026-02-11)
  'compliance-dashboard.html',
  // PR 10a: Embedded ERP Surface — dev-only standalone reference host.
  // Production embedding flows through a NetSuite Suitelet or BC AL
  // Extension that calls /api/embedded/host-bootstrap server-side.
  'embedded/host-reference.html',
  'cost-transparency-dashboard.html',  // Added 2026-05-22: Cost Transparency Dashboard (PR 21)
  'squire-portfolio-evidence.html',  // Added 2026-05-22: SuiteCentral Portfolio Evidence View (PR 22)
  'review-hub.html',  // Added 2026-06-18: Review & Evidence hub (shell Review top-tab landing)
  // Added 2026-09-02 (tranche-1 Workstream A): dashboards that were reachable
  // only through the retired EXEMPT bypass in check-html-whitelist-sync.mjs.
  // They were already served to anyone; listing them keeps that true and makes
  // it a recorded decision rather than a gap.
  'context-sidecar-demo.html',
  'contract-central-dashboard.html',
  'customer-central.html',
  'finance-central-dashboard.html',
  'installer-central-dashboard.html',
  'inventory-central-dashboard.html',
  'payment-central.html',
  'payment-central-dashboard.html',
  'quality-central-dashboard.html',
  'service-central-dashboard.html',
  'supplier-central.html',
  'supplier-central-dashboard.html',
  'sync-central.html',
  'sync-central-dashboard.html',
  'workflow-central-dashboard.html',
];

export const HTML_WHITELIST: ReadonlySet<string> = new Set(htmlFiles);
