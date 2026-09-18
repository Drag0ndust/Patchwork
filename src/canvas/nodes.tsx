import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  authoredArtifactName,
  authoredArtifactOf,
  branchesWithinLimit,
  conditionalModeOf,
  describeRule,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ArtifactRefData,
  type ConditionalData,
  type GraphNode,
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
 * A node whose step is an artifact. Rendered for both kinds, because the only
 * difference on the canvas is the label and how the artifact is invoked — and for
 * both ways an artifact comes to be, because *that* difference is worth a glance.
 *
 * An **authored** artifact was written in this graph: it ships inside the exported
 * bundle, there is no reference to resolve, and the name it will be invoked by is
 * derived (a skill takes its node's label — see `authoredArtifactName`). So it says
 * so in its header, shows the derived name, and never carries the unresolved flag —
 * that flag would claim a dependency on a source root the node does not have.
 */
function ArtifactRefNode({
  data,
  selected,
  kind,
}: NodeProps<PatchNode> & { kind: "skill" | "agent" }) {
  const label = kind === "skill" ? "Skill" : "Agent";
  const node: GraphNode = {
    id: "",
    type: kind,
    label: data.label,
    data: data.node,
  };
  const authored = authoredArtifactOf(node);
  const name =
    authored === undefined
      ? ((data.node as ArtifactRefData | undefined)?.name ?? "")
      : authoredArtifactName(node);
  // Only an imported reference can be unresolved; see the note above.
  const unresolved = authored === undefined && data.unresolved === true;
  const missing = authored === undefined ? "no artifact bound" : "not named yet";

  return (
    <div
      className={`pw-node pw-node--${kind}${selected ? " is-selected" : ""}${
        authored ? " is-authored" : ""
      }${unresolved ? " is-unresolved" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <header className="pw-node__type">{authored ? `${label} · Authored` : label}</header>
      <div className="pw-node__label">
        {data.label || (kind === "skill" ? "Untitled skill" : "Untitled agent")}
      </div>
      <div className="pw-node__detail">{name === "" ? missing : name}</div>
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
  // Which of the two decides this branch is the most consequential thing about the node
  // — a question the executing model judges, or a check the exported control scaffold
  // evaluates — so it is on the node itself, where a workflow is read, and not only in
  // the dock, where one node at a time is edited.
  const mode = conditionalModeOf(conditional ?? { question: "", branches: [] });
  const rule = conditional?.rule;
  // A rule with nothing measured yet is "no rule", not the bare comparison it would
  // summarise to: a node freshly switched to rule-based should read as unfinished.
  const detail =
    mode === "rule"
      ? rule === undefined || (rule.subject ?? "").trim() === ""
        ? "no rule"
        : summarize(describeRule(rule))
      : summarize(conditional?.question ?? "") || "no question";
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
      <header className="pw-node__type">
        {mode === "rule" ? "Conditional · Rule" : "Conditional · LLM"}
      </header>
      <div className="pw-node__label">{data.label || "Untitled conditional"}</div>
      <div className="pw-node__detail">{detail}</div>
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
