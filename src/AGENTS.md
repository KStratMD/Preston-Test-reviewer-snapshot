# src/AGENTS.md

Use this for code under `src/`.

- Follow the existing TypeScript and module patterns in the touched area.
- Keep edits local to the module boundary unless a cross-cutting fix is required.
- Run `npm run typecheck` for code changes that affect shared types or contracts.
- Add or update the smallest focused regression test when behavior changes.
- Prefer existing helpers and data shapes over new abstractions.
