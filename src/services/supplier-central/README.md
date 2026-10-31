# supplier-central/

Internal decomposition of `SupplierCentralService`. The facade at
`src/services/SupplierCentralService.ts` is the only public boundary; everything
in this directory is composed behind that facade.

## Files

| File | Responsibility |
|------|----------------|
| `SupplierCentralRuntime.ts` | Shared runtime seam: `logger`, `telemetryService`, `now()`, `random()`, `createId()`, `wait()`, and optional AI agents. Every collaborator routes time/randomness/timers through this. |
| `VendorDirectory.ts` | Owns the in-memory vendor, template, and activity maps. CRUD for vendors, templates, portal activity, plus `recordActivity(...)`. |
| `VendorDocumentService.ts` | Owns document uploads and AI parsing (`uploadDocument`, `parseDocument`). Updates vendors via `VendorDirectory.updateVendor(...)`. |
| `VendorOnboardingService.ts` | Owns stage transitions (`approveVendor`, `rejectVendor`, `assessVendorForApproval`), Business Central sync, and onboarding stats. Approval internally chains to `syncVendorToBusinessCentral`. |
| `VendorOnboardingAgentAdapter.ts` | Wraps the optional `VendorOnboardingAgent` so `VendorOnboardingService` depends on a concrete collaborator rather than DI-optional branching. |
| `PurchaseOrderService.ts` | Owns the PO and ASN maps. CRUD for POs, acknowledgements, ASNs. Reads vendors from `VendorDirectory`. |
| `GovernanceThrottle.ts` | Owns NetSuite pacing state (`requestTimestamps`, `activeRequests`, `config`). `acquire()` / `release()` bracket every NetSuite call. |
| `NetSuiteSyncService.ts` | Orchestrates the 6 NetSuite/governance public methods. Reads vendors + POs via `VendorDirectory` / `PurchaseOrderService`, paces through `GovernanceThrottle`. |
| `progressHelpers.ts` | Pure functions for onboarding progress calculation. No state. |

## Ownership rules

- **`VendorDirectory` owns the `vendors` Map.** See "Vendor mutation convention"
  below for the explicit `updateVendor(...)` mutation boundary used by collaborators.
- **`PurchaseOrderService` owns the PO and ASN maps.** `NetSuiteSyncService`
  reads via `getPurchaseOrderById()`.
- **`GovernanceThrottle` owns all pacing state.** `NetSuiteSyncService` reads
  config via `getConfig()` / `getRequestsInLastMinute()` / `getActiveRequests()`
  for dashboards, but never touches the underlying arrays/counters directly.

### Vendor mutation convention

- `VendorDirectory.getVendorById(id)` returns a **snapshot copy**, not the live
  object stored in the `vendors` Map.
- Collaborators (`VendorDocumentService`, `VendorOnboardingService`,
  `NetSuiteSyncService`) treat fetched vendors as read-only snapshots.
- Collaborator-initiated vendor updates go through
  `VendorDirectory.updateVendor(id, apply)`, which clones the stored vendor,
  applies the mutation, and replaces the stored copy in one explicit step.
- The `apply` callback must be synchronous. The signature is
  `(draft) => undefined` (catches `async` callbacks at compile time), and a
  runtime Promise-detector throws `TypeError` if a caller bypasses the types.
  Async mutations after an `await` would run AFTER the store step and be lost.
- `VendorDirectory` itself still performs direct writes for creation, the
  top-level `updateVendorProfile(partial)` path, seeding, and similar internal
  ownership flows; the convention above is the **collaborator** boundary, not
  a claim that every internal write path routes through `updateVendor(...)`.
- This keeps in-memory storage intact while making the collaborator mutation
  boundary explicit and reviewable.

## Why the facade stays

The facade is bound to `TYPES.SupplierCentralService` in `inversify.config.ts`
and re-exports public types (`VendorProfile`, `PurchaseOrder`, etc.). External
callers — routers, `NLActionGateService`, tests — all depend on the facade
signatures. The facade is now pure composition + delegation (~330 lines) and
constructs each collaborator concretely in its constructor.

## Scope notes

- **No new Inversify bindings** — collaborators are constructed concretely by
  the facade, not resolved from the container. This keeps the DI surface
  unchanged.
- **No repository abstraction** — collaborators own in-memory maps directly.
  Persistence is out of scope for this refactor.
- **No ports/interfaces on collaborators** — concrete-collaborator pattern per
  the accepted design. Substitutability is achieved via the `SupplierCentralRuntime`
  seam (for time/randomness) and by injecting fakes of concrete collaborators
  in tests where needed.
- `src/services/supplier/SupplierCentralParityService.ts` is an **unrelated**
  parallel file and is not touched by this decomposition.
