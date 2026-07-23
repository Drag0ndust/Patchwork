import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { InputData, OutputData, PromptData } from "../domain/graph-document";
import type { PatchNode } from "./react-flow-adapter";

function summarize(text: string, max = 64): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function InputNode({ data, selected }: NodeProps<PatchNode>) {
  const params = (data.node as InputData | undefined)?.parameters ?? [];
  return (
    <div className={`pw-node pw-node--input${selected ? " is-selected" : ""}`}>
      <header className="pw-node__type">Input</header>
      <div className="pw-node__label">{data.label || "Untitled input"}</div>
      <div className="pw-node__detail">
        {params.length > 0
          ? params.map((p) => p.name).join(", ")
          : "no parameters"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function PromptNode({ data, selected }: NodeProps<PatchNode>) {
  const instruction = (data.node as PromptData | undefined)?.instruction ?? "";
  return (
    <div className={`pw-node pw-node--prompt${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header className="pw-node__type">Prompt</header>
      <div className="pw-node__label">{data.label || "Untitled prompt"}</div>
      <div className="pw-node__detail">
        {summarize(instruction) || "no instruction"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function OutputNode({ data, selected }: NodeProps<PatchNode>) {
  const description = (data.node as OutputData | undefined)?.description ?? "";
  return (
    <div className={`pw-node pw-node--output${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header className="pw-node__type">Output</header>
      <div className="pw-node__label">{data.label || "Untitled output"}</div>
      <div className="pw-node__detail">
        {summarize(description) || "no description"}
      </div>
    </div>
  );
}

export const nodeTypes = {
  input: InputNode,
  prompt: PromptNode,
  output: OutputNode,
};
