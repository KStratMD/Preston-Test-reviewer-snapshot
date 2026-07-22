# Squire Product Card: CustomerCentral

**Owner:** TBD (not identified in 2026-05-04 Preston interview)
**Squire-side status:** Sold to clients
**Last reviewed:** 2026-06-01 · git sha `b26e862c2`

## What it does today

CustomerCentral is Squire's customer portal into NetSuite, deployed inside the customer's NetSuite instance. Sold to active clients. Per-product behavior beyond this paragraph is not yet captured in the canonical Squire reference; cite the underlying source before adding behavior claims.

## Repo evidence

This repo's evidence for CustomerCentral specifically is thinner than for SyncCentral or PaymentCentral. The relevance is at the protocol layer (NetSuite connector, DLP on customer-data egress) rather than at a feature-parity layer.

- **Connector relevance:** NetSuite (`production`) — directly load-bearing. No customer-portal-specific connector in this repo.
- **Service relevance:**
  - DLPService — customer-data PII (name, contact, ID-document patterns) is exactly the surface the field-gated 14-pattern set targets. Critical for any customer-facing form.
  - GovernanceService — policy gate on outbound customer-data flows.
  - AuditService — audit log of who-accessed-what.
- **Proof-card pointers:** [NetSuite](../proof-cards/netsuite-connector.md), [DLPService](../proof-cards/dlp-service.md), [GovernanceService](../proof-cards/governance-service.md).
- **Module/feature relevance (per CLAUDE.md):** NL Action Gate (6 actions + LLM intent) — could power AI-assisted customer self-service. Context Sidecar — could embed AI affordances in the existing NetSuite-resident UI. Both are speculative until CustomerCentral-specific feature work happens.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Yes — DLP/governance overlay on customer-facing surfaces. NetSuite connector evidence is solid. | low | mid |
| **Enhance** | Speculative — no customer-portal-specific feature in this repo today. NL Action Gate is the closest candidate but unproven at customer-portal scope. | mid | low |
| **Replace** | No — repo doesn't have customer-portal scaffolding. | high | very low |

**Recommended path today:** **Insufficient evidence for a CustomerCentral-specific pilot.** The DLP/governance integrate path is real but indistinguishable from a SyncCentral pilot at the egress layer. Recommend deferring CustomerCentral-specific evaluation until the SyncCentral pilot validates the overlay approach.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | Same overlay-only egress profile as SyncCentral. |
| Liability split | **pass** | Customer data stays in NetSuite. |
| Kill-switch enforcement | **pass** | Per-tenant kill switch shipped (`TenantLifecycleService` + `tenantStatusGate` + `revokeAllForTenant`, migration 040); `/api/customer-central` is gated by it. Scopes to the repo's governed Central API overlay. |
| SOC 2 acceleration | **pass** | Customer portal = customer-data surface; audit + DLP both apply. |
| Budget ceiling | **pass** | Integrate-only overlay is small. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** CustomerCentral-specific feature work in this repo. Without that, a CustomerCentral pilot is structurally indistinguishable from a SyncCentral pilot at the egress layer.
- **Larger gaps (out-of-pilot scope):** customer-portal feature parity, customer-self-service AI capability, customer-facing reasoning-trace UX.
- **Suggested pilot scope:** **Defer.** Not a credible pilot candidate today. Re-evaluate after SyncCentral pilot.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
