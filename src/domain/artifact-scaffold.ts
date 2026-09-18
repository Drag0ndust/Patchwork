/**
 * The starter body a node's artifact is born with.
 *
 * An authored artifact's body is prose a model reads, and the hard part of writing
 * one is not the typing — it is knowing what a skill or an agent is *shaped* like.
 * A blank textarea hands that problem to the author; a scaffold answers it, and the
 * author edits sentences instead.
 *
 * The two shapes are genuinely different, which is why this is per kind rather than
 * one template with the noun swapped: a **skill** is instructions Claude Code
 * follows in place (when it applies, what to do, what comes out), while an **agent**
 * is a role delegated to a subagent that comes back with a report (who it is, what
 * it may not do, what it returns). The sections mirror the artifacts in
 * `__fixtures__/artifacts/`, which are real ones.
 *
 * Pure text: no frontmatter, because an authored artifact's frontmatter is derived
 * from the form's fields (ADR-0007) and a `---` here would emit a second, stale copy
 * of it inside the body.
 */

import type { ArtifactKind } from "./artifact-codec";

/**
 * Put the node's label on one line, so it can be a heading.
 *
 * The label is free text off the canvas: a newline in it would end the heading and
 * turn the rest of the name into body prose under a heading nobody wrote.
 */
function headingText(title: string, fallback: string): string {
  const collapsed = title.replace(/[\s-]+/g, " ").trim();
  return collapsed === "" ? fallback : collapsed;
}

/** The starter body for a newly authored artifact of `kind`, titled after its node. */
export function artifactScaffold(kind: ArtifactKind, title: string): string {
  return kind === "skill"
    ? skillScaffold(headingText(title, "New skill"))
    : agentScaffold(headingText(title, "New agent"));
}

function skillScaffold(title: string): string {
  return `# ${title}

One paragraph on what this skill does, in the voice of an instruction to whoever runs it.

## When to use this

- The situation that should reach for it.
- The situation that should not — say what to do instead.

## Process

1. The first step, stated as something to do.
2. The next step.
3. How to tell it is finished.

## Output

What the caller gets back, and the shape it comes back in.
`;
}

function agentScaffold(title: string): string {
  return `# ${title}

You are the subagent that does one job: say which, in a sentence.

## What you do

1. What to read or gather first.
2. What to work out from it.
3. What to decide or produce.

## Hard rules

- What you must never do, however the task is phrased.
- The boundary of your remit — what you hand back rather than act on.

## Report

What to return as your final message, and how it is laid out.
`;
}
