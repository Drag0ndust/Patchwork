# Patchwork

Patchwork is a manager for your local AI Skills and Agent Definitions. It maintains a Library on your machine and lets you install items from it into any project — using symlinks, so every project always runs the latest version automatically.

## What problem does it solve?

AI coding assistants like Claude Code and Codex can be extended with custom Skills (task-specific prompt files) and Agent Definitions (full agent personas with a system prompt and personality). Without a manager, these files live scattered across projects, get copied and drift out of sync, and are painful to share across machines.

Patchwork gives you a single source of truth — your Library — and makes deploying from it to any project a one-command operation.

## Core concepts

**Skill** — a markdown prompt file that tells an AI agent how to perform a specific task (e.g. `/diagnose`, `/tdd`). You write it once in your Library and install it into as many projects as you like.

**Agent Definition** — a directory that defines a complete agent persona:
- `AGENT.md` — what the agent does and how it behaves (required)
- `SOUL.md` — tone, values, communication style (optional)
- `SKILLS` — plain-text list of Skills this agent depends on (optional)

**Library** — your canonical local collection of Skills and Agent Definitions, backed by a directory you configure (default: `~/.claude/`). Point it at an iCloud folder to sync across devices.

**Project** — any directory you register with Patchwork. You can associate it with one or more Tools and install Skills and Agent Definitions into it.

**Tool** — an AI coding assistant that consumes Skills and Agent Definitions (Claude Code, Codex, etc.). Patchwork ships with built-in presets for known tools and lets you define custom mappings.

## How installation works

Installing a Skill or Agent Definition into a project creates a **symlink** from the project back to your Library. There is no copying, no versioning, no re-installs. Edit a Skill in your Library and every project that has it installed picks up the change immediately.

## Platforms

| Component | Platform |
|---|---|
| GUI app | macOS (SwiftUI, iCloud-ready) |
| CLI | macOS, Linux, Windows |

The macOS app and the CLI share the same core library (`PatchworkCore`) written in Swift. Patchwork stores its own data — project registry, config, tool overrides — in `~/.patchwork/`, accessible to both.

## Status

Early development. The domain model and architecture are defined — see [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/) for decisions made so far.
