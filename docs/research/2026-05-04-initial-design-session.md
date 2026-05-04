# Patchwork — Initial Design Session

**Date:** 2026-05-04

This document captures the key decisions made during the initial design grilling session that shaped Patchwork's domain model and architecture.

---

## What is Patchwork?

Patchwork is an app to manage local AI Skills and Agent Definitions and install them into projects. It has a Library — a user-configured local directory that acts as the canonical store — and lets users symlink Skills and Agent Definitions into any project they register.

---

## Core concepts resolved

### Skill vs Agent Definition

These are distinct concepts at different scopes:

- **Skill**: a single markdown prompt file that instructs an AI agent how to perform a specific named task (e.g. `/diagnose`, `/tdd`). Analogous to `~/.claude/skills/`.
- **Agent Definition**: a directory that defines a complete agent persona. Contains `AGENT.md` (required), `SOUL.md` (optional personality layer), and a `SKILLS` plain-text file (optional list of Library Skill dependencies).

### Library

The Library is the canonical local collection of Skills and Agent Definitions on the user's machine. It is backed by a user-configured directory (**Library Root**), defaulting to `~/.claude/`. The user can point it at any local path, including an iCloud-synced folder, to share their collection across devices.

A remote community registry is explicitly a future extension — not in scope for v1.

### Installation

Installing a Skill or Agent Definition into a Project creates a **symlink** from the project directory back to the Library file. Symlinks mean updates to the Library are immediately reflected in all Projects — no re-install needed, no versioning. See ADR-0001.

### Projects

Patchwork maintains an explicit registry of Projects. A Project is a directory the user has registered with the app. Each Project can be associated with one or more Tools (e.g. Claude Code, Codex). When installing, the user can target one Tool or all configured Tools at once.

### Tools

A Tool is an AI coding assistant that consumes Skills or Agent Definitions. Each Tool has a path mapping that determines where symlinks are placed within a project (e.g. Claude Code → `.claude/skills/`). Patchwork ships with built-in **Tool Presets** for known tools and allows user overrides or custom Tool definitions.

---

## Architecture

| Concern | Decision |
|---|---|
| GUI | macOS native app (SwiftUI, iCloud-ready) |
| CLI | Cross-platform (macOS, Linux, Windows) |
| Language | Swift throughout — shared `PatchworkCore` Swift Package |
| Patchwork data | `~/.patchwork/` — project registry, config, tool overrides |
| CLI distribution | Homebrew tap + GitHub Releases direct binaries |
| Editing | External editor (built-in editor deferred to future version) |

See ADR-0002 for the rationale on Swift for the CLI.

---

## macOS app UI structure

Three primary views:

1. **Library** — browse and manage all Skills and Agent Definitions. Add, remove, open in external editor.
2. **Projects** — list of registered projects. Each project shows its associated Tool(s) (Claude Code, Codex, or both). Click a project to see installed Skills/Agents and install/uninstall more.
3. **Settings** — Library Root path, Tool configurations (presets + overrides).

---

## Agent Definition file format

An Agent Definition is a directory containing:

```
my-agent/
├── AGENT.md      ← required: functional definition (what the agent does)
├── SOUL.md       ← optional: personality layer (tone, values, style)
└── SKILLS        ← optional: plain text, one Library Skill name per line
```

The `SKILLS` file uses `#` for comments. Installing an Agent Definition also installs all Skills listed in `SKILLS` as separate symlinks.

---

## Key deferred decisions

- Remote community registry (future v2+)
- Built-in editor in the macOS app (future version)
- Windows Homebrew formula (covered by direct binary download for now)
