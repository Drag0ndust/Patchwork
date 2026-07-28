---
name: review-change
description: Implement a change test-first, then review it.
---

# Review Change

Implement a change test-first, then review it.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

## Parameters

- `task`: What to build.

## Requirements

This workflow references capabilities by name — they are not bundled here, so they must already be installed in Claude Code:

- skill `coding:tdd`
- subagent `pr-reviewer`

## Steps

1. Invoke the `coding:tdd` skill with the Skill tool, then use its result in the next step.
2. Summarize the diff for {task}.
3. Delegate to the `pr-reviewer` subagent with the Task tool, then use its result in the next step.

## Output

Return the following as the final result:

The review digest.
