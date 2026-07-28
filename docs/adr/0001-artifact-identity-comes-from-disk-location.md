# ADR-0001: An artifact's identity comes from its location on disk, and the walk that finds it is shape-bounded

- **Status:** Accepted
- **Date:** 2026-07-28
- **Context:** Import Scanner, Artifact Codec, Graph Compiler

## Context

Patchwork lets a workflow reference skills and agents the user already has
installed, and exports that workflow as an umbrella `SKILL.md` whose prose tells
Claude Code to invoke them **by name**. Nothing is copied into the bundle, so the
emitted name is the whole of the reference: if it is wrong, the export fails at
run time, inside Claude Code, far from Patchwork.

Two questions had to be settled before any of that could be written.

**Where does the name come from?** A skill's `SKILL.md` and an agent's `.md` both
carry a `name:` in their frontmatter, which looks authoritative.

**How deep does the scan go?** A `~/.claude` tree contains far more `SKILL.md`
files than it contains skills. This repo's own `~/.claude` has two of them
vendored under a plugin's `references/.venv/.../playwright/`.

## Decision

**1. Identity comes from the path, never from the frontmatter.**

Claude Code resolves a skill or agent by the name its *path* implies. A
frontmatter `name:` that disagrees with the path — stale, copy-pasted, or absent —
is simply not what gets invoked. Deriving the name from frontmatter would emit a
reference that reads correctly to a human and cannot be invoked by the tool.

The layout is therefore the definition, and it is written down twice, on purpose,
because both a privileged Rust walk and a pure TypeScript function need it:

| Path relative to a source root                  | Artifact                |
| ----------------------------------------------- | ----------------------- |
| `skills/<name>/SKILL.md`                        | skill `<name>`          |
| `agents/<name>.md`                              | agent `<name>`          |
| `skills/<plugin>/SKILL.md`                      | skill `<plugin>`        |
| `skills/<plugin>/skills/<name>/SKILL.md`        | skill `<plugin>:<name>` |
| `skills/<plugin>/agents/<name>.md`              | agent `<plugin>:<name>` |

Note the asymmetry this encodes: **a skill is a directory** (identified by the
`SKILL.md` it contains), while **an agent is a single file** (identified by its own
basename). `artifact-codec.ts` is the one place that knows this, so every other
module stays agnostic.

**2. The walk is shape-bounded, not depth-budgeted.**

A directory below `skills/` mints a namespace segment only when it carries a
`.claude-plugin/` marker directory, and nothing below a plugin's own
`skills/<name>/` or `agents/` is reachable at all. At most one namespace segment
can ever be formed.

A depth budget was the obvious alternative and is wrong: it admits whatever
happens to sit within the budget. It would fabricate importable names like
`writing:excalidraw:references:vendored` — plausible-looking references that
resolve to nothing.

**3. The rule is pinned by one table read from both languages.**

`src/domain/__fixtures__/artifact-locations.json` holds `path → (kind, name)`
pairs and is read by `artifact-codec.test.ts` and by `lib.rs`. The Rust side
asserts the discovered set equals the table's non-null entries *exactly*, so the
14 rows asserting a path yields **nothing** are enforced rather than documented.

Absence is the property that regresses silently: a walk that starts importing
vendored `SKILL.md` files still passes every test that only checks the artifacts
it does find.

## Consequences

- Renaming a skill's directory changes its identity, and any document referencing
  the old name shows as unresolved. This is correct — Claude Code would fail the
  same way — and the unresolved flag is derived at open time rather than persisted,
  so a moved artifact heals when it comes back.
- A user cannot import an artifact from a layout Claude Code cannot resolve. That
  is the point, but it means an unconventional tree imports as empty, and the scan
  must say *why* rather than silently returning nothing.
- Any change to the layout — a new plugin shape, a new nesting level — is a change
  to the fixture table first, in both languages, or the Rust exact-set assertion
  fails. This is the intended cost.
- Names are constrained further, to a charset and a length, because they are
  rendered into an inline code span in the emitted `SKILL.md`
  (`isValidArtifactName`). Path-derived names satisfy this; a hand-edited document
  is the case that needs the guard.

## Alternatives considered

- **Trust frontmatter `name:`.** Rejected: it is not what Claude Code resolves.
- **Depth budget instead of shape rules.** Rejected: admits vendored trees and
  fabricates namespace segments (see above).
- **Vendor-copy every referenced artifact into the bundle**, making identity a
  Patchwork-internal matter. Deferred, not rejected — it is a per-node export
  choice in a later slice. The codec's parse/emit is byte-faithful specifically so
  that slice can copy an artifact without rewriting it, and that slice will need
  its own ADR for the staleness question it introduces.
