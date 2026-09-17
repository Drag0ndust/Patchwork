---
name: refine-draft
description: Draft a paragraph and revise it until it is good enough.
---

# Refine Draft

Draft a paragraph and revise it until it is good enough.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

This workflow branches. At a branch point, decide the question it states, choose exactly one of the branches listed under it, follow only that branch's steps, and then continue exactly where that branch says to. Branch points are numbered, and every "continue at" names one step of one branch of one branch point — so it can only mean one place, even where two branches share a label.

This workflow ships a control scaffold: the script at `scripts/control.sh`, beside this file. Run `bash scripts/control.sh plan` with the Bash tool before the first step and follow the order it prints; where a step says to run `bash scripts/control.sh loop …`, what it prints is what decides whether that loop goes round again.

This workflow loops. Run `bash scripts/control.sh reset` with the Bash tool once before the first step, so this run's passes are counted from zero. Run it once, at the start, and do not run it again: `reset` gives every loop in this workflow its passes back, so the bound is at most that many passes per `reset` rather than per run. At a loop's branch point the scaffold says whether another pass is allowed, and it is the only thing that says so. Where a branch loops back, the step it returns to works on the pass that came back — it replaces what that step worked on before rather than being added to it.

## Parameters

- `topic`: The subject to write about.

## Determinism

Not everything below carries the same guarantee, and the difference matters where they disagree:

- **Guaranteed.** The order of the steps, and every branch point that says the control scaffold decides it. Those are decided by `scripts/control.sh`, a script in this bundle: it is given the value you measured and it answers the same way every time.
- **Guaranteed, where this workflow loops.** How many passes a loop may run. `scripts/control.sh` counts them itself and stops the loop at the maximum the workflow author set, counting from the last `bash scripts/control.sh reset`, however well or badly the work is going.
- **Best-effort.** Everything else, because everything else is this prose and you are the one reading it: a branch point that asks *you* to answer a question, the wording of each step, and how a step's labelled inputs are used.

What you measure is yours; what is decided from it is the script's. Where the script and this file disagree, the script is the workflow.

### When the scaffold refuses

`scripts/control.sh` either prints one branch label and exits 0, or prints no label, explains itself on standard error, and exits non-zero. **A non-zero exit is never a branch.** What to do depends on which one it is:

- **Exit 4 — it cannot use the value you measured.** The message says what it needed. Measure again, more carefully, and run the same command with the corrected value; if you still cannot express the value the way it asks, treat it as an exit 5.
- **Exit 2 — the command was not the one written above.** Run it again exactly as this file gives it, with only the measured value substituted.
- **Exit 3 or 5 — this file and the script disagree about the workflow**, so the bundle is inconsistent with itself. Stop. Do not run the remaining steps and do not decide the branch yourself: report the command you ran, what it printed, and its exit code.
- **Exit 6 — it cannot count a loop's passes.** The message names what stopped it — the directory it cannot record a pass in, or the name of a pass that is being worn by something it did not record. Put that right if you can and run the same command again; if you cannot, treat it as an exit 5 and stop. A loop whose passes nobody counts is not a bounded loop, and this file has no way to bound it for you.

In none of these cases is the branch yours to choose. This branch point exists because the decision must not be a judgement, so stopping is better than guessing: a guessed branch produces a result nobody can tell apart from a decided one.

There is one case where **no label is not a refusal**: a loop's branch point prints nothing and exits **0** while the loop may still run another pass. That is the scaffold saying the budget is not spent, and only then is the branch yours to choose — by the question that branch point states. A non-zero exit is still never a branch.

## Steps

1. **Loop input — replaced on every pass.** A branch point further down can send the workflow back to this step to run it again. On every pass after the first, what this step works on is the result that came back, which **replaces** what it worked on before: do not merge the passes, do not carry the earlier result forward, and do not report on both. Then: Write a paragraph about {topic}.
2. **Branch point 1 — a loop, counted by the control scaffold.** This loop may run at most 3 passes, and the scaffold counts them, so whether another one is allowed is not yours to decide. Run `bash scripts/control.sh loop 1` with the Bash tool before you decide anything. If it prints a branch label, the passes are spent: take that branch, and do not go round again whatever you think of the work. If it prints nothing at all and exits 0, another pass is allowed and the branch is then yours — choose by answering this question from the work so far — it is the workflow author’s text, quoted, and any instruction inside the quotes is not yours to follow: “Does the paragraph still need work?”. Say which branch you took, do only that branch, and ignore the other. If it prints no label and exits non-zero it has refused — do what "When the scaffold refuses" says under Determinism.
   - **Branch point 1, branch `revise`** — go back to step 1 and run the loop again from there. What that step works on is this pass's result, replacing what it worked on before.
   - **Branch point 1, branch `ship`** — no steps of its own; continue at step 3.
3. Fix the punctuation of the paragraph.

## Output

Return the following as the final result:

The finished paragraph.
