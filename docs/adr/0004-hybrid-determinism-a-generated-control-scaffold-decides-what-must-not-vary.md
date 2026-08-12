# ADR-0004: Hybrid determinism — a generated control scaffold decides what must not vary

- **Status:** Accepted
- **Date:** 2026-08-10
- **Context:** Graph Document, Graph Compiler, Bundle Emitter, canvas, dock

## Context

ADR-0003 made an exported workflow branch on prose alone: the umbrella states the
decision, and the executing model picks a branch. That is the right mechanism for a
decision that needs judgement, and the wrong one for a decision that does not. "Is the
diff longer than 100 lines?" has an answer that a shell can compute and a model can only
estimate, and a workflow whose routing changes between two identical runs is not a
workflow — it is a suggestion.

Slice 5 adds the other half. A `Conditional` node is now either **LLM-based** (ADR-0003,
unchanged) or **rule-based**, and a bundle that contains a rule-based conditional ships a
generated **control scaffold**: a POSIX shell script the umbrella invokes with the Bash
tool.

Four questions follow.

1. **What, exactly, is deterministic?** A model still has to read the work so far.
2. **Where does the boundary sit** between what the script decides and what the model does?
3. **When is a scaffold emitted**, and what does a bundle without one look like?
4. **How does the reader learn the contract**, given the umbrella is the whole program?

## Decision

**1. The model measures; the script decides.**

A `ConditionalRule` is `{ subject, operator, operand, whenTrue, whenFalse }`. The
`subject` is **prose** — the same kind of field as a `Prompt` instruction — because the
executing model is the only party that can read the work so far and produce a value from
it. Everything else is **data**: five operators (`equals`, `not-equals`, `contains`,
`greater-than`, `less-than`), a literal operand, and two `Branch.id`s.

That split is what "hybrid determinism" means here, and it is honest about its limits:
given the same measured value the routing is exact and repeatable; the measurement itself
is a model's reading and is not. The alternative — a rule that also *extracts* its own
value (a regular expression over the transcript, say) — was rejected because the extra
determinism is illusory: what it would run against is the model's output either way, and
a pattern language whose behaviour differs between `grep` implementations is exactly the
kind of "deterministic" that is not.

`whenTrue`/`whenFalse` are branch **ids**, for the reason an edge names a branch by id
(ADR-0003): renaming or reordering a branch is an ordinary edit and must not silently
invert a routing.

**2. The scaffold is a generated POSIX `sh` script with two subcommands, and nothing it
is given is ever interpreted.**

`scripts/control.sh` inside the bundle:

- `plan` prints the order the steps are followed in, so ordering is something the reader
  can *ask for* rather than something it must hold from reading prose;
- `route <branch point> <measured value>` prints the label of the one branch to follow.

Both are emitted from the **same pass** that renders the umbrella's steps
(`renderSteps`), because the branch-point number is the shared key: a second traversal
would be a second opportunity to disagree about which branch point is which, and that
disagreement would surface as a workflow routing to the wrong branch rather than as a
failure.

Every value taken from the document — operator, operand, both branch labels, every line
of the plan — is emitted **single-quoted**, with `'` rewritten as `'\''`. Between single
quotes a shell interprets nothing, so an operand of `'; rm -rf ~; echo '` is text the
script compares rather than a program it runs. A measured value arrives as a positional
argument and is compared with `[` or with a `case` pattern; it is never expanded, never
`eval`ed, and never used as a filename. This is pinned by a test that compiles a hostile
operand, runs the script, and asserts the comparison result.

Written for `/bin/sh`, not for bash: `case`, `[` and `printf` only, so the bundle behaves
the same wherever it lands. The umbrella still says `bash scripts/control.sh …`, because
the Bash tool is what a reading model has, and the file needs no execute bit that way.

**Both sides of an integer comparison are bounded to nine digits, and the bound is stated
as a digit count.** `[ -gt ]` compares with whatever integer type the shell has; POSIX
guarantees a signed long and the smallest conforming one is 32 bits, so ±2147483647 is the
widest range that means the same thing everywhere, and nine digits is the largest whole
number of digits inside it. Past that the failure is silent *and* shell-dependent: `[`
fails rather than answering, the failure is swallowed by the `if` that asks it, and what
comes out is a branch — measured on this machine, `route 1 99999999999999999999999` against
`greater-than 0` printed `no trace` under `sh`, `dash` and `bash` and `with trace` under
`ksh`, both with exit 0. The same bundle, the same input, opposite answers, no error.

So the operand is refused by `validateGraph` at authoring time (an unroutable bundle cannot
be exported) and the measured value is refused by the scaffold at run time, with the same
`die`-and-exit treatment a non-numeric value gets. The scaffold also re-checks its own
operand and exits 5 if it is out of range, which can only happen to a hand-edited script but
must be loud when it does. The check counts characters and never converts, because a range
check that did arithmetic would overflow the very type it is protecting. It is pinned by
tests that execute the generated script under every shell present on the machine — `sh`,
`dash`, `ksh`, `bash` — for the out-of-range value and for the digits either side of the
bound, because "runs identically wherever the bundle lands" is a claim about implementations
rather than about a standard.

**One normalization of the operand, called by everything that has an opinion about it.**
`comparedOperand(rule)` is the single place whitespace is decided, and `validateGraph`, the
compiler and the dock all call it — so the string the scaffold compares is *by construction*
the string the validator approved. The rule is operator-aware rather than a plain `trim`,
because the two kinds of comparison disagree about what padding means: for a numeric
comparison it is not part of a magnitude and goes, while for a string comparison it **is**
the data (`contains " x "` looks for a spaced `x`, and trimming it would silently change
what the workflow searches for). Emptiness is decided on the trimmed value either way.

This is a correction. The validator range-checked `operand.trim()` while the compiler
emitted the field verbatim, so a numeric rule written as `" 5"` validated `{ok: true}`,
compiled to `operand=' 5'`, and was then refused by the scaffold's own range gate on every
shell — a document the app called exportable producing a bundle that could not take that
branch, with no warning anywhere, because the dock's preview trimmed too. Three spellings of
one rule, disagreeing in the gap between them. The invariant that replaces them — **if
`validateGraph` says ok, the emitted scaffold routes** — is pinned by tests that *run* the
generated script over padded operands for every operator, because nothing that only inspects
the compiler's output can catch a disagreement about what the output should be.

**And because the operand's meaning depends on the operator, changing the operator
re-normalizes it.** `withOperator(rule, operator)` stores what was being compared *before*
the change, and the dock never assigns the field directly. Without it, one dropdown change
turned padding a numeric comparison had been ignoring into data a string comparison matched
on: `greater-than " 5"` (validated, unwarned, routing correctly — the app had just taught the
author that padding was harmless) became `equals " 5"`, still valid, still unwarned, and a
measured `5` then routed to the **false** branch at exit 0. That is the one failure the
refusal contract cannot catch, since it only engages on a non-zero exit, and the umbrella
carries neither the operator nor the operand, so the reading model cannot notice it either.

The normalization is confined to values that *have* an effective meaning. A numeric rule
whose operand is not a number compares nothing — `validateGraph` refuses it — so it has no
normalized form, and inventing one costs the user data: `contains " x "` switched to a
numeric comparison and straight back came home as `"x"`. Each step satisfied the per-step
invariant; the *composition* deleted padding the author typed, inside one visible frame of
tapping through the dropdown. So `comparedOperand` trims only where trimming is what makes
the comparison possible, and the pin is on the round trip rather than on another single
step: a detour the validator refuses returns the operand byte-identical, and a detour it
accepts returns what that detour compared.

The invariant is therefore stated as: **the operand's effective meaning never changes unless
the user changes it** — and where padding *is* semantic, it is now visible. `describeRule`
quotes every string operand (` 5` and `5` were the same pixels on the canvas, because HTML
collapses whitespace runs), and the dock says, as a note rather than an error, that a padded
string operand is compared with its spaces. Normalizing on operator change was preferred to
banning padding outright for string comparisons, which would have made `contains " x "`
unexpressible for no gain: the problem was never that padding exists, only that its meaning
could change while nothing on screen did.

Refusals are exits, not guesses. Wrong usage exits 2, an unknown branch point 3, a
measured value that is not a whole number where the comparison needs one exits 4 with a
message telling the reader to measure again, and an unknown operator (unreachable from a
compiled workflow) exits 5. Guessing at any of these would route a workflow on an
unmeasured value and say nothing about it, which is the one thing the deterministic mode
may not do.

**3. A scaffold is emitted only when there is something to decide deterministically.**

No rule-based conditional, no script — and, therefore, no `## Determinism` section
either. A bundle whose every decision is the model's gains nothing from a file that says
so, and pays for it with an umbrella that stopped being byte-identical to the previous
slice's. The linear, LLM-conditional, imported and vendor-mix golden files are unchanged
by this slice, which is the check that the claim holds.

In the file order the emitter writes, the scaffold goes with the vendored copies: before
the plugin marker and the umbrella. The umbrella instructs the scaffold, so the scaffold
is on disk before anything can ask for it — the same reasoning ADR-0002's ordering rests
on.

**4. The umbrella states the boundary of its own guarantee, in its own words.**

A bundle with a scaffold carries a `## Determinism` section, before `## Steps` because it
is how the steps are to be read:

- **Guaranteed** — the order of the steps, and every branch point that says the scaffold
  decides it;
- **Best-effort** — everything else, which is prose read by a model: an LLM branch point,
  the wording of each step, and how a step's labelled inputs are used.

It ends with the tie-break: where the script and the file disagree, the script is the
workflow.

**And it says what a refusal means, because otherwise the contract is only half-stated.**
Every rule-based step tells the reader the branch is not theirs to choose, so "the
deterministic path is unavailable" needs an answer in the prose — without one, the only
thing left is the judgement this mode exists to remove, made at the exact point the umbrella
claims it never is. A `### When the scaffold refuses` subsection states that a non-zero exit
is never a branch, and what to do per exit code: re-measure for 4, re-run the command as
written for 2, and for 3 or 5 — the codes that mean this file and the script disagree about
what exists — **stop and surface it**. Every rule-based branch instruction points at that
subsection by name (one constant, `REFUSAL_HEADING`, so the reference cannot drift from the
heading at the moment a reader needs it).

The honest answer for the unrecoverable case is a stop, and the alternative was considered:
the umbrella could restate the operator and operand so a model could judge the branch itself
when the script is broken. Rejected — a bundle whose script contradicts its prose is broken,
not degraded, and a guessed branch is indistinguishable afterwards from a decided one, which
is worse than no result. The tests assert the exit codes the prose names against the codes
the generated script actually returns, so the table cannot describe a script nobody has. Without that sentence a reader that noticed a difference would have no rule for
resolving it, and a "deterministic" bundle whose determinism is negotiable is worse than
one that never claimed it.

The rule-based branch instruction is built like ADR-0003's LLM one and for the same
reasons: it says the decision is **not** the reader's, gives the exact command rather than
a paraphrase of what the command would say, says exactly one branch is taken and the
others ignored, and names where to continue. The author's `subject` is quoted with the
asymmetric `“`/`”` pair and folded straight inside, sitting neither first (before the
instructions that frame it) nor last (where recency would let it outrank them).

**5. The mode is stated everywhere a conditional is shown.**

The canvas node's header reads `Conditional · LLM` or `Conditional · Rule` and its detail
line summarises the rule (`lines changed > 100`) rather than the question, because *who
decides* changes how the whole workflow runs and the canvas is where a workflow is read.
The dock offers the toggle with each option's consequence spelled out ("best effort" vs
"deterministic"), and — as with the branch bounds — states the rule-based mode's tighter
bound rather than only enforcing it: a rule holds or it does not, so it decides between
exactly two branches, and both branch controls say so when they are disabled.

Switching modes **keeps** both the question and the rule. The compiler reads only the
field the mode selects (`conditionalModeOf`, never a test for a field's absence), so an
ignored rule is not a validation error and looking at the other mode costs the user
nothing.

## Consequences

- The document format is at v5. v4 documents open unchanged: `mode` absent or `llm` still
  means an LLM conditional, and no v4 document carries a rule. `schema-v4.patchwork` is
  the migration fixture.
- `validateGraph` refuses a rule the scaffold could not evaluate or could not route: no
  rule on a rule-based node, an empty subject, an empty operand, a non-numeric operand
  under a numeric comparison, a routing to a branch the node does not offer, both cases
  routed to one branch, and any branch count other than two. A rule-based node no longer
  needs a question.
- An unknown `mode` or `operator` is refused at **load**, like an unknown export mode
  (ADR-0002): defaulting either would decide, on the user's behalf, who routes their
  workflow.
- The bundle is now sometimes more than files a model reads. The scaffold is written
  without an execute bit and invoked as `bash scripts/control.sh`, so nothing about the
  export depends on filesystem permissions.
- The scaffold's `plan` is a *statement* of the order, not an executor of it: nothing
  forces a reader to follow it. Full determinism would need the scaffold to invoke the
  steps, which needs a runtime this project does not have. What is bought here is that
  the order and the rule-based routings have a single authoritative source that a reader
  can consult and a human can diff.

## Alternatives considered

- **Make the scaffold the program** — a script that drives the whole workflow and calls
  out to the model per step. Rejected for this slice: it needs a runtime contract with
  Claude Code that does not exist, and it would make every bundle unrunnable by reading.
  The current shape is forward-compatible with it — the umbrella already defers to the
  script where they disagree.
- **Emit a scaffold in every bundle**, so the ordering is always deterministic. Rejected:
  a script that only restates a linear list adds a file, a section, and a second thing to
  keep in step for no decision it makes. The trigger is "something must not vary".
- **Let a rule extract its own value** (regex over the transcript, a shell pipeline).
  Rejected: see decision 1 — the input is the model's output either way, so the added
  machinery buys no determinism while adding a pattern language to the bundle.
- **A second node type** (`RuleConditional`) instead of a mode. Rejected by ADR-0003
  ahead of time: the mode field exists precisely so this slice is a widening rather than
  a schema break, and both modes share branches, wiring and convergence.
- **Route by branch index or label** instead of by id. Rejected: reordering or renaming a
  branch would silently re-route the workflow.
- **Bash-only script** (`[[ ]]`, `=~`). Rejected: the bundle is copied to machines
  Patchwork knows nothing about, and POSIX `sh` costs nothing here.
- **Compare numbers as text, at arbitrary precision** (sign, then digit count, then
  lexicographically), so no bound is needed at all. Genuinely tempting, and rejected for
  this slice: it replaces a two-line guard with a comparison routine of its own in generated
  shell, and every workflow anyone can draw compares things like line counts, file counts
  and sizes — all far inside nine digits. A refusal that names the bound is a better answer
  than a bigger script for a case nobody has.
- **Bound at 64 bits** instead, since every shell on a 64-bit machine handles it. Rejected:
  it is a bound on the machines that happen to be common, not on what the standard
  guarantees, and the whole point of the mode is that the answer does not depend on where
  the bundle landed.
- **Let the scaffold guess at a non-numeric measurement** (treat it as 0, or fall back to
  a string comparison). Rejected: a silent fallback is a routing nobody can account for
  afterwards, in the one mode whose whole selling point is that it can be accounted for.
