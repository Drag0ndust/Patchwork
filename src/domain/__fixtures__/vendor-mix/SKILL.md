---
name: vendor-mix
description: Carry some dependencies along and reference the rest.
---

# Vendor Mix

Carry some dependencies along and reference the rest.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

## Parameters

- `task`: What to build.

## Requirements

This workflow references capabilities by name — they are not bundled here, so they must already be installed in Claude Code:

- skill `conventions`
- subagent `pr-reviewer`

## Bundled capabilities

These capabilities are copied into this bundle, so nothing has to be installed for them. Invoke each by its bundled name — inside this bundle it is the name below, not the name it has where it was copied from:

- skill `patchwork-vendor-mix:tdd` — bundled at `skills/tdd/SKILL.md`, copied from `coding:tdd`
- subagent `patchwork-vendor-mix:pr-reviewer` — bundled at `agents/pr-reviewer.md`, copied from `coding:pr-reviewer`

## Steps

1. Invoke the `patchwork-vendor-mix:tdd` skill with the Skill tool — it is bundled here at `skills/tdd/SKILL.md`, so read that file if the name does not resolve — then use its result in the next step.
2. Invoke the `conventions` skill with the Skill tool, then use its result in the next step.
3. Delegate to the `patchwork-vendor-mix:pr-reviewer` subagent with the Task tool — it is bundled here at `agents/pr-reviewer.md`, so read that file if the name does not resolve — then use its result in the next step.
4. Delegate to the `pr-reviewer` subagent with the Task tool, then use its result in the next step.

## Output

Return the following as the final result:

The review digest.
