# Squire Product Card: PaymentCentral

**Owner:** Preston Stratford / Andy Nelson / Dave (co-originals)
**Squire-side status:** Sold to clients
**Last reviewed:** 2026-05-06 · git sha `1e6cb686`

## What it does today

PaymentCentral is Squire's Stripe ↔ NetSuite integration plus a customer payment portal, deployed inside the customer's NetSuite instance. Sold to active clients. Naming convention: any "*Central" product is an integration between systems. Per-product behavior beyond this paragraph is not yet captured in the canonical Squire reference; cite the underlying source before adding behavior claims.

## Repo evidence

- **Connector relevance:**
  - NetSuite (`production` — real OAuth 1 HMAC-SHA256, sandbox tested) — directly load-bearing.
  - Stripe (`demo_only` — auth scaffolding wired with demo fallback, no production credential test on file). Payment-side connector is not yet promotion-ready.
  - Adyen + PayPal (`demo_only`) — alternative payment-rail connectors that would be relevant if PaymentCentral broadened beyond Stripe.
- **Service relevance:**
  - DLPService — payment-form data is exactly the surface DLP/PII protection covers (credit_card, bank_account, name patterns are unconditional or field-gated in the 14-pattern set).
  - GovernanceService — synchronous policy gate on financial-data egress.
  - AuditService — SOC 2-grade audit log persistence (PR 4A2) for payment events.
- **Proof-card pointers:** [NetSuite](../proof-cards/netsuite-connector.md), [DLPService](../proof-cards/dlp-service.md), [GovernanceService](../proof-cards/governance-service.md).
- **Module/feature relevance (per CLAUDE.md):** "Payment Central" is listed as one of this repo's production-ready features. Synchronous Policy Gate is the egress-block mechanism on payment-data flows. Cost Transparency Dashboard (forthcoming module spec) would surface per-transaction AI cost rollups for any AI-assisted payment flow.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Yes — DLP/PII layer + audit log on payment portal forms; no code change to PaymentCentral itself, only a webhook subscription. | low | high |
| **Enhance** | Conditional — Stripe connector is `demo_only`; promotion to `production` requires a credential test on file. After promotion, AI-assisted reconciliation of unmatched payments is plausible. | mid | mid |
| **Replace** | No — repo doesn't have payment-portal UI parity. | high | very low |

**Recommended path today:** **Integrate** — DLP + audit overlay is the cleanest first slice.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | DLP scans on egress; audit log is structured-row metadata, no PCI scope expansion. |
| Liability split | **pass** | Stripe holds card data; Squire's services touch only metadata + DLP-redacted summaries. |
| Kill-switch enforcement | **conditional** | Same gap as SyncCentral — per-tenant revocation point not yet wired. |
| SOC 2 acceleration | **strong accelerator** | Payment-data audit is exactly what SOC 2 wants explicit. |
| Budget ceiling | **pass for Integrate** | Webhook subscription + DLP/audit overlay fits a small overlay. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** confirm DLP coverage of the specific payment-form fields PaymentCentral surfaces; document which of the 14 DLP patterns apply to Stripe webhook payloads.
- **Larger gaps (out-of-pilot scope):** Stripe connector promotion to `production` (needs a real-credential test on file), payment-portal UI parity, Cost Transparency dashboard with payment-flow rollups (forthcoming module spec).
- **Suggested pilot scope:** integrate audit + DLP on one PaymentCentral deployment's webhook stream. 30-day audit-log review. No portal UI changes. Squire dev cost target: ≤6 hrs.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
