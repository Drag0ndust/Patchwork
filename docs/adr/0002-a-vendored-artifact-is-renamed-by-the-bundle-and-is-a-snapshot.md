# ADR-0002: A vendored artifact is renamed by the bundle that carries it, and the copy is a snapshot

- **Status:** Accepted
- **Date:** 2026-07-28
- **Context:** Artifact Codec, Graph Compiler, Bundle Emitter

## Context

ADR-0001 settled the reference-by-name export: the umbrella `SKILL.md` names the
artifacts a workflow needs and copies nothing, so the emitted name is the whole
of the reference. It deferred the other half — **vendor-copy**, a per-node choice
to carry the dependency inside the bundle — and flagged that the deferral would
need its own decision about staleness.

Vendoring raises two questions that reference-by-name did not have.

**What is the copy called?** A bundle is a directory, `patchwork-<slug>/`, that
the user drops into a source root. By the layout in ADR-0001, that directory is
itself the enclosing namespace for anything nested under it: a file at
`patchwork-<slug>/skills/tdd/SKILL.md` is not `tdd` and is certainly not
`coding:tdd` — the name it resolves under is derived from where it now lives. So
the source name is not usable inside the bundle, and the umbrella's prose (which
is the only thing that makes the workflow run) has to say the right one.

**What happens when the source changes?** The document stores a *symbolic*
reference and re-resolves it on open, precisely so nothing goes stale. A vendored
copy is the opposite: bytes, frozen at the moment of export, in a directory
Patchwork does not own afterwards.

## Decision

**1. The bundle renames what it carries, and the umbrella says so.**

A vendored artifact is copied to the canonical layout *relative to the bundle
root* — `skills/<name>/SKILL.md` for a skill, `agents/<name>.md` for an agent —
and the umbrella's prose invokes it as `patchwork-<slug>:<name>`. It loses the
namespace it had on disk (there is no plugin directory in a bundle) and gains the
bundle's:

| Node                            | Bundle file                | Invoked as                   |
| ------------------------------- | -------------------------- | ---------------------------- |
| skill `coding:tdd`, vendored    | `skills/tdd/SKILL.md`      | `patchwork-<slug>:tdd`       |
| agent `coding:pr-reviewer`, v.  | `agents/pr-reviewer.md`    | `patchwork-<slug>:pr-reviewer` |
| skill `conventions`, referenced | *(none)*                   | `conventions`                |

The copy's bytes are `emitArtifact` output — byte-faithful, frontmatter
included. Its frontmatter `name:` is deliberately **not** rewritten to the
bundled name: by ADR-0001 the location is authoritative and the declaration is
advisory, so rewriting it would buy nothing and would cost the round-trip
property the codec exists to provide.

The two modes are kept apart in the prose as well as in the file set.
`## Requirements` lists only the reference-mode artifacts ("not bundled here, so
they must already be installed"); vendored ones get their own
`## Bundled capabilities` section, which names each copy by its bundled name,
its path inside the bundle, and the source name it was copied from. A reader (or
Claude Code) can tell from the umbrella alone what ships with the workflow and
what the workflow expects to find.

**1b. A bundle that vendors anything declares itself a plugin, so the namespace
it advertises is real.**

*Supersedes the "UNCERTAIN mitigation" this ADR first recorded.* The original
version left the namespace assumed and mitigated the risk by printing each copy's
path in `## Bundled capabilities`. That mitigation was inadequate on its own
terms: by the rule this project encodes in **both** languages (ADR-0001, rule 2),
a directory below `skills/` provides a namespace only when it carries a
`.claude-plugin/` marker — and `lib.rs`'s own
`given_nested_skills_without_the_plugin_marker_when_scanned_then_nothing_is_importable`
asserts that the *exact* shape an unmarked bundle has yields **nothing**. So every
`patchwork-<slug>:<leaf>` the umbrella emitted was, by Patchwork's own model of
discovery, a dangling name; and the path that was supposed to save it appeared
only in a section the actionable instruction never points at.

Two changes settle it:

1. When (and only when) a bundle vendors something, the compiler emits
   `.claude-plugin/plugin.json` — the same marker `lib.rs`'s test helper
   `mark_plugin` writes — carrying the bundle's own name and description. A
   reference-only bundle stays a plain skill directory, because it claims no
   namespace and should assert none.
2. Each vendored **step** restates the copy's path inline ("it is bundled here at
   `skills/tdd/SKILL.md`, so read that file if the name does not resolve"). The
   step is what gets acted on, so the fallback has to live there rather than in a
   section further up.

This is now *verified* rather than assumed, against the only model of discovery
this repo owns: `given_an_exported_bundle_that_vendors_artifacts_when_scanned_then_its_bundled_names_resolve`
copies the compiler's golden bundle into a source root exactly as a user would
drop it and asserts the walk finds `patchwork-vendor-mix`,
`patchwork-vendor-mix:tdd` and `patchwork-vendor-mix:pr-reviewer` — the very names
the umbrella tells Claude Code to invoke. One fixture tree, both languages, the
way ADR-0001 pins the layout rule.

A bundled name must also **round-trip through the layout**, not merely be a valid
name: `artifactRelativePath` is not injective in reverse for every input — an agent
named `SKILL` would land at `agents/SKILL.md`, which the layout rule says is not an
artifact at all — so the copy would sit in the bundle under a name nothing can
resolve. The planner refuses such a copy and names the node to fix, rather than
special-casing the one name that exhibits it.

Residual uncertainty, narrowed: whether Claude Code's *own* plugin loader wants
more than `name` in `plugin.json` (a `version`, a marketplace entry) could not be
established, so nothing further is invented. If it does, the manifest is the one
place to extend — and step-level paths mean a bundle stays usable even then.

**2. A leaf collision is resolved by chain order, never by overwriting — and
"different" means different to a filesystem.**

Two artifacts that are distinct on disk can share a leaf — `coding:implementer`
and `swift:implementer` — and inside the bundle they would want the same path.
The first one along the chain keeps the leaf; the next falls back to the
flattened source name (`swift-implementer`), then to a numeric suffix. Both
copies exist, both are named in the prose, and the assignment is a function of
chain order rather than of iteration accident.

Collision is judged **case-insensitively**, because the bundle is written to a
filesystem and the default one on macOS (APFS) and Windows (NTFS) is
case-insensitive: `coding:tdd` and `swift:TDD` would otherwise both take their
leaf, and the second `write` would silently replace the first copy — leaving the
umbrella advertising a path whose contents are a different artifact. Folding is
sufficient and no Unicode normalization is needed: `isValidArtifactName` admits
only ASCII letters, digits, `.`, `_` and `-`.

**2b. The export mode belongs to the artifact, not to the node.**

Two nodes can be bound to the same artifact and disagree about the mode. They
cannot each have their way: the file is either in the bundle or it is not. An
explicit vendor-copy therefore wins for that artifact **wherever it sits in the
chain**, and every node bound to it invokes the one bundled name. Deciding from
whichever node came first would let one node's default silently discard another
node's explicit choice — and the loss would be invisible, since a dropped copy
leaves nothing behind in the bundle to notice.

**3. A vendored copy is a snapshot, and export is the only refresh.**

Patchwork does not track a copy after it is written: no content hash, no
provenance field, no staleness check. Re-exporting re-reads the artifact through
the import scan and re-copies it, so the way to refresh a bundle is to export it
again — the same act that created it. The document keeps storing the symbolic
reference (name plus root id), never the bytes, so nothing inside the
`.patchwork` file can go stale either.

**3b. An export is all-or-nothing, and a half-written bundle is never
discoverable.**

*Replaces this ADR's earlier deferral, which justified itself entirely in terms of
two overlapping exports and so documented a narrower risk than the one that
existed.* Vendor-copy turns a bundle from one file into N, and decision 1b made the
bundle a plugin — so a **single** export failing halfway (a full disk, a revoked
permission, a path the filesystem rejects, a volume disappearing) was enough to
destroy the previous bundle and leave a discoverable plugin whose steps instructed
copies that had never landed. No concurrency needed.

Two layers, deliberately, because they fail independently:

1. **Ordering (pure, compiler side).** The tree lists the copies first, then
   `.claude-plugin/plugin.json`, then the umbrella `SKILL.md` last. Those last two
   are what make a bundle visible — the marker mints the namespace, the umbrella
   carries the instructions — so the worst partial state this order can produce is
   an invisible one. The old order committed exactly those two first.
2. **Atomic swap (privileged, emitter side).** `write_bundle` fills a hidden
   staging directory beside the destination and swaps it in with `rename`, retiring
   any previous bundle only once the new one is in place (and moving it back if the
   swap itself fails). Nothing at the destination is touched until the complete
   bundle exists, so a failed export is a no-op rather than a demolition.

The staging directory is a sibling so the swap stays within one filesystem, and its
name is unique per export so no export ever *swaps in* a directory it did not
create.

**3c. An export reaps its own bundle's old leftovers, and nothing else's.**

*Replaces this ADR's earlier "a leftover from a crashed export stays put, named for
what it is."* That was a leak, not a policy: every leftover is a full copy of a
bundle, so a destination only ever grew — a crashed or raced export left
`.{dirName}.patchwork-staging-…` behind, and a retired **file** at the bundle path
(a symlink, or a stray file the user put there) could not be removed by
`remove_dir_all` at all, so `.{dirName}.patchwork-previous-…` lingered for ever.

An export therefore removes hidden siblings whose names match its **own** bundle's
pattern exactly — `.{dirName}.patchwork-{staging|previous}-{pid}-{nanos}`, with both
numeric fields all digits — for the `dirName` being exported, and removes them
whether they are directories, files, or symlinks. A leftover of a *different* bundle
in the same destination, and anything that is not that exact shape, is left strictly
alone: this deletes inside a directory the **user** picked, so the rule is exact
rather than a prefix guess.

The one thing the name cannot tell us is whether the export that made it is still
running — a pid may have been reused, and a foreign pid is quite likely a second
Patchwork window exporting right now. Age stands in for liveness: the `nanos` in the
name must be at least an hour old. A live export's working directory is therefore
never removed, and the cost is that a leftover survives until the next export an
hour or more later. The reverse trade (reaping eagerly and breaking an export that
was about to succeed) is far worse. An export that somehow ran longer than an hour
loses its staging directory and then fails at the swap: an error, and nothing
destroyed, because a staging directory only ever holds a bundle that was never
delivered.

**The two roles are therefore reaped at different moments, and age alone does not
decide it.** An export killed between the swap's two renames leaves the bundle's
*only* copy under `.{dirName}.patchwork-previous-…`. Reaping both roles before the
fill meant a later export that then **failed** deleted that copy — an export which
wrote nothing destroying the last copy of a bundle, which is precisely what staging
exists to prevent. So a `staging` leftover is reaped before the fill (it can never be
a sole copy, and this keeps a failing export tidying the common leak), while a
`previous` leftover is reaped **only after the swap has succeeded** — at which point
the new bundle is in place and nothing being removed is anyone's only copy. The cost
is a retired orphan surviving until the next *successful* export, which is the right
direction to fail in.

Reaping can never fail an export — the bundle on disk is what the user asked for —
but it is not silent either, since silence is what let the retired-file leak go
unnoticed: a reap that fails goes to stderr naming the path.

The atomic swap also settles the concurrency question the deferral was about: two
exports can no longer interleave into one directory, whatever process they come
from — last rename wins and both bundles are complete. The renderer still allows
only one export at a time (the button is disabled while one is in flight), because
that is what makes the *reported* result match what a user did; but correctness on
disk no longer depends on it, which is what an in-process lock could never have
guaranteed anyway.

**4. Vendoring is a pure transform, so the compiler stays pure.**

`compile` takes the resolved artifacts as an argument and copies from memory. The
bytes are already parsed — the Import Catalog holds them — so no disk read is
needed to vendor, and the Bundle Emitter (privileged Rust) remains the only
module that touches the filesystem. A vendor-mode node whose artifact is not
resolvable is reported by `vendorErrors` *before* the export directory is even
chosen, because a bundle that promises a copy it does not contain would fail
later, inside Claude Code.

## Consequences

- A bundle is refreshed by re-exporting it, and a source artifact that changed
  after an export is silently older-or-newer than the copy. This is the intended
  cost of vendoring: the point of the copy is that it does *not* follow the
  source.
- Reordering the chain can rename a vendored copy when two of them share a leaf.
  Harmless in practice because the umbrella is regenerated in the same pass, so
  the prose and the file set can never disagree — but a bundle's internal names
  are not stable across edits, and nothing outside the bundle may depend on them.
- A vendored copy's frontmatter `name:` will usually disagree with the name it is
  invoked by inside the bundle, and its body may even name its old namespace
  (real artifacts say things like "Claude Code invokes this agent as
  `coding:pr-reviewer`"). That is visible to a reader and is the reason the
  umbrella has to state the bundled name explicitly.
- Vendor mode makes the artifact's availability an **export precondition**, where
  reference mode only made it a notice. An unresolved vendor-mode node blocks the
  export with an error naming the node; an unresolved reference-mode node still
  exports, exactly as in the prior slice. The same holds for the (UI-unreachable)
  case of an artifact whose name could not be a path component inside the bundle:
  the planner refuses the copy and says which node to fix, rather than trusting
  that the name must have come from the codec.
- A leftover of a bundle Patchwork no longer exports (the workflow was renamed, so
  `dirName` changed) is never reaped, because the reaper only ever matches the
  bundle in front of it. That is the deliberate edge of "exact, not a prefix guess",
  and it is visible: the name says what it is and where it came from.
- Anything at the bundle path that is not a bundle — a file, a symlink, a dangling
  symlink — is *retired*, not written through and not deleted in place. So exporting
  over a symlink to the user's own data moves the link aside and leaves the target
  untouched, and a stale dangling link no longer wedges the destination.
- Bundles grow by the size of what they carry. The scan's per-artifact ceiling
  (512 KB) bounds a single copy; nothing bounds their number, which is the user's
  choice to make.
- The umbrella's frontmatter `name:` (the workflow slug, `vendor-mix`) disagrees
  with the bundle directory and the manifest (`patchwork-vendor-mix`), so importing
  your own exported bundle raises a declared-name notice. **Known and intentional
  — do not "fix" it.** ADR-0001 makes the location authoritative and the
  declaration advisory, so the disagreement changes nothing about what resolves;
  aligning them would change the umbrella of a *reference-only* bundle too, and
  reference-only output being byte-identical to the prior slice is a verified
  property of this change (AC 3). If it is ever worth resolving, the direction is
  to reconsider the slug, not to rewrite the frontmatter at emit time.

## Alternatives considered

- **Keep the source name in the prose** (`coding:tdd` for a copy that lives in
  the bundle). Rejected: it sends Claude Code to the very dependency the copy
  exists to remove, so a vendored bundle would only work on machines where
  vendoring was unnecessary.
- **Always flatten to the full source name** (`coding:tdd` → `coding-tdd`), so no
  collision is possible. Rejected as the default: it makes every bundled name
  longer to pre-empt a case that is rare, and it still needs a tie-break
  (a flat artifact really can be named `coding-tdd`). Kept as the *first* fallback
  instead, which is where it earns its length.
- **Leave the bundle unmarked and rely on the copy's path alone.** Rejected —
  this was the first version of this ADR, and it made the umbrella's own
  instructions untrue by the project's own discovery rule (see 1b). The path is
  kept, but as a *fallback inside the step*, not as a substitute for a name that
  resolves.
- **Reproduce the plugin layout inside the bundle**
  (`skills/coding/skills/tdd/SKILL.md`). Rejected: it rebuilds the namespace the
  bundle just replaced, needs its own plugin marker to mean anything, and yields a
  name (`coding:tdd`) that collides with the *installed* artifact the copy was
  meant to make unnecessary.
- **Rewrite the copy's frontmatter `name:` to the bundled name.** Rejected: the
  declaration is advisory (ADR-0001), and rewriting it forfeits byte-faithfulness
  — the property that lets Patchwork copy a user's file without being able to
  mangle it.
- **Record provenance (source path, content hash, export timestamp) in the copy
  or in a sidecar manifest, and warn when the source drifts.** Deferred, not
  rejected: it is the only way to *detect* staleness, but it needs a bundle-level
  format Patchwork does not have yet, and a warning is worth little until there is
  a way to act on it (a "re-vendor" action). Nothing in this decision blocks it.
- **Refuse to export when a copy would differ from the source.** Rejected as
  incoherent: the bundle is output, not state Patchwork owns, so there is no
  previous copy to compare against at export time.
