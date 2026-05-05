# Skill is a directory, not a file

A Skill in the Library is a **directory** named for the Skill. It must contain a `SKILL.md` (the prompt body, with frontmatter) and may contain any supporting files the Skill references — sub-docs, scripts, examples. The directory name is the Skill's identity.

This matches the on-disk format Claude Code already uses for skills under `~/.claude/skills/`. Patchwork's earlier definition described a Skill as a single markdown file, which contradicted that reality and could not represent Skills with auxiliary files (e.g. `grill-with-docs` ships `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` alongside its `SKILL.md`).

The main trade-off: you cannot drop a stray loose `.md` file into the Library and have it Just Work. `patchwork add ./foo.md` against a single file is rejected — the user must wrap it in a directory containing at least `SKILL.md`. We accept this because the cost is one `mkdir`, and the win is a model that fits both trivial Skills (one file inside a directory) and complex Skills (many files inside the same directory) without a second code path.

A pleasant side effect: Agent Definitions (v1.1) are also directories. Having both Library item types be directories means installation is uniformly "symlink one directory into the Project" — no per-type install logic.

## Considered options

- **Skill is a single `.md` file**: simple to think about; matches the original glossary. Rejected because it contradicts how Claude Code skills actually live on disk and cannot represent skills with supporting files. A symlink to the file would orphan its references.
- **Skill is a directory with a required `SKILL.md`**: chosen. Matches reality, symmetric with Agent Definitions, supports both trivial and complex skills without branching.
- **Skill is either a file or a directory**: rejected. Two code paths, two name-resolution rules (filename-without-`.md` vs. directory name), and ambiguity when both `foo.md` and `foo/` exist in the Library.
