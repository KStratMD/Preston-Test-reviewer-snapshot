# src/connectors/AGENTS.md

Use this for connector and registry work.

- Keep connector classes, registry entries, and proof cards in sync.
- Production-grade connectors need the documented static metadata and proof card path.
- Avoid direct `new <Connector>` call sites outside the registry factory path.
- After connector metadata changes, check `npm run audit-status-claims` and `npm run audit-proof-cards`.
- Keep changes to connector behavior backed by the smallest relevant regression test.
