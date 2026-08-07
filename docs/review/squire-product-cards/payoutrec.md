# Squire Product Card: Payout Rec

**Owner:** Sam Dean (current; originally Andy / Danny / Tyler)
**Squire-side status:** Built first; oldest
**Last reviewed:** 2026-06-01 · git sha `b26e862c2`

## What it does today

Payout Rec is Squire's merchant reconciliation tool. Architecturally distinct from the other five products: it lives in **Celigo + Azure**, NOT inside NetSuite. Reconciles payment-processor payouts against merchant transactions, surfacing mismatches for resolution. The oldest of the six products by build date.

## Repo evidence

This repo's evidence for Payout Rec is the thinnest of the six products. The mismatch is structural:

- This repo's connectors are NetSuite-anchored (Celigo is not a wired connector here).
- The reconciliation domain (transaction-to-payout matching) doesn't map cleanly onto any current repo feature. (A **Reconciliation Center** shipped since — proof card [`reconciliation-center.md`](../proof-cards/reconciliation-center.md), production — but it reconciles NetSuite ↔ Business Central record cadence, a different domain from merchant payout-vs-transaction matching.)

- **Connector relevance:**
  - Adyen / Stripe / PayPal (`demo_only`) — payment-processor connectors, but all in demo state. Promotion would require credential tests on file.
  - No Celigo connector in this repo's partition.
- **Service relevance:**
  - AI providers — could power AI-assisted reconciliation matching (transaction-to-record fuzzy matching), but this is speculative.
  - Reasoning Traces — would be highly relevant for auditable reconciliation explanations, but no Payout-Rec-specific feature exists.
  - GovernanceService + AuditService — apply at the protocol layer.
- **Proof-card pointers:** [AI providers](../proof-cards/ai-providers.md), [GovernanceService](../proof-cards/governance-service.md). No Celigo proof card exists.
- **Module/feature relevance (per CLAUDE.md):** AI Field Mapping is the structural cousin of transaction-to-record matching, but the domain is different. **Record-Level Lineage has shipped (production)** — `LineageQueryService`, `/api/lineage`, proof card [`record-lineage.md`](../proof-cards/record-lineage.md) (2026-05-24) — so the auditable-explanation substrate now exists; combined with Reasoning Traces it would back a reconciliation explanation feature if the payout domain were built.

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
| SOC 2 acceleration | **conditional** | Reconciliation = high-trust; audit + lineage matter. Record-Level Lineage **has now shipped** (production, 2026-05-24); combined with audit + DLP it provides SOC 2 evidence substrate at the protocol layer. Residual: no Celigo / payout-domain coverage, so any acceleration is generic, not Payout-Rec-specific. |
| Budget ceiling | **N/A** | No clean overlay path. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** A **Celigo connector** — the actual structural blocker. Lineage foundations (previously named here) have since shipped, so the substrate is no longer the gap; Payout Rec's Celigo + Azure architecture having no repo connector is.
- **Larger gaps (out-of-pilot scope):** Celigo connector, merchant payout-vs-transaction reconciliation domain feature, transaction-matching AI.
- **Suggested pilot scope:** **Defer.** Not a credible pilot candidate. Lineage foundations now shipped; re-evaluate gated on a Celigo connector + payout-domain coverage.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
