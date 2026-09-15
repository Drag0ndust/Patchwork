import {
  artifactKindOf,
  branchesWithinLimit,
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
  type ArtifactRefData,
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
import {
  catalogArtifactsOfKind,
  findCatalogArtifact,
  type ImportCatalog,
} from "../import/catalog";
import type { PatchNode } from "../canvas/react-flow-adapter";

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

export function NodeEditor({ node, catalog, onChange }: NodeEditorProps) {
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
        <ArtifactPicker
          kind={artifactKindOf(type) as ArtifactKind}
          data={data as ArtifactRefData}
          catalog={catalog}
          onChange={(d) =>
            emit(
              label,
              typeof d === "function"
                ? (current) => d(current as ArtifactRefData)
                : d,
            )
          }
        />
      )}
    </div>
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
