import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  branchesWithinLimit,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ArtifactRefData,
  type ConditionalData,
  type InputData,
  type OutputData,
  type PromptData,
} from "../domain/graph-document";
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

/**
 * A node bound to an imported artifact. Rendered for both kinds, because the
 * only difference on the canvas is the label and how the reference is invoked.
 */
function ArtifactRefNode({
  data,
  selected,
  kind,
}: NodeProps<PatchNode> & { kind: "skill" | "agent" }) {
  const ref = data.node as ArtifactRefData | undefined;
  const name = ref?.name ?? "";
  const unresolved = data.unresolved === true;

  return (
    <div
      className={`pw-node pw-node--${kind}${selected ? " is-selected" : ""}${
        unresolved ? " is-unresolved" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <header className="pw-node__type">{kind === "skill" ? "Skill" : "Agent"}</header>
      <div className="pw-node__label">
        {data.label || (kind === "skill" ? "Untitled skill" : "Untitled agent")}
      </div>
      <div className="pw-node__detail">
        {name === "" ? "no artifact bound" : name}
      </div>
      {unresolved && (
        <div className="pw-node__warning">unresolved — not in any source root</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function SkillNode(props: NodeProps<PatchNode>) {
  return <ArtifactRefNode {...props} kind="skill" />;
}

export function AgentNode(props: NodeProps<PatchNode>) {
  return <ArtifactRefNode {...props} kind="agent" />;
}

/**
 * A conditional: the decision question, and one source handle per branch.
 *
 * The handle-per-branch is what makes the branch of an edge something the user *draws* rather
 * than a property they set afterwards — a connection out of this node cannot exist without
 * naming a branch. Each row is its own positioning context, so React Flow places that branch's
 * handle beside its label.
 *
 * **What is drawn is bounded, what is stored is not.** A document may be opened with more
 * branches than the export allows (`validateGraph` refuses it, `deserialize` does not — see
 * ADR-0003), and drawing 20,000 handles froze a real browser for 10.8 s on load. So the node
 * draws at most `MAX_BRANCHES_PER_CONDITIONAL` of them and says how many it left out, keeping
 * the load path fast while the document keeps every branch the user has. The node is flagged
 * the way an unresolved artifact reference is: present, editable, and visibly wrong.
 */
export function ConditionalNode({ data, selected }: NodeProps<PatchNode>) {
  const conditional = data.node as ConditionalData | undefined;
  const question = conditional?.question ?? "";
  const branches = Array.isArray(conditional?.branches) ? conditional.branches : [];
  const overWidth = branches.length > MAX_BRANCHES_PER_CONDITIONAL;
  const drawn = branchesWithinLimit(branches);

  return (
    <div
      className={`pw-node pw-node--conditional${selected ? " is-selected" : ""}${
        overWidth ? " is-over-width" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <header className="pw-node__type">Conditional · LLM</header>
      <div className="pw-node__label">{data.label || "Untitled conditional"}</div>
      <div className="pw-node__detail">{summarize(question) || "no question"}</div>
      <ul className="pw-node__branches">
        {drawn.map((branch) => (
          <li key={branch.id} className="pw-node__branch">
            {/* The id, when the label is blank, so a branch is never a nameless
                handle the user cannot tell from the next one. */}
            {(branch.label ?? "").trim() || branch.id}
            <Handle id={branch.id} type="source" position={Position.Right} />
          </li>
        ))}
      </ul>
      {overWidth && (
        <div className="pw-node__warning">
          {`${branches.length} branches, over the limit of ${MAX_BRANCHES_PER_CONDITIONAL} — the rest are in the document but not drawn`}
        </div>
      )}
    </div>
  );
}

export const nodeTypes = {
  input: InputNode,
  prompt: PromptNode,
  output: OutputNode,
  skill: SkillNode,
  agent: AgentNode,
  conditional: ConditionalNode,
};
