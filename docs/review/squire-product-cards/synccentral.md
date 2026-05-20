# Squire Product Card: SyncCentral

**Owner:** Preston Stratford
**Squire-side status:** ~40+ deployments (largest by deployment count of the six products)
**Last reviewed:** 2026-05-06 · git sha `1e6cb686`

## What it does today

SyncCentral is Squire's generic ERP integration platform — "connect anything to NetSuite." Architecture: NetSuite scripts call Azure every 15 minutes; Azure calls the external system, transforms the payload, and returns it to NetSuite, which then attempts to create or update the record. **Azure is pass-through transformation only — never stores data** (a hard architectural constraint after a prior incident with Azure Data Factory holding data). Failed payloads are stored as error records inside NetSuite, not in Azure. ~90% of customer setup happens in NetSuite (custom bundle install + connection record config); only a small but important part runs in Azure. Currently active in 3PL deployments (ShipStation and others) and Macy's as a commerce channel.

## Repo evidence

This is the closest match between this repo's surface and a Squire product. The repo's "connect anything" thesis is structurally the same as SyncCentral's.

- **Connector relevance:** all 18 connectors — but the production-tier ones map most directly. NetSuite (`production`, real OAuth 1 HMAC-SHA256), ShipStation (`production`, real API-key + secret) are both already in use in active SyncCentral deployments. Business Central (`production`) is the dual-ERP-track equivalent. See [`../../../metrics.json`](../../../metrics.json) for the full partition.
- **Service relevance:**
  - AI Field Mapping — directly relevant to the Azure transformation step (today the transformation is hand-written ETL per integration; AI Field Mapping is the candidate replacement).
  - GovernanceService + DLPService — outbound DLP at the AI provider boundary (PR 2B) and connector-write DLP guard (PR 2C) protect customer payloads on egress.
  - AuditService — SOC 2-grade audit log persistence (PR 4A2).
  - IntelligentProviderRouter — multi-provider AI selection with cost transparency.
- **Proof-card pointers:** [NetSuite](../proof-cards/netsuite-connector.md), [ShipStation](../proof-cards/shipstation-connector.md), [Business Central](../proof-cards/business-central-connector.md), [AI providers](../proof-cards/ai-providers.md), [DLPService](../proof-cards/dlp-service.md), [GovernanceService](../proof-cards/governance-service.md), [MCP aggregator](../proof-cards/mcp-aggregator.md).
- **Module/feature relevance (per CLAUDE.md production-ready features):** AI Field Mapping, Schema Drift Shield, Delta Sync, Governance Pacer (respects NetSuite API limits — directly load-bearing for SyncCentral's 15-min polling cadence), Synchronous Policy Gate, Reasoning Traces, Hallucination Detector, MCP Native API, NL Action Gate, "Sync Central" feature itself listed alongside Payment / Supplier Central.
- **Roadmap relevance:** Sync Error AI Assist is named in the strategic plan (forthcoming module spec) as Preston's exact stated pain point — when SyncCentral writes a NetSuite error record like "could not find item 1234," AI proposes the fix.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Yes — overlay this repo's governance / DLP / audit-log services on existing 40+ deployments without code changes to the SyncCentral bundle. Egress-path interception. | low | high |
| **Enhance** | Yes — replace the Azure transformation step (currently hand-written ETL per integration) with this repo's AI Field Mapping + Schema Drift Shield + Reasoning Traces. Requires Azure-side route change per deployment. | mid | mid (depends on AI Field Mapping evaluation harness work) |
| **Replace** | Thin today. This repo doesn't yet ship an NS SuiteApp / BC AL Extension deployment story or a "connection record" UI parity story. Replace becomes credible only after Tier-B engineering work lands. | high | low |

**Recommended path today:** **Enhance** — pilot AI Field Mapping + Sync Error AI Assist on one production SyncCentral deployment.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | Repo services don't persist customer payload bodies; audit log is structured-row metadata, governed by DLP. |
| Liability split | **pass** | Squire still owns the control plane; client still owns the NetSuite-side data. |
| Kill-switch enforcement | **conditional** | No per-tenant token revocation point yet that mirrors Squire's "revoke Azure API key" pattern. Tier-B per-tenant service-token issuance is the path. |
| SOC 2 acceleration | **pass / accelerator** | Audit log persistence + DLP enforcement + identity propagation (PR 2C) all double as SOC 2 evidence. |
| Budget ceiling (≤20 hrs/yr Preston) | **pass for Integrate; conditional for Enhance** | Integrate fits the overlay model. Enhance requires per-deployment Azure-route change — possibly within ceiling for one pilot deployment, not for fleet rollout. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** Sync Error AI Assist module implementation. The component sits at the SyncCentral ↔ NetSuite error-record boundary; doesn't require Azure-side changes to SyncCentral's transformation step.
- **Larger gaps (out-of-pilot scope):**
  - NS SuiteApp + BC AL Extension adapters (Tier-B engineering work) — needed for a "Replace" story.
  - Cost Transparency Dashboard (forthcoming module spec) — needed for fleet-wide rollout cost visibility.
  - Per-tenant kill-switch — needed for the enforcement parity.
  - AI accuracy benchmark harness — needed for "Enhance" credibility on AI Field Mapping percentages.
- **Suggested pilot scope:** Run Sync Error AI Assist against one production SyncCentral deployment for 30 days. Measure (a) error-record fix-suggestion accept rate, (b) DLP false-positive rate on outbound AI calls, (c) audit-log volume vs. baseline. Squire dev cost target: ≤8 hrs (Preston onboarding + one deployment route to the Sync Error AI Assist endpoint).

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens. For the canonical Squire product family + hard constraints, see the lens itself.*
