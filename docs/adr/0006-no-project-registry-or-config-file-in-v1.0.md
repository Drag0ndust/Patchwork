# No Project registry or config file in v1.0

v1.0 ships without `~/.patchwork/`. There is no Project registry, no config file, no persistent state owned by Patchwork. The only durable artifacts are the Library directory (default `~/.claude/`) and the symlinks `install` writes into Projects. Library Root is resolved per-invocation from `PATCHWORK_LIBRARY_ROOT` or the hardcoded default.

`install`, `uninstall`, and `status` operate on the **current working directory** as the Project. There is no project-root walk, no `.patchwork` marker, no registry to consult. The filesystem (specifically, symlinks under `./.claude/skills/` resolving into `<library>/skills/`) is the source of truth for what's installed where.

This stays true until v1.x introduces explicit Project registration, at which point `~/.patchwork/` is added additively and v1.0-style cwd installs continue to work unchanged — the registry becomes a *cache* of what's already on disk, not a precondition for any command.

The trade-off: v1.0 cannot answer cross-project questions ("which of my projects has `diagnose` installed?"). `status` only sees the current directory. We accept this because the cross-project question is the *next* feature the registry unlocks, not v1.0's core loop, and shipping the registry now would mean designing its schema before we know what it needs to hold for v1.x's other features (multi-Tool projects, bulk install, etc.).

## Considered options

- **Ship the registry in v1.0**, design its schema speculatively. Rejected: locks in a serialization format before we know what v1.x's multi-Tool and bulk-install features need from it. High risk of v1.x breaking the v1.0 schema.
- **Ship a config file in v1.0** for Library Root only, no registry. Rejected: `PATCHWORK_LIBRARY_ROOT` already covers the override case, and a config file with one key earns its keep mostly as a place to add the second key — which we don't have yet. Same lock-in risk on the file format.
- **No registry, no config file in v1.0**: chosen. Smallest possible surface, zero leftover state on uninstall, all v1.0 commands derivable from environment + filesystem.

## Consequences

- `patchwork status` is cwd-only. Cross-project queries arrive with the registry in v1.x.
- Setting `PATCHWORK_LIBRARY_ROOT` is per-shell — durable use requires the user to `export` it in their rc file. Documented in `--help`.
- v1.x precedence rule (env var > config file > default) is forward-compatible: existing v1.0 users with `PATCHWORK_LIBRARY_ROOT` set keep their override regardless of what the future config file says.
- Uninstalling Patchwork is `rm $(which patchwork)` — nothing else to clean up. The Library and project-side symlinks are user data, intentionally not Patchwork's to remove.
