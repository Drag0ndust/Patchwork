# Patchwork

Design AI Workflows.

Patchwork is a Tauri desktop app for composing linear AI workflows on a visual
canvas and exporting them as runnable Claude Code skill bundles.

## Stack

- **Tauri v2** (Rust) — desktop shell + privileged filesystem (Bundle Emitter,
  document read/write).
- **React 18 + TypeScript + Vite** — canvas UI (`@xyflow/react`).
- **pnpm** — package manager. **vitest** (TS) + `cargo test` (Rust) for tests.

## Architecture

- **Graph Document** (`src/domain/graph-document.ts`) — the `.patchwork` schema,
  `validateGraph`, and `serialize`/`deserialize`. Patchwork's own format, not a
  raw React Flow dump.
- **Graph Compiler** (`src/domain/compiler.ts`) — pure `compile(doc)` producing
  an in-memory `BundleTree` (no IO). Emits an umbrella `SKILL.md` whose prose
  encodes the linear Input → Prompt(s) → Output order.
- **Bundle Emitter** (`src-tauri/src/lib.rs`, `export_bundle`) — writes the tree
  to disk with a clean-overwrite guarantee.

## Develop

```sh
pnpm install       # install frontend deps
pnpm test          # run TS unit tests (vitest)
pnpm tauri dev     # launch the app
pnpm build         # typecheck + build the frontend
```

```sh
cd src-tauri && cargo test    # run Rust emitter tests
```
