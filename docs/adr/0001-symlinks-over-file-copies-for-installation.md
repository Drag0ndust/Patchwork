# Symlinks over file copies for installation

When a Skill or Agent Definition is installed into a Project, Patchwork creates a symlink pointing back to the Library — not a copy of the file. This means any edit to the Library item is immediately reflected in every Project that has it installed, with no re-install step required.

The main trade-off: if the user moves or changes their Library Root, all symlinks break. We accept this because the Library Root is a stable, user-configured path (defaulting to `~/.claude/`), and the auto-update behaviour is core to Patchwork's value proposition. Copies would silently diverge across projects, defeating the purpose of a managed library.

## Considered options

- **File copies**: each Project gets its own independent copy. Simple, robust to Library Root changes. Rejected because copies diverge silently — the user has no way to know which projects are on an old version of a Skill.
- **Symlinks**: chosen. Always-latest, zero maintenance. Breaks if Library Root moves, but that's a recoverable, visible failure (broken symlink) rather than a silent one (stale copy).
