# Multi-System Integration Hub Documentation

Comprehensive reference material for the AI-powered integration platform connecting Salesforce, NetSuite, SAP, Oracle, Business Central, Dynamics 365, and more.

---

## Quick Start Paths

### For Business Stakeholders
- **[Executive Overview](strategic/executive-overview.md)** – ROI highlights, executive-ready summary.
- **[Value Proposition](strategic/value-proposition.md)** – Why organizations choose this platform.
- **[Demo Showcase](demos/demo-guide.md)** – 90-second guided tour plus extended walkthroughs.
- **[Executive Package v2 Async Guide](demos/EXECUTIVE-PACKAGE-V2-ASYNC-GUIDE.md)** – Entry points, local run requirements, and package validation commands.
  Includes Start Here, Decision Path, no-server mini-pack flow, 4-minute executive reel, Watch playlist narration, and transcript/caption index details.

### For Developers
- **[Getting Started](user-guides/getting-started.md)** – Installation, first integration, AI quick start.
- **[API Reference](developer/api-reference.md)** - REST endpoints, authentication, payload formats.
- **[Navigation Standard](developer/NAVIGATION-BACK-ESC-STANDARD.md)** - Canonical Back, ESC, fallback, and child-tab behavior.
- **[Endpoint Registry](api/ENDPOINT-REGISTRY.md)** - Canonical list of HTTP endpoints, including MCP and policy APIs.
- **[Code Architecture Infographic](architecture/suitecentral-code-architecture-infographic.png)** - Visual map of surfaces, APIs, services, governance, connectors, and publishing.
- **[Code Architecture Dashboard](/code-architecture-dashboard.html)** - Interactive version of the infographic with hotspot overlays; public and internal knowledge modes (internal requires server-side auth).
- **[SuiteCentral 2.0 Deployment Options](strategic/SUITECENTRAL_2_DEPLOYMENT_OPTIONS.md)** - Squire deployment spectrum, first-to-bill wedge, and code-present vs activation-proof boundaries.
- **[Deployment Options Dashboard](/suitecentral-deployment-options-dashboard.html)** - Interactive version of the deployment-options infographic with tier hotspots and deployment Q&A.
- **[MCP Gateway Architecture](architecture/MCP-GATEWAY-ARCHITECTURE.md)** – Gateway, adapters, policy, and governance flow.
- **[AI Agents System](../AGENTS.md)** – Multi-Agent Orchestrator architecture and usage.
- **[AI Agents Tutorial](tutorials/ai-agents-comprehensive-guide.md)** – End-to-end orchestrator lab.
- **[Claude Instructions](developer/claude-instructions.md)** – Coding guidelines and architecture notes.

### For End Users
- **[Dashboard Guide](user-guides/dashboard-guide.md)** – UI tour for analysts and operators.
- **[AI Features Guide](user-guides/ai-features-guide.md)** – Detailed coverage of five AI services.
- **[AI Agents Dashboard Guide](tutorials/ai-agents-dashboard-guide.md)** – Monitoring and observability.
- **[Sample Data Guide](user-guides/sample-data.md)** – Demo scenarios explained.
- **[Feature Showcase](user-guides/feature-showcase.md)** – Capability-by-capability breakdown.

### For DevOps & Operations
- **[Production Deployment](operations/deployment.md)** – Deployment checklist and environment matrix.
- **[Comprehensive Testing Report](operations/testing/comprehensive-report.md)** – QA evidence and coverage.
- **[Grafana Setup Guide](monitoring/grafana-setup-guide.md)** – Observability and alerting.
- **MCP validation commands** – `npm run mcp:contract` and `npm run mcp:smoke` for MCP protocol/route checks.

---

## Documentation Structure

```
docs/
├── strategic/                  # Business case, competitive analysis, value proposition
├── user-guides/                # End-user guides, feature walkthroughs
├── developer/                  # API reference, coding standards, agent details
├── tutorials/                  # Hands-on labs and scenario guides
├── operations/                 # Deployment, testing, runbook material
├── monitoring/                 # Grafana and observability setup
├── demos/                      # Demo scripts and assets
├── integrations/               # System-specific integration playbooks
│   ├── embedding-guide.md      # NetSuite/BC iframe embedding
│   └── netsuite-businesscentral.md  # Dual-platform integration docs
└── active/                     # Work in progress notes and research
```

Key indexes:
- **[Documentation Index](INDEX.md)** – Complete file inventory.
- **[Features Overview](features/README.md)** – Platform capability summary.
- **[AI Provider System](ai-systems/AI_PROVIDER_SYSTEM.md)** – AI roadmap, provider routing, and runtime coverage.
- **[Developer Hub](developer/README.md)** – Deep technical reference entry point.

### Historical material

Stale documents are archived under `docs/archive/superseded/<YYYY-MM>/` with a banner stamp. Reviewers should treat anything in that subtree as historical — current architecture, status, and metrics live in this directory and in [`metrics.json`](../metrics.json). The archive bundle is excluded from the reviewer mirror's allowlist; see [`scripts/reviewer-mirror.allowlist.json`](../scripts/reviewer-mirror.allowlist.json) for the full include/exclude contract.

---

## Platform Highlights

### AI Capabilities
- **Field Mapping Intelligence** – Multi-agent semantic mapping with fallback heuristics.
- **Data Quality & Validation** – Anomaly detection, cleansing recommendations, rules engine.
- **Process Optimization** – Predictive failure detection and workflow tuning.
- **Business Intelligence** – Executive dashboards with ROI forecasting.
- **Natural Language Configuration** – Conversational integration setup.

### Grand Unified Strategy 2026 (v3.4.1)
- **Context Loop** – Zero-click intelligence based on ERP record context (BC ↔ SuiteCentral)
- **Action Islands** – Cross-system actions (DocuSign, Risk Profile, Stock Check) embedded in modules
- **Schema Registry** – Drift detection, severity assessment, sync blocking for schema changes
- **NL Action Gate** – Natural language → API with Human-in-the-Loop approval ([Tutorial](tutorials/NL-ACTION-GATE-TUTORIAL.md))
- **Predictive Operations** – Inventory depletion, latency trends, payment risk forecasting
- **Golden Record MDM** – Single source of truth across systems ([Guide](features/MDM-FEATURE-GUIDE.md) | [Tutorial](tutorials/MDM-TUTORIAL.md))
- ⭐ **MDM ↔ Field Mapping Feedback** – Conflict patterns improve AI mapping suggestions

📚 [Grand Unified Strategy Feature Guide](features/GRAND-UNIFIED-STRATEGY-GUIDE.md)

### Integration Features
- Connects 10+ enterprise systems with real-time and scheduled sync options.
- Drag-and-drop field mapping enhanced by AI suggestions.
- **Dual-access dashboards**: All SuiteCentral modules accessible from both ERP embedding (NetSuite/BC) AND main dashboard navigation.
- Dead-letter queue processing, automated retries, and alerting.
- Built-in governance pacer for NetSuite and other rate-limited APIs.
- Universal demo data toggle across dashboards for live/demo switching.

### Business Value Snapshot
- 285 % realized ROI; $605K annual savings demonstrated.
- 98.5 % data quality achieved through automated validation.
- 99.9 % uptime with predictive maintenance and proactive alerting.

---

## Getting Started Recommendations

**New to the platform?**
1. Read the [Getting Started Guide](user-guides/getting-started.md).  
2. Explore the UI with the [Dashboard Guide](user-guides/dashboard-guide.md).  
3. Run the [Demo Showcase](demos/demo-guide.md) for a quick win.

**Business decision maker?**
1. Review the [Executive Overview](strategic/executive-overview.md).  
2. Study the [Value Proposition](strategic/value-proposition.md).  
3. Align planned rollouts with the [Competitive Strategy](strategic/competitive-strategy.md).

**Developer or integrator?**
1. Follow the [Claude Instructions](developer/claude-instructions.md) for architecture context.  
2. Reference the [API Docs](developer/api-reference.md) for implementation details.  
3. Complete the [AI Agents Tutorial](tutorials/ai-agents-comprehensive-guide.md) to understand orchestration.

**Operations or DevOps?**
1. Execute the [Production Deployment](operations/deployment.md) checklist.  
2. Configure monitoring using the [Grafana Setup Guide](monitoring/grafana-setup-guide.md).  
3. Validate environments against the [Comprehensive Testing Report](operations/testing/comprehensive-report.md).

---

## Support & Resources

- **Documentation updates:** All primary guides were refreshed for the November 2025 NetSuite release.  
- **Issues or requests:** Submit through the repository issue tracker or open a discussion thread.  
- **Email support:** `support@integration-hub.com`

This documentation set provides clear navigation for every audience while capturing the latest AI-enabled integration, governance, and business value capabilities.
