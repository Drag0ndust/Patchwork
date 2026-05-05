# Symlinks use the configured Library Root, not the resolved real path

When `patchwork install` writes a symlink into a Project, the symlink's target path is the **configured** Library Root joined with the Skill name — not the result of `realpath` on that path. If the configured Library Root is itself a symlink (e.g. `~/.claude` → `~/iCloud Drive/.claude`), Patchwork preserves the indirection in every Project-side symlink it writes.

This means a Project's `.claude/skills/diagnose` typically points at `~/.claude/skills/diagnose`, not at `~/iCloud Drive/.claude/skills/diagnose`. When the user moves their iCloud folder (or replaces it with a non-iCloud directory), only the single symlink at the Library Root needs to update — every Project-side symlink keeps working.

The trade-off: a casual reader of `ls -la .claude/skills/` sees a path that may itself need resolving to find the real file. We accept this because the alternative bakes the user's storage layout into every Project on their machine, and the Library Root being a symlink is the *expected* configuration for iCloud-synced libraries.

## Considered options

- **Resolve through to the real path** when writing symlinks. Rejected: every Project-side symlink would hardcode the iCloud (or other) storage path. Moving the iCloud folder would silently break every install across every Project, and users would only discover it the next time their AI agent failed to find a skill.
- **Use the configured Library Root path verbatim**: chosen. The Library Root is a single, stable, user-controlled indirection point. Updates to the storage layout propagate through it automatically.
- **Make it configurable per-install** (`--resolve-symlinks` flag). Rejected: extra surface area in v1.0 for a case the default already handles correctly.

## Consequences

- The Library Root must remain a stable path on the user's filesystem. ADR-0001 already established this constraint; this ADR is downstream of it.
- `patchwork status` resolves symlinks lexically when checking "does this point into the Library?" — it compares the symlink's *target string* against the configured Library Root path, not the realpath of either.
