# PaymentCentral Internal Services

This directory holds the sub-services that `PaymentCentralService` (the facade)
composes. None of these are bound in the Inversify container — they are
construction-time implementation details of the facade.

## Architecture

```
PaymentCentralService (facade, src/services/PaymentCentralService.ts)
  ├── PaymentCentralRuntime  (logger, telemetry, dunningAgent?, now, random, createId)
  ├── ProcessorService       — owns processors Map, implements ProcessorReader
  ├── TransactionService     — owns transactions Map, implements TransactionReader
  │                            (depends on ProcessorReader)
  ├── ReconciliationService  — owns reports Map
  │                            (depends on ProcessorReader, TransactionReader)
  ├── PaymentAnalyticsService — stateless
  │                            (depends on ProcessorReader, TransactionReader)
  ├── DunningAgentAdapter    — isolates DunningAgent I/O
  ├── DunningService         — owns dunningSchedules + dunningEntries Maps
  │                            (depends on DunningAgentAdapter only — no readers)
  ├── GLPostingService       — owns glAccounts + journalEntries + postingBatches
  │                            (depends on ProcessorReader, TransactionReader)
  └── InvoiceMatchingService — owns invoices + invoiceDisputes + creditMemos + config
                               (self-contained — no readers)
```

## Boundary rules

1. Each sub-service owns its own state Maps. There is NO shared mutable state
   bag (no `PaymentCentralState` object passed around). Cross-domain reads
   happen exclusively through typed read-port interfaces in `ports.ts`
   (`ProcessorReader`, `TransactionReader`).

2. Cross-domain writes never happen. A sub-service may read another domain's
   state via a port, but never mutate another domain's Maps.

3. Only `DunningAgentAdapter` may instantiate or call `DunningAgent`. Other
   sub-services that need AI dunning behavior receive the adapter and call
   `adapter.analyze(entry, schedule, mode)`. (`DunningService` imports the
   `DunningOutput` type alone for return-type annotations on its public methods —
   a type-only import is permitted because it erases at compile time and creates
   no runtime coupling.)

4. Demo seeding lives per-service as a public `seedDemo()` method called from
   the facade constructor in dependency order. There is no central seeder.

5. The facade `PaymentCentralService` is the only Inversify-bound entry point.
   Sub-services are plain TypeScript classes constructed by the facade.

6. The facade re-exports types via `export * from '../types/paymentCentral'`
   so existing consumers importing types from the facade module still work.

7. Time and randomness are accessed via `PaymentCentralRuntime.now()` and
   `.random()`, not directly via `Date.now()` / `Math.random()`. This makes
   sub-services controllable under test.

## Adding a new sub-service

DO:
- Make it a plain class with a `(runtime: PaymentCentralRuntime, ...readers)` constructor.
- Own your own state Maps.
- Implement a read-port interface in `ports.ts` if your state needs to be readable
  by another sub-service.
- Add a `seedDemo()` method if your domain needs demo data.
- Wire it in `PaymentCentralService` constructor and add one-line delegations
  for any new public surface.

DON'T:
- Bind it in `inversify.config.ts`.
- Re-introduce a shared mutable state bag.
- Mutate another sub-service's state.
- Bypass the runtime to call `Date.now()` or `Math.random()` directly.

## Deferred / out of scope

The original refactor plan (`docs/archive/superseded/2026-04/superpowers/plans/2026-04-18-payment-central-service-refactor-plan.md`, archived)
explicitly deferred the following — they are NOT TODOs hidden in code, just
known follow-ups that require their own design decisions:

- **Split `src/routes/paymentCentral.ts` into per-domain routers.** The routes
  file is still a single 1,084-line file; the domain split should now mirror
  the service split.
- **Replace demo randomness with deterministic fixtures.** `seedDemo()` methods
  currently use the runtime's `random()` (which delegates to `Math.random()`
  in production). For deterministic test fixtures, the runtime's `random` and
  `now` would need to be overridable from the test harness; see
  `tests/unit/services/__tests__/helpers/createPaymentCentralService.ts` as
  the natural override point.
- **Evaluate facade deletion in a follow-up PR** after downstream callers are
  intentionally migrated to inject sub-services directly. This refactor kept
  the facade as the single Inversify-bound entry point to avoid touching any
  consumer.
- **Container-bind individual sub-services** if a real external consumer
  appears that needs to inject one of them directly.
