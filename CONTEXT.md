# Patchwork — Context

## Platform

- **GUI**: macOS native app (SwiftUI, iCloud-ready)
- **CLI**: cross-platform (macOS, Linux, Windows)
- **Language**: Swift throughout. Shared core Swift Package (`PatchworkCore`) with a CLI target and a macOS app target.
- **CLI distribution**: Homebrew tap + direct binary downloads via GitHub Releases (macOS, Linux, Windows).

## Glossary

### Skill
A prompt file that instructs an AI agent how to perform a specific, named task (e.g. `/diagnose`, `/tdd`). Skills live in `~/.claude/skills/` and are invoked by name inside a project.

### Agent Definition
A directory in the Library that defines a complete agent persona. Contains:
- `AGENT.md` (required) — functional definition: what the agent does, its capabilities, and task behaviour
- `SOUL.md` (optional) — personality layer: tone, values, communication style
- `SKILLS` (optional) — plain text file, one Skill name per line (`#` for comments). Installing the Agent Definition also installs all declared Skills as separate symlinks.

An Agent Definition can be installed into any Project.

### Library
The canonical collection of Skills and Agent Definitions managed by Patchwork. Backed by a user-configured directory on disk (default: `~/.claude/`, with skills in `~/.claude/skills/` and agent definitions in `~/.claude/agents/`). The user can point the Library at any local path — including an iCloud-synced folder — to share their collection across devices. A remote community registry is a future extension, not in scope now.

### Library Root
The directory on disk that backs the Library. User-configurable. Default: `~/.claude/`.

### Patchwork Data Directory
`~/.patchwork/` — where Patchwork stores its own data: the Project registry, Library Root config, and Tool overrides. Shared by both the GUI and the CLI.

### Installation
The act of creating a symlink from a Skill or Agent Definition in the Library into a Project. The symlink means updates to the Library item are immediately reflected in all Projects that have it installed — no re-install required. No versioning or pinning; all Projects always run the latest version of each installed item. The target path within the project is determined by the Tool configuration, making Patchwork tool-agnostic.

### Project
A directory on disk explicitly registered with Patchwork. A Project can be associated with one or more Tools. Patchwork tracks which Skills and Agent Definitions are installed per Tool within a Project. When installing, the user can target one specific Tool or all configured Tools at once.

### Tool
An AI coding assistant that consumes Skills or Agent Definitions (e.g. Claude Code, Codex). Patchwork ships with built-in presets for known Tools and allows users to define custom Tool configurations or override presets.

### Tool Preset
A built-in Tool configuration that ships with Patchwork. Defines the directory mappings for Skills and Agent Definitions within a Project for a known tool (e.g. Claude Code → `.claude/skills/`, `.claude/agents/`).
