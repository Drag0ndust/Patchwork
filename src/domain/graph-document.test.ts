import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isValidArtifactName } from "./artifact-codec";
import {
  branchesOf,
  BUNDLE_DIR_PREFIX,
  CURRENT_SCHEMA_VERSION,
  MAX_BRANCH_LABEL_LENGTH,
  MAX_BRANCH_NESTING_DEPTH,
  MAX_BRANCHES_PER_CONDITIONAL,
  MAX_FAN_OUT,
  MAX_INPUT_LABEL_LENGTH,
  MAX_RULE_NUMBER_DIGITS,
  MAX_WORKFLOW_NODES,
  MAX_BUNDLE_DIR_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  type ArtifactRefData,
  type ConditionalData,
  type GraphNode,
  type ConditionalRule,
  type InputData,
  type PatchworkDocument,
  conditionalModeOf,
  deserialize,
  exportModeOf,
  inputLabelOf,
  loopGuardOf,
  serialize,
  slugify,
  validateGraph,
  withOperator,
  comparedOperand,
  describeRule,
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

  /**
   * The check has to ask `slugify`, not a regex over the name as typed: the slug is
   * derived from the *lowercased* name, and lowercasing can turn an unusable
   * character into a usable one. `İ` (U+0130) is not `[a-z0-9]`, but it lowercases
   * to `i` + U+0307 and so slugs to a perfectly good `i`.
   */
  it.each(["İ", "İİ", "  İ  "])(
    "given_aNameUsableOnlyOnceLowercased_%s_whenValidating_thenAccepted",
    (name) => {
      const doc = linearDocument();
      doc.workflow.name = name;

      expect(slugify(name)).not.toBe("");
      expect(validateGraph(doc).ok).toBe(true);
    },
  );
});

describe("validateGraph — the bundle directory name has to stay discoverable", () => {
  function named(name: string): PatchworkDocument {
    const doc = linearDocument();
    doc.workflow.name = name;
    return doc;
  }

  /**
   * The rule is about the **slug**, not the name as typed, because the two do not
   * have the same length in either direction.
   *
   * `İ` (U+0130, LATIN CAPITAL LETTER I WITH DOT ABOVE — on every Turkish
   * keyboard) lowercases to *two* code units, `i` + U+0307, and the combining mark
   * is not `[a-z0-9]`, so `slugify` turns each one into `i-`: the slug is twice the
   * length of the name. Bounding the typed name would accept a 29-character name
   * that produces a 66-character directory, which is the exact failure this bound
   * exists to keep out of the export.
   *
   * It runs the other way too — 250 spaces slug to nothing — so a name-length rule
   * would also refuse names that export perfectly well.
   */
  it.each([
    ["at the limit in plain ASCII", "a".repeat(MAX_WORKFLOW_NAME_LENGTH), true],
    ["one character past it", "a".repeat(MAX_WORKFLOW_NAME_LENGTH + 1), false],
    ["short but slug-doubling (U+0130)", `a${"İ".repeat(100)}`, false],
    ["the smallest slug-doubling overflow", `a${"İ".repeat(28)}`, false],
    ["one İ short of it", `a${"İ".repeat(27)}`, true],
    ["long but slugging to almost nothing", `a${" ".repeat(250)}`, true],
  ])("given_aWorkflowName_%s_whenValidating_thenAcceptedIs_%s", (_case, name, ok) => {
    expect(validateGraph(named(name)).ok).toBe(ok);
  });

  it("given_aSlugTooLongToExport_whenValidating_thenTheErrorNamesTheFieldAndBothLengths", () => {
    const result = validateGraph(named(`a${"İ".repeat(28)}`));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      `Workflow name is too long to export: it becomes the bundle directory 'patchwork-<slug>', which is also the name Claude Code discovers the exported skill by (and the namespace of anything bundled with it), so it must be at most ${MAX_BUNDLE_DIR_LENGTH} characters — this name produces 66. Shorten it (up to ${MAX_WORKFLOW_NAME_LENGTH} characters is always safe).`,
    );
  });

  it("given_theLongestExportableName_whenSlugged_thenTheBundleDirIsStillAnArtifactName", () => {
    // The binding half of the bound: the bundle directory is the name the umbrella
    // skill is discovered by and the namespace its vendored capabilities are
    // invoked under, so a directory the codec would reject is an export that
    // succeeds and then resolves to nothing.
    const longest = `${BUNDLE_DIR_PREFIX}${slugify("a".repeat(MAX_WORKFLOW_NAME_LENGTH))}`;

    expect(longest.length).toBe(MAX_BUNDLE_DIR_LENGTH);
    expect(isValidArtifactName(longest)).toBe(true);
    expect(isValidArtifactName(`${longest}x`)).toBe(false);
  });

  it("given_theLimit_whenComparedWithWhatTheEmitterAdds_thenAWholeStagingNameStillFits", () => {
    // The other half: the emitter's longest name has to stay within a path
    // component — `.<dirName>.patchwork-previous-<pid>-<nanos>`. Pinned from the Rust
    // side too, against these very constants — see
    // `given_the_staging_name_cost_then_it_matches_the_workflow_name_bound`.
    const longestEmitterName = `.${"d".repeat(MAX_BUNDLE_DIR_LENGTH)}.patchwork-previous-${"9".repeat(10)}-${"9".repeat(19)}`;

    expect(longestEmitterName.length).toBeLessThanOrEqual(255);
    expect(MAX_WORKFLOW_NAME_LENGTH).toBe(MAX_BUNDLE_DIR_LENGTH - "patchwork-".length);
  });
});

describe("validateGraph — connectivity enforcement", () => {
  it("given_extraStrayEdge_whenValidating_thenTheSplitIsAcceptedAsAFanIn", () => {
    const doc = linearDocument();
    // n1 -> n2 -> n3 already; add a stray n1 -> n3 so n1 splits and n3 merges. Since
    // labeled fan-in exists, that is a shape with a meaning rather than an error.
    doc.edges.push({ id: "e3", source: "n1", target: "n3" });

    expect(validateGraph(doc)).toEqual({ ok: true });
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

  it("given_aSplitWhoseSecondPathLeadsNowhere_whenValidating_thenRejectsWithActionableError", () => {
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
      "Node 'p2' has no outgoing edge; every node except the Output node must lead somewhere",
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
    // A chain this long is past `MAX_WORKFLOW_NODES`, so it is refused — but for its size
    // and nothing else: the structural walk still completed over 20,000 nodes without
    // throwing, which is what this test is here for (a chain at the limit is accepted by
    // `given_aDocumentAtTheNodeLimit_whenValidating_thenAccepted`).
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error("expected failure");
    expect(result.errors).toEqual([
      `This workflow has ${total} nodes; at most ${MAX_WORKFLOW_NODES} can be compiled into one skill. Split it into workflows that call each other.`,
    ]);
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

describe("export mode — the per-node vendor-copy vs reference-by-name choice", () => {
  it("given_schemaV2Fixture_whenDeserializing_thenEveryArtifactRefDefaultsToReferenceByName", () => {
    // The prior slice's behaviour: a document saved before the choice existed
    // must keep exporting exactly as it did, i.e. nothing gets copied.
    const migrated = deserialize(readFixture("schema-v2.patchwork"));

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const modes = migrated.nodes
      .filter((n) => n.type === "skill" || n.type === "agent")
      .map((n) => (n.data as ArtifactRefData).exportMode);
    expect(modes).toEqual(["reference", "reference"]);
  });

  it("given_schemaV2Fixture_whenMigrated_thenNothingElseAboutTheNodesChanges", () => {
    const original = JSON.parse(
      readFixture("schema-v2.patchwork"),
    ) as PatchworkDocument;

    const migrated = deserialize(readFixture("schema-v2.patchwork"));

    expect(migrated.workflow).toEqual(original.workflow);
    expect(migrated.edges).toEqual(original.edges);
    expect(migrated.nodes.map((n) => [n.id, n.type, n.label, n.position])).toEqual(
      original.nodes.map((n) => [n.id, n.type, n.label, n.position]),
    );
    expect(validateGraph(migrated)).toEqual({ ok: true });
  });

  it("given_vendorModeNodes_whenRoundTripped_thenTheChoiceSurvives", () => {
    const doc = importedRefDocument();
    doc.nodes[1].data = {
      name: "coding:tdd",
      rootId: "personal",
      exportMode: "vendor",
    };
    doc.nodes[2].data = {
      name: "pr-reviewer",
      rootId: "project",
      exportMode: "reference",
    };

    const restored = deserialize(serialize(doc));

    expect(restored).toEqual(doc);
    expect((restored.nodes[1].data as ArtifactRefData).exportMode).toBe("vendor");
  });

  it.each([
    ["an unknown word", "copy"],
    ["a boolean", true],
    ["null", null],
  ])(
    "given_exportMode_that_is_%s_whenDeserializing_thenThrowsActionableErrorNamingTheNode",
    (_case, exportMode) => {
      const doc = importedRefDocument();
      (doc.nodes[1].data as { exportMode: unknown }).exportMode = exportMode;

      expect(() => deserialize(JSON.stringify(doc))).toThrow(
        /Skill node 'n2' has an invalid 'exportMode'/,
      );
    },
  );

  it("given_handEditedCurrentVersionDocumentWithoutExportMode_whenDeserializing_thenItIsTolerated", () => {
    // Absence is tolerated exactly the way the migration treats it, so a
    // hand-written document does not have to spell out the default.
    const doc = importedRefDocument();

    const restored = deserialize(JSON.stringify(doc));

    expect(exportModeOf(restored.nodes[1].data as ArtifactRefData)).toBe("reference");
    expect(exportModeOf(restored.nodes[2].data as ArtifactRefData)).toBe("reference");
  });

  it("given_refDataWithAnExplicitMode_whenAskedForIt_thenTheStoredChoiceIsReturned", () => {
    expect(
      exportModeOf({ name: "tdd", rootId: "r", exportMode: "vendor" }),
    ).toBe("vendor");
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

/**
 * The canonical LLM conditional graph:
 *
 * ```
 * Input -> Assess -> Conditional -- crash   --> Extract frame -\
 *                                \- unclear --> Ask reporter --+-> Summarize -> Output
 * ```
 *
 * Two labelled branches that fan out and re-converge on one node, which is the
 * smallest graph that is not a chain and still has a single entry and exit.
 */
function conditionalDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: {
      name: "Triage Report",
      description: "Triage a bug report along the path its contents call for.",
    },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Report",
        data: { parameters: [{ name: "report", description: "The raw bug report." }] },
      },
      {
        id: "n2",
        type: "prompt",
        label: "Assess",
        data: { instruction: "Read {report} and list what it does and does not contain." },
      },
      {
        id: "c1",
        type: "conditional",
        label: "Has a stack trace?",
        data: {
          mode: "llm",
          question: "Does the report contain a stack trace?",
          branches: [
            { id: "b1", label: "with trace" },
            { id: "b2", label: "no trace" },
          ],
        },
      },
      {
        id: "n3",
        type: "prompt",
        label: "Extract frame",
        data: { instruction: "Name the failing frame in the stack trace." },
      },
      {
        id: "n4",
        type: "prompt",
        label: "Ask reporter",
        data: { instruction: "List the reproduction details the reporter must add." },
      },
      {
        id: "n5",
        type: "prompt",
        label: "Summarize",
        data: { instruction: "Write the triage summary." },
      },
      {
        id: "n6",
        type: "output",
        label: "Triage",
        data: { description: "The triage summary." },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "c1" },
      { id: "e3", source: "c1", target: "n3", branch: "b1" },
      { id: "e4", source: "c1", target: "n4", branch: "b2" },
      { id: "e5", source: "n3", target: "n5" },
      { id: "e6", source: "n4", target: "n5" },
      { id: "e7", source: "n5", target: "n6" },
    ],
  };
}

/** The conditional node's data, for tests that edit one field of it. */
function conditionalOf(doc: PatchworkDocument): ConditionalData {
  const node = doc.nodes.find((n) => n.type === "conditional");
  if (!node) throw new Error("the conditional document has a conditional node");
  return node.data as ConditionalData;
}

function errorsOf(doc: PatchworkDocument): string[] {
  const result = validateGraph(doc);
  if (result.ok) throw new Error("expected failure");
  return result.errors;
}

describe("validateGraph — LLM conditional nodes", () => {
  it("given_aTwoWayConditionalThatReconverges_whenValidating_thenReturnsOk", () => {
    expect(validateGraph(conditionalDocument())).toEqual({ ok: true });
  });

  it("given_aConditionalWithOneBranch_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches = [{ id: "b1", label: "with trace" }];
    doc.edges = doc.edges.filter((e) => e.id !== "e4");

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' must offer at least two branches to choose between (found 1)",
    );
  });

  it("given_aConditionalWithAnEmptyQuestion_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).question = "   ";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' has an empty decision question; the exported skill has nothing to decide from",
    );
  });

  it("given_aBranchWithAnEmptyLabel_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].label = "  ";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' has a branch with an empty label; a branch is chosen by its label",
    );
  });

  it("given_aBranchLabelWithABacktick_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].label = "no`trace";

    expect(
      errorsOf(doc).some((e) =>
        e.startsWith("Conditional node 'c1' has branch label 'no`trace' with invalid characters"),
      ),
    ).toBe(true);
  });

  it("given_aBranchLabelPastTheLengthLimit_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].label = "a".repeat(MAX_BRANCH_LABEL_LENGTH + 1);

    expect(
      errorsOf(doc).some((e) => e.includes(`at most ${MAX_BRANCH_LABEL_LENGTH} characters`)),
    ).toBe(true);
  });

  it("given_aBranchLabelAtTheLengthLimit_whenValidating_thenAccepted", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].label = "a".repeat(MAX_BRANCH_LABEL_LENGTH);

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it.each([
    ["identical labels", "with trace"],
    ["labels differing only in case", "With Trace"],
    ["labels differing only in surrounding space", " with trace "],
  ])(
    "given_twoBranchesWith_%s_whenValidating_thenRejectsWithActionableError",
    (_case, label) => {
      // The label is what the executing LLM is asked to name back, so two labels it
      // could not tell apart in prose are not two branches.
      const doc = conditionalDocument();
      conditionalOf(doc).branches[1].label = label;

      expect(
        errorsOf(doc).some((e) =>
          e.startsWith("Conditional node 'c1' has two branches labelled"),
        ),
      ).toBe(true);
    },
  );

  it("given_twoBranchesSharingAnId_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].id = "b1";

    expect(errorsOf(doc)).toContain("Conditional node 'c1' has two branches with the id 'b1'");
  });

  it("given_aBranchWithAnEmptyId_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    conditionalOf(doc).branches[1].id = "";
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, branch: "" } : e));

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' has a branch with an empty id; an edge cannot be attached to it",
    );
  });
});

describe("validateGraph — a conditional's outgoing edges carry its branches", () => {
  it("given_anEdgeLeavingAConditionalWithNoBranch_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { id: e.id, source: e.source, target: e.target } : e));

    expect(errorsOf(doc)).toContain(
      "Edge e4 leaves Conditional node 'c1' without a branch; connect it to one of the node's branch handles",
    );
  });

  it("given_anEdgeLeavingAConditionalOnAnUnknownBranch_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, branch: "gone" } : e));

    expect(errorsOf(doc)).toContain(
      "Edge e4 leaves Conditional node 'c1' on branch 'gone', which that node does not offer",
    );
  });

  it("given_anUnwiredBranch_whenValidating_thenRejectsWithActionableError", () => {
    // A branch the LLM may choose and that then leads nowhere is a dead end at
    // runtime, so every declared branch has to be wired.
    const doc = conditionalDocument();
    doc.edges = doc.edges.filter((e) => e.id !== "e4");

    expect(errorsOf(doc)).toContain(
      "Branch 'no trace' of Conditional node 'c1' is not wired to anything; every branch must lead somewhere",
    );
  });

  it("given_aConditionalWithNoOutgoingEdgesAtAll_whenValidating_thenEveryBranchIsReported", () => {
    const doc = conditionalDocument();
    doc.edges = doc.edges.filter((e) => e.source !== "c1");

    const errors = errorsOf(doc);

    expect(errors).toContain(
      "Branch 'with trace' of Conditional node 'c1' is not wired to anything; every branch must lead somewhere",
    );
    expect(errors).toContain(
      "Branch 'no trace' of Conditional node 'c1' is not wired to anything; every branch must lead somewhere",
    );
  });

  it("given_oneBranchWiredTwice_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, branch: "b1" } : e));

    expect(errorsOf(doc)).toContain(
      "Branch 'with trace' of Conditional node 'c1' is wired to 2 nodes; a branch is one path",
    );
  });

  it("given_aBranchOnAnEdgeLeavingSomethingElse_whenValidating_thenRejectsWithActionableError", () => {
    const doc = conditionalDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e1" ? { ...e, branch: "b1" } : e));

    expect(errorsOf(doc)).toContain(
      "Edge e1 carries branch 'b1', but its source node 'n1' is not a Conditional node",
    );
  });
});

describe("validateGraph — a branching graph still has to be followable", () => {
  it("given_aNonConditionalNodeThatSplitsAroundAConditional_whenValidating_thenTheSplitIsAccepted", () => {
    // A plain split runs *every* path; a conditional runs exactly one. Both fan out, and
    // both are followable, so the rule that only a conditional may fan out is gone.
    const doc = conditionalDocument();
    doc.edges.push({ id: "e8", source: "n2", target: "n5" });

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aNodeThatLeadsNowhere_whenValidating_thenRejectsWithActionableError", () => {
    // Reachable now that a graph can fan out: one branch can end mid-air while the
    // other reaches the Output node, and every node is still connected.
    const doc = conditionalDocument();
    doc.edges = doc.edges.filter((e) => e.id !== "e6");

    expect(errorsOf(doc)).toContain(
      "Node 'n4' has no outgoing edge; every node except the Output node must lead somewhere",
    );
  });

  it("given_twoBranchesWiredToTheSameNode_whenValidating_thenAccepted", () => {
    // Not a rejoin: the two branches converge *immediately*, which is a choice the
    // user is allowed to draw (the decision is recorded, both paths then do the same
    // thing). The plan reads it as two empty branches followed by that node.
    const doc = conditionalDocument();
    doc.edges = doc.edges.filter((e) => e.id !== "e4" && e.id !== "e6");
    doc.nodes = doc.nodes.filter((n) => n.id !== "n4");
    doc.edges.push({ id: "e4", source: "c1", target: "n3", branch: "b2" });

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aBranchThatSkipsPastAnOuterConvergencePoint_whenValidating_thenRejectsWithActionableError", () => {
    // A nested conditional whose own branches converge *after* the outer one's
    // convergence point: 'j' is then instructed twice — once at the end of the inner
    // branch, once as the step the outer merge runs into. Drawable on the canvas, and
    // not something the emitted prose could express, so it is refused here.
    //
    //   i -> c1 -x-> c2 -p-> j -> o
    //           \-y-> b -> n -/  ^
    //                 c2 -q-> n --'
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Skipping Branch", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        {
          id: "c1",
          type: "conditional",
          label: "Outer",
          data: {
            mode: "llm",
            question: "Outer?",
            branches: [
              { id: "x", label: "x" },
              { id: "y", label: "y" },
            ],
          },
        },
        {
          id: "c2",
          type: "conditional",
          label: "Inner",
          data: {
            mode: "llm",
            question: "Inner?",
            branches: [
              { id: "p", label: "p" },
              { id: "q", label: "q" },
            ],
          },
        },
        { id: "b", type: "prompt", label: "B", data: { instruction: "b" } },
        { id: "n", type: "prompt", label: "N", data: { instruction: "n" } },
        { id: "j", type: "prompt", label: "J", data: { instruction: "j" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e1", source: "i", target: "c1" },
        { id: "e2", source: "c1", target: "c2", branch: "x" },
        { id: "e3", source: "c1", target: "b", branch: "y" },
        { id: "e4", source: "c2", target: "j", branch: "p" },
        { id: "e5", source: "c2", target: "n", branch: "q" },
        { id: "e6", source: "b", target: "n" },
        { id: "e7", source: "n", target: "j" },
        { id: "e8", source: "j", target: "o" },
      ],
    };

    expect(errorsOf(doc)).toContain(
      "Node 'j' is reached more than once when the workflow is followed; a Conditional's branches must not rejoin before the point where all of them converge",
    );
  });

  it("given_aCycleThroughAConditional_whenValidating_thenTheCycleIsTheReportedProblem", () => {
    // The plan check is skipped while a cycle is present: every node on the cycle is
    // "reached more than once", and burying the cause under its symptoms is not an
    // actionable error list.
    const doc = conditionalDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e6" ? { ...e, target: "n2" } : e));

    const errors = errorsOf(doc);

    expect(errors.some((e) => /Graph contains a cycle through/.test(e))).toBe(true);
    expect(errors.some((e) => /reached more than once/.test(e))).toBe(false);
  });
});

describe("conditional nodes — schema shape and round trip", () => {
  it("given_aConditionalDocument_whenRoundTripped_thenBranchesAndEdgeBranchesSurvive", () => {
    const doc = conditionalDocument();

    expect(deserialize(serialize(doc))).toEqual(doc);
  });

  it("given_aConditionalWithoutAMode_whenAskedForIt_thenItReadsAsLlm", () => {
    // Rule-based conditionals are a later slice; a document that predates the field
    // (or omits it) is an LLM conditional, which is the only mode there is.
    expect(conditionalModeOf({ question: "q?", branches: [] })).toBe("llm");
  });

  it("given_aHandEditedConditionalWithoutAMode_whenDeserializing_thenItIsTolerated", () => {
    const doc = conditionalDocument();
    delete (conditionalOf(doc) as { mode?: string }).mode;

    const restored = deserialize(JSON.stringify(doc));

    expect(conditionalModeOf(conditionalOf(restored))).toBe("llm");
    expect(validateGraph(restored)).toEqual({ ok: true });
  });

  it.each([
    ["an unknown word", "rules"],
    ["a boolean", true],
    ["null", null],
  ])(
    "given_conditionalMode_thatIs_%s_whenDeserializing_thenThrowsActionableErrorNamingTheNode",
    (_case, mode) => {
      const doc = conditionalDocument();
      (conditionalOf(doc) as { mode: unknown }).mode = mode;

      expect(() => deserialize(JSON.stringify(doc))).toThrow(
        /Conditional node 'c1' has an invalid 'mode'/,
      );
    },
  );

  it("given_aConditionalWithoutAQuestion_whenDeserializing_thenThrowsActionableError", () => {
    const doc = conditionalDocument();
    (conditionalOf(doc) as { question: unknown }).question = 7;

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Conditional node 'c1' must have a string 'question'/,
    );
  });

  it("given_aConditionalWithoutABranchesArray_whenDeserializing_thenThrowsActionableError", () => {
    const doc = conditionalDocument();
    (conditionalOf(doc) as { branches: unknown }).branches = "two";

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Conditional node 'c1' must have a 'branches' array/,
    );
  });

  it("given_aBranchWithoutStringFields_whenDeserializing_thenThrowsActionableError", () => {
    const doc = conditionalDocument();
    (conditionalOf(doc).branches as unknown[])[1] = { id: "b2" };

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Conditional node 'c1' branch 1 must have a string 'id' and 'label'/,
    );
  });

  it("given_anEdgeBranchThatIsNotAString_whenDeserializing_thenThrowsActionableError", () => {
    const doc = conditionalDocument();
    (doc.edges[2] as { branch: unknown }).branch = 1;

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /edge at index 2 'branch' must be a string when present/,
    );
  });

  it("given_schemaV3Fixture_whenDeserializing_thenItOpensUnchangedAtTheCurrentVersion", () => {
    // v3 -> v4 only widened the vocabulary (a node type, an optional edge field), so
    // a document from before conditionals existed must open byte-for-byte the same.
    const original = JSON.parse(readFixture("schema-v3.patchwork")) as PatchworkDocument;

    const migrated = deserialize(readFixture("schema-v3.patchwork"));

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.workflow).toEqual(original.workflow);
    expect(migrated.nodes).toEqual(original.nodes);
    expect(migrated.edges).toEqual(original.edges);
    expect(validateGraph(migrated)).toEqual({ ok: true });
  });
});

/**
 * Two conditionals whose ids and branch ids overlap around a space: node `n1` with
 * branch `x y`, and node `n1 x` with branch `y`. Both collapse to `"n1 x y"` under a
 * space-joined composite key.
 *
 * Unreachable through the UI — `newId` never emits a space — but branch ids are
 * attacker-controlled in a hand-edited `.patchwork`, and by ADR-0002/0003 the
 * validator is the boundary for exactly that.
 */
function collidingKeyDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Colliding Keys", description: "d" },
    nodes: [
      { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      {
        id: "n1",
        type: "conditional",
        label: "First",
        data: {
          mode: "llm",
          question: "First?",
          branches: [
            { id: "x y", label: "alpha" },
            { id: "z", label: "beta" },
          ],
        },
      },
      {
        id: "n1 x",
        type: "conditional",
        label: "Second",
        data: {
          mode: "llm",
          question: "Second?",
          branches: [
            { id: "y", label: "gamma" },
            { id: "w", label: "delta" },
          ],
        },
      },
      { id: "m", type: "prompt", label: "Merge", data: { instruction: "merge" } },
      { id: "o", type: "output", label: "Out", data: { description: "r" } },
    ],
    edges: [
      { id: "e1", source: "i", target: "n1" },
      { id: "e2", source: "n1", target: "n1 x", branch: "x y" },
      { id: "e3", source: "n1", target: "m", branch: "z" },
      { id: "e4", source: "n1 x", target: "m", branch: "w" },
      { id: "e5", source: "m", target: "o" },
    ],
  };
}

describe("validateGraph — a branch id cannot borrow another node's wiring", () => {
  it("given_idsThatCollideUnderASpaceJoinedKey_whenValidating_thenTheUnwiredBranchIsStillReported", () => {
    // The false negative: branch 'gamma' of 'n1 x' is wired to nothing, but its key
    // collided with the *wired* branch 'x y' of 'n1', so the export went ahead with a
    // branch that leads nowhere — defeating the rule that refuses exactly that.
    expect(errorsOf(collidingKeyDocument())).toContain(
      "Branch 'gamma' of Conditional node 'n1 x' is not wired to anything; every branch must lead somewhere",
    );
  });

  it("given_idsThatCollideUnderASpaceJoinedKey_whenEveryBranchIsWired_thenTheDocumentIsAccepted", () => {
    // The false positive, the same collision the other way round: two branches wired
    // once each read as one branch wired twice.
    const doc = collidingKeyDocument();
    doc.edges.push({ id: "e6", source: "n1 x", target: "m", branch: "y" });

    expect(validateGraph(doc)).toEqual({ ok: true });
  });
});

describe("validateGraph — how deeply branches may nest", () => {
  /**
   * `depth` conditionals nested one inside the other, closed by a merge chain — the
   * shape whose emitted umbrella grows an indentation level per level.
   */
  function nestedDocument(depth: number): PatchworkDocument {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Nested", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [{ id: "e-in", source: "i", target: "c0" }],
    };
    for (let at = 0; at < depth; at += 1) {
      doc.nodes.push({
        id: `c${at}`,
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      });
      doc.nodes.push({
        id: `m${at}`,
        type: "prompt",
        label: "M",
        data: { instruction: "merge" },
      });
      doc.edges.push({
        id: `a${at}`,
        source: `c${at}`,
        target: at + 1 === depth ? `m${at}` : `c${at + 1}`,
        branch: "a",
      });
      doc.edges.push({ id: `b${at}`, source: `c${at}`, target: `m${at}`, branch: "b" });
      doc.edges.push({
        id: `m${at}-e`,
        source: `m${at}`,
        target: at === 0 ? "o" : `m${at - 1}`,
      });
    }
    return doc;
  }

  it("given_nestingAtTheLimit_whenValidating_thenAccepted", () => {
    expect(validateGraph(nestedDocument(MAX_BRANCH_NESTING_DEPTH))).toEqual({ ok: true });
  });

  it("given_nestingOnePastTheLimit_whenValidating_thenRejectedWithActionableError", () => {
    // Each level adds an indentation level to every line below it, so the emitted
    // umbrella grows with the square of the nesting — 5,000 levels produced a 63 MB
    // `SKILL.md` — and no reader, human or model, can hold that many open choices.
    const result = validateGraph(nestedDocument(MAX_BRANCH_NESTING_DEPTH + 1));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      `Conditionals are nested ${MAX_BRANCH_NESTING_DEPTH + 1} levels deep; at most ${MAX_BRANCH_NESTING_DEPTH} levels can be written as instructions a reader could follow. Converge some branches before opening the next one.`,
    );
  });
});

describe("validateGraph — how large a document may be", () => {
  /** A plain chain of `total` nodes: Input -> prompt... -> Output. */
  function chainOf(total: number): PatchworkDocument {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Chain", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      ],
      edges: [],
    };
    let previous = "i";
    for (let at = 0; at < total - 2; at += 1) {
      doc.nodes.push({
        id: `p${at}`,
        type: "prompt",
        label: "P",
        data: { instruction: "do" },
      });
      doc.edges.push({ id: `e${at}`, source: previous, target: `p${at}` });
      previous = `p${at}`;
    }
    doc.nodes.push({ id: "o", type: "output", label: "Out", data: { description: "r" } });
    doc.edges.push({ id: "e-last", source: previous, target: "o" });
    return doc;
  }

  /** `depth` conditionals nested one inside the other, closed by a merge chain. */
  function nestedOf(depth: number): PatchworkDocument {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Nested", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [{ id: "e-in", source: "i", target: "c0" }],
    };
    for (let at = 0; at < depth; at += 1) {
      doc.nodes.push({
        id: `c${at}`,
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      });
      doc.nodes.push({
        id: `m${at}`,
        type: "prompt",
        label: "M",
        data: { instruction: "merge" },
      });
      doc.edges.push({
        id: `a${at}`,
        source: `c${at}`,
        target: at + 1 === depth ? `m${at}` : `c${at + 1}`,
        branch: "a",
      });
      doc.edges.push({ id: `b${at}`, source: `c${at}`, target: `m${at}`, branch: "b" });
      doc.edges.push({
        id: `m${at}-e`,
        source: `m${at}`,
        target: at === 0 ? "o" : `m${at - 1}`,
      });
    }
    return doc;
  }

  it("given_aDocumentAtTheNodeLimit_whenValidating_thenAccepted", () => {
    expect(validateGraph(chainOf(MAX_WORKFLOW_NODES))).toEqual({ ok: true });
  });

  it("given_aDocumentOneNodePastTheLimit_whenValidating_thenRejectedWithActionableError", () => {
    const result = validateGraph(chainOf(MAX_WORKFLOW_NODES + 1));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      `This workflow has ${MAX_WORKFLOW_NODES + 1} nodes; at most ${MAX_WORKFLOW_NODES} can be compiled into one skill. Split it into workflows that call each other.`,
    );
  });

  it("given_aDocumentFarPastTheLimit_whenValidating_thenItIsRefusedWithoutPlanningIt", () => {
    // The size rules are checked *before* the plan, so the refusal costs what reading the
    // document costs. It used to cost a full plan first: 20,002 nodes took 22.8 s to
    // validate and another 21.9 s to compile, on the renderer's main thread — and past
    // some 16,000 nodes the plan falls back to sweeping reachability, which is quadratic.
    // The budget is loose on purpose: it exists to catch the plan running at all.
    const doc = nestedOf(10_000);
    expect(doc.nodes.length).toBeGreaterThan(MAX_WORKFLOW_NODES);

    const started = performance.now();
    const result = validateGraph(doc);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.startsWith("This workflow has 20002 nodes"))).toBe(
      true,
    );
    // Nothing about nesting is reported: the document was refused before it was walked,
    // and one reason to fix is more actionable than two.
    expect(result.errors.some((e) => e.includes("nested"))).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it("given_aDocumentInsideTheNodeLimitButTooDeeplyNested_whenValidating_thenTheDepthIsReported", () => {
    // Within the size the plan is affordable, so the deeper rule still runs and still says
    // which limit was crossed.
    const doc = nestedOf(2_000);
    expect(doc.nodes.length).toBeLessThan(MAX_WORKFLOW_NODES);

    const result = validateGraph(doc);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.startsWith("Conditionals are nested 2000 levels deep"))).toBe(
      true,
    );
  });
});

describe("validateGraph — how many branches one conditional may offer", () => {
  /**
   * Input -> Conditional(`branches` ways out, all wired to the same next node) -> Prompt ->
   * Output. **Four nodes**, whatever the branch count, so no size bound of the document
   * touches it.
   */
  function wideConditional(branches: number): PatchworkDocument {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Wide", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        {
          id: "c",
          type: "conditional",
          label: "Which?",
          data: {
            mode: "llm",
            question: "Which one?",
            branches: Array.from({ length: branches }, (_, at) => ({
              id: `b${at}`,
              label: `branch ${at}`,
            })),
          },
        },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e-in", source: "i", target: "c" },
        { id: "e-out", source: "p", target: "o" },
        ...Array.from({ length: branches }, (_, at) => ({
          id: `e${at}`,
          source: "c",
          target: "p",
          branch: `b${at}`,
        })),
      ],
    };
    return doc;
  }

  it("given_aConditionalWithFiftyThousandBranches_whenValidating_thenItIsCheckedInLinearTime", () => {
    // The check that refuses an unwired branch used to look each edge's branch up with a
    // linear scan of the node's branch list — O(edges × branches) — so a *four-node*
    // document froze the renderer for 9.8 s at 50,000 branches and 67 s at 200,000, on the
    // one path the export button runs. `compile` was linear throughout, so the freeze was
    // entirely in the check meant to be cheap. The budget is loose on purpose: it is here to
    // catch a return to quadratic, not to police milliseconds.
    const doc = wideConditional(50_000);

    const started = performance.now();
    const result = validateGraph(doc);
    const elapsed = performance.now() - started;

    // Refused — but for the branch count, not by timing out.
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it("given_aConditionalAtTheBranchLimit_whenValidating_thenAccepted", () => {
    expect(validateGraph(wideConditional(MAX_BRANCHES_PER_CONDITIONAL))).toEqual({ ok: true });
  });

  it("given_aConditionalOneBranchPastTheLimit_whenValidating_thenRejectedWithActionableError", () => {
    const result = validateGraph(wideConditional(MAX_BRANCHES_PER_CONDITIONAL + 1));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      `Conditional node 'c' offers ${MAX_BRANCHES_PER_CONDITIONAL + 1} branches; at most ${MAX_BRANCHES_PER_CONDITIONAL} can be written as a choice a reader could make. Decide between fewer, or branch again inside a branch.`,
    );
  });

  it("given_aConditionalPastTheBranchLimit_whenDeserializing_thenItOpensWithEveryBranchIntact", () => {
    // Refusing to *open* the file was the wrong failure mode, and this is the correction. Two
    // hundred thousand branches can be drawn, just slowly — that is a performance defect, not
    // the structural impossibility `assertNodeShape` exists for (an unknown node type has no
    // renderer at all; a non-finite position breaks layout arithmetic). This codebase already
    // has the pattern for "openable but not exportable" one screen away: an artifact reference
    // that resolves to nothing opens, renders flagged, stays editable, and is refused at
    // export. Width now works the same way, and nothing is truncated on the way in — a user
    // must be able to fix the document without losing branches they did not choose to delete.
    const doc = wideConditional(MAX_BRANCHES_PER_CONDITIONAL + 40);

    const opened = deserialize(JSON.stringify(doc));

    expect(opened).toEqual(doc);
    expect(branchesOf(opened.nodes[1])).toHaveLength(MAX_BRANCHES_PER_CONDITIONAL + 40);
  });

  it("given_aConditionalPastTheBranchLimit_whenOpenedAndValidated_thenTheExportIsStillRefused", () => {
    // The hard "no" stays where it belongs: at the export boundary, with a message that names
    // the node and the way out.
    const opened = deserialize(JSON.stringify(wideConditional(MAX_BRANCHES_PER_CONDITIONAL + 1)));

    const result = validateGraph(opened);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toContain(
      `Conditional node 'c' offers ${MAX_BRANCHES_PER_CONDITIONAL + 1} branches; at most ${MAX_BRANCHES_PER_CONDITIONAL} can be written as a choice a reader could make. Decide between fewer, or branch again inside a branch.`,
    );
  });

  it("given_aConditionalAtTheBranchLimit_whenDeserializing_thenItOpens", () => {
    const doc = wideConditional(MAX_BRANCHES_PER_CONDITIONAL);

    expect(deserialize(JSON.stringify(doc))).toEqual(doc);
  });
});

/**
 * The canonical rule-based conditional: the same triage graph, decided by a check the
 * control scaffold evaluates rather than by the model reading a question.
 */
function ruleConditionalDocument(): PatchworkDocument {
  const doc = conditionalDocument();
  const conditional = conditionalOf(doc);
  conditional.mode = "rule";
  conditional.question = "";
  conditional.rule = {
    subject: "the number of stack frames in the report",
    operator: "greater-than",
    operand: "0",
    whenTrue: "b1",
    whenFalse: "b2",
  };
  return doc;
}

describe("validateGraph — rule-based conditional nodes", () => {
  it("given_aRuleBasedConditional_whenValidating_thenReturnsOk", () => {
    expect(validateGraph(ruleConditionalDocument())).toEqual({ ok: true });
  });

  it("given_aRuleBasedConditionalWithNoQuestion_whenValidating_thenTheQuestionIsNotRequired", () => {
    // The question is the *LLM* mode's decision text. A rule states its own check, so
    // demanding a question too would ask the user to write prose nothing reads.
    expect(
      errorsOf({
        ...ruleConditionalDocument(),
        workflow: { name: "", description: "" },
      }).some((e) => e.includes("empty decision question")),
    ).toBe(false);
  });

  it("given_aRuleBasedConditionalWithoutARule_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    delete conditionalOf(doc).rule;

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' is rule-based but has no rule; give it a check the control scaffold can evaluate, or switch it back to LLM-based",
    );
  });

  it("given_aRuleWithNoSubject_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc).rule as ConditionalRule).subject = "   ";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' has a rule with no subject; the control scaffold needs to be told which value to check",
    );
  });

  it("given_aRuleWithAnEmptyOperand_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc).rule as ConditionalRule).operand = "";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' has a rule with nothing to compare against; give it a value",
    );
  });

  it.each(["greater-than", "less-than"] as const)(
    "given_a_%s_ruleComparedAgainstSomethingThatIsNotANumber_whenValidating_thenRejectsWithActionableError",
    (operator) => {
      const doc = ruleConditionalDocument();
      const rule = conditionalOf(doc).rule as ConditionalRule;
      rule.operator = operator;
      rule.operand = "a few";

      expect(errorsOf(doc)).toContain(
        `Conditional node 'c1' compares '${operator}' against 'a few', which is not a whole number; a numeric rule needs one`,
      );
    },
  );

  it.each([
    ["greater-than", "99999999999999999999"],
    ["less-than", "-99999999999999999999"],
  ] as const)(
    "given_a_%s_ruleComparedAgainstANumberNoShellAgreesAbout_whenValidating_thenRejectsWithActionableError",
    (operator, operand) => {
      // A number past what a shell compares reliably is not a comparison at all: `[ -gt ]`
      // fails on it, the failure is swallowed by the `if` that asks it, and the answer that
      // comes out differs between shells. Refused here so an unroutable bundle cannot be
      // exported — see the scaffold's own guard for the other side of the comparison.
      const doc = ruleConditionalDocument();
      const rule = conditionalOf(doc).rule as ConditionalRule;
      rule.operator = operator;
      rule.operand = operand;

      expect(errorsOf(doc)).toContain(
        `Conditional node 'c1' compares '${operator}' against '${operand}', which has more than ${MAX_RULE_NUMBER_DIGITS} digits; a rule is compared by a shell, and only numbers up to ${"9".repeat(MAX_RULE_NUMBER_DIGITS)} compare the same way in every shell`,
      );
    },
  );

  it.each([
    ["the largest comparable number", "9".repeat(MAX_RULE_NUMBER_DIGITS), true],
    ["its negative", `-${"9".repeat(MAX_RULE_NUMBER_DIGITS)}`, true],
    ["one digit more", "1".padEnd(MAX_RULE_NUMBER_DIGITS + 1, "0"), false],
    // Leading zeros are padding, not magnitude: the value is what is compared.
    ["a padded number inside the range", `000000${"9".repeat(MAX_RULE_NUMBER_DIGITS)}`, true],
  ])(
    "given_aNumericRuleComparedAgainst_%s_whenValidating_thenTheRangeVerdictIs_%s",
    (_case, operand, accepted) => {
      const doc = ruleConditionalDocument();
      (conditionalOf(doc).rule as ConditionalRule).operand = operand;

      const result = validateGraph(doc);

      expect(result.ok).toBe(accepted);
      expect(result.ok || result.errors.some((e) => e.includes("digits"))).toBe(true);
    },
  );

  it.each([
    ["equals", "   "],
    ["contains", " \t "],
    ["not-equals", "\n"],
  ] as const)(
    "given_a_%s_ruleComparedAgainstNothingButWhitespace_whenValidating_thenItIsStillNothingToCompareAgainst",
    (operator, operand) => {
      // A string comparison keeps its padding, because padding is data there — but an
      // operand that is *only* padding is not data, it is an unfinished rule. Emptiness is
      // therefore decided on the trimmed value whatever the comparison, and this pins it:
      // deciding it on the verbatim value would export `operand='   '` and route by it.
      const doc = ruleConditionalDocument();
      const rule = conditionalOf(doc).rule as ConditionalRule;
      rule.operator = operator;
      rule.operand = operand;

      expect(errorsOf(doc)).toContain(
        "Conditional node 'c1' has a rule with nothing to compare against; give it a value",
      );
    },
  );

  it.each([
    // Numeric -> string is the sequence that made padding semantic behind the user's back:
    // what was compared as `5` must stay `5`.
    ["greater-than", " 5", "equals", "5"],
    ["less-than", "\t5\n", "contains", "5"],
    // Numeric -> numeric normalizes too; nothing about the comparison changes.
    ["greater-than", " 5", "less-than", "5"],
    // String -> anything keeps what was being compared, because that is what was visible.
    ["contains", " x ", "equals", " x "],
    ["equals", " x ", "greater-than", " x "],
  ] as const)(
    "given_a_%s_ruleAgainst_%j_whenTheComparisonBecomes_%s_thenTheOperandIsWhatWasLastCompared",
    (operator, operand, next, expected) => {
      const rule: ConditionalRule = {
        subject: "the count",
        operator,
        operand,
        whenTrue: "b1",
        whenFalse: "b2",
      };

      const switched = withOperator(rule, next);

      expect(switched).toEqual({ ...rule, operator: next, operand: expected });

      // The invariant, stated as itself: a switch either compares exactly what it compared
      // before, or the user is told — never a different comparison, silently. (The one row
      // that changes what is compared is ` x ` becoming a *number*, which `validateGraph`
      // refuses outright, so nothing about it is quiet.)
      const doc = ruleConditionalDocument();
      conditionalOf(doc).rule = switched;
      const unchanged = comparedOperand(switched) === comparedOperand(rule);
      expect(unchanged || !validateGraph(doc).ok).toBe(true);
    },
  );

  it("given_aPaddedStringOperand_whenTheComparisonDetoursThroughANumericOneAndBack_thenThePaddingSurvives", () => {
    // The reviewer's repro. Each switch satisfies the per-step invariant on its own — the
    // detour keeps the operand, and the return trims what a numeric comparison would have
    // ignored — but *composed* they delete padding the user typed, within one visible frame
    // of tapping through the dropdown. A rule that never compared anything (this one is
    // refused: ` x ` is not a number) has no meaning to normalize towards.
    const rule: ConditionalRule = {
      subject: "the label",
      operator: "contains",
      operand: " x ",
      whenTrue: "b1",
      whenFalse: "b2",
    };

    const detoured = withOperator(rule, "greater-than");
    const back = withOperator(detoured, "contains");

    expect(detoured.operand).toBe(" x ");
    expect(back).toEqual(rule);
  });

  it("given_anyComparisonRoundTrip_whenTheDetourIsRefused_thenNothingTheUserTypedIsTouched", () => {
    // The pin has to be on the **composition**, because that is where the loss lives. Two
    // rules, swept over every pair of comparisons:
    //
    // - if the detour is a rule `validateGraph` refuses, nothing was ever compared through
    //   it, so the operand comes back byte-identical;
    // - if the detour is valid, what it compared is what comes back — the B3 invariant,
    //   asserted across a round trip rather than a single step.
    const operands = [" x ", "x", " 5 ", "5", " 5x ", "0009", " a b "];
    const comparisons = [
      "equals",
      "not-equals",
      "contains",
      "greater-than",
      "less-than",
    ] as const;
    const lost: string[] = [];

    for (const from of comparisons) {
      for (const operand of operands) {
        const rule: ConditionalRule = {
          subject: "the label",
          operator: from,
          operand,
          whenTrue: "b1",
          whenFalse: "b2",
        };
        const doc = ruleConditionalDocument();
        conditionalOf(doc).rule = rule;
        // Only rules that are themselves usable have a meaning to preserve.
        if (!validateGraph(doc).ok) continue;

        for (const via of comparisons) {
          const detoured = withOperator(rule, via);
          const back = withOperator(detoured, from);
          const detour = ruleConditionalDocument();
          conditionalOf(detour).rule = detoured;

          const expected = validateGraph(detour).ok
            ? comparedOperand(detoured)
            : operand;
          if (comparedOperand(back) !== expected) {
            lost.push(
              `${from} ${JSON.stringify(operand)} via ${via}: ${JSON.stringify(
                comparedOperand(back),
              )} != ${JSON.stringify(expected)}`,
            );
          }
        }
      }
    }

    expect(lost).toEqual([]);
  });

  it.each([
    ["a numeric comparison", "greater-than", "100", "lines changed > 100"],
    ["a string comparison", "equals", "closed", 'lines changed = "closed"'],
    // The case the canvas used to render identically to an unpadded rule, because HTML
    // collapses whitespace runs: quoted, the padding is there to see.
    ["a padded string comparison", "equals", " 5", 'lines changed = " 5"'],
    ["interior padding", "contains", "a  b", 'lines changed contains "a  b"'],
    // A padded operand under a numeric comparison is a rule the export refuses, and the
    // padding is why — so the summary shows it rather than rendering as the valid rule it
    // is not.
    ["padding a number cannot have", "greater-than", " 5x ", 'lines changed > " 5x "'],
    // The delimiter is escaped inside the value, so the quoted region has exactly one end
    // however many quotes the operand contains.
    ["an operand containing the delimiter", "contains", 'a"b', 'lines changed contains "a\\"b"'],
    ["an operand containing a backslash", "contains", "a\\b", 'lines changed contains "a\\\\b"'],
  ] as const)(
    "given_%s_whenDescribingTheRule_thenWhatIsComparedIsVisible",
    (_case, operator, operand, expected) => {
      expect(
        describeRule({
          subject: "lines changed",
          operator,
          operand,
          whenTrue: "b1",
          whenFalse: "b2",
        }),
      ).toBe(expected);
    },
  );

  it("given_aRuleBasedConditionalWithThreeBranches_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    conditionalOf(doc).branches.push({ id: "b3", label: "maybe" });
    doc.edges.push({ id: "e8", source: "c1", target: "n5", branch: "b3" });

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' is rule-based and offers 3 branches; a rule holds or it does not, so it decides between exactly two",
    );
  });

  it("given_aRuleRoutedToABranchTheNodeDoesNotOffer_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc).rule as ConditionalRule).whenTrue = "bx";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' routes its rule's true case to branch 'bx', which that node does not offer",
    );
  });

  it("given_aRuleRoutingBothCasesToOneBranch_whenValidating_thenRejectsWithActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc).rule as ConditionalRule).whenFalse = "b1";

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' routes both cases of its rule to branch 'with trace'; a rule chooses between two paths",
    );
  });

  it("given_anUnknownConditionalMode_whenDeserializing_thenThrowsActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc) as { mode: string }).mode = "coin-flip";

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Conditional node 'c1' has an invalid 'mode' 'coin-flip' \(expected one of llm, rule\)/,
    );
  });

  it("given_aRuleWithAnUnknownOperator_whenDeserializing_thenThrowsActionableError", () => {
    const doc = ruleConditionalDocument();
    (conditionalOf(doc).rule as { operator: string }).operator = "sounds-like";

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /Conditional node 'c1' has a rule with an invalid 'operator' 'sounds-like'/,
    );
  });

  it("given_aRuleBasedConditional_whenRoundTripped_thenTheRuleSurvives", () => {
    const doc = ruleConditionalDocument();

    expect(deserialize(serialize(doc))).toEqual(doc);
  });

  it("given_aRuleStoredOnAnLlmConditional_whenValidating_thenItIsIgnoredRatherThanRejected", () => {
    // Toggling a conditional to LLM and back must not cost the user the rule they wrote.
    const doc = ruleConditionalDocument();
    const conditional = conditionalOf(doc);
    conditional.mode = "llm";
    conditional.question = "Does the report contain a stack trace?";

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aConditionalWithNoMode_whenReadingItsMode_thenItIsLlmBased", () => {
    expect(conditionalModeOf({ question: "q", branches: [] })).toBe("llm");
    expect(conditionalModeOf({ mode: "rule", question: "", branches: [] })).toBe("rule");
  });
});

/**
 * The canonical fan-in graph: the Input splits into two paths that are done in turn and
 * come back together at one node, which reads both results under their labels.
 *
 * ```
 * Input -> Draft   -\
 *      \-> Research -+-> Combine -> Output
 * ```
 */
function fanInDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: {
      name: "Brief Topic",
      description: "Draft a brief and check it against research.",
    },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic", description: "The subject." }] },
      },
      {
        id: "n2",
        type: "prompt",
        label: "Draft",
        data: { instruction: "Draft a brief about {topic}." },
      },
      {
        id: "n3",
        type: "prompt",
        label: "Research",
        data: { instruction: "List the facts known about {topic}." },
      },
      {
        id: "n4",
        type: "prompt",
        label: "Combine",
        data: { instruction: "Correct the draft against the facts." },
      },
      {
        id: "n5",
        type: "output",
        label: "Brief",
        data: { description: "The corrected brief." },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n1", target: "n3" },
      { id: "e3", source: "n2", target: "n4" },
      { id: "e4", source: "n3", target: "n4" },
      { id: "e5", source: "n4", target: "n5" },
    ],
  };
}

describe("validateGraph — labeled fan-in", () => {
  it("given_twoPathsThatSplitAndComeBackTogether_whenValidating_thenReturnsOk", () => {
    // Fan-in needs a fan-out to exist at all, so an ordinary node may now split into
    // paths that are all followed — a conditional is where exactly *one* path is taken.
    expect(validateGraph(fanInDocument())).toEqual({ ok: true });
  });

  it("given_anEdgeWithAnInputLabel_whenValidating_thenReturnsOk", () => {
    const doc = fanInDocument();
    doc.edges[2].inputLabel = "the draft";

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_anInputLabelWithABacktick_whenValidating_thenRejectsWithActionableError", () => {
    const doc = fanInDocument();
    doc.edges[2].inputLabel = "the `draft`";

    expect(
      errorsOf(doc).some((e) =>
        e.startsWith("Edge e3 carries input label 'the `draft`' with invalid characters"),
      ),
    ).toBe(true);
  });

  it("given_anInputLabelPastTheLengthLimit_whenValidating_thenRejectsWithActionableError", () => {
    const doc = fanInDocument();
    doc.edges[2].inputLabel = "a".repeat(MAX_INPUT_LABEL_LENGTH + 1);

    expect(
      errorsOf(doc).some((e) => e.includes(`at most ${MAX_INPUT_LABEL_LENGTH} characters`)),
    ).toBe(true);
  });

  it.each([
    ["the node labels", (doc: PatchworkDocument) => {
      doc.nodes[2].label = "Draft";
    }],
    ["the edge labels", (doc: PatchworkDocument) => {
      doc.edges[3].inputLabel = "Draft";
    }],
  ])(
    "given_twoInputsOfOneNodeIndistinguishableBy_%s_whenValidating_thenRejectsWithActionableError",
    (_case, collide) => {
      const doc = fanInDocument();
      collide(doc);

      expect(errorsOf(doc)).toContain(
        "Node 'n4' has two incoming paths labelled 'Draft'; label the edges or rename the nodes so the step can tell its inputs apart",
      );
    },
  );

  it("given_aConditionalWhoseBranchTailsShareALabel_whenValidating_thenTheConvergenceIsNotAFanIn", () => {
    // The blocker this test exists for: the two edges arriving at a conditional's
    // convergence point are the *tails* of two branches, and neither carries a `branch`
    // field once the branch has a step of its own — which is the ordinary case. Only one
    // branch ever runs, so only one result ever arrives, so two branch bodies with the
    // same node label are an ordinary document rather than an ambiguous fan-in.
    const doc = conditionalDocument();
    doc.nodes[3].label = "Draft";
    doc.nodes[4].label = "Draft";

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aConditionalWhoseBranchesGoStraightToTheJoin_whenValidating_thenTheConvergenceIsNotAFanIn", () => {
    // The same shape with no intermediate step, where the arriving edges *do* carry a
    // branch: both spellings of a convergence have to be excluded, not just one.
    const doc = conditionalDocument();
    doc.nodes = doc.nodes.filter((n) => n.id !== "n3" && n.id !== "n4");
    doc.edges = doc.edges.filter((e) => e.id !== "e5" && e.id !== "e6");
    doc.edges = doc.edges.map((e) =>
      e.id === "e3" || e.id === "e4" ? { ...e, target: "n5" } : e,
    );

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aSplitInsideOneBranchWhosePathsShareALabel_whenValidating_thenItIsStillRefused", () => {
    // And the discrimination is by *which list a step belongs to*, not by "anything
    // downstream of a conditional is exempt": two paths that both run inside one branch
    // are a real fan-in, wherever that branch sits.
    const doc = conditionalDocument();
    doc.nodes.push(
      { id: "s1", type: "prompt", label: "Draft", data: { instruction: "one" } },
      { id: "s2", type: "prompt", label: "Draft", data: { instruction: "two" } },
      { id: "s3", type: "prompt", label: "Merge", data: { instruction: "merge" } },
    );
    doc.edges = doc.edges.filter((e) => e.id !== "e5");
    doc.edges.push(
      { id: "e8", source: "n3", target: "s1" },
      { id: "e9", source: "n3", target: "s2" },
      { id: "e10", source: "s1", target: "s3" },
      { id: "e11", source: "s2", target: "s3" },
      { id: "e12", source: "s3", target: "n5" },
    );

    expect(errorsOf(doc)).toContain(
      "Node 's3' has two incoming paths labelled 'Draft'; label the edges or rename the nodes so the step can tell its inputs apart",
    );
  });

  it("given_aNodeSplittingIntoMorePathsThanTheLimit_whenValidating_thenRejectsWithActionableError", () => {
    const doc = fanInDocument();
    for (let at = 0; at < MAX_FAN_OUT; at += 1) {
      doc.nodes.push({
        id: `p${at}`,
        type: "prompt",
        label: `Path ${at}`,
        data: { instruction: "x" },
      });
      doc.edges.push({ id: `ea${at}`, source: "n1", target: `p${at}` });
      doc.edges.push({ id: `eb${at}`, source: `p${at}`, target: "n4" });
    }

    expect(errorsOf(doc)).toContain(
      `Node 'n1' splits into ${MAX_FAN_OUT + 2} paths; at most ${MAX_FAN_OUT} can be written as a list a reader could follow. Merge some of them before splitting again.`,
    );
  });

  it("given_anEdgeInputLabelThatIsNotAString_whenDeserializing_thenThrowsActionableError", () => {
    const doc = fanInDocument();
    (doc.edges[2] as { inputLabel: unknown }).inputLabel = 7;

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /edge at index 2 'inputLabel' must be a string when present/,
    );
  });

  it("given_anEdgeWithNoInputLabel_whenAskingWhatItCarries_thenTheSourceNodesLabelNamesIt", () => {
    const doc = fanInDocument();

    expect(inputLabelOf(doc.edges[2], doc.nodes[1])).toBe("Draft");
    expect(inputLabelOf({ ...doc.edges[2], inputLabel: "the draft" }, doc.nodes[1])).toBe(
      "the draft",
    );
    expect(inputLabelOf(doc.edges[2], { ...doc.nodes[1], label: "  " })).toBe("n2");
  });

  it.each([
    ["blank", "   "],
    ["a tab", "\t"],
    ["a newline", "\n"],
  ])(
    "given_anEdgeLabelledWith_%s_whenAskingWhatItCarries_thenItFallsBackToTheSourceNode",
    (_case, blank) => {
      // Whitespace is not a name. Without the trim the compiler would emit ``Inputs — `  ` ``
      // — a label the reading model is asked to quote back and cannot see — instead of the
      // node label that is right there on the canvas.
      const doc = fanInDocument();
      doc.edges[2].inputLabel = blank;

      expect(inputLabelOf(doc.edges[2], doc.nodes[1])).toBe("Draft");
      expect(validateGraph(doc)).toEqual({ ok: true });
    },
  );
});

/**
 * A guarded loop: `Review` sends the draft round again, at most three times.
 *
 * ```
 * Input -> Draft -> Review -- revise --> (back to Draft)
 *                         \- ship   --> Output
 * ```
 */
function loopDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Refine", description: "Refine a draft until it is good enough." },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic", description: "The subject." }] },
      },
      {
        id: "n2",
        type: "prompt",
        label: "Draft",
        data: { instruction: "Draft a paragraph about {topic}." },
      },
      {
        id: "c1",
        type: "conditional",
        label: "Good enough?",
        data: {
          mode: "llm",
          question: "Does the draft still need work?",
          maxIterations: 3,
          branches: [
            { id: "b1", label: "revise" },
            { id: "b2", label: "ship" },
          ],
        },
      },
      {
        id: "n3",
        type: "output",
        label: "Paragraph",
        data: { description: "The finished paragraph." },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "c1" },
      { id: "e3", source: "c1", target: "n2", branch: "b1" },
      { id: "e4", source: "c1", target: "n3", branch: "b2" },
    ],
  };
}

describe("validateGraph — a cycle is refused unless a loop gate bounds it", () => {
  it("given_aGuardedLoop_whenValidating_thenItIsExportable", () => {
    // The whole of slice 6 in one assertion: a cyclic document is now a legal workflow,
    // and it is legal *because* the conditional its loop passes through says how many
    // passes the exported scaffold may allow.
    expect(validateGraph(loopDocument())).toEqual({ ok: true });
  });

  it("given_aLoopGateWithNoGuard_whenValidating_thenItIsRefusedNamingTheGateAndTheEdge", () => {
    const doc = loopDocument();
    const gate = doc.nodes.find((n) => n.id === "c1") as GraphNode;
    delete (gate.data as ConditionalData).maxIterations;

    const errors = errorsOf(doc);

    expect(errors).toContain(
      "Conditional node 'c1' is a loop gate — edge e3 leads back to node 'n2' — but it has no max-iteration guard; give it a maximum number of passes between 1 and 999999999, which the exported control scaffold counts and stops the loop at",
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["past what every shell compares alike", 1_000_000_000],
  ])(
    "given_aLoopGateGuardedBy_%s_whenValidating_thenItIsRefusedAsNoGuardAtAll",
    (_case, guard) => {
      // A guard out of range is not a smaller bound or a bigger one: it is a loop the
      // scaffold cannot be made to stop, which is the same defect as no guard at all.
      const doc = loopDocument();
      const gate = doc.nodes.find((n) => n.id === "c1") as GraphNode;
      (gate.data as ConditionalData).maxIterations = guard;

      expect(
        errorsOf(doc).some((e) =>
          e.includes(`is guarded by '${guard}', which is not a number of passes`),
        ),
      ).toBe(true);
    },
  );

  it("given_aCycleThroughNoConditional_whenValidating_thenItIsStillRefusedAsACycle", () => {
    // A cycle with nothing to decide whether it runs again has nowhere to put a guard,
    // so it stays the refusal it has always been — with an error that now says what the
    // way out is.
    const doc = loopDocument();
    doc.nodes.push({
      id: "n4",
      type: "prompt",
      label: "Rewrite",
      data: { instruction: "Rewrite it." },
    });
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, target: "n4" } : e));
    doc.edges.push({ id: "e5", source: "n4", target: "n2" });

    expect(
      errorsOf(doc).some((e) => /Graph contains a cycle through/.test(e)),
    ).toBe(true);
  });

  it("given_aLoopGateWhoseEveryBranchLoopsBack_whenValidating_thenItIsRefusedForHavingNoWayOut", () => {
    const doc = loopDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, target: "n2" } : e));
    doc.nodes = doc.nodes.filter((n) => n.id !== "n3");

    expect(
      errorsOf(doc).some((e) =>
        e.includes(
          "is a loop gate whose every branch leads back into the loop",
        ),
      ),
    ).toBe(true);
  });

  it("given_aLoopGateOfferingThreeBranches_whenValidating_thenItIsRefusedForNotBeingATwoWayDecision", () => {
    // The scaffold prints one label when the passes run out, so there has to be exactly
    // one branch that is not the loop.
    const doc = loopDocument();
    const gate = doc.nodes.find((n) => n.id === "c1") as GraphNode;
    (gate.data as ConditionalData).branches.push({ id: "b3", label: "escalate" });
    doc.nodes.push({
      id: "n4",
      type: "prompt",
      label: "Escalate",
      data: { instruction: "Escalate." },
    });
    doc.edges.push({ id: "e5", source: "c1", target: "n4", branch: "b3" });
    doc.edges.push({ id: "e6", source: "n4", target: "n3" });

    expect(errorsOf(doc)).toContain(
      "Conditional node 'c1' is a loop gate and offers 3 branches; a loop gate decides between going round again and leaving the loop, so it decides between exactly two",
    );
  });

  it("given_aGuardedLoopWithAnAmbiguousFanIn_whenValidating_thenThePlanCheckStillRuns", () => {
    // Every plan-derived check used to be skipped the moment a document held a cycle,
    // because every node on one is "reached more than once". A loop is not that, so the
    // checks run — and the fan-in check is the one that proves it, since it can only be
    // asked of a graph that can be followed at all. It also shows the two arrivals being
    // told apart: the two `Note` paths are inputs, the loop-back into the same node is not.
    const doc = loopDocument();
    doc.edges = doc.edges.filter((e) => e.id !== "e1");
    for (const at of [1, 2]) {
      doc.nodes.push({
        id: `s${at}`,
        type: "prompt",
        label: "Note",
        data: { instruction: `note ${at}` },
      });
      doc.edges.push({ id: `e1${at}`, source: "n1", target: `s${at}` });
      doc.edges.push({ id: `e2${at}`, source: `s${at}`, target: "n2" });
    }

    expect(errorsOf(doc)).toContain(
      "Node 'n2' has two incoming paths labelled 'Note'; label the edges or rename the nodes so the step can tell its inputs apart",
    );
  });

  it("given_aGuardOnAConditionalThatDoesNotLoop_whenValidating_thenItIsIgnoredRatherThanRefused", () => {
    // Kept, not validated, like a rule a node switched away from: rerouting an edge to
    // look at the graph without its loop must not cost the user the bound they chose.
    const doc = loopDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e3" ? { ...e, target: "n3" } : e));
    doc.edges = doc.edges.filter((e) => e.id !== "e4");
    (doc.nodes.find((n) => n.id === "c1")?.data as ConditionalData).branches = [
      { id: "b1", label: "revise" },
      { id: "b2", label: "ship" },
    ];
    doc.edges.push({ id: "e4", source: "c1", target: "n3", branch: "b2" });

    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_aGuardThatIsNotANumber_whenDeserializing_thenItIsRejectedAtTheLoadBoundary", () => {
    const doc = loopDocument();
    (doc.nodes.find((n) => n.id === "c1")?.data as Record<string, unknown>).maxIterations =
      "3";

    expect(() => deserialize(JSON.stringify(doc))).toThrow(
      /numeric 'maxIterations' when present/,
    );
  });

  it("given_aGuardedLoop_whenRoundTripped_thenTheGuardSurvives", () => {
    const round = deserialize(serialize(loopDocument()));
    const gate = round.nodes.find((n) => n.id === "c1");

    expect(loopGuardOf(gate?.data as ConditionalData)).toBe(3);
  });
});

describe("deserialize — forward migration to v6", () => {
  it("given_schemaV5Fixture_whenDeserializing_thenItOpensUnchangedAtTheCurrentVersion", () => {
    // v5 -> v6 only widened the vocabulary (a conditional's max-iteration guard), and no
    // v5 document could contain a cycle at all, so a document from before loops opens
    // exactly as it was.
    const original = JSON.parse(readFixture("schema-v5.patchwork")) as PatchworkDocument;

    const migrated = deserialize(readFixture("schema-v5.patchwork"));

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.workflow).toEqual(original.workflow);
    expect(migrated.nodes).toEqual(original.nodes);
    expect(migrated.edges).toEqual(original.edges);
    expect(validateGraph(migrated)).toEqual({ ok: true });
  });

  it("given_schemaV5Fixture_whenDeserializing_thenItsConditionalCarriesNoGuard", () => {
    const migrated = deserialize(readFixture("schema-v5.patchwork"));
    const conditional = migrated.nodes.find((n) => n.type === "conditional");

    expect(loopGuardOf(conditional?.data as ConditionalData)).toBeUndefined();
  });
});

describe("deserialize — forward migration to v5", () => {
  it("given_schemaV4Fixture_whenDeserializing_thenItOpensUnchangedAtTheCurrentVersion", () => {
    // v4 -> v5 only widened the vocabulary (a conditional mode, a rule, an optional edge
    // field), so a document from before rule-based conditionals opens exactly as it was.
    const original = JSON.parse(readFixture("schema-v4.patchwork")) as PatchworkDocument;

    const migrated = deserialize(readFixture("schema-v4.patchwork"));

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.workflow).toEqual(original.workflow);
    expect(migrated.nodes).toEqual(original.nodes);
    expect(migrated.edges).toEqual(original.edges);
    expect(validateGraph(migrated)).toEqual({ ok: true });
  });

  it("given_schemaV4Fixture_whenDeserializing_thenItsConditionalIsStillLlmBased", () => {
    const migrated = deserialize(readFixture("schema-v4.patchwork"));
    const conditional = migrated.nodes.find((n) => n.type === "conditional");

    expect(conditionalModeOf(conditional?.data as ConditionalData)).toBe("llm");
  });
});
