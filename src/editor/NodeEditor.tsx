import {
  artifactKindOf,
  branchesWithinLimit,
  exportModeOf,
  MAX_BRANCHES_PER_CONDITIONAL,
  MIN_BRANCHES_PER_CONDITIONAL,
  type ArtifactRefData,
  type Branch,
  type ConditionalData,
  type ExportMode,
  type InputData,
  type NodeData,
  type NodeType,
  type OutputData,
  type PromptData,
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
 * Edit an LLM conditional: the question the executing model has to answer, and the
 * branches it chooses between.
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
  const branches = Array.isArray(data.branches) ? data.branches : [];
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
  const atCeiling = branches.length >= MAX_BRANCHES_PER_CONDITIONAL;
  const atFloor = branches.length <= MIN_BRANCHES_PER_CONDITIONAL;
  const ceilingReason = `At the limit of ${MAX_BRANCHES_PER_CONDITIONAL} branches. Remove one, or branch again inside a branch.`;
  const floorReason =
    "A conditional offers a choice, so it keeps at least two branches.";

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
      <div className="pw-field pw-field--grow">
        <span>
          Branches ({branches.length} of {MAX_BRANCHES_PER_CONDITIONAL})
        </span>
        <ul className="pw-branches">
          {shown.map((branch, index) => (
            <li key={branch.id} className="pw-branches__item">
              <input
                // Numbered, not named by the label: the label is what is being
                // edited, so it cannot also be the handle used to find the field.
                aria-label={`Branch ${index + 1} label`}
                value={branch.label}
                onChange={(e) => {
                  // Captured eagerly, as with the question above.
                  const label = e.target.value;
                  editBranches((current) =>
                    current.map((b) => (b.id === branch.id ? { ...b, label } : b)),
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
                  editBranches((current) => current.filter((b) => b.id !== branch.id))
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
          Claude Code answers the question above at run time and follows the one branch
          it picks. Wire each branch from its own handle on the node.
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
