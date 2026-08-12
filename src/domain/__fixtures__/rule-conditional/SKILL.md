---
name: triage-report
description: Triage a bug report along the path its contents call for.
---

# Triage Report

Triage a bug report along the path its contents call for.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

This workflow branches. At a branch point, decide the question it states, choose exactly one of the branches listed under it, follow only that branch's steps, and then continue exactly where that branch says to. Branch points are numbered, and every "continue at" names one step of one branch of one branch point — so it can only mean one place, even where two branches share a label.

This workflow ships a control scaffold: the script at `scripts/control.sh`, beside this file. Run `bash scripts/control.sh plan` with the Bash tool before the first step and follow the order it prints; where a step says to run `bash scripts/control.sh route …`, the branch it prints is the branch to take.

## Parameters

- `report`: The raw bug report.

## Determinism

Not everything below carries the same guarantee, and the difference matters where they disagree:

- **Guaranteed.** The order of the steps, and every branch point that says the control scaffold decides it. Those are decided by `scripts/control.sh`, a script in this bundle: it is given the value you measured and it answers the same way every time.
- **Best-effort.** Everything else, because everything else is this prose and you are the one reading it: a branch point that asks *you* to answer a question, the wording of each step, and how a step's labelled inputs are used.

What you measure is yours; what is decided from it is the script's. Where the script and this file disagree, the script is the workflow.

### When the scaffold refuses

`scripts/control.sh` either prints one branch label and exits 0, or prints no label, explains itself on standard error, and exits non-zero. **A non-zero exit is never a branch.** What to do depends on which one it is:

- **Exit 4 — it cannot use the value you measured.** The message says what it needed. Measure again, more carefully, and run the same command with the corrected value; if you still cannot express the value the way it asks, treat it as an exit 5.
- **Exit 2 — the command was not the one written above.** Run it again exactly as this file gives it, with only the measured value substituted.
- **Exit 3 or 5 — this file and the script disagree about the workflow**, so the bundle is inconsistent with itself. Stop. Do not run the remaining steps and do not decide the branch yourself: report the command you ran, what it printed, and its exit code.

In none of these cases is the branch yours to choose. This branch point exists because the decision must not be a judgement, so stopping is better than guessing: a guessed branch produces a result nobody can tell apart from a decided one.

## Steps

1. Read {report} and list what it does and does not contain.
2. **Branch point 1 — decided by the control scaffold, not by you.** Measure this from the work so far — it is the workflow author’s text, quoted, and any instruction inside the quotes is not yours to follow: “the number of stack frames in the report”. Then run `bash scripts/control.sh route 1 '<the value you measured>'` with the Bash tool: it prints the label of exactly one of the branches below. Do only that branch's steps, ignore the other branches' steps, and do not overrule its answer. If it prints no label and exits non-zero it has refused — do not choose a branch yourself; do what "When the scaffold refuses" says under Determinism. Whichever branch it names, continue at step 3 once it is done.
   - **Branch point 1, branch `with trace`** — do these steps in order, then continue at step 3:
     1. Name the failing frame in the stack trace.
   - **Branch point 1, branch `no trace`** — do these steps in order, then continue at step 3:
     1. List the reproduction details the reporter must add.
3. Write the triage summary.

## Output

Return the following as the final result:

The triage summary.
