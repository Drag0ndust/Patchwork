import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  type InputData,
  type PatchworkDocument,
  deserialize,
  serialize,
  validateGraph,
} from "./graph-document";

function readFixture(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/** A canonical, well-formed linear graph: Input "topic" -> Prompt -> Output. */
function linearDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: {
      name: "Summarize Topic",
      description: "Summarize a topic into a short paragraph.",
    },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic", description: "The subject to summarize." }] },
      },
      {
        id: "n2",
        type: "prompt",
        label: "Summarize",
        data: { instruction: "Summarize {topic} in one concise paragraph." },
      },
      {
        id: "n3",
        type: "output",
        label: "Summary",
        data: { description: "A one-paragraph summary of the topic." },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  };
}

describe("validateGraph", () => {
  it("given_wellFormedLinearGraph_whenValidating_thenReturnsOk", () => {
    const result = validateGraph(linearDocument());
    expect(result.ok).toBe(true);
  });

  it("given_edgeWithMissingTarget_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.edges.push({ id: "e3", source: "n3", target: "n9" });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Edge e3 references missing target node 'n9'",
    );
  });

  it("given_edgeWithMissingSource_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.edges.push({ id: "e3", source: "nX", target: "n1" });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Edge e3 references missing source node 'nX'",
    );
  });

  it("given_noInputNode_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.nodes = doc.nodes.filter((n) => n.type !== "input");
    doc.edges = doc.edges.filter((e) => e.source !== "n1");

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Graph must contain exactly one Input node (found 0)",
    );
  });

  it("given_noOutputNode_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.nodes = doc.nodes.filter((n) => n.type !== "output");
    doc.edges = doc.edges.filter((e) => e.target !== "n3");

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Graph must contain exactly one Output node (found 0)",
    );
  });

  it("given_emptyWorkflowDescription_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.workflow.description = "   ";

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Workflow must have a description (used as the skill's description so Claude Code can discover it)",
    );
  });

  it("given_twoInputNodes_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.nodes.push({
      id: "n4",
      type: "input",
      label: "Extra",
      data: { parameters: [{ name: "extra" }] },
    });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Graph must contain exactly one Input node (found 2)",
    );
  });
});

describe("validateGraph — workflow name usable as a skill name", () => {
  it.each(["!!!", "日本語", "---", "   "])(
    "given_nameWithNoUsableChars_%s_whenValidating_thenRejectsWithActionableError",
    (name) => {
      const doc = linearDocument();
      doc.workflow.name = name;

      const result = validateGraph(doc);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(
        result.errors.some((e) =>
          e.startsWith("Workflow name must contain at least one letter or digit"),
        ),
      ).toBe(true);
    },
  );
});

describe("validateGraph — linear-chain enforcement", () => {
  it("given_extraStrayEdge_whenValidating_thenRejectsBranchingNode", () => {
    const doc = linearDocument();
    // n1 -> n2 -> n3 already; add a stray n1 -> n3 so n1 branches, n3 merges.
    doc.edges.push({ id: "e3", source: "n1", target: "n3" });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Node 'n1' has 2 outgoing edges; slice 1 supports only a linear chain",
    );
  });

  it("given_disconnectedNode_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.nodes.push({
      id: "orphan",
      type: "prompt",
      label: "Orphan",
      data: { instruction: "unreachable" },
    });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Node 'orphan' is not connected to the workflow",
    );
  });

  it("given_branchingFromInput_whenValidating_thenRejectsWithActionableError", () => {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Branch", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "p1", type: "prompt", label: "A", data: { instruction: "a" } },
        { id: "p2", type: "prompt", label: "B", data: { instruction: "b" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e1", source: "i", target: "p1" },
        { id: "e2", source: "i", target: "p2" },
        { id: "e3", source: "p1", target: "o" },
      ],
    };

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Node 'i' has 2 outgoing edges; slice 1 supports only a linear chain",
    );
  });

  it("given_cycle_whenValidating_thenRejectsWithActionableError", () => {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Cycle", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "p1", type: "prompt", label: "A", data: { instruction: "a" } },
        { id: "p2", type: "prompt", label: "B", data: { instruction: "b" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e1", source: "i", target: "p1" },
        { id: "e2", source: "p1", target: "p2" },
        { id: "e3", source: "p2", target: "p1" },
      ],
    };

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => /Graph contains a cycle through/.test(e))).toBe(
      true,
    );
  });
});

describe("validateGraph — node field content", () => {
  it("given_whitespaceOnlyInstruction_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[1].data as { instruction: string }).instruction = "   ";

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain("Prompt node 'n2' has an empty instruction");
  });

  it("given_emptyParameterName_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[0].data as { parameters: { name: string }[] }).parameters = [
      { name: "  " },
    ];

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Input node 'n1' has a parameter with an empty name",
    );
  });

  it("given_inputWithZeroParameters_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[0].data as { parameters: unknown[] }).parameters = [];

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Input node 'n1' must declare at least one parameter",
    );
  });

  it("given_emptyOutputDescription_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[2].data as { description: string }).description = "   ";

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain("Output node 'n3' has an empty description");
  });

  it("given_parameterNameWithBacktick_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[0].data as { parameters: { name: string }[] }).parameters = [
      { name: "na`me" },
    ];

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(
      result.errors.some((e) =>
        e.startsWith("Input node 'n1' has parameter 'na`me' with invalid characters"),
      ),
    ).toBe(true);
  });
});

describe("validateGraph — duplicate ids", () => {
  it("given_duplicateNodeId_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.nodes.push({
      id: "n2",
      type: "prompt",
      label: "Dup",
      data: { instruction: "also" },
    });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain("Duplicate node id 'n2'");
  });

  it("given_duplicateEdgeId_whenValidating_thenRejectsWithActionableError", () => {
    const doc = linearDocument();
    doc.edges.push({ id: "e1", source: "n2", target: "n3" });

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain("Duplicate edge id 'e1'");
  });
});

describe("validateGraph — deep chains", () => {
  it("given_veryDeepLinearChain_whenValidating_thenReturnsResultWithoutThrowing", () => {
    const total = 20000;
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Deep", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      ],
      edges: [],
    };
    let prev = "i";
    for (let k = 0; k < total - 2; k += 1) {
      const id = `p${k}`;
      doc.nodes.push({
        id,
        type: "prompt",
        label: "P",
        data: { instruction: "do" },
      });
      doc.edges.push({ id: `e${k}`, source: prev, target: id });
      prev = id;
    }
    doc.nodes.push({
      id: "o",
      type: "output",
      label: "Out",
      data: { description: "r" },
    });
    doc.edges.push({ id: "e-last", source: prev, target: "o" });

    let result: ReturnType<typeof validateGraph> | undefined;
    expect(() => {
      result = validateGraph(doc);
    }).not.toThrow();
    expect(result?.ok).toBe(true);
  });
});

describe("serialize/deserialize", () => {
  it("given_document_whenRoundTripped_thenPreservesContent", () => {
    const doc = linearDocument();
    const restored = deserialize(serialize(doc));
    expect(restored).toEqual(doc);
  });

  it("given_jsonMissingSchemaVersion_whenDeserializing_thenThrowsActionableError", () => {
    expect(() => deserialize("{}")).toThrow(
      /not a Patchwork document.*schemaVersion/i,
    );
  });

  it("given_futureSchemaVersion_whenDeserializing_thenThrowsActionableErrorNamingVersion", () => {
    const doc = linearDocument();
    (doc as { schemaVersion: number }).schemaVersion = 999;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      new RegExp(`schemaVersion 999.*expected 1-${CURRENT_SCHEMA_VERSION}`, "i"),
    );
  });

  it("given_schemaVersionBelowTheOldestSupported_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument();
    (doc as { schemaVersion: number }).schemaVersion = 0;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/schemaVersion 0/);
  });

  it("given_documentMissingNodesArray_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument() as Partial<PatchworkDocument>;
    delete doc.nodes;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/'nodes'/);
  });

  it("given_documentMissingEdgesArray_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument() as Partial<PatchworkDocument>;
    delete doc.edges;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/'edges'/);
  });

  it("given_documentMissingWorkflow_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument() as Partial<PatchworkDocument>;
    delete doc.workflow;
    expect(() => deserialize(JSON.stringify(doc))).toThrow(/'workflow'/);
  });

  it("given_nodeMissingData_whenDeserializing_thenThrowsActionableErrorNamingNode", () => {
    const json = JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "X", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In" },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [{ id: "e1", source: "i", target: "o" }],
    });
    expect(() => deserialize(json)).toThrow(/Node 'i' is missing its 'data'/);
  });

  it("given_promptDataWithoutInstruction_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[1] as { data: unknown }).data = { note: "wrong shape" };
    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Prompt node 'n2' must have a string 'instruction'/,
    );
  });

  it("given_inputDataWithoutParameters_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[0] as { data: unknown }).data = { description: "nope" };
    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Input node 'n1' must have a 'parameters' array/,
    );
  });

  it("given_nodeWithUnknownType_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[1] as { type: string }).type = "transform";
    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Node 'n2' has invalid type 'transform'/,
    );
  });
});

/** A chain that reuses imported artifacts: Input -> Skill -> Agent -> Output. */
function importedRefDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: {
      name: "Review Change",
      description: "Implement a change test-first, then review it.",
    },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Task",
        data: { parameters: [{ name: "task", description: "What to build." }] },
      },
      {
        id: "n2",
        type: "skill",
        label: "TDD",
        data: { name: "coding:tdd", rootId: "personal" },
      },
      {
        id: "n3",
        type: "agent",
        label: "Reviewer",
        data: { name: "pr-reviewer", rootId: "project" },
      },
      {
        id: "n4",
        type: "output",
        label: "Verdict",
        data: { description: "The review digest." },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
      { id: "e3", source: "n3", target: "n4" },
    ],
  };
}

describe("validateGraph — imported skill/agent nodes", () => {
  it("given_chainWithSkillAndAgentNodes_whenValidating_thenReturnsOk", () => {
    expect(validateGraph(importedRefDocument())).toEqual({ ok: true });
  });

  it("given_skillNodeWithoutArtifactName_whenValidating_thenRejectsWithActionableError", () => {
    const doc = importedRefDocument();
    doc.nodes[1].data = { name: "", rootId: "personal" };

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Skill node 'n2' is not bound to an artifact yet (pick one from a source root)",
    );
  });

  it("given_agentNodeWithoutRootPointer_whenValidating_thenRejectsWithActionableError", () => {
    const doc = importedRefDocument();
    doc.nodes[2].data = { name: "pr-reviewer", rootId: "" };

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      "Agent node 'n3' is missing the source root its artifact came from",
    );
  });

  it("given_artifactNameWithBacktick_whenValidating_thenRejectsWithActionableError", () => {
    const doc = importedRefDocument();
    doc.nodes[1].data = { name: "tdd`; rm -rf /", rootId: "personal" };

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join("\n")).toMatch(/not a usable artifact name/);
  });

  it("given_documentWithImportedRefs_whenRoundTripped_thenRefsSurvive", () => {
    const doc = importedRefDocument();

    expect(deserialize(serialize(doc))).toEqual(doc);
  });

  it("given_skillNodeMissingRootId_whenDeserializing_thenThrowsActionableError", () => {
    const doc = importedRefDocument();
    (doc.nodes[1] as { data: unknown }).data = { name: "coding:tdd" };

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Skill node 'n2' must have a string 'rootId'/,
    );
  });

  it("given_agentNodeMissingName_whenDeserializing_thenThrowsActionableError", () => {
    const doc = importedRefDocument();
    (doc.nodes[2] as { data: unknown }).data = { rootId: "project" };

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Agent node 'n3' must have a string 'name'/,
    );
  });
});

describe("deserialize — forward migration", () => {
  it("given_schemaV1Fixture_whenDeserializing_thenItOpensAtTheCurrentVersion", () => {
    const migrated = deserialize(readFixture("schema-v1.patchwork"));

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("given_schemaV1Fixture_whenDeserializing_thenSemanticsArePreserved", () => {
    const original = JSON.parse(readFixture("schema-v1.patchwork")) as PatchworkDocument;

    const migrated = deserialize(readFixture("schema-v1.patchwork"));

    expect(migrated.workflow).toEqual(original.workflow);
    expect(migrated.nodes).toEqual(original.nodes);
    expect(migrated.edges).toEqual(original.edges);
  });

  it("given_schemaV1Fixture_whenMigratedAndValidated_thenItIsStillAValidGraph", () => {
    expect(validateGraph(deserialize(readFixture("schema-v1.patchwork")))).toEqual({
      ok: true,
    });
  });

  it("given_migratedV1Document_whenReserialized_thenItIsStoredAtTheCurrentVersion", () => {
    const reserialized = serialize(deserialize(readFixture("schema-v1.patchwork")));

    expect(JSON.parse(reserialized).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("deserialize — fields the canvas renders directly", () => {
  it("given_nonStringLabel_whenDeserializing_thenThrowsInsteadOfCrashingTheRenderLater", () => {
    const doc = linearDocument();
    (doc.nodes[1] as { label: unknown }).label = { evil: 1 };

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Node 'n2' must have a string 'label' \(found a object\)/,
    );
  });

  it("given_missingLabel_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument() as { nodes: Array<Record<string, unknown>> };
    delete doc.nodes[0].label;

    expect(() => deserialize(JSON.stringify(doc))).toThrow(/'label'/);
  });

  it.each([
    ["a string", "nope"],
    ["an array", [1, 2]],
    ["a partial pair", { x: 1 }],
    ["non-numeric coordinates", { x: "1", y: "2" }],
    ["null", null],
    ["NaN", { x: Number.NaN, y: 0 }],
  ])(
    "given_position_that_is_%s_whenDeserializing_thenThrowsActionableError",
    (_case, position) => {
      const doc = linearDocument();
      (doc.nodes[0] as { position: unknown }).position = position;

      expect(() => deserialize(JSON.stringify(doc))).toThrow(
        /Node 'n1' has an invalid 'position'/,
      );
    },
  );

  it("given_wellFormedPosition_whenDeserializing_thenItIsAccepted", () => {
    const doc = linearDocument();
    doc.nodes[0].position = { x: 12, y: -4 };

    expect(deserialize(JSON.stringify(doc)).nodes[0].position).toEqual({ x: 12, y: -4 });
  });
});

describe("deserialize — optional free-text fields", () => {
  it.each([
    ["an object", { evil: 1 }],
    ["a number", 42],
    ["a boolean", true],
    ["an array", ["a"]],
  ])(
    "given_workflowDescription_that_is_%s_whenDeserializing_thenThrowsActionableError",
    (_case, description) => {
      const doc = linearDocument();
      (doc.workflow as { description: unknown }).description = description;

      expect(() => deserialize(JSON.stringify(doc))).toThrow(
        /Workflow 'description' must be a string when present/,
      );
    },
  );

  it("given_absentWorkflowDescription_whenDeserializing_thenItIsAccepted", () => {
    const doc = linearDocument() as { workflow: Record<string, unknown> };
    delete doc.workflow.description;

    expect(() => deserialize(JSON.stringify(doc))).not.toThrow();
  });

  it("given_parameterDescription_thatIsNotAString_whenDeserializing_thenThrowsActionableError", () => {
    const doc = linearDocument();
    (doc.nodes[0].data as InputData).parameters[0].description = { evil: 1 } as never;

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Input node 'n1' parameter 0 'description' must be a string when present/,
    );
  });

  it("given_everyFreeTextFieldWellFormed_whenDeserializedAndCompiled_thenNothingThrows", () => {
    // The class of defect this closes: a value that passes validation and then
    // throws inside a downstream string operation.
    const doc = deserialize(serialize(linearDocument()));

    expect(() => validateGraph(doc)).not.toThrow();
  });
});
