# Squire Product Card: VendorCentral

**Owner:** Lee
**Squire-side status:** Sold to clients (formerly named SupplierCentral)
**Last reviewed:** 2026-06-01 · git sha `b26e862c2`

## What it does today

VendorCentral is Squire's vendor portal into NetSuite, deployed inside the customer's NetSuite instance. Sold to active clients. Originally named SupplierCentral. Per-product behavior beyond this paragraph is not yet captured in the canonical Squire reference; cite the underlying source before adding behavior claims.

## Repo evidence

- **Connector relevance:** NetSuite (`production`) — directly load-bearing. HubSpot (`production`) is also indirectly relevant if vendor relationship management overlaps with CRM.
- **Service relevance:**
  - DLPService — vendor data is less PII-heavy than customer data, but contact + name patterns still apply.
  - GovernanceService — policy gate on vendor data egress.
  - AuditService — vendor-action audit trail.
- **Proof-card pointers:** [NetSuite](../proof-cards/netsuite-connector.md), [HubSpot](../proof-cards/hubspot-connector.md), [DLPService](../proof-cards/dlp-service.md), [GovernanceService](../proof-cards/governance-service.md).
- **Module/feature relevance (per CLAUDE.md):** NL Action Gate — could power vendor-facing AI assistance (e.g., invoice categorization). A "Vendor Onboarding AI Flow" module is named in the strategic plan as a forthcoming spec but **explicitly deferred to Tier-C** per the 2026-05-05 Codex+Claude consensus — Preston identified vendor onboarding as a plausible direction but not his stated current pain.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Yes — DLP/governance overlay on vendor-facing surfaces via the NetSuite connector + DLPService. Low risk. | low | mid |
| **Enhance** | Speculative — Vendor Onboarding AI Flow (forthcoming module spec) is the closest candidate but explicitly deferred to Tier-C. | mid | low |
| **Replace** | No — repo doesn't have vendor-portal scaffolding. | high | very low |

**Recommended path today:** **Insufficient evidence for a VendorCentral-specific pilot.** Vendor Onboarding AI Flow's deferral means the AI-assisted vendor flow is not on the near-term roadmap. The integrate path (DLP/audit overlay at the NetSuite egress layer) is structurally indistinguishable from a SyncCentral pilot at the same layer; recommend deferring VendorCentral-specific evaluation until SyncCentral pilot validates the overlay approach.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | Same overlay-only egress profile. |
| Liability split | **pass** | Vendor data stays in NetSuite. |
| Kill-switch enforcement | **pass** | Per-tenant kill switch shipped (`TenantLifecycleService` + `tenantStatusGate` + `revokeAllForTenant`, migration 040); `/api/supplier-central` (VendorCentral's repo route, formerly SupplierCentral) is gated by it. Scopes to the repo's governed Central API overlay. |
| SOC 2 acceleration | **pass** | Vendor-data audit applies. |
| Budget ceiling | **pass** | Overlay is small. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** Vendor Onboarding AI Flow module implementation. Currently deferred to Tier-C — meaning a VendorCentral-specific pilot is not on the near-term path.
- **Larger gaps (out-of-pilot scope):** vendor-portal feature parity, vendor-self-service AI capability.
- **Suggested pilot scope:** **Defer.** Not a credible pilot candidate today. Re-evaluate after SyncCentral pilot and the Vendor Onboarding AI Flow reactivation decision.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
