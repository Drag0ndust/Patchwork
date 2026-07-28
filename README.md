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
  encodes the linear Input → step(s) → Output order. Imported `Skill`/`Agent`
  nodes are emitted as **reference-by-name** (the artifact is not copied).
- **Artifact Codec** (`src/domain/artifact-codec.ts`) — pure parse/emit for the
  two on-disk formats, and the one place that knows a skill is a *directory*
  containing `SKILL.md` while an agent is a *single file* `agents/<name>.md`.
  `parseArtifactLocation` states the naming rule: the layout is **bounded** to at
  most one namespace segment, taken from a plugin directory
  (`skills/<plugin>/skills/<name>/SKILL.md` → `<plugin>:<name>`). The rule is
  checked in once, in `src/domain/__fixtures__/artifact-locations.json`, and
  exercised from **both** the TS and Rust test suites.
- **Root Resolver** (`src/domain/root-resolver.ts`) — pure precedence over
  artifact listings: skills personal > project, agents project > personal.
- **Import Scanner** — a thin shell: the privileged walk lives in Rust
  (`src-tauri/src/lib.rs`, `scan_roots`), the decisions live in
  `src/import/catalog.ts` (parse + resolve) and `src/import/source-roots.ts`
  (the configured roots, default `~/.claude`).
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
