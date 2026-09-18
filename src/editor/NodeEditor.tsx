import {
  artifactKindOf,
  artifactSourceOf,
  asText,
  authoredArtifactErrors,
  authoredArtifactName,
  authoredArtifactPathOf,
  branchesWithinLimit,
  bundleDirNameFor,
  conditionalModeOf,
  DEFAULT_RULE_OPERATOR,
  comparedOperand,
  exportModeOf,
  isComparableNumber,
  isWholeNumber,
  MAX_BRANCHES_PER_CONDITIONAL,
  MAX_RULE_NUMBER_DIGITS,
  MIN_BRANCHES_PER_CONDITIONAL,
  NUMERIC_RULE_OPERATORS,
  type ArtifactNodeData,
  type ArtifactRefData,
  type ArtifactSource,
  type AuthoredArtifactData,
  type Branch,
  type ConditionalData,
  type ConditionalMode,
  type ConditionalRule,
  type ExportMode,
  type InputData,
  type NodeData,
  type NodeType,
  type OutputData,
  type PromptData,
  type RuleOperator,
  withOperator,
} from "../domain/graph-document";
import { newId } from "../domain/ids";
import type { ArtifactKind } from "../domain/artifact-codec";
import { artifactScaffold } from "../domain/artifact-scaffold";
import {
  catalogArtifactsOfKind,
  findCatalogArtifact,
  type ImportCatalog,
} from "../import/catalog";
import { toGraphNode, type PatchNode } from "../canvas/react-flow-adapter";

/**
 * A node's new data, or a function producing it from the node's *current* data.
 *
 * The updater form exists for edits that change one field of the data and must
 * leave the rest alone: building a whole object from the rendered props would let
 * two edits landing in the same tick overwrite each other with what each of them
 * last saw. React flushes discrete events one at a time, so this is a latent
 * hazard rather than a live bug — closed here rather than left resting on that.
 */
export type NodeDataEdit = NodeData | ((current: NodeData) => NodeData);

interface NodeEditorProps {
  node: PatchNode | null;
  catalog: ImportCatalog;
  /**
   * The other nodes on the canvas, for the one question that cannot be answered from
   * the selected node alone: whether an artifact authored here would collide with one
   * authored somewhere else in the same graph.
   *
   * Optional, and the *selected* node is never taken from it — see
   * [`authoredProblemsFor`] — so a caller that does not pass it loses the in-graph
   * half of the collision check rather than the whole of the validation.
   */
  nodes?: readonly PatchNode[];
  /**
   * The workflow's name, which is what the bundle directory — and so the namespace
   * everything in the bundle is invoked under — is slugged from.
   *
   * Needed because an authored name is only exportable *relative to it*: a 64-character
   * directory and a 64-character artifact name make an invocation Claude Code cannot
   * resolve, and without the name the dock would promise a path the export refuses.
   * Optional, and omitting it is not the same as switching the check off: it falls back
   * to the directory an unnamed workflow compiles into, which is the one the export
   * would use for it.
   */
  workflowName?: string;
  onChange: (id: string, label: string, data: NodeDataEdit) => void;
}

const TYPE_LABEL: Record<NodeType, string> = {
  input: "Input",
  prompt: "Prompt",
  output: "Output",
  skill: "Skill",
  agent: "Agent",
  conditional: "Conditional",
};

export function NodeEditor({
  node,
  catalog,
  nodes = [],
  workflowName = "",
  onChange,
}: NodeEditorProps) {
  if (!node) {
    return (
      <div className="pw-dock pw-dock--empty">
        Select a node to edit its details.
      </div>
    );
  }

  const type = node.type as NodeType;
  const { label, node: data } = node.data;

  const emit = (nextLabel: string, nextData: NodeDataEdit) =>
    onChange(node.id, nextLabel, nextData);

  return (
    <div className="pw-dock">
      <div className="pw-dock__title">{TYPE_LABEL[type]} node</div>

      <label className="pw-field">
        <span>Label</span>
        <input
          value={label}
          onChange={(e) => emit(e.target.value, data)}
          placeholder="Node label"
        />
      </label>

      {type === "input" && (
        <InputFields
          data={data as InputData}
          onChange={(d) => emit(label, d)}
        />
      )}
      {type === "prompt" && (
        <PromptFields
          data={data as PromptData}
          onChange={(d) => emit(label, d)}
        />
      )}
      {type === "output" && (
        <OutputFields
          data={data as OutputData}
          onChange={(d) => emit(label, d)}
        />
      )}
      {type === "conditional" && (
        <ConditionalFields
          data={data as ConditionalData}
          onChange={(d) => emit(label, (current) => d(current as ConditionalData))}
        />
      )}
      {artifactKindOf(type) && (
        <ArtifactFields
          kind={artifactKindOf(type) as ArtifactKind}
          node={node}
          label={label}
          data={data as ArtifactNodeData}
          nodes={nodes}
          catalog={catalog}
          workflowName={workflowName}
          onChange={(edit) => emit(label, (current) => edit(current as ArtifactNodeData))}
        />
      )}
    </div>
  );
}

/**
 * A `skill`/`agent` node's artifact, whichever way it came to be: picked out of the
 * import catalog, or **written here**.
 *
 * The choice comes first because it decides what the rest of this section even is —
 * a binding to something on disk, or a small editor for a file that does not exist
 * yet. Everything below it is one or the other, never both.
 */
function ArtifactFields({
  kind,
  node,
  label,
  data,
  nodes,
  catalog,
  workflowName,
  onChange,
}: {
  kind: ArtifactKind;
  node: PatchNode;
  label: string;
  data: ArtifactNodeData;
  nodes: readonly PatchNode[];
  catalog: ImportCatalog;
  workflowName: string;
  onChange: (edit: (current: ArtifactNodeData) => ArtifactNodeData) => void;
}) {
  const source = artifactSourceOf(data);
  const noun = kind === "skill" ? "skill" : "agent";

  return (
    <>
      <label className="pw-field">
        <span>Artifact</span>
        <select
          value={source}
          onChange={(e) => {
            const picked = e.target.value as ArtifactSource;
            onChange((current) =>
              picked === "authored"
                ? asAuthored(current, kind, label)
                : asImported(current),
            );
          }}
        >
          {/* Each option states its consequence, like the export-mode select: the
              choice is about whether this capability has to exist somewhere already. */}
          <option value="imported">Import one — pick something installed</option>
          <option value="authored">Author one here — written into the bundle</option>
        </select>
      </label>
      {source === "authored" ? (
        <AuthoredFields
          kind={kind}
          node={node}
          data={data as AuthoredArtifactData}
          nodes={nodes}
          catalog={catalog}
          workflowName={workflowName}
          onChange={(edit) =>
            onChange((current) => edit(current as AuthoredArtifactData))
          }
        />
      ) : (
        <ArtifactPicker
          kind={kind}
          data={data as ArtifactRefData}
          catalog={catalog}
          onChange={(d) =>
            onChange((current) =>
              typeof d === "function" ? d(current as ArtifactRefData) : d,
            )
          }
        />
      )}
      {source === "authored" && (
        <p className="pw-ref">
          This {noun} is written in this workflow, so it is always written into the
          exported bundle — there is nothing installed for it to refer to.
        </p>
      )}
    </>
  );
}

/**
 * Turn a node's data into an authored artifact, keeping what can be kept.
 *
 * The prose is kept, because losing a written body to a mis-click on a select is a
 * real loss and the fields it would be carried in are the same ones. The **name** is
 * not: the two shapes both have one and they mean different things, so inheriting it
 * would author an artifact claiming the name of an installed one.
 *
 * The scaffold seeds only an empty body (AC3): it is a starting point, not a reset.
 *
 * Every carried field is read through [`asText`], not `?? ""`. An *imported* node's
 * authoring fields are deliberately left untyped by `assertNodeShape` — that is what
 * lets the return trip survive — so a hand-edited document with a number where prose
 * belongs opens cleanly and lands here, and this is the first surface that reads it as
 * prose. Not text is a field with nothing in it, the same answer the rest of the app
 * gives (issue #27); carrying the number on instead would also make the document this
 * produced unopenable the next time it was saved.
 */
function asAuthored(
  current: ArtifactNodeData,
  kind: ArtifactKind,
  label: string,
): AuthoredArtifactData {
  const prior = current as Partial<AuthoredArtifactData>;
  const body = asText(prior.body);
  return {
    ...prior,
    source: "authored",
    name: "",
    description: asText(prior.description),
    tools: carriedText(prior.tools),
    model: carriedText(prior.model),
    effort: carriedText(prior.effort),
    body: body.trim() === "" ? artifactScaffold(kind, label) : body,
  };
}

/**
 * An optional Advanced field carried across the source switch — as the text it is meant
 * to be, and still absent if it was absent, so a node that never had one is not given
 * an empty one to save.
 */
function carriedText(value: unknown): string | undefined {
  return value === undefined ? undefined : asText(value);
}

/** Turn it back into an unbound import, keeping the authored prose for a return trip. */
function asImported(current: ArtifactNodeData): ArtifactRefData {
  return {
    ...current,
    source: "imported",
    name: "",
    rootId: "",
    exportMode: exportModeOf(current as ArtifactRefData),
  };
}

/**
 * The problems with the artifact this node authors, as they are *being* written.
 *
 * The same function `validateGraph` asks (`authoredArtifactErrors`), asked with the
 * import catalog as well — so the dock adds exactly one thing the export cannot know,
 * a clash with an artifact already installed, and can never disagree with the export
 * about the rest.
 *
 * The selected node is taken from the **props**, not from the `nodes` list: those are
 * a render behind while a field is being typed into, and the whole point is to answer
 * for the character just entered.
 */
function authoredProblemsFor(
  node: PatchNode,
  nodes: readonly PatchNode[],
  catalog: ImportCatalog,
  workflowName: string,
): string[] {
  const others = nodes.filter((other) => other.id !== node.id).map(toGraphNode);
  return (
    authoredArtifactErrors(
      [toGraphNode(node), ...others],
      catalog.artifacts.map(({ kind, name }) => ({ kind, name })),
      bundleDirNameFor(workflowName),
    ).get(node.id) ?? []
  );
}

/**
 * Write a new skill or agent from inside the node — **born in the graph**.
 *
 * Progressive disclosure, and the split is the point: in front of the author are the
 * fields an artifact cannot be without (a description, and the prose itself; an agent
 * also its name), while the fuller frontmatter surface — which tools it may use,
 * which model runs it, how hard it thinks — is folded into `Advanced`, because most
 * artifacts never set any of it and a form that asks for everything is a form nobody
 * finishes.
 *
 * A **skill** is not asked for a name at all up front: it is a directory Patchwork
 * mints, and the graph already names it — the node's label, slugged. The override
 * sits in `Advanced` beside the rest. See [`authoredArtifactName`] and ADR-0007.
 *
 * Validation is live and it never refuses a keystroke: every problem is surfaced in a
 * status region under the fields, and the fields themselves accept anything. A dock
 * that rejected input would make a half-typed name unrepairable.
 */
function AuthoredFields({
  kind,
  node,
  data,
  nodes,
  catalog,
  workflowName,
  onChange,
}: {
  kind: ArtifactKind;
  node: PatchNode;
  data: AuthoredArtifactData;
  nodes: readonly PatchNode[];
  catalog: ImportCatalog;
  workflowName: string;
  onChange: (edit: (current: AuthoredArtifactData) => AuthoredArtifactData) => void;
}) {
  const noun = kind === "skill" ? "skill" : "agent";
  const problems = authoredProblemsFor(node, nodes, catalog, workflowName);
  const name = authoredArtifactName(toGraphNode(node));
  // Asked, never re-derived. The dock may only promise a path the export has already
  // agreed to write, and `authoredArtifactPathOf` is the *same* decision the refusal
  // above is made from — so a name that is unusable, that its own path would not name
  // back (`agents/SKILL.md`), or that overruns this workflow's namespace gets the
  // problem and no path, rather than a path and a surprise on the export click.
  const path = authoredArtifactPathOf(toGraphNode(node), bundleDirNameFor(workflowName));

  /** One field, edited as an update over the node's data as it is *now*. */
  const field = (key: keyof AuthoredArtifactData) => ({
    onChange: (e: { target: { value: string } }) => {
      // Read out of the event before the updater, as everywhere else in this dock:
      // the control is controlled, so by then the DOM value is back to the prop.
      const value = e.target.value;
      onChange((current) => ({ ...current, [key]: value }));
    },
  });

  const nameField = (
    <label className="pw-field">
      <span>Name</span>
      <input
        value={data.name ?? ""}
        {...field("name")}
        placeholder={
          kind === "skill" ? `From the node's label: ${name || "…"}` : "e.g. report-reviewer"
        }
      />
    </label>
  );

  return (
    <>
      {kind === "agent" && nameField}
      <label className="pw-field pw-field--grow">
        <span>Description</span>
        <textarea
          value={data.description ?? ""}
          {...field("description")}
          placeholder={`When Claude Code should reach for this ${noun}`}
        />
      </label>
      <label className="pw-field pw-field--grow">
        <span>Instructions</span>
        <textarea
          className="pw-authored-body"
          value={data.body ?? ""}
          {...field("body")}
          placeholder={`What this ${noun} does, in Markdown`}
        />
      </label>
      <details className="pw-advanced">
        <summary>Advanced</summary>
        {kind === "skill" && nameField}
        <label className="pw-field">
          <span>Tools</span>
          <input
            value={data.tools ?? ""}
            {...field("tools")}
            placeholder="e.g. Read, Grep, Glob — leave empty for all"
          />
        </label>
        <label className="pw-field">
          <span>Model</span>
          <input value={data.model ?? ""} {...field("model")} placeholder="e.g. opus" />
        </label>
        <label className="pw-field">
          <span>Effort</span>
          <input value={data.effort ?? ""} {...field("effort")} placeholder="e.g. high" />
        </label>
      </details>
      <div className="pw-field pw-field--grow">
        <span>Exported as</span>
        {path === undefined ? (
          <p className="pw-ref pw-ref--unresolved">
            There is nowhere in the bundle to write this {noun} yet — see below.
          </p>
        ) : (
          <p className="pw-ref">
            <code>{path}</code>
            <br />
            Invoked as <code>{name}</code> inside the exported bundle's namespace.
          </p>
        )}
      </div>
      {problems.map((problem) => (
        <p className="pw-ref pw-ref--unresolved" role="status" key={problem}>
          {problem}
        </p>
      ))}
    </>
  );
}

/**
 * Bind a `Skill`/`Agent` node to an artifact from the resolved import catalog.
 *
 * The node stores only the artifact's name plus the id of the root it came from
 * — never a path — so the reference is re-resolved on every open. A reference to
 * an artifact that is no longer present stays selectable and visible, flagged
 * unresolved, rather than being silently reset.
 *
 * Alongside the binding sits the per-node export choice: reference the artifact
 * by name, or copy it into the bundle. It is edited and stored independently of
 * *which* artifact is bound, so re-picking one never quietly changes what the
 * export does with it.
 */
function ArtifactPicker({
  kind,
  data,
  catalog,
  onChange,
}: {
  kind: ArtifactKind;
  data: ArtifactRefData;
  catalog: ImportCatalog;
  onChange: (data: ArtifactRefData | ((current: ArtifactRefData) => ArtifactRefData)) => void;
}) {
  const options = catalogArtifactsOfKind(catalog, kind);
  const bound = data.name === "" ? undefined : findCatalogArtifact(catalog, kind, data.name);
  const noun = kind === "skill" ? "skill" : "agent";
  const exportMode = exportModeOf(data);

  return (
    <>
      <label className="pw-field">
        <span>Imported {noun}</span>
        <select
          value={data.name}
          onChange={(e) => {
            // Updates, not rebuilds — symmetrical with the export-mode select
            // below: this control owns the binding and must leave every other
            // field of the node's data exactly as it currently is.
            //
            // The placeholder unbinds: without this the select would snap back
            // and a bound (or unresolved) node could never be re-picked.
            if (e.target.value === "") {
              onChange((current) => ({ ...current, name: "", rootId: "" }));
              return;
            }
            const picked = findCatalogArtifact(catalog, kind, e.target.value);
            if (!picked) return;
            onChange((current) => ({
              ...current,
              name: picked.name,
              rootId: picked.rootId,
            }));
          }}
        >
          <option value="">Pick an imported {noun}…</option>
          {data.name !== "" && !bound && (
            <option value={data.name}>{data.name} (unresolved)</option>
          )}
          {options.map((option) => (
            <option key={`${option.rootId}/${option.name}`} value={option.name}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <label className="pw-field">
        <span>On export</span>
        <select
          value={exportMode}
          onChange={(e) => {
            // An update, not a rebuild: the mode is independent of the binding, so
            // it must not carry a copy of the binding along with it.
            const mode = e.target.value as ExportMode;
            onChange((current) => ({ ...current, exportMode: mode }));
          }}
        >
          {/* Each option states its consequence: the choice is about whether the
              exported bundle carries this artifact or expects to find it. */}
          <option value="reference">Reference by name — must be installed</option>
          <option value="vendor">Copy into the bundle — runs anywhere</option>
        </select>
      </label>
      <div className="pw-field pw-field--grow">
        <span>Resolves to</span>
        {bound ? (
          <p className="pw-ref">
            <code>{bound.path}</code>
            <br />
            {bound.artifact.description}
          </p>
        ) : (
          <p className="pw-ref pw-ref--unresolved">
            {data.name === ""
              ? `No ${noun} bound yet. ${options.length === 0 ? "No artifacts were found in the configured source roots." : ""}`
              : `'${data.name}' is not in any configured source root right now. Re-point it or restore the root; the reference is kept either way.`}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * How each comparison is offered to the user.
 *
 * A phrase rather than the symbol the canvas node shows: a select is read as a sentence
 * about the value above it ("the value I measure *is greater than* 100"), while a node
 * has room for one line and reads better as an expression.
 */
const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: "is",
  "not-equals": "is not",
  contains: "contains",
  "greater-than": "is greater than",
  "less-than": "is less than",
};

/** The rule a conditional starts from when it is switched to rule-based. */
function freshRule(branches: readonly Branch[]): ConditionalRule {
  return {
    subject: "",
    operator: DEFAULT_RULE_OPERATOR,
    operand: "",
    // Wired to the branches the node already offers, so a new rule routes somewhere
    // instead of naming branches that do not exist.
    whenTrue: branches[0]?.id ?? "",
    whenFalse: branches[1]?.id ?? "",
  };
}

/**
 * Edit the deterministic check a rule-based conditional routes by.
 *
 * The split of labour is what the fields are shaped around, and it is the whole point of
 * the mode (ADR-0004): the **subject** is prose, because the executing model is the only
 * party that can read the work so far and measure it, while everything else is data a
 * shell script compares — so the subject gets a textarea and the rest get controls with
 * a fixed vocabulary.
 *
 * Every edit is an **update** over the node's current data, like every other control in
 * this dock: five fields over one object, and rebuilding it from the rendered props
 * would let two edits landing in the same tick overwrite each other.
 */
function RuleFields({
  rule,
  branches,
  onChange,
}: {
  rule: ConditionalRule;
  branches: readonly Branch[];
  onChange: (edit: (current: ConditionalRule) => ConditionalRule) => void;
}) {
  const numeric = NUMERIC_RULE_OPERATORS.includes(rule.operator);
  // Said here, not only at export: the operand is typed by hand, and "the export was
  // refused" is a worse place to learn that a numeric comparison needs a number — or that
  // the number it was given is one no two shells compare alike.
  // `comparedOperand`, so the dock's verdict is the export's verdict rather than a third
  // spelling of the same normalization — which is what let a padded number pass validation
  // and then refuse to route (see its comment in the schema).
  const written = comparedOperand(rule);
  const operandProblem =
    !numeric || written.trim() === ""
      ? undefined
      : !isWholeNumber(written)
        ? `'${rule.operand}' is not a whole number, and this comparison needs one — the export is refused until it is.`
        : !isComparableNumber(written)
          ? `'${rule.operand}' has more than ${MAX_RULE_NUMBER_DIGITS} digits, and a rule is compared by a shell — only numbers up to ${"9".repeat(MAX_RULE_NUMBER_DIGITS)} compare the same way everywhere. The export is refused until it does.`
          : undefined;
  // Not a problem — ` x ` is a legitimate thing to look for — but the one surface that can
  // say so before the export does. Every other rendering of this value collapses its
  // whitespace, so without this the author has nowhere to see that ` 5` and `5` are two
  // different comparisons.
  const operandNote =
    numeric || written.trim() === "" || written === written.trim()
      ? undefined
      : `This compares against "${written}" exactly, spaces included. Trim it if you did not mean them.`;

  return (
    <>
      <label className="pw-field pw-field--grow">
        <span>Value to measure</span>
        <textarea
          value={rule.subject}
          onChange={(e) => {
            // Read out of the event before the updater, as everywhere else here: the
            // control is controlled, so by then the DOM value is back to the prop.
            const subject = e.target.value;
            onChange((current) => ({ ...current, subject }));
          }}
          placeholder="e.g. the number of files the diff touches"
        />
      </label>
      <label className="pw-field">
        <span>Comparison</span>
        <select
          value={rule.operator}
          onChange={(e) => {
            const operator = e.target.value as RuleOperator;
            // `withOperator`, not a field assignment: changing the comparison changes what
            // the *operand* means, and padding a numeric comparison was ignoring must not
            // become data a string comparison matches on. The rule is the schema's, so the
            // dock, the validator and the compiler cannot drift apart about it.
            onChange((current) => withOperator(current, operator));
          }}
        >
          {(Object.keys(OPERATOR_LABELS) as RuleOperator[]).map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </select>
      </label>
      <label className="pw-field">
        <span>Compared against</span>
        <input
          value={rule.operand}
          onChange={(e) => {
            const operand = e.target.value;
            onChange((current) => ({ ...current, operand }));
          }}
          placeholder={numeric ? "e.g. 10" : "e.g. crash"}
        />
      </label>
      {operandProblem !== undefined && (
        <p className="pw-ref pw-ref--unresolved" role="status">
          {operandProblem}
        </p>
      )}
      {operandNote !== undefined && (
        <p className="pw-ref" role="status">
          {operandNote}
        </p>
      )}
      {(
        [
          ["When it holds, take branch", "whenTrue"],
          ["When it does not, take branch", "whenFalse"],
        ] as const
      ).map(([label, field]) => (
        <label className="pw-field" key={field}>
          <span>{label}</span>
          <select
            value={rule[field]}
            onChange={(e) => {
              // The branch **id**, never its label or position: renaming or reordering a
              // branch is an ordinary edit and must not invert the routing (ADR-0003).
              const picked = e.target.value;
              onChange((current) => ({ ...current, [field]: picked }));
            }}
          >
            {rule[field] !== "" && !branches.some((branch) => branch.id === rule[field]) && (
              <option value={rule[field]}>{rule[field]} (no such branch)</option>
            )}
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.label.trim() || branch.id}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="pw-ref">
        Claude Code measures the value above and the control scaffold exported with this
        workflow compares it, so the same measured value always takes the same branch.
      </p>
    </>
  );
}

/**
 * Edit a conditional: what decides it, the decision that mode needs, and the branches it
 * chooses between.
 *
 * Every edit is sent as an **update** over the node's current data, for the reason the
 * artifact picker is: the question and the branch list are separate controls over one
 * object, and rebuilding it from the rendered props would let two edits landing in the
 * same tick overwrite each other.
 *
 * Adding a branch mints a fresh id and leaves the label empty rather than inventing
 * one: a placeholder label would be a branch the exported prose asks the model to
 * choose by a name the user never wrote, and `validateGraph` names the empty label.
 */
function ConditionalFields({
  data,
  onChange,
}: {
  data: ConditionalData;
  onChange: (edit: (current: ConditionalData) => ConditionalData) => void;
}) {
  // Normalized for *rendering* only, and tolerant of an entry that is not a branch — the
  // shape `workflow-order` already guards against, because a hand-edited file can hold
  // anything in that array. `deserialize` rejects such a file, so this is unreachable
  // through the app; the asymmetry is the point, since a dock that throws takes the whole
  // session to the error boundary while every other surface degrades. What is *written*
  // still goes through `editBranches`, over the data as it actually is.
  const branches: Branch[] = (Array.isArray(data.branches) ? data.branches : []).map(
    (branch) => ({ id: branch?.id ?? "", label: branch?.label ?? "" }),
  );
  /** Rewrite the branch list, leaving every other field of the data as it is. */
  const editBranches = (rewrite: (current: Branch[]) => Branch[]) =>
    onChange((current) => ({
      ...current,
      branches: rewrite(Array.isArray(current.branches) ? current.branches : []),
    }));

  // Both bounds are stated rather than only enforced: a control that stops working without
  // saying why leaves the user guessing at a number they cannot see. The count sits in the
  // field's own label, and the *reason* appears only at a bound — in a `role="status"`
  // region, so it is announced when the limit is reached instead of being discovered as a
  // dead button, and so nothing is announced while there is nothing to say.
  //
  // A rule-based conditional has a third, tighter bound: a rule holds or it does not, so
  // it decides between exactly two branches and both controls are at their limit at once.
  // It is stated the same way rather than silently disabling the buttons.
  const mode = conditionalModeOf(data);
  const exactlyTwo = mode === "rule";
  // A bound is only half the job: the dock also has to leave the way out open. A rule-based
  // conditional switched on with three branches is *over* its bound, and the way back is
  // downwards — so this tightens the **ceiling** to two and leaves the floor where it is.
  // Disabling both at once (which is what `atFloor = exactlyTwo || …` did) locked the extra
  // branches in place and left switching back to LLM, trimming, and switching again as the
  // only route: the dock refusing to repair what it had just made invalid.
  const twoReason =
    branches.length > MIN_BRANCHES_PER_CONDITIONAL
      ? `A rule holds or it does not, so a rule-based conditional decides between exactly two branches (this one has ${branches.length} — remove one).`
      : "A rule holds or it does not, so a rule-based conditional decides between exactly two branches.";
  const atCeiling =
    branches.length >=
    (exactlyTwo ? MIN_BRANCHES_PER_CONDITIONAL : MAX_BRANCHES_PER_CONDITIONAL);
  const atFloor = branches.length <= MIN_BRANCHES_PER_CONDITIONAL;
  const ceilingReason = exactlyTwo
    ? twoReason
    : `At the limit of ${MAX_BRANCHES_PER_CONDITIONAL} branches. Remove one, or branch again inside a branch.`;
  const floorReason = exactlyTwo
    ? twoReason
    : "A conditional offers a choice, so it keeps at least two branches.";

  // A document can be *opened* over the limit — `deserialize` keeps every branch and
  // `validateGraph` refuses the export (ADR-0003) — so the dock has the same job the canvas
  // has: bound what it draws, say what is wrong, and offer the way out. Rendering thousands of
  // text inputs would freeze selecting the node, which is one click from the canvas.
  const excess = branches.length - MAX_BRANCHES_PER_CONDITIONAL;
  const overWidth = excess > 0;
  const shown = branchesWithinLimit(branches);
  const overWidthReason = `${branches.length} branches, over the limit of ${MAX_BRANCHES_PER_CONDITIONAL}. The first ${MAX_BRANCHES_PER_CONDITIONAL} are shown; the export is refused until the rest are removed.`;

  return (
    <>
      <label className="pw-field">
        <span>Decided by</span>
        <select
          value={mode}
          onChange={(e) => {
            const picked = e.target.value as ConditionalMode;
            onChange((current) => ({
              ...current,
              mode: picked,
              // A rule is minted only when there is none. Neither field is ever cleared
              // by switching: looking at the other mode must not cost the user what they
              // wrote, and the compiler reads only the field the mode selects.
              ...(picked === "rule" && current.rule === undefined
                ? {
                    rule: freshRule(
                      Array.isArray(current.branches) ? current.branches : [],
                    ),
                  }
                : {}),
            }));
          }}
        >
          {/* Each option states its consequence, like the export-mode select: the choice
              is about *who* decides this branch when the exported workflow runs. */}
          <option value="llm">Claude Code, from a question — best effort</option>
          <option value="rule">A rule in the control scaffold — deterministic</option>
        </select>
      </label>
      {mode === "llm" ? (
        <label className="pw-field pw-field--grow">
          <span>Decision question</span>
          <textarea
            value={data.question}
            onChange={(e) => {
              // Read out of the event *before* the updater, which runs later: the
              // control is controlled, so by then the DOM value has been set back to
              // the prop and the edit would read as a no-op.
              const question = e.target.value;
              onChange((current) => ({ ...current, question }));
            }}
            placeholder="e.g. Does the report contain a stack trace?"
          />
        </label>
      ) : (
        <RuleFields
          rule={data.rule ?? freshRule(branches)}
          branches={branches}
          onChange={(edit) =>
            onChange((current) => ({
              ...current,
              rule: edit(
                current.rule ??
                  freshRule(Array.isArray(current.branches) ? current.branches : []),
              ),
            }))
          }
        />
      )}
      <div className="pw-field pw-field--grow">
        <span>
          Branches ({branches.length} of {MAX_BRANCHES_PER_CONDITIONAL})
        </span>
        <ul className="pw-branches">
          {shown.map((branch, index) => (
            // Keyed by id, falling back to the position for an entry that has none, so two
            // malformed entries cannot collide on one key.
            <li key={branch.id || `at-${index}`} className="pw-branches__item">
              <input
                // Numbered, not named by the label: the label is what is being
                // edited, so it cannot also be the handle used to find the field.
                aria-label={`Branch ${index + 1} label`}
                value={branch.label}
                onChange={(e) => {
                  // Captured eagerly, as with the question above.
                  const label = e.target.value;
                  // `b?.id`, matching the tolerance the rendered list has: the write side
                  // of a guard is where it has to hold, or editing the *good* branch beside
                  // a malformed entry throws — on the control the user can actually reach.
                  editBranches((current) =>
                    current.map((b) => (b?.id === branch.id ? { ...b, label } : b)),
                  );
                }}
                placeholder="e.g. with trace"
              />
              <button
                aria-label={`Remove branch ${branch.label.trim() || branch.id}`}
                // Two is the floor: fewer is not a choice, and the export refuses it.
                title={atFloor ? floorReason : undefined}
                disabled={atFloor}
                onClick={() =>
                  editBranches((current) => current.filter((b) => b?.id !== branch.id))
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          aria-label="Add branch"
          // The ceiling, as the two-branch floor is a ceiling from below: past it
          // `validateGraph` refuses the document and the canvas draws more source handles
          // than it can draw responsively, so the edit is not offered — and the reason is
          // both on the control and in the status line below it.
          title={atCeiling ? ceilingReason : undefined}
          disabled={atCeiling}
          onClick={() =>
            editBranches((current) => [...current, { id: newId("branch"), label: "" }])
          }
        >
          ＋ Branch
        </button>
        {overWidth && (
          <button
            aria-label={`Remove the ${excess} branches past the limit`}
            // Recovery in the app rather than in a text editor: removing rows one at a time
            // would be thousands of clicks on a generated document. It says exactly how many
            // it removes and touches nothing else, so the loss is the user's choice.
            onClick={() =>
              editBranches((current) => current.slice(0, MAX_BRANCHES_PER_CONDITIONAL))
            }
          >
            Remove the {excess} past the limit
          </button>
        )}
        {(overWidth || atCeiling || atFloor) && (
          <p className="pw-ref pw-ref--unresolved" role="status">
            {overWidth ? overWidthReason : atCeiling ? ceilingReason : floorReason}
          </p>
        )}
        <p className="pw-ref">
          {mode === "llm"
            ? "Claude Code answers the question above at run time and follows the one branch it picks. Wire each branch from its own handle on the node."
            : "The exported scaffold prints one of these labels and Claude Code follows that branch. Wire each branch from its own handle on the node."}
        </p>
      </div>
    </>
  );
}

function InputFields({
  data,
  onChange,
}: {
  data: InputData;
  onChange: (data: InputData) => void;
}) {
  const param = data.parameters[0] ?? { name: "", description: "" };
  const update = (patch: Partial<{ name: string; description: string }>) =>
    onChange({ parameters: [{ ...param, ...patch }] });

  return (
    <>
      <label className="pw-field">
        <span>Parameter name</span>
        <input
          value={param.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="e.g. topic"
        />
      </label>
      <label className="pw-field">
        <span>Description</span>
        <input
          value={param.description ?? ""}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="What the caller should provide"
        />
      </label>
    </>
  );
}

function PromptFields({
  data,
  onChange,
}: {
  data: PromptData;
  onChange: (data: PromptData) => void;
}) {
  return (
    <label className="pw-field pw-field--grow">
      <span>Instruction</span>
      <textarea
        value={data.instruction}
        onChange={(e) => onChange({ instruction: e.target.value })}
        placeholder="e.g. Summarize {topic} in one paragraph."
      />
    </label>
  );
}

function OutputFields({
  data,
  onChange,
}: {
  data: OutputData;
  onChange: (data: OutputData) => void;
}) {
  return (
    <label className="pw-field pw-field--grow">
      <span>Result description</span>
      <textarea
        value={data.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Describe the final result"
      />
    </label>
  );
}
