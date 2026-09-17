# ADR-0006: A loop is a Conditional that leads back, and the scaffold counts its passes

- **Status:** Accepted
- **Date:** 2026-09-17
- **Context:** Graph Document, Workflow Order, Graph Compiler, canvas, dock

## Context

Every slice so far refused a cycle. `validateGraph` said "Graph contains a cycle through
'x'" and meant it: the walk that produces the plan would have instructed the same step
twice, the topological order the convergence rule depends on would have been incomplete,
and the exported umbrella would have described a workflow with no end.

But "revise until it is good enough" is the shape half of real workflows have, and prose
cannot bound it. A model told to "go back to step 1 if the draft needs work" has no way to
count how many times it already has, and the one thing a workflow must never do is run
forever while claiming to be a workflow.

Slice 6 adds the loop. Four questions follow.

1. **What, structurally, is a loop** — which edge closes it, and what is the difference
   between a loop and the cycle that is still refused?
2. **What bounds it**, and who enforces the bound?
3. **What happens to the step a loop returns to**, given a fan-in at the same step
   concatenates?
4. **How does the plan stay finite** without losing the loop?

## Decision

**1. A loop is a branch of a `Conditional` that arrives where the walk already is.**

`loopBacks(doc)` is the one definition, in `workflow-order`: an edge is a **loop-back**
when it leaves a `conditional` on one of its branches *and* its target is on the
depth-first path being walked when the edge is reached. The `conditional` it leaves is the
**loop gate**.

The test is "already inside", which is exactly the condition under which walking the edge
would instruct a step a second time. Two cheaper rules were tried and are wrong:

- *points backwards* is a fact about the node list, and a document's node order is not
  something the user maintains;
- *sits on a cycle* — both endpoints in one strongly connected component — also catches the
  branch that **enters** the loop from outside. In `assess -> gate`, `gate --b--> B`,
  `B -> assess`, all three nodes are one component, so that rule called `gate --b--> B` the
  loop-back, dropped it from the walk, and left `B` unreachable: a step the user drew,
  silently outside their own workflow.

The search runs from the Input and then over anything it did not reach, taking nodes and
edges in document order, so the answer is a function of the document rather than of
iteration accident — the same determinism `topologicalIndex` and the walk's "first edge
wins" already rest on. Where a cycle carries two gate branches that could each be read as
its loop-back, the one the search meets with its start still on the path is the one. That is
a **tie-break, not a judgement**: the same document always classifies the same way, and
entering the same two gates by a different edge is a different document — a different
workflow, with the guard on a different gate — rather than one workflow with two readings.

**A cycle no gate closes is still refused**, with an error that now says what the way out
is: a loop must pass through a `Conditional` whose branch leads back, because that is the
only place a bound can live and the only place the workflow can ask whether to stop.

**2. The guard is on the gate, and the exported scaffold counts.**

`ConditionalData` gains `maxIterations?: number`, read through `loopGuardOf` — which is
also where the range check lives, because a guard out of range is not a bigger or smaller
bound, it is *no* bound, and every surface has to agree about that. The range is
1..999999999: at least one pass, and at most what `MAX_RULE_NUMBER_DIGITS` allows, since
the count is compared by a shell and ADR-0004's reasoning about nine digits is unchanged.

`validateGraph` asks for a guard **exactly when a branch of that node loops back**, naming
the node and the edge. A guard on a conditional that does not loop is kept and ignored, the
way an ignored `rule` is: rerouting an edge to look at the graph without its loop must not
cost the user the bound they chose. A loop gate must also offer exactly two branches, one
of which leaves — the scaffold prints one label when the passes run out, so there has to be
exactly one branch for it to print.

The scaffold gains two subcommands (ADR-0004's shape, extended):

- `loop <branch point> [measured value]` counts this pass and answers;
- `reset` puts every count back to zero, which is what starts a run.

**A pass is claimed, not counted.** The obvious counter — read the number back, compare it,
write it out again — fails open twice, and both were found by attacking the first
implementation of this slice rather than by reasoning about it. It *trusts what it reads*,
so whoever can write the state directory sets the bound: a file holding `-999999999` passed
the emitted range check (which accepts a sign, correctly, because a rule's operand may be
negative) and then bought a billion passes, each one printing "another pass is allowed". And
it is *three steps*, so two invocations sharing one state directory interleave them, both
read the same number and both are told the budget is unspent.

So pass *n* of a loop is the **name** `loop-<point>-pass-<n>` under the state directory,
taken with `mkdir`. The pass an invocation is on is the first name it managed to take.
Nothing is parsed, so nothing hand-written can be believed; and there is no lock, so a run
killed mid-pass leaves nothing held that a later run would have to decide whether to break.

**`mkdir`, and not a redirection under `set -C`.** Noclobber was the first answer here and
it was the wrong one: it is an exclusive create for *regular* files and for nothing else,
which attacking it showed costs the whole guarantee twice over. A character device left at a
pass's name (`ln -s /dev/null …` is enough, no privileges needed) was happily written, so
the same pass was claimed again on every invocation — the loop ran forever while the gate
went on affirming a bound that no longer existed, fail-*open* and silent. A FIFO at that
name was *opened*, and the open blocked for a reader that never came, hanging the bundle.
Making a directory has neither failure: it is atomic, it fails when the name is taken
whatever kind of thing has taken it, and it opens nothing, so it cannot block. The claim is
still its own record, so there is still no lock to leak — which is what ruled a `mkdir`
*mutex* out and leaves a `mkdir` *claim* in.

That makes three outcomes, and each is answered rather than assumed. A claim that succeeds
is this invocation's pass. A claim that fails on a name that is a directory this script made
— a directory, and not a symlink to one — is a pass somebody already holds, so the next one
is tried. Anything else is exit **6**: a name that does not exist at all means the bundle
cannot record a pass here (unasked, an unwritable state directory would read as "every pass
is spent" — bounded, but silently uncounted), and a name wearing something that is not a
pass means this loop can no longer be counted at all. Both are loud, because a loop whose
passes nobody counts is not a slow workflow, it is an unbounded one.

`loop` therefore **saturates** by construction: past the last pass there is nothing left to
take, so a loop that has been stopped stays stopped however many times it is asked. The
claims live in a directory beside the script (`PATCHWORK_LOOP_STATE` moves it), because a
shell remembers nothing between the invocations that make up one run, and a human can count
them. `reset` removes them one name at a time rather than in one glob, because a run of many
thousands of passes would otherwise be un-resettable — the whole glob being an argument list
too long to pass to a command — and it clears a broken symlink too, which is a name that
exists while `-e` says it does not.

Everything that can refuse is asked **before** anything is claimed: the arity of the command
and, for a rule-decided gate, the rule itself. A refused command must not cost a pass, since
the umbrella's answer to a refusal is to measure again and run the same command as written —
advice that would otherwise spend the budget of the reader who followed it.

**The guard overrules the decision, never the other way round.** A loop gate may be
LLM-decided or rule-based, and in both cases the count is asked first. A rule that would
loop forever is still stopped, and it is stopped by the scaffold rather than by the rule
changing its mind.

**And "nothing" is an answer, in exactly one place.** For an LLM-decided gate with passes
left, `loop` prints *nothing* on standard output and exits 0, with a note on standard error
saying which pass this is. That is what lets a loop be judged by the model and bounded by
the script at the same time: the scaffold never has to say "go round again", only "you may
not". The umbrella states it beside the refusal table rather than inside it — a non-zero
exit is still never a branch.

**3. A loop-back replaces; a fan-in concatenates.**

This is the distinction ADR-0005 decision 4 wrote down and deferred, and it is now
realised at both ends. `fanInInputs` excludes a loop-back twice over — it is a branch edge,
and it arrives from later in the plan — so the step a loop returns to is never described as
having two inputs. What it is told instead, in its own step, is:

> **Loop input — replaced on every pass.** A branch point further down can send the
> workflow back to this step to run it again. On every pass after the first, what this step
> works on is the result that came back, which **replaces** what it worked on before: do
> not merge the passes, do not carry the earlier result forward, and do not report on both.

Three prohibitions, for the reason the fan-in sentence gives three: the default reading of
"here is the earlier draft and here is the new one" is to keep both. A step that is *both*
a fan-in and a loop target gets both sentences, in that order — what arrives on the first
pass, then what happens to it on the next.

The sentence does **not** name the branch point by number. Branch points are numbered as
they are opened by `renderSteps`, which reaches the gate *after* this line is written, and
numbering them twice is precisely the second traversal ADR-0004 refused for `route`.

**4. A loop-back is planned, not walked.**

`planWorkflow` builds its adjacency **without** the loop-backs. Every traversal below that
is therefore a DAG traversal again — the walk terminates, the topological order is total,
and the transitive closure (which a cycle would fill wrongly) is available — while nothing
is lost: the branch that loops carries `loopBackTo`, the node the next pass restarts at.

A looping branch has no segments of its own, deliberately. Its steps are the ones already
planned between its target and its gate, and planning them again is the "reached more than
once" problem, i.e. the reading in which a loop is a defect. The umbrella renders such a
branch as "go back to step 1 and run the loop again from there", naming the step by the
same name every other "continue at" uses.

**Unless nothing bounds it.** `compile` is total, so it also renders documents
`validateGraph` refuses — and a gate with no usable guard is one of them, compiled into a
bundle with no scaffold to count against. Rendering the way back as an instruction there
would make the Graph Compiler the author of an unbounded loop, with the caller's memory to
run `validateGraph` first as the only thing between that bundle and a reader. So the branch
is still drawn and is drawn as a refusal: it names where it leads back to, says that no
maximum was set, and tells the reader not to take it and to stop and report the workflow.
The step it would have gone back to is not told it is a loop target either — the two halves
of one umbrella must not disagree about the same edge, one calling it a pass that replaces
what came before and the other saying never to take it.

Because the walk is acyclic again, **every plan-derived check now runs on a looping
document** — convergence, nesting depth, the fan-in ambiguity check — where before a single
cycle skipped all of them.

The naive reference planner in `workflow-order.test.ts` gained the same rule, so the
differential corpora (300 documents "full of backward edges" per seed) check the optimised
planner against the rule as written on cyclic shapes too. That is the arrangement ADR-0003
set up and ADR-0005 extended.

**5. The guard is shown where the workflow is read, and offered where a node is edited.**

The canvas node says `loops at most 3 passes` whenever a usable guard is set — through
`loopGuardOf`, so the canvas can never show a bound the validator refuses as though it were
one. The dock offers the field on **every** conditional rather than only on gates: whether
a node is a gate depends on where an edge goes, the dock sees one node, and a field that
appeared and disappeared as the user wires the canvas is a field they cannot find. It says
when it is used, and it starts **empty** — a guard nobody chose is the thing this slice
exists to prevent, so the absence has to be expressible and has to be the starting state.

## Consequences

- The document format is at v6. A v5 document opens unchanged: no v5 document carries a
  guard, because no v5 document could contain a cycle at all. `schema-v5.patchwork` is the
  migration fixture.
- `validateGraph` no longer refuses every cycle. It refuses a cycle no gate closes, a gate
  with no usable guard, a gate whose every branch loops back, and a gate that does not
  decide between exactly two things.
- A non-numeric `maxIterations` is refused at **load**, like an unknown mode or operator: a
  value the emitter would render into generated shell has to be the type it claims.
- The bundle now carries state. A scaffold is emitted for a loop even when nothing is
  rule-based, since the counting *is* the deterministic part; a bundle with neither a rule
  nor a loop is byte-identical to the previous slice's, which the unchanged golden files
  are the check on.
- The scaffold's promise is still a *statement*: nothing forces a reader to run `loop` at
  all, exactly as nothing forces it to follow `plan` (ADR-0004). What is bought is that the
  bound has one authoritative source, that it is the same on every run, and that a reader
  which asks gets an answer it cannot argue with.
- `reset` is a second thing to run before the first step, and a run that skips it starts
  with the previous run's passes spent. The umbrella says so in its opening lines.
- **The guarantee is "at most `max` passes per `reset`", not "per workflow run"**, and the
  umbrella now says exactly that. Nothing stops a reader from running `reset` again
  mid-workflow and refilling the budget — the party being bounded holds the button. That is
  the same statement-not-enforcement limit the bullet above describes (a reader can decline
  to run `loop` at all), and it is why "Have `plan` reset the counts" is rejected below: the
  refill must be a thing someone *chose* to do, never a side effect of being careful.
- **Nested loops share one budget.** Each gate counts its own passes, and an outer loop
  going round again does not clear the inner gate's claims — so an inner loop guarded at 3
  runs at most 3 passes across the whole run, not 3 per outer pass. That is surprising, and
  it is kept: the alternative is an inner bound that multiplies with an outer one, which is
  a number nobody wrote anywhere. It fails closed, `reset` is the only thing in the scaffold
  that refills,
  and the umbrella's sentence about `reset` is what says so.
- Nothing in an exported bundle reads a *number* back out of its own state. Passes are
  claimed by name; a hand-written state directory can cost a loop passes, make it refuse to
  count at all, and never buy it one.
- **The exclusivity is the filesystem's.** `mkdir` is atomic where the filesystem says it
  is; on one that does not honour that (old NFS without `O_EXCL` support, FAT), two racers
  could hold the same pass. Every filesystem a bundle is realistically read from does honour
  it, and there is nothing a shell script can do about one that does not except be honest
  that the guarantee is inherited rather than provided.
- **A large guard is a performance anti-pattern.** The claim loop is a scan from pass 1, so
  the *n*-th pass costs *n* attempts and a whole run costs their sum. That is self-limiting
  only in the sense that reaching pass *n* takes *n* real passes of a model, which dominate
  it utterly (measured: 0.09 s of scaffold at pass 100, 3.1 s at pass 5 000, 67.6 s at pass
  100 000). It bounds the *per-call* cost, not the cumulative one — guards are meant to be
  small numbers, and a four-figure one will be felt.

## Alternatives considered

- **Let the model count** — pass the pass number to the scaffold and have it range-check.
  Rejected: the counting is the guarantee. A bound checked against a number the bounded
  party supplies is not a bound.
- **A `Loop` node type** owning the body and the guard. Rejected for the reason ADR-0004
  rejected a `RuleConditional`: the gate is a decision between going round and going on,
  which is what a `Conditional` is, and a new node type would need its own branches,
  wiring, convergence and prose. It would also make "where does this loop end?" a question
  about two nodes instead of about an edge the user drew.
- **Mark the loop-back on the edge** (`loopBack: true`) instead of deriving it. Rejected:
  it is derivable from the graph exactly and cheaply, and a stored flag is a second source
  of truth that a re-wired edge would leave stale — the same argument ADR-0005 made against
  a canvas copy of the fan-in rule.
- **Unroll the loop in the umbrella**, writing the body out `max` times. Rejected: the file
  grows with the guard, a guard of 50 is unreadable, and the steps stop corresponding to the
  nodes the user drew.
- **Count in an environment variable or in the transcript.** Rejected: neither survives
  between Bash invocations, which is the only place the count can be asked for.
- **Have `plan` reset the counts**, so there is one command to run rather than two.
  Tempting, and rejected: a reader that re-runs `plan` mid-workflow to re-check the order —
  which the umbrella positively encourages — would silently refill the budget, turning the
  bound off at exactly the moment someone was being careful.
- **Let the scaffold say "go round again"** rather than staying silent. Rejected for an
  LLM-decided gate: the scaffold cannot know whether the work is done, so a label from it
  would be a decision it did not make. Silence says precisely what it knows — that the
  budget is not spent.
- **Warn when a node's prose mentions `control.sh reset`.** An author can write "run
  `bash scripts/control.sh reset`, then …" into a prompt node, which is rendered verbatim
  and refills the budget on every pass. Rejected as a validation rule: it is the author
  bounding the author, the umbrella contradicts the instruction three lines above it ("do
  not run it again"), and a check on prose is a string match that would refuse legitimate
  workflows — one that *documents* the bundle's own commands, say — while missing every
  spelling it did not anticipate. The guard is a promise to the workflow's reader about the
  model, not a promise to the author about themselves.
- **A default guard** (say 10) on every conditional. Rejected: a loop bounded by a number
  nobody chose is a workflow whose length is an accident of the tool, and the failure it
  prevents — an unbounded loop — is better reported than papered over.
