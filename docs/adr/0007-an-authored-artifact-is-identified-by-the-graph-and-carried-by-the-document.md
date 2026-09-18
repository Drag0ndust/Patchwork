# ADR-0007: An authored artifact is identified by the graph and carried by the document

- **Status:** Accepted
- **Date:** 2026-09-17
- **Context:** Graph Document, Artifact Codec, Graph Compiler, dock editor

## Context

Slice 8 lets a user write a **new** skill or agent from inside a node —
born-in-graph — instead of importing one that is already installed. That runs
straight into ADR-0001, which is the load-bearing decision of the import half of
this project:

> An artifact's identity comes from its location on disk, never from its
> frontmatter.

An artifact authored in a node **has no location on disk**. There is no directory
whose name is its name, and there will not be one until the workflow is exported
(and, for a source root, not until slice 9 promotes it). Something else has to say
what it is called, when the two names it will eventually be invoked by — inside the
bundle, and later inside a root — both have to be decided *now*, while it is being
typed.

Three questions followed, and each of them had a plausible wrong answer.

1. **Where does an authored artifact's name come from?**
2. **What, exactly, does the document store — a file, or fields?**
3. **What does "collision" mean for something that is not written anywhere yet?**

## Decision

**1. Identity comes from the graph, and the two kinds take it from different places.**

- An **agent** is named by the author, explicitly. It *is* the file
  `agents/<name>.md`; the name is the file, and nothing else in the graph says what
  that file is called. An unnamed authored agent is refused by `validateGraph`
  rather than given a name Patchwork invented.
- A **skill** is a *directory Patchwork mints*, and the graph already has a name for
  it: the node's own label, slugged the way a workflow name is slugged into the
  bundle directory (`authoredArtifactName`). A `Name` override sits in the dock's
  Advanced panel for when the label is not what the artifact should be called.
- A label that **slugs to nothing** names nothing. The slug's fallback to the literal
  `workflow` belongs to the bundle directory, which must be called something; borrowing
  it here named every skill whose label is not Latin script `workflow` — a Chinese,
  Japanese, Russian, Greek or Arabic author's artifacts silently misnamed, and two of
  them colliding on a name nobody typed. Such a label is a **required-field problem**,
  reported by `validateGraph` and by the dock in the same words, and the way out is the
  explicit name the skill form already carries. A skill keeping an explicit name is
  what makes refusing the label acceptable: the minimal form stays usable whatever
  script the author writes in.

This is what makes the minimal form for a skill be a **description and nothing
else**, which is the shape issue #22 asks for — and it keeps identity where ADR-0001
put it in spirit: derived from where the artifact *lives*, which for an
authored one is the graph rather than the filesystem.

The asymmetry is the same one ADR-0001 records: a skill is a directory, an agent is a
file.

**2. The document stores fields and a body, and the frontmatter is derived.**

An *imported* artifact is modelled as verbatim file text — `RawFrontmatter` keeps the
delimiters and the exact YAML, because re-emitting a vendored copy must not mangle a
user's bytes. An **authored** artifact is the opposite case, and is modelled the
opposite way: `AuthoredArtifactData` holds `description`, the curated Advanced fields
(`tools`, `model`, `effort`) and the Markdown `body`, and the Artifact Codec's
`composeArtifact` derives the frontmatter through a real YAML emitter at emit time.

So the form *is* the artifact. A description containing a colon, a quote, a leading
`-`, or a line of its own `---` produces valid YAML because it was never concatenated
into any. `emitArtifact(composeArtifact(spec))` parses back into an equal artifact —
the property the codec's round-trip tests pin — which is what "format compliance" is
asserted as rather than eyeballed.

The emitter is told it is writing **YAML 1.1** (`stringifyFrontmatter`), and that is
not a detail. The `yaml` package defaults to 1.2, whose core schema has no `yes`/`no`
booleans and no sexagesimal integers, so a description of `yes` emits bare and is read
back by PyYAML — a 1.1 reader, and what this ecosystem is full of — as the boolean
`True`; `1:30` comes back as `90`. A round-trip test cannot see any of it, because it
re-reads with the parser that wrote it. So the ambiguous values are asserted on the
*emitted bytes*, and against PyYAML itself where the machine has it. The umbrella
`SKILL.md` goes through the same function, because it is read by the same loaders the
artifacts beside it are.

**2a. The name Patchwork mints is stricter than the name it imports.**

`isValidArtifactName` accepts what the Import Scanner may *find* on disk.
`isValidAuthoredArtifactName` is what Patchwork may *invent*, and it is stricter in two
ways, because an authored name is typed by a user rather than read off a real file:

- **no `:` namespace segment.** An authored artifact is written bare into the bundle,
  whose directory is already its namespace (ADR-0002). A name carrying one of its own
  would land at a path whose leaf is not the `name:` the emitted file declares;
- **no Windows device name** (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`LPT9`, with or
  without an extension). NTFS resolves these before it looks at the directory, so
  `agents/NUL.md` and `skills/CON/` cannot be created at all. An artifact *discovered*
  under such a name is still importable — it exists, and refusing it would be refusing
  a file the user is looking at.

**3. An authored artifact is always materialized; it has no export mode.**

A `skill`/`agent` node's export choice (ADR-0002) is between naming an installed
artifact and copying it in. An authored one has no original to name: the bytes exist
only in the `.patchwork` document, so the bundle must carry them or the step refers to
nothing. It is otherwise bundled exactly as a vendored copy is — same name choice,
same `patchwork-<slug>:` namespace, same plugin marker — because once the bytes are in
the bundle, Claude Code cannot tell the two apart. The umbrella's
`## Bundled capabilities` section is the one place that can, and it says
`authored in this workflow` instead of `copied from …`, because there is no original
to go back to.

**3a. When an authored artifact and a vendored copy want one name, the authored name
wins.**

The two claims are not alike. A vendored copy's bare name is one the *bundle chose for
it* — the source namespace does not exist in here, so `coding:tdd` becomes whatever is
free, and ADR-0002 already says a vendored artifact is renamed by the bundle. An
authored artifact's name is the author's, and Patchwork writes **both** halves of it:
the path and the `name:` inside the file. So every authored name is claimed before a
single copy is placed (`authoredNameClaims`), and the copy is the one that moves.

Deciding in chain order instead — which is what the leaf-then-flatten-then-suffix
ladder did when the authored branch fell through it — made the author's own name depend
on where an unrelated node sat in the chain, silently, and emitted
`skills/tdd-2/SKILL.md` declaring `name: tdd`: a file this repo's own Import Scanner
flags as a declared-name conflict, written by Patchwork. A copy may disagree with its
location that way (those are the user's untouched bytes, and `name` is advisory); an
artifact Patchwork writes both halves of may not.

**4. A collision inside the graph is an error; a collision with an installed artifact
is a live notice.**

Two authored nodes claiming one kind+name would be written to **one path** inside the
bundle, so only one file can exist: `validateGraph` refuses the export and names both
nodes. Comparison is case-folded, because the bundle is written to a filesystem whose
default on macOS and Windows treats `skills/triage/` and `skills/Triage/` as one
directory.

An authored name that matches an artifact **already installed in a source root** is
*not* an export problem — a bundle is its own namespace (ADR-0002), so the two never
meet — but it is exactly what will bite when the artifact is written to a root, and
finding out then is too late. So it is surfaced in the dock, live, and nowhere else.

One function answers both (`authoredArtifactErrors`), and the difference is entirely
in its second argument: `validateGraph` asks it of the document alone, the dock asks
it of the same nodes plus the resolved catalog. That is deliberate — the dock's
verdict and the export's verdict have drifted apart in this codebase before (see the
note on `comparedOperand`), and the fix each time was one definition with two readers.

## Consequences

- Renaming a node renames the skill it authors. That is the intended coupling — it is
  the same one the workflow name has with the bundle directory — and it is made
  visible: the dock states the path the artifact will be written to, and the canvas
  node shows the derived name.
- A `.patchwork` document is now **self-contained**: a graph whose capabilities were
  written in it exports on a machine that has no source roots configured at all, and
  can be shared as one file. Documents therefore grow by the size of the prose they
  carry.
- `schemaVersion` goes to 7. The change is a widening — an artifact node with no
  `source` is an imported reference, which is exactly what every v6 artifact node
  already was — so the migration only records the version, and shape validation still
  runs before migration (see `MIGRATIONS`). It is 7 rather than 6 because a second
  branch in flight (a cycle's iteration guard) took 6 first: a version number that
  identifies two formats opens a document into an error about a field the reader has
  never heard of, which is worse than a gap in this slice's own numbering.
- Switching a node from authored back to imported keeps the prose but **loses the
  authored name**: both shapes have a `name` and they mean different things, so
  carrying it would author an artifact claiming an installed one's name. Losing a
  written body to a mis-click would be the worse trade, so the body is kept.
  This holds for the **whole round trip** — authored → imported → authored returns the
  description, body, tools, model and effort, and asks for the name again. The name has
  no slot to survive in: the imported shape's `name` is the binding the picker writes,
  and giving it a second one would put a field in every saved document, and in the
  schema's shape check, whose only job is undoing a select. A nameless authored artifact
  is a problem the dock reports the moment it is one, so the loss is never silent — and
  for a skill there is usually nothing to re-type, since the node's label names it.
- Promoting an authored artifact **to a source root** is deliberately not here. This
  slice validates the collision that promotion would hit; slice 9 (#23) does the
  writing.

## Alternatives considered

- **Give an authored artifact a synthetic identity (a uuid, or the node id).** Rejected:
  the name is what a reading model invokes, and `patchwork-triage-report:n2` is a name
  no author chose and no reader can act on.
- **Surface the authored/vendored name contest as a validation error naming both
  nodes.** Rejected in favour of renaming the copy: the rule "a vendored artifact is
  renamed by the bundle" already exists (ADR-0002), it costs the user nothing, and
  refusing the export would make a workflow unexportable over a name the author picked
  for their own artifact and the bundle picked for someone else's.
- **Ask for a name for both kinds, up front.** Rejected: it is a second thing to name
  for a node that is already named, and issue #22's minimal skill is a description. The
  override in Advanced covers the case where the label is wrong for the artifact.
- **Store the authored artifact as file text** (frontmatter included) and parse it back,
  as an imported one is. Rejected: it makes every typed character a chance to write
  invalid YAML, it puts two copies of the description in the document (one in the form,
  one in the text), and it gives up the guarantee that what the form collects is what
  gets emitted.
- **Let an authored artifact be exported by reference.** Rejected: there is nothing to
  refer to. It would emit a step naming an artifact that exists nowhere.
- **Treat a clash with an installed artifact as an export error.** Rejected: it would
  refuse a bundle that is provably fine — the bundle's namespace is its own — and would
  make an export depend on which roots happen to be configured at the time.
