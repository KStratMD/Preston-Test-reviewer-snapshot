# Contract fixtures

Layout: `<vendor>/<entity>/<name>.json`, with `_provenance.json` in every entity
directory. Load through `tests/helpers/contractFixtures.ts`. The loader validates
provenance, directory identity and naming; callers validate the returned payload
shape. The generic type argument does not validate JSON at runtime. This is a
test helper for trusted local fixture paths, not an arbitrary-file access API.

Provenance contains `vendor`, `entity`, `sourceUrl`, `docVersion`, `capturedAt`
(`YYYY-MM-DD`), `rung` (1, 2 or 3), optional `sourceSha256` and optional `notes`.
The loader rejects a literal `/latest/` URL segment and refuses recording names
containing `cassette` or `replay` below rung 3. The optional hash is a lowercase
SHA-256 of the fetched source text encoded as UTF-8; every shipped rung-1 fixture
has a measured hash. It identifies a capture, not a claim that a mutable URL will
return identical bytes later. Hashes are not re-fetched by tests.

The [evidence ladder](../../../docs/superpowers/specs/2026-09-02-governed-assurance-control-plane-design.md#5-evidence-ladder)
defines rung 1 as official contract evidence, rung 2 as fixtures and simulation,
and rung 3 as development-system captures. These vendor examples are rung 1,
documentation-derived field selections with synthetic values. They are not live
responses or proof of connector interoperability. Platform selection remains
provisional under the spec's discovery gate.

## Source capture limits

Sources were fetched on 2026-09-08. Each entity's provenance records its exact
primary URL and measured hash; notes name supplemental field references and
their hashes where needed. Source HTML/PHP is not vendored into the fixture kit.

- Shopify requests use the `2026-07` URL. The site redirected to `/latest/`, whose
  displayed version was `2026-07` at capture. Provenance retains the requested
  version URL and records the redirect. Payout and balance-transaction sources
  have separate directories; `net`, `amount` and `fee` are money objects.
- NetSuite uses the plan's REST overview plus entity-specific reference pages.
  These pages are mutable; their capture hashes identify what was fetched.
  `2026.1` is the plan's target version, not a claim that a versioned schema was
  retrieved or that account-specific fields were verified. A failed Swagger
  fetch and failed browser content chunks are excluded from the evidence.
- Business Central URLs identify API v2.0, with separate resource and line
  references. Documentation text at those URLs can change independently.
- WooCommerce sources are pinned to tag `11.0.1`. The `wc/v3` controllers inherit
  schema from Version2 controllers; both references are recorded. The plan's old
  `v3.html` link describes the legacy `/wc-api/v3` API and is not fixture evidence.
  The separate refund fixture describes a later state; the order fixture stays
  in its paid, pre-refund state.

The generated dataset in `tests/fixtures/order-to-cash/` is rung 2 simulation.
`npm run fixtures:order-to-cash` deterministically creates 200 orders with seed 42.
The generator accepts `--seed` (uint32), `--orders` (0–100000) and `--out`.
All ten types are guaranteed when the requested count is at least ten; a smaller
dataset contains only that prefix. Invalid arguments and filesystem failures
exit 2. Values use integer minor units, and all identifiers and addresses are
synthetic.
The reference detector emits every applicable one of its ten named discrepancy
types, independently pinned by hand-authored tests. It compares SKU multiplicity
without regard to order, but does not compare line quantities or unit prices.
It checks payout presence, not payout amounts, fees or currency. For duplicate
ERP documents it compares the first document. It is a reference for these limited
cases, not the product reconciler or proof that an order has fully reconciled.

Run the loader, shape and detector/generator suites under `tests/unit/{helpers,fixtures,scripts}`.
CI checks committed output freshness before regeneration; the same checker runs
in the reviewer mirror without requiring a Git index.
Run `tests/scripts/check-order-to-cash-fixtures.test.sh` on Linux (WSL from the
Windows session), as required by the shared workflow. Its symlink regression
must exercise a real symlink; Git Bash may copy the file instead and is not a
supported executor for that harness. All 15 cases remain mandatory on Linux.
`npm run check:order-to-cash-fixtures` exits 0 for identical output, 1 for stale,
missing or unexpected output, and 2 for usage or environment errors. An optional
`--root <repository directory>` supports isolated checks; it does not change the
generator implementation being exercised.
