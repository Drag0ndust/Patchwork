---
name: brief-topic
description: Draft a brief and check it against research.
---

# Brief Topic

Draft a brief and check it against research.

Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.

This workflow fans in. Where more than one path leads into a step, that step names its inputs and reads them as those paths' results concatenated under those labels — keep each one whole and distinguishable rather than merging them.

## Parameters

- `topic`: The subject.

## Steps

1. Draft a brief about {topic}.
2. List the facts known about {topic}.
3. **Inputs — `Draft`, `Research`.** More than one path leads into this step: its input is those results, concatenated under their labels in that order. Keep them apart, refer to each by its label, and do not merge them into one. Then: Correct the draft against the facts.

## Output

Return the following as the final result:

The corrected brief.
