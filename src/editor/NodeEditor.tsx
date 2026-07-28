import {
  artifactKindOf,
  exportModeOf,
  type ArtifactRefData,
  type ExportMode,
  type InputData,
  type NodeData,
  type NodeType,
  type OutputData,
  type PromptData,
} from "../domain/graph-document";
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
