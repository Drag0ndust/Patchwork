# ADR-0003: A branch belongs to the edge that leaves the conditional, and branching lives in the umbrella's prose

- **Status:** Accepted
- **Date:** 2026-07-30
- **Context:** Graph Document, Workflow Order, Graph Compiler, canvas

## Context

Until now a workflow was a chain: `validateGraph` refused anything with a fan-out or
a fan-in, and the compiler's ordering was a single walk from Input to Output. Slice 4
adds a `Conditional` node with **LLM-based** branching — the user names a decision
question and labels the ways out, wires each label to a different downstream path, and
the exported umbrella asks the executing model to pick one at run time.

That raises four questions the linear slices never had to answer.

1. **Where does a branch label live** — on the node as a port, or on the edge?
2. **What is the ordering**, now that "the next node" is not a single node?
3. **What makes an exported workflow actually branch**, given there is still no
   control scaffold — the umbrella's prose is the whole program.
4. **What is a well-formed branching graph**, i.e. what must `validateGraph` refuse
   so that the prose the compiler emits is always followable?

Rule-based conditionals, the deterministic Bash control scaffold, loops and their
iteration guards are explicitly *not* in this slice; the decisions below are made so
they can be added without a second schema.

## Decision

**1. The branch is a field on the edge, keyed by a stable branch id; the node owns
the label, and nothing joins the two into one key.**

`GraphEdge` gains `branch?: string`, present exactly on the edges leaving a
`conditional` node, and holding a `Branch.id` declared on that node
(`{ id, label }`). The canvas realizes it as one **source handle per branch**, so a
connection out of a conditional cannot exist without naming a branch — but the handle
is a *rendering* of the field, not a second source of truth.

Why the edge rather than a port-only model: the edge is the thing the user draws and
the thing the traversal follows, so putting the branch there means one lookup answers
"which way does this path leave?" for both the compiler and validation. A ports-only
model would have to reconstruct the association from handle ids at every read anyway —
which is precisely what the field records.

Why an **id** and not the label itself: renaming a branch is an ordinary edit. Keying
edges by the label would make every rename either orphan the wiring or require a
cascade through the edge list, and a half-applied cascade is a silently mis-wired
workflow. With ids, the label is free to change and the canvas re-labels its edges
from the node (`withBranchLabels`) — derived state, never persisted, so a saved
document cannot hold a label that disagrees with its node's.

A branch is therefore identified by a *pair*, and the pair is never flattened into a
key. Validation counts wired edges in a map of maps, and the canvas resolves labels the
same way, because a branch id is an arbitrary string in a hand-edited document: node `n1`
with branch `x y` and node `n1 x` with branch `y` join to the same `"n1 x y"` under any
delimiter. That collision let an unwired branch borrow another node's wiring —
exporting a choice that leads nowhere, defeating the rule in decision 5 —
and, the same collision the other way round, made two correctly wired branches read as one
branch wired twice.

The cost is accepted deliberately: **deleting** a branch deletes the path it named, so
its edges go with it (`keepConnectedEdges`). React Flow cannot draw an edge whose source
handle is absent, so keeping such an edge would leave something in the document that is
invisible on the canvas. The same pruning applies when a *hand-edited* document names a
branch the node does not offer: the edge is dropped rather than reported, and what
remains — a branch wired to nothing — is what validation reports and the canvas shows.

**2. The mode is a discriminated field from the start, defaulting to `llm`.**

`ConditionalData.mode` is `"llm"` and nothing else today, read through
`conditionalModeOf` and validated as "absent, or a known value" — the same shape
`exportMode` has (ADR-0002). Rule-based branching is then an added variant with its own
per-branch data, not a second node type and not a schema break. Absent means `llm`, so
a hand-written document need not spell out the only mode there is.

**3. Ordering becomes a plan, and there is exactly one of them.**

`src/domain/workflow-order.ts` replaces the compiler's private chain walk with
`planWorkflow(doc)`: a list of segments where a branch is itself a segment holding one
sub-list per labelled branch. A branch's sub-list ends at the node where **all**
branches of that conditional converge, which is the earliest node in topological order
that every branch reaches. The convergence point belongs to the enclosing sequence, not
to any branch — it runs whichever branch was taken.

The plan is shared, not duplicated: the compiler renders it, and `validateGraph` asks
it whether the graph can be followed at all. A second, independent notion of "a
well-formed branch" is exactly the kind of thing that drifts from what the compiler
actually emits.

It is **total and iterative**. Total, because it must not fail on a hand-edited document:
an unwired branch plans as a choice with no steps, an unreachable node is appended rather than
dropped, a cycle terminates with a reported problem. Iterative — **every** traversal,
`plannedNodes` and `nestingDepth` included, and the step renderer too — because nesting is
whatever the user drew and neither `validateGraph` nor an export may die of a `RangeError`. That
is not hypothetical: while `plannedNodes` was still recursive, a *valid* workflow nested a few
thousand levels deep ended an export with `RangeError: Maximum call stack size exceeded`, through
`compile` and through `vendorErrors` (the export's own precondition check), after a ten-second
freeze. Nothing here may use recursion, or `push(...items)`, over graph-sized data.

**`compile`, however, is not total on an arbitrary document, and the plan cannot make it so.**
The umbrella indents every line of a branch one level further, so a document nested thousands
deep renders a string longer than the runtime can hold — `RangeError: Invalid string
length` — however the plan is walked. The guarantee is therefore the narrower one, and it
is written where a caller will read it: *a document `validateGraph` accepts compiles*. That is
what the two size bounds are for, that is why the export path validates first, and the corners of
that envelope — the most nodes and the deepest nesting the bounds allow — are pinned
by tests. Anyone calling `compile` on a document they have not validated is outside the promise.

**Convergence is looked up, not swept, and the two spellings are checked against each
other.** The definition is unchanged, but asking it by intersecting a fresh reachability
sweep per branch head per conditional is quadratic: 6,000 two-branch conditionals took 8.8 s
to plan, and an export plans three times (`validateGraph`, `vendorErrors`, `compile`) on the
main thread — the frozen-window defect class `collapseLineBreakRuns` already
documents. The plan now builds one `ConvergenceIndex` per document: a topological order plus
a transitive closure held as one bit per node pair (`n²/8` bytes), and finds the
convergence point by scanning topological order from the last branch head, stopping at the
first candidate every head reaches. Same answer; about 110 ms for the whole export path at
10,000 nodes instead of about 10 s.

The "from the last branch head" shortcut is valid **only in an acyclic document**, and it is
skipped otherwise. A node on a cycle has no topological position, so `topologicalIndex` parks
it after every sorted node; a node every head reaches can then sit *before* the last head, and
the scan would walk past it and answer something the rule does not say. `validateGraph` refuses
a cycle, so nothing user-visible depended on it — but loops are a planned slice, and a
rule that holds only on currently-legal input is not the rule as written.

Both of those claims are checked rather than asserted. `workflow-order.test.ts` carries a
**naive reference plan** — reachability by sweeping, convergence by intersecting the
heads' reachable sets and taking the topologically earliest, the walk by plain recursion —
and runs the optimised planner against it over seeded corpora of generated documents. The corpora
are chosen for the paths they reach, and each property is asserted inside the test so it cannot
lapse: some are **acyclic by construction**, which is the only way to reach the transitive
closure at all (one cycle sends the whole plan down the sweep fallback, so a corpus of mostly
cyclic documents silently tests one implementation twice), and some are **wider than 32 nodes**,
which is where the closure's word arithmetic begins to exist. The same corpora are planned again
with the closure ceiling lowered to zero, which is the only way to reach the size fallback
without building the 16,000-node document where it really begins. Both checks fail against the
pre-fix shortcut, and the wide acyclic corpus is what kills a wrong word index — by a
wrong *answer* rather than by a slow one.

Above `MAX_CLOSURE_BYTES` (32 MB, roughly 16,000 nodes), or for a cyclic document, the closure
is skipped and reachability is swept per conditional: correctness kept and speed given up,
rather than an allocation that might fail. `MAX_WORKFLOW_NODES` is set so a document
`validateGraph` accepts never lands there.

**4. Branching is prose, and the prose is the specification.**

There is still no control scaffold: what makes an exported workflow branch is the
umbrella's wording, so it is pinned by a golden file and asserted line for line. Each
part of it earns its place against how a model reads a numbered list with no other
context:

- the workflow's intro says, once and up front, that the workflow branches and how a
  branch step is to be taken — a numbered list reads as "do all of these" otherwise.
  It is emitted **only** for a document that has a conditional, so a linear workflow's
  umbrella is byte-identical to the previous slice's;
- the branch step names the decision (`Decide, from the work so far: <question>`),
  requires exactly **one** branch, asks the model to **state** which it chose and why,
  tells it to **ignore** the other branches, and says where to continue afterwards;
- each branch bullet repeats the continuation, because a reader that jumps to the
  branch it chose must not have to read the branch step again to find its way back;
- **branch points are numbered across the whole umbrella**, and a continuation inside a
  branch names the point as well as the branch (`continue at step 2 of branch point 1,
  branch `with trace``); the outermost list continues into
  `## Output`.

  The number is not decoration. "Step 2" alone would also name a step of the main
  sequence — but worse, *two nested branches may carry the same label*:
  `yes`/`no` at every level is what the toolbar mints and what a user naturally draws, so
  a reference by bare label sent a reader inside the inner branch `yes` back to **its
  own** step 2 (redoing a step, never reaching the merge), and sent the inner branch `no`
  into a step of the other branch entirely. The fix belongs in the reference, not in a
  global label-uniqueness rule imposed on the user: labels must be distinguishable
  *within one conditional* and may repeat freely between them. Numbering also keeps a
  reference the same length at any depth, where a path-shaped reference ("branch `yes` of
  step 1 of branch `yes` ...") would grow with the nesting, on every line.

Every user-supplied value in that prose goes through the existing sanitizers: the
question through `sanitizeInline`, a branch label through a code-span escaper that strips
backticks (`branchSpanText`) — the same boundary against a hand-edited
document that `artifactSpanText` is, for the same reason.

`sanitizeInline`'s line-collapse covers **every character that ends a line for something
that splits lines**: `LF`, `CR`, `VT`, `FF`, `FS`, `GS`, `RS`, `NEL`, `LS`, `PS` — the ten
Python's `str.splitlines()` breaks on. Strict CommonMark ends a line at `LF`/`CR` only, so the
other eight cannot open a block in a *parser*; but the reader of an exported umbrella is a model
whose tokenizer is closer to `splitlines` than to CommonMark, and a run of one of them is exactly
how a hostile `question` tried to grow the umbrella an extra branch bullet. Naming only `LF`/`CR`
(and later only some of the rest) left `FS`/`GS`/`RS` passing through verbatim, which is the kind
of gap a comment claiming "every character" invites. `\s` matches neither `U+0085` nor
`FS`/`GS`/`RS`, so those are named in the run pattern as well as in the class.

The **question** carries no charset or length rule, deliberately, unlike a branch label. It is
prose — the same kind of field as a `Prompt` instruction or the workflow description,
neither of which is constrained — written in whatever language and punctuation the decision
needs, and `sanitizeInline` is lossless for prose. A label is the opposite: an identifier the
model must quote back inside a code span, which is why it alone is constrained.

**Because the question is prose, the branch step surrounds it.** Numbering the branch points
made `continue at step K of branch point P, branch \`L\`` a load-bearing sentence, and the
question shares the vocabulary it is written in: rendered first, a question could open with its
own `Whichever branch you take, ...` naming a *sibling* branch, and a reader would meet the
forged clause before the real one — the hijack decision 4 exists to prevent,
re-achievable by whoever authors the document. A branch label cannot reach that vocabulary (the
comma and the backticks a reference needs are outside `BRANCH_LABEL_PATTERN`), but a question
can. So the question is given neither position of influence:

- **not first.** Everything that frames the choice — follow exactly one, say which,
  ignore the others — is stated before it.
- **not last.** The continuation is stated after it. Recency is a position too, and the first
  attempt at this fix moved the question to the *end* of the line, which handed a forged
  instruction the last word instead of the first.
- **inside a quoted region it cannot leave**, introduced as the author's text with the explicit
  note that an instruction inside the quotes is not the reader's to follow. The delimiters are
  the asymmetric pair `“`/`”`, and `questionText` folds both to a straight
  `"` inside the question. Straight quotes were the first attempt and were defeated by one
  character: a `"` in the question ended the quoted region, so the rest of it sat *outside* the
  quotes, where the umbrella's own convention says the compiler is speaking. Folding costs the
  field the two curly quotes and nothing else; escaping the delimiter would have worked too, but
  the reader here is a model rather than a Markdown parser, and `\”` still looks like
  a closing quote in the raw bytes.

This is mitigation, not elimination: whoever writes the `.patchwork` writes the workflow. What a
question can no longer do is precede the instructions it would contradict, outrank them by
recency, or appear to be in the compiler's voice. Constraining the field was considered and
rejected: a decision question is written in whatever words the decision needs.

**5. A conditional's edges and its branches must correspond exactly, and every node
must lead somewhere.**

`validateGraph` refuses: fewer than two branches; a blank, over-long, unsafely
charactered, or (case-insensitively) duplicated label; an empty decision question; an
edge leaving a conditional without a branch or on a branch the node does not offer; a
branch wired twice; a branch **not wired at all**; a branch on an edge leaving anything
that is not a conditional; and a fan-out anywhere but a conditional.

An unwired branch is rejected rather than read as "a branch that just continues": the
umbrella would offer a choice with nothing to do and nowhere to go, which is the one
failure an LLM cannot recover from at run time. A branch that should simply carry on is
wired straight to the convergence point, which says the same thing and is visible.

Three bounds, and each one closes a cost that grows faster than the graph: nesting at
`MAX_BRANCH_NESTING_DEPTH` (32), document size at `MAX_WORKFLOW_NODES` (8,192), and **width at
`MAX_BRANCHES_PER_CONDITIONAL` (64)**.

Nesting, because the umbrella indents every line of a branch one level further, so its size
grows with the *square* of the depth (5,000 nested levels produced a 63 MB `SKILL.md`, built on
the renderer's main thread), and the reader has to hold one open choice per level —
2^depth combinations. 32 is far past anything a person composes; the error says to converge a
branch before opening the next one.

Size, checked **before the document is planned** while the depth bound is checked after —
that order is the whole point of having a size bound. Every later cost is a function of the node
count (the plan, the closure, the umbrella, the IPC that carries the bundle), and a 20,002-node
document used to take 22.8 s to validate and 21.9 s to compile *before* anything refused it,
because the refusal was computed from the very plan it should have avoided. 8,192 also keeps the
closure at 8 MB, comfortably inside the ceiling past which reachability degrades to sweeping, so
an accepted document is always on the fast path. An over-large document is refused with one
reason rather than two: it is never walked, so nothing is reported about its nesting.

Width, because none of the other bounds touch it: a **four-node** document — Input,
Conditional, Prompt, Output — with 200,000 branches wired to one next node satisfied
every rule there was. It froze `validateGraph` for 67 s (a per-edge linear scan of the branch
list, now a `Set` built once per node, so the check is linear again), it froze a real browser for
10.8 s *on load* (the canvas draws one source handle per branch, and React Flow was handed an
edge per branch), and it exported a 26 MB umbrella without an error. A branch is a choice made
by reading the alternatives, and that stops being a decision long before 64 of them —
the same reasoning as a 64-character label. Together with the node bound it also finally bounds
the **edge** count of an accepted document, since every non-conditional node has at most one way
out.

**Where the width bound is enforced, and where it deliberately is not.** The first version of
this decision refused an over-wide document in `assertNodeShape`, i.e. at **load**, on the
argument that it is the same category that function already rejects: what the canvas cannot be
asked to draw. That argument was wrong, and this is the correction. An unknown node type has no
renderer and a non-finite position breaks layout arithmetic — neither can be drawn at all.
200,000 branches *can* be drawn, just slowly: a performance defect, not a structural
impossibility. Refusing them at load turned a file that used to open into a file that could
never be opened, whose only repair was hand-editing JSON to delete branches *and* the edges
referencing them. Closing a freeze by making the document unrecoverable is a worse trade than
the freeze.

The pattern this now follows is the one an **unresolved artifact reference** has used since slice
2, one file away: the document opens, the node renders *flagged*, it stays editable, and the
**export** is refused. Concretely, for width:

- `deserialize` bounds nothing and truncates nothing — every branch a document holds
  survives a round trip through the canvas, so opening an over-wide workflow and saving it cannot
  delete branches the user did not choose to delete.
- What the canvas **draws** is bounded instead: `ConditionalNode` renders at most
  `MAX_BRANCHES_PER_CONDITIONAL` handles and says how many it left out, and `drawableEdges` hides
  the edges of branches it did not draw, because React Flow cannot place an edge whose handle is
  absent. Both are *rendering* filters composed into what the canvas is given, never into the
  canvas state that a save writes. Measured in the browser the freeze was found in: a
  20,000-branch document went from **10,812 ms** to load and render to **164 ms**.

  **What withholding those edges cost, and what it taught.** This decision first claimed the
  filter "loses nothing, because `flowToDocument` still sees every edge". That was true of
  *saving* and false of *deleting*, which nobody had asked about: React Flow works out which
  edges a deleted node owns from the `edges` prop it was **given**, so deleting an over-wide
  conditional took its 64 drawn edges and left the rest in state with a source that no longer
  existed — then wrote them to disk. One keystroke, on a node the app had just refused to export,
  silent, and unrepairable in the app, since nothing draws an edge whose source is missing and so
  nothing can select it. The lesson generalises past this bug: **a derived view handed to a
  library is also an input to that library's own semantics.** `withBranchLabels` adds
  information and is safe; `drawableEdges` withholds it, and everything the library infers from
  absence changes with it.

  The fix is the rule that makes withholding safe rather than a compensation for one keystroke:
  `keepConnectedEdges` (formerly `keepWiredBranches`) reconciles canvas state on every change to
  the nodes, dropping edges whose endpoints are gone as well as those whose branch is gone. It
  holds for any way a node leaves the canvas, not just the key that found it. The rejected
  alternative was to hand React Flow every edge with `hidden: true` on the undrawn ones: it
  removes the divergence at its source, but with `onlyRenderVisibleElements` off (the default)
  `useVisibleEdgeIds` returns *every* edge id and the `hidden` check happens **inside**
  `EdgeWrapper`, so a component is still mounted per edge — which is exactly the 10.8 s this
  bound exists to avoid.
- The dock editor shows the same bound (at most that many rows) and offers the repair the file
  system cannot: a button that removes exactly the excess, labelled with the number it removes.
  Which branches all three surfaces show is **one function** (`branchesWithinLimit`), not three
  slices that happen to agree: they did agree, but a drift in any one of them would have produced
  handles whose edges were filtered away, or dock rows the canvas does not show, with nothing
  failing.
- `validateGraph` keeps the hard "no", with a message naming the node and the way out. That is
  the boundary where an unexportable document belongs.

**And both branch bounds are stated, not merely enforced.** A disabled control that says nothing
is a defect of its own: the count and its ceiling sit in the field's label, the reason a control
is unavailable is on the control *and* in a `role="status"` line that appears only at a bound, and
the two-branch floor gets the same treatment as the 64-branch ceiling. A user who reaches a limit
learns what the limit is and what to do about it.

Two rules moved: the old "no fan-in" check is **gone**, because fan-in is now what
re-convergence looks like — and it cannot occur without a conditional, since every other
node is limited to one outgoing edge and reaching a merge twice in a fan-out-free graph
requires a cycle, which is still refused. In its place, every node except the Output node
must have an **outgoing edge**: in a chain, one Output plus connectivity already forced
that, but a branch can now end mid-air with every node still reachable.

## Consequences

- The document format is at v4. v1–v3 documents open unchanged: v3 → v4 only widens the
  vocabulary (a node type, an optional edge field), so no older document contains
  anything the new contracts reject.
- Branch labels are user-facing identifiers with a charset and a length bound
  (`MAX_BRANCH_LABEL_LENGTH`, borrowed from the artifact name segment rather than
  invented), because a label is quoted back by the model that picks it.
- Two branches wired to the *same* node is accepted and reads as two empty branches
  followed by that node: the decision is recorded in the transcript and both paths then
  do the same thing. It is a shape a user can draw, so it gets a defined meaning rather
  than an error.
- A conditional whose branches converge *past* an outer conditional's convergence point
  (a branch that skips a merge) is refused, naming the node that would otherwise be
  instructed twice. Nested conditionals are supported; crossing ones are not.
- The plan builds a transitive closure for any document that branches, so a branching
  graph costs memory the graph itself does not: `n^2/8` bytes, capped at 32 MB, past which
  it trades speed for memory instead. A chain pays nothing — the index is
  built lazily, only once a conditional is reached.
- Emitted size is linear in the number of steps for any nesting a person draws, and
  bounded overall by the nesting cap; without the cap it was quadratic in the depth, and
  5,000 levels produced a 63 MB umbrella.
- Nothing about **loops** is settled here. A cycle is still refused, and the "reached
  more than once" problem is how the plan reports one; a loop slice will have to give
  cycles a meaning in the plan and an iteration guard in the prose, and it will land in
  `workflow-order.ts` rather than beside a second traversal.

## Alternatives considered

- **Branch labels as node ports only, with no field on the edge.** Rejected: the branch
  of a path would exist only as a React Flow handle id, which makes the *document*
  dependent on a canvas library's edge model, and every consumer would have to
  re-derive the association the field states.
- **Key edges by the branch label.** Rejected: renaming a branch is an ordinary edit,
  and it would either break the wiring or need a cascade whose half-applied state is a
  mis-wired workflow.
- **A `Branch` node type per outgoing path** (conditional → branch → path). Rejected: it
  doubles the node count for no added expressiveness and puts the label a hop away from
  the decision that uses it.
- **Emit a deterministic control scaffold now** (a Bash script that evaluates the
  branch and invokes the right steps). Deferred by the slice, and the prose has to be
  self-sufficient regardless: an LLM-mode branch is decided by the model reading the
  umbrella, so the umbrella is where the decision has to be stated. The next slice can
  add the scaffold beside this prose without changing the schema.
- **Let a branch be unwired and mean "continue".** Rejected: see decision 5 — the
  emitted choice would have no steps and no continuation.
- **Compute convergence as "the immediate post-dominator" via a dominator algorithm.**
  Rejected as over-general for the shapes validation admits: the earliest common reachable
  node is the same answer for every graph that passes validation, and it is a rule a reader
  of `workflow-order.ts` can check by eye. It was also the tempting fix for the quadratic
  cost, and rejected there too — it changes the *answer* on irregular graphs, and the
  rule as written is now checked against a naive reference implementation on every run (see
  below), so the cost was fixed by memoising the question rather than by redefining it.
- **Require branch labels to be unique across the whole document**, so a bare label could
  name a list. Rejected: `yes`/`no` at every level is the normal case — it is
  what the toolbar mints — so this would refuse ordinary workflows to save
  the compiler a qualifier.
- **Reference a nested continuation by its path** ("branch `yes` of step 1 of branch `yes`
  ..."). Unambiguous, but the reference grows with the nesting depth and appears on every branch
  line, which is a second source of quadratic output.
- **Lead the bullet with the label** (`- **\`yes\`** (branch point 2) — do these steps...`),
  keeping the meaningful part first. Considered and **not** taken: what makes the numbering work
  for a reader that resolves references by matching strings is that the continuation
  (`... of branch point 2, branch \`yes\``) appears *verbatim* as the bullet's heading. Leading
  with the label would either break that identity or force the reference to carry Markdown, and
  the disambiguator is precisely the part that must not be buried. The label is still the last
  thing in the heading and the thing the reader chose by name.
- **Leave nesting unbounded.** Rejected: the umbrella's size is quadratic in the depth and
  the reader's job exponential in it, and both are reachable from a hand-edited or
  generated document. The bound is set where no real workflow can meet it.
