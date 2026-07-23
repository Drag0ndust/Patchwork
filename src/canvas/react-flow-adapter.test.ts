import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type PatchworkDocument } from "../domain/graph-document";
import { documentToFlow, flowToDocument } from "./react-flow-adapter";

function doc(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Round Trip", description: "d" },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic", description: "subject" }] },
        position: { x: 10, y: 20 },
      },
      {
        id: "n2",
        type: "output",
        label: "Result",
        data: { description: "the answer" },
        position: { x: 300, y: 20 },
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  };
}

describe("react-flow-adapter", () => {
  it("given_document_whenRoundTrippedThroughFlow_thenPreservesSchema", () => {
    const original = doc();
    const flow = documentToFlow(original);
    const restored = flowToDocument(flow.nodes, flow.edges, original.workflow);
    expect(restored).toEqual(original);
  });

  it("given_documentNode_whenConverted_thenFlowNodeCarriesLabelAndData", () => {
    const flow = documentToFlow(doc());
    const inputNode = flow.nodes.find((n) => n.id === "n1");
    expect(inputNode?.type).toBe("input");
    expect(inputNode?.data.label).toBe("Topic");
    expect(inputNode?.position).toEqual({ x: 10, y: 20 });
  });
});
