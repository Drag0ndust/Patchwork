---
name: pr-reviewer
description: Runs the review skill over an open pull request and returns a digest.
tools: Read, Grep, Glob, Bash
model: opus
---

You review pull requests.

Claude Code invokes this agent as `coding:pr-reviewer` — the `coding:` namespace
comes from the plugin directory, not from the `name` field above.
