# Squire Product Card: Elastic Suite

**Owner:** Connor Bailey (current; originally Dave; later Preston for a stretch)
**Squire-side status:** Sold to clients (deployment location TBD per Preston interview)
**Last reviewed:** 2026-06-01 · git sha `b26e862c2`

## What it does today

Elastic Suite is Squire's NetSuite ↔ Elasticsearch 2-way integration. Where it lives architecturally is TBD per the 2026-05-04 Preston interview. Per-product behavior beyond this paragraph is not yet captured in the canonical Squire reference; cite the underlying source before adding behavior claims.

## Repo evidence

Evidence for Elastic Suite specifically is the thinnest of the six products — the repo has NetSuite coverage but no Elasticsearch connector or indexing-domain feature.

- **Connector relevance:** NetSuite (`production`) — directly load-bearing. **No Elasticsearch connector** in this repo's partition.
- **Service relevance:**
  - GovernanceService + AuditService — apply at protocol layer.
  - AI providers — could power semantic-search augmentation, but not built.
- **Proof-card pointers:** [NetSuite](../proof-cards/netsuite-connector.md). No Elasticsearch proof card.
- **Module/feature relevance:** None specific to NetSuite ↔ Elasticsearch sync in this repo's current feature set.

## Integrate / Enhance / Replace evaluation

| Scenario | Repo evidence today | Pilot risk | Confidence |
|---|---|---|---|
| **Integrate** | Thin — audit + governance overlay possible at NetSuite egress, but no Elasticsearch-specific surface. | mid | low |
| **Enhance** | Speculative — AI-aided semantic search would require an Elasticsearch connector + retrieval-augmented logic, neither built. | high | very low |
| **Replace** | No — repo doesn't have NetSuite ↔ Elasticsearch domain coverage. | high | very low |

**Recommended path today:** **Insufficient evidence.** Elastic Suite is the thinnest match between this repo and a Squire product.

## Hard constraints check

| Constraint | Verdict | Notes |
|---|---|---|
| Zero data hosting (Squire side) | **pass** | Same overlay-only egress profile as other NetSuite-anchored products. |
| Liability split | **pass** | Standard NetSuite-side ownership. |
| Kill-switch enforcement | **conditional** | The per-tenant kill switch mechanism shipped repo-wide (`TenantLifecycleService` + `tenantStatusGate` + `revokeAllForTenant`, migration 040). No Elastic Suite-specific route exists in this repo to gate, so parity would be inherited if/when an Elasticsearch surface is built — no longer a missing mechanism, just no surface to apply it to. |
| SOC 2 acceleration | **pass** | Audit applies at protocol layer. |
| Budget ceiling | **N/A** | No credible pilot scope. |

## Pilot readiness

- **Smallest gap to close before a 30-day pilot:** Elasticsearch connector implementation — currently absent from this repo. Would need to be added with real authentication and a credential test on file before any Elastic Suite-specific evaluation is credible.
- **Larger gaps (out-of-pilot scope):** retrieval-augmented search, semantic-search AI, Elasticsearch indexing pipeline.
- **Suggested pilot scope:** **Defer.** Not a credible pilot candidate today. Re-evaluate after Elasticsearch connector implementation.

---

*This card extends [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) Squire-Specific Lens.*
