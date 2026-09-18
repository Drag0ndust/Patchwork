---
name: triage-report
description: Triage a bug report with capabilities written here.
---

# Triage Report

Triage a bug report with capabilities written here.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

## Parameters

- `report`: The raw bug report.

## Requirements

This workflow references capabilities by name — they are not bundled here, so they must already be installed in Claude Code:

- skill `conventions`

## Bundled capabilities

These capabilities ship inside this bundle — some written as part of this workflow, some copied in — so nothing has to be installed for them. Invoke each by its bundled name, which is the name below:

- skill `patchwork-triage-report:triage` — bundled at `skills/triage/SKILL.md`, authored in this workflow
- subagent `patchwork-triage-report:report-reviewer` — bundled at `agents/report-reviewer.md`, authored in this workflow

## Steps

1. Invoke the `patchwork-triage-report:triage` skill with the Skill tool — it is bundled here at `skills/triage/SKILL.md`, so read that file if the name does not resolve — then use its result in the next step.
2. Delegate to the `patchwork-triage-report:report-reviewer` subagent with the Task tool — it is bundled here at `agents/report-reviewer.md`, so read that file if the name does not resolve — then use its result in the next step.
3. Invoke the `conventions` skill with the Skill tool, then use its result in the next step.

## Output

Return the following as the final result:

The triage digest.
