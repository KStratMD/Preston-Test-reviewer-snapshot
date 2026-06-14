# 005. Demo Connector Decorator Pattern

**Status**: Accepted

**Date**: April 19, 2026

**Context**:
Each production connector (NetSuite, HubSpot, ShipStation) contained 200-500 lines of duplicated demo mode code: a `demoMode` boolean, a `demoStore` Map, `setDemoModeOverride()` method, demo seed data, and `if (this.demoMode)` branching in every CRUD operation. This caused:
- ~1,300 lines of duplicated code across 3 connectors (more as connectors are added)
- Every new connector had to reimplement the same demo pattern
- Production connector code was cluttered with demo concerns
- Demo behavior was inconsistent between connectors
- Tests had to manage `demoMode` state on each connector instance

**Decision**:
Use the **Decorator Pattern** to extract all demo behavior into a single `DemoConnectorDecorator` class that wraps any `IConnector` implementation.

Key design choices:
1. `DemoConnectorDecorator` implements `IConnector` and delegates to a wrapped inner connector
2. All CRUD operations are intercepted and serviced by an in-memory `Map<string, Map<string, DataRecord>>` store
3. The decorator is **always** applied at the InversifyJS DI layer via `wrapWithDecorator()` in `inversify.config.ts` — it checks `isDemoMode()` at runtime on each call, so toggling demo mode via `/api/settings/demo-mode` takes effect immediately without a restart
4. A `Proxy` wraps the decorator to forward `has`/`get` checks to the inner connector in non-demo mode, so route guards like `'getOrderByNumber' in connector` correctly detect connector-specific methods
5. Route files use `IConnector` interface (not concrete types) with `'methodName' in connector` type narrowing for connector-specific methods
6. On `initialize()`, seeded fixture data from `MockConnectorBase` subclasses is deep-cloned into the decorator's demo store
7. Filtering (`matchField`) and sorting (`applySorting`) check both top-level record keys and `record.fields.*` values

**Alternatives Considered**:
- **Strategy pattern** (inject a DataStrategy): More flexible but over-engineered for a simple demo/real switch
- **Base class demo mixin**: Would require all connectors to extend a specific base, limiting composition
- **Keep inline demo code**: Status quo, increasingly costly as connector count grows

**Consequences**:

*Easier*:
- Adding demo mode to new connectors (just wrap with `wrapWithDecorator()`)
- Maintaining demo behavior (single file to update)
- Testing connectors in isolation (no demo state to manage)
- Reading connector code (zero demo noise in production classes)

*More difficult*:
- Connector-specific demo behavior (e.g., custom seed data per connector) — would need decorator subclasses or configuration (mitigated: `importSeedData()` now auto-imports `MockConnectorBase` seed data)
- Route files must use `IConnector` interface and type-narrow for connector-specific methods (mitigated: Proxy transparently forwards `in` checks to inner connector in non-demo mode)

**Files**:
- `src/connectors/DemoConnectorDecorator.ts` — the decorator (new)
- `src/inversify/inversify.config.ts` — `wrapWithDecorator()` helper with Proxy forwarding
- `src/connectors/NetSuiteConnector.ts` — demo code removed (~400 lines)
- `src/connectors/HubSpotConnector.ts` — demo code removed (~500 lines)
- `src/connectors/ShipStationConnector.ts` — demo code removed (~400 lines)
- `src/routes/hubSpot.ts`, `src/routes/shipStation.ts` — changed to `IConnector` interface
