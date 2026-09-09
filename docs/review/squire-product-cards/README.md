# Squire SuiteCentral Product Cards

One card per product in Squire's existing SuiteCentral family, mapping that product's surface area against this repo's evidence using the **integrate / enhance / replace** framing introduced in [`../REVIEWER-PROMPT.md`](../REVIEWER-PROMPT.md) (Squire-Specific Lens section).

These cards are the per-product evidence index. The `REVIEWER-PROMPT.md` Squire-Specific Lens points reviewers here when they need to answer the per-product decision question.

## Audience

The primary audience is **Reuben Cook** (Chief Strategy Officer | Partner at Squire & Company, and President of Squire Technology) and the executive team evaluating SuiteCentral 2.0. The reading order is: REVIEWER-PROMPT.md → these cards → underlying technical proof cards in [`../proof-cards/`](../proof-cards/).

## How these differ from `proof-cards/`

| Dimension | `proof-cards/` | `squire-product-cards/` (this directory) |
|---|---|---|
| Scope | One technical component (connector, service, helper) | One Squire-side product (PaymentCentral, SyncCentral, etc.) |
| Audience | Outside engineer / AI reviewer doing claim audit | Squire executive deciding portfolio direction |
| Enforcement | `npm run audit-proof-cards` enforces structure | `npm run audit-portfolio-evidence` enforces drift between cards and `public/portfolio-evidence.json` (the manifest the static surface consumes). Every parsed field is gated: `productName`, `owner`, `status`, `lastReviewed.{date,sha}`, `whatItDoesToday`, `recommendedPath`, `sourcePath`, `reviewerMirrorUrl`, plus top-level `cardCount` and `generatedFrom`. Strategic judgment in the card body (the integrate/enhance/replace evaluation, hard constraints, pilot readiness sections) is NOT auto-enforced — there's no automated way to validate executive-judgment text. |
| Anchor field | `productionStatus` static on the implementing class | Squire product's existing real-world status (Sold / In production / etc.) |
| Update cadence | On every implementation PR | On every strategic milestone or pilot decision |

A product card may cite multiple proof cards. A proof card may be cited by zero or several product cards.

## The six products

| Product | Owner | Card |
|---|---|---|
| **PaymentCentral** | Preston / Andy / Dave | [paymentcentral.md](paymentcentral.md) |
| **CustomerCentral** | TBD | [customercentral.md](customercentral.md) |
| **VendorCentral** (was SupplierCentral) | Lee | [vendorcentral.md](vendorcentral.md) |
| **SyncCentral** | Preston | [synccentral.md](synccentral.md) |
| **Payout Rec** | Sam Dean | [payoutrec.md](payoutrec.md) |
| **Elastic Suite** | Connor Bailey | [elasticsuite.md](elasticsuite.md) |

## Card structure

Every card uses the same structure so a reader can read across cards quickly:

1. **Header** — product name, owner, status, last reviewed.
2. **What it does today** — one paragraph in plain language. Sourced from the 2026-05-04 Preston Stratford interview transcript and Squire-internal materials, not invented.
3. **Repo evidence** — what this codebase has that touches the product's surface area: connectors, services, proof-card pointers, module-level features.
4. **Integrate / Enhance / Replace evaluation** — table with one row per scenario, plus a single "recommended path today" line.
5. **Hard constraints check** — five-row gate against zero-data-hosting, liability split, kill-switch, SOC 2 readiness, and budget ceiling. Mark each pass / fail / conditional.
6. **Pilot readiness** — the smallest gap to close before a 30-day pilot, larger gaps that are out-of-pilot scope, and a suggested pilot scope.

## Authoring rules

1. **Don't invent product structure.** The six products and their architecture come from the Preston interview + Squire-internal materials. If a card claims a Squire-side feature that's not in the canonical reference, that's a fact-error.
2. **Don't oversell repo evidence.** A connector marked `demo_only` in the partition is `demo_only` here too. If the repo doesn't have a feature, mark the gap and say "out-of-scope for this pilot" rather than projecting a future state.
3. **Hard constraints are gates, not preferences.** A "fail" on zero-data-hosting or liability split is a structural blocker, not a polish item.
4. **Pilot readiness must name a specific gap.** "More work needed" doesn't qualify. The gap should be one observable, fundable item.
5. **Keep cards under ~100 lines.** Reuben browses, doesn't read. Density beats length.

## Source provenance

- Squire product family + ownership: [Preston Stratford interview, 2026-05-04](https://example.invalid) (private transcript; internal-only).
- Hard constraints: same source.
- Repo evidence: codebase at the SHA recorded in the card header, plus [`../proof-cards/`](../proof-cards/) and [`../../../metrics.json`](../../../metrics.json).
