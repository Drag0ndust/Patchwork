import type {
  InputData,
  NodeData,
  NodeType,
  OutputData,
  PromptData,
} from "../domain/graph-document";
import type { PatchNode } from "../canvas/react-flow-adapter";

interface NodeEditorProps {
  node: PatchNode | null;
  onChange: (id: string, label: string, data: NodeData) => void;
}

const TYPE_LABEL: Record<NodeType, string> = {
  input: "Input",
  prompt: "Prompt",
  output: "Output",
};

export function NodeEditor({ node, onChange }: NodeEditorProps) {
  if (!node) {
    return (
      <div className="pw-dock pw-dock--empty">
        Select a node to edit its details.
      </div>
    );
  }

  const type = node.type as NodeType;
  const { label, node: data } = node.data;

  const emit = (nextLabel: string, nextData: NodeData) =>
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
    </div>
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
