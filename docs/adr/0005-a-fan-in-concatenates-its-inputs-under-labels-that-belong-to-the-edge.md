# ADR-0005: A fan-in concatenates its inputs under labels, and the label belongs to the edge

- **Status:** Accepted
- **Date:** 2026-08-10
- **Context:** Graph Document, Workflow Order, Graph Compiler, canvas

## Context

Until now every step had exactly one thing leading into it. A fan-in — two paths arriving
at one node — existed only as a conditional's re-convergence, where exactly *one* of the
paths actually ran, so there was never more than one result to describe.

Slice 7 adds the real thing: a node may **split** into paths that are all followed, and
they may come back together at a step that reads all of their results. Three questions
follow.

1. **Where does the name of an incoming result live**, given a step now has several?
2. **What is the ordering**, now that "the next node" may be several nodes that all run?
3. **What does the umbrella say**, so the reading model does not merge two results into
   one blob?

## Decision

**1. The label belongs to the edge, and defaults to the source node's own label.**

`GraphEdge` gains `inputLabel?: string`, read through `inputLabelOf(edge, source)`, which
falls back to the source node's label and then to its id.

The edge, for the reason the branch is on the edge (ADR-0003): the edge is the thing the
user draws and the thing the traversal follows. The **default**, because naming the nodes
is already how a graph is made legible — a fan-in whose sources are called `Draft` and
`Research` needs no second set of names, and the field exists for the case one node feeds
two different things into one step. Labels are constrained exactly like branch labels
(same charset, same length bound): both land in an inline code span the reading model has
to quote back to itself.

`validateGraph` refuses two incoming paths of one node whose labels are indistinguishable
— compared case-folded and trimmed, because the comparison that matters is the one a
*reader* makes. That is not a naming quibble: it is a step that cannot say which result
it is looking at. Branch edges are excluded from the check for the same reason they are
excluded from the concatenation.

**2. A plain split is a fan-out that needs no segment kind.**

`planWorkflow` already knew how to fan out; the difference is that a conditional's
branches are alternatives (one runs) while a split's paths are all followed. So a split's
paths are appended to the list the splitting node sits in, in the order they were drawn,
and the walk resumes at the node they converge on — one flat list, no nesting, no new
`FlowSegment`.

What the two fan-outs share is the *scoping*, and that is now one helper (`pushWalks`):
the convergence point's scope opens, every path is walked inside it — so each stops
*before* the merge rather than instructing it — the scope closes, and only then does the
enclosing walk resume there. Without that, a merge is instructed once per path.

The naive reference plan in `workflow-order.test.ts` gained the same rule, the generated
corpora now contain plain splits (asserted, so the coverage cannot quietly lapse), and
the differential test is what keeps the optimised planner and the rule as written in
agreement — the arrangement ADR-0003 set up.

**3. A fan-in step is told its inputs, by name, before it is told what to do.**

The umbrella emits, at a step more than one path leads into:

> **Inputs — `Draft`, `Research`.** More than one path leads into this step: its input is
> those results, concatenated under their labels in that order. Keep them apart, refer to
> each by its label, and do not merge them into one. Then: …

The labels come first because they are what the reader has to hold on to. The rule is
three prohibitions in a row because the default reading of two results in one context is
one blob. The Output section says the same thing about the same shape, since it consumes
the results in exactly the same way while being a section rather than a step. And, once
per umbrella and only where there is a fan-in, the intro says what a labelled input is —
the same treatment branching gets.

**4. Which edges are inputs is a fact about the traversal, not about the graph — and that
is what tells a fan-in from a loop-back.**

An incoming edge contributes a labelled input only when it is not a branch edge, its
source is placed *earlier* in the plan than its target, and the two sit in the **same
segment list**.

- The list rule is what excludes a conditional's re-convergence: the two edges arriving
  at the merge are the tails of two branches, only one of which ran, so there is nothing
  to concatenate. They live in different lists; two paths of a split live in one.
- The direction rule is the distinction slice 7 owes the loop slice: a fan-in
  **concatenates** its inputs under labels, while a loop-back carries the next pass's
  value and **replaces** what the step worked on last time. Counting incoming edges
  cannot tell those apart; direction can. Loops are not in this slice and a cycle is
  still refused — what is settled here is that when they land, a back edge does not
  silently become a second labelled input.

**5. The canvas labels what an edge carries; the compiler decides what a step reads.**

`withInputLabels` puts the label on each edge arriving at a node that more than one
non-branch edge arrives at. That is deliberately the *local* rule, not the compiler's:
what an edge carries, and what it is called, is a property of the edge and is true
whether or not the consuming step concatenates. The one thing the two must agree on is the
**name**, and that is `inputLabelOf`, which both call.

The two therefore differ in one visible place, and it is accepted rather than overlooked:
at a **conditional's convergence point** the umbrella emits no fan-in prose (only one
branch runs, so only one result arrives) while the canvas labels both arriving edges. Each
label is still true — whichever branch was taken, that is what its edge carried and what it
is called — and nothing on the canvas asserts the results are concatenated; the sentence
that would is the umbrella's, and the umbrella does not emit it.

Closing the gap costs more than it buys. The compiler's rule needs the plan, and this runs
on every canvas change: React Flow hands over a new `nodes` array per frame of a drag, and
a branching document's plan allocates a transitive closure — 8 MB at `MAX_WORKFLOW_NODES`.
A graph-sized allocation per frame is the frozen-window defect class this codebase treats
as a bug (ADR-0003), spent to remove two labels that are not wrong. Memoising the plan
behind a structural signature was considered and rejected too: the signature is itself an
O(nodes) pass per render and adds a second notion of "has the graph changed?" to App. The
divergence is pinned by a test in `react-flow-adapter.test.ts` so that it stays a decision
and cannot drift into an accident.

## Consequences

- The document format is at v5 (jointly with ADR-0004). A v4 document carries no
  `inputLabel`, so it opens unchanged.
- `documentToFlow` carries an author's `inputLabel` through the canvas in the edge's
  `data`, and `flowToDocument` writes it back: derived labels are shown, given labels are
  persisted, and a round trip through the canvas cannot lose one.
- A plain fan-out is now a legal shape anywhere, bounded by `MAX_FAN_OUT` (64, the same
  number and the same reasoning as the branch ceiling) — which is also what keeps the
  edge count of an accepted document bounded now that any node may split.
- There is **no edge inspector**. An edge's label is the source node's unless the
  document says otherwise, which covers every fan-in a user can draw on the canvas today;
  an explicit label is readable, writable and validated, and the UI for typing one can
  land with the first workflow that needs two edges out of one node into another.
- The compiler's fan-in prose is emitted only where a fan-in exists, so every earlier
  golden file is byte-identical.

## Alternatives considered

- **Label the ports of the consuming node** instead of the edges. Rejected: it puts the
  name a hop away from the thing it names, and every consumer would have to reconstruct
  the edge→label association the field states — the same argument ADR-0003 made about
  branches.
- **Require an explicit label on every fan-in edge.** Rejected: the node labels already
  say it, and a required field that repeats what is on screen is a field people fill with
  `a` and `b`.
- **Merge the results into one context and let the step sort it out.** Rejected: that is
  precisely the failure mode — two results with no boundary between them read as one, and
  the step's instruction cannot refer to either.
- **A `Merge` node type** that owns the concatenation. Rejected: it doubles the node count
  for a shape the edges already express, and it would make "what does this step read?" a
  question about two nodes.
- **Give a plain split its own `FlowSegment` kind**, mirroring branches. Rejected: a
  segment kind exists so a consumer can tell alternatives apart from sequence, and every
  path of a split *is* sequence. It would add a case to every walk for no reader-visible
  difference.
- **Decide the canvas's labels from the plan**, so the canvas and the compiler answer the
  identical question. Rejected on cost — see decision 5 — and because the two questions
  are genuinely different.
