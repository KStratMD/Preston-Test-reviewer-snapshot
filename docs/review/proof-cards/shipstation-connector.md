# Proof Card: ShipStation Connector

**Status:** production_ready
**Last verified:** 2026-09-11 · historical verified source `8abb12eba04b8e21e976f8d6a55890fe01d4e944` (source and fixture checks at that commit; no live credentials)
**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation

## Claim

`ShipStationConnector` configures `https://ssapi.shipstation.com` with Basic authentication built from an API key and secret. CRUD methods target orders, shipments and warehouses. These are source-wiring claims; fixtures do not establish live vendor acceptance.

## Source

- Implementation: `src/connectors/ShipStationConnector.ts`
- Entry point: `BaseConnector.authenticate()` delegates to `ShipStationConnector.performAuthentication()`; see the [authentication implementation evidence](../2026-09-10-authentication-implementation.md).
- Dependencies:
  - `src/core/BaseConnector.ts` — shared lifecycle and scoped `/carriers` credential probe
  - Base URL: `https://ssapi.shipstation.com` (initializer)

## Tests

- Contract: `tests/unit/contract/ShipStationConnector.contract.test.ts` (15 passing tests)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector configures `ssapi.shipstation.com` and dispatches through the shared Axios transport.
- Demo-mode toggle? **No** — no `isDemoMode()` branch in this connector.
- Production credential test on file? **No live evidence on record**; the static status evidence does not substitute for a credential test.

## Known Gaps

- No live-credential evidence is on record: **no live evidence on record**. Readiness checklist met: governance wiring, rate limiting, outbound DLP, unit and contract suites, docs.

- The contract tests verify that the right HTTP methods + URLs are produced for the documented entity types but do not exercise pagination behavior at scale (ShipStation's response cursor format is documented but not asserted per page-of-orders test).
- Webhook signature verification (ShipStation can send webhooks for shipment events) is not part of this connector — webhook handling lives in the route layer if at all.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/contract/ShipStationConnector.contract.test.ts
rg -n 'ssapi.shipstation.com|/carriers|performAuthentication' src/connectors/ShipStationConnector.ts
```

The source search shows the configured host and the credential-probe path.
