# Proof Card: ShipStation Connector

**Status:** production
**Last verified:** 2026-04-28 · git sha `562e3ab4`

## Claim

`ShipStationConnector` is a real client for the ShipStation v2 REST API (`https://api.shipstation.com/v2`) with API-key + secret authentication. CRUD is wired against the three core 3PL resource types — orders, shipments, warehouses — using live ShipStation endpoints.

## Source

- Implementation: `src/connectors/ShipStationConnector.ts:1-384`
- Entry point: `src/connectors/ShipStationConnector.ts:188-203` (`authenticate()`)
- Dependencies:
  - `src/services/AuthService.ts` — API-key authentication path
  - Base URL: `https://api.shipstation.com/v2` (constructor)

## Tests

- Contract: `tests/unit/contract/ShipStationConnector.contract.test.ts` (15 tests, 28 expects)
- Integration: `none — credential-gated`

## Live vs Fixture

- Real HTTP wired? **Yes** · the connector targets `api.shipstation.com` and the `/v2` API version, with CRUD methods at lines 234-300 routing through the live REST endpoints.
- Demo-mode toggle? **No** — no `isDemoMode()` branch in this connector.
- Production credential test on file? **Yes** — per `statusEvidence` field at line 158: "Real ShipStation v2 REST API calls (orders, shipments, warehouses) with API-key + secret auth".

## Known Gaps

- The contract tests verify that the right HTTP methods + URLs are produced for the documented entity types but do not exercise pagination behavior at scale (ShipStation's response cursor format is documented but not asserted per page-of-orders test).
- Webhook signature verification (ShipStation can send webhooks for shipment events) is not part of this connector — webhook handling lives in the route layer if at all.

## Verification (60-second AI-reviewer recipe)

```bash
npm test -- tests/unit/contract/ShipStationConnector.contract.test.ts
grep -n "api.shipstation.com\|/v2/" src/connectors/ShipStationConnector.ts | head -5
```

The grep should show the `api.shipstation.com` host and the `/v2/` API version path at multiple sites.
