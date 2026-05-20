# Squire Product Card: Payout Rec

**Owner:** Sam Dean (current; originally Andy / Danny / Tyler)
**Squire-side status:** Built first; oldest
**Last reviewed:** 2026-05-06 · git sha `1e6cb686`

## What it does today

Payout Rec is Squire's merchant reconciliation tool. Architecturally distinct from the other five products: it lives in **Celigo + Azure**, NOT inside NetSuite. Reconciles payment-processor payouts against merchant transactions, surfacing mismatches for resolution. The oldest of the six products by build date.

## Repo evidence

This repo's evidence for Payout Rec is the thinnest of the six products. The mismatch is structural:

- This repo's connectors are NetSuite-anchored (Celigo is not a wired connector here).
- The reconciliation domain (transaction-to-payout matching) doesn't map cleanly onto any current repo feature.

- **Connector relevance:**
  - Adyen / Stripe / PayPal (`demo_only`) — payment-processor connectors, but all in demo state. Promotion would require credential tests on file.
  - No Celigo connector in this repo's partition.
- **Service relevance:**
  - AI providers — could power AI-assisted reconciliation matching (transaction-to-record fuzzy matching), but this is speculative.
  - Reasoning Traces — would be highly relevant for auditable reconciliation explanations, but no Payout-Rec-specific feature exists.
  - GovernanceService + AuditService — apply at the protocol layer.
- **Proof-card pointers:** [AI providers](../proof-cards/ai-providers.md), [GovernanceService](../proof-cards/governance-service.md). No Celigo proof card exists.
- **Module/feature relevance (per CLAUDE.md):** AI Field Mapping is the structural cousin of transaction-to-record matching, but the domain is different. **No data-lineage feature is currently implemented**; lineage foundations are named in the broader plan but not yet shipped.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Thin — repo doesn't have Celigo coverage. Audit + DLP overlay is possible but at protocol layer only. | mid | low |
| **Enhance** | Speculative — AI-assisted reconciliation is a plausible direction but not built. | high | very low |
| **Replace** | No — repo doesn't have reconciliation domain coverage. | high | very low |

**Recommended path today:** **Insufficient evidence.** Payout Rec's Celigo + Azure architecture and reconciliation domain don't intersect cleanly with this repo's current surface. Out-of-scope for the first pilot.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | Payout Rec already lives outside NetSuite (Celigo + Azure pass-through). |
| Liability split | **pass** | Squire owns Azure side; Celigo holds processor data. |
| Kill-switch enforcement | **conditional** | Different shape than the other five products: Payout Rec already lives outside NetSuite, so Squire's "revoke Azure API key" pattern operates differently here. Celigo has its own enforcement model; this repo doesn't extend it. |
| SOC 2 acceleration | **conditional** | Reconciliation = high-trust; audit + lineage matter. Lineage foundations are not yet built in this repo — meaning this repo cannot accelerate Payout Rec's SOC 2 readiness today. |
| Budget ceiling | **N/A** | No clean overlay path. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** Lineage foundations module implementation — would create the substrate for a reconciliation explanation feature. Currently not on the Tier-A or Tier-B near-term path.
- **Larger gaps (out-of-pilot scope):** Celigo connector, reconciliation domain feature, transaction-matching AI.
- **Suggested pilot scope:** **Defer.** Not a credible pilot candidate. Re-evaluate after lineage foundations work.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
