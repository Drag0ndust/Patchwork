/**
 * The seam AC 5 lives in: a scanned root becomes a catalog, a node is bound to a
 * catalogued artifact, and the compiled umbrella must reference it by a name
 * Claude Code can actually resolve. Each module in the chain can be right on its
 * own while the composition emits a dead reference, so it is asserted end to end.
 */

import { describe, expect, it } from "vitest";
import { parseArtifactLocation } from "../domain/artifact-codec";
import { compile } from "../domain/compiler";
import {
  CURRENT_SCHEMA_VERSION,
  validateGraph,
  type PatchworkDocument,
} from "../domain/graph-document";
import { buildCatalog, findCatalogArtifact, type ScanReport } from "./catalog";
import { DEFAULT_SOURCE_ROOTS } from "./source-roots";

const PERSONAL = DEFAULT_SOURCE_ROOTS[0];

/**
 * A root laid out the way a plugin really is on disk. Names are DERIVED from the
 * paths with `parseArtifactLocation` rather than hand-written, so this cannot
 * presuppose a naming rule the scanner does not actually implement.
 */
function scannedAt(relativePath: string, description: string) {
  const located = parseArtifactLocation(relativePath);
  if (!located) throw new Error(`${relativePath} is not an artifact location`);
  return {
    rootId: PERSONAL.id,
    kind: located.kind,
    name: located.name,
    path: `${PERSONAL.path}/${relativePath}`,
    contents: `---\nname: ${located.name.split(":").pop()}\ndescription: ${description}\n---\n\nBody.\n`,
  };
}

function pluginScanReport(): ScanReport {
  return {
    artifacts: [
      scannedAt("skills/coding/skills/tdd/SKILL.md", "Red-green-refactor."),
      scannedAt("skills/coding/agents/pr-reviewer.md", "Reviews PRs."),
      scannedAt("skills/coding/agents/implementer.md", "Implements."),
      scannedAt("skills/swift/agents/implementer.md", "Implements in Swift."),
    ],
    problems: [],
  };
}

function documentBoundTo(skillName: string, agentName: string): PatchworkDocument {
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
      { id: "n2", type: "skill", label: "TDD", data: { name: skillName, rootId: PERSONAL.id } },
      {
        id: "n3",
        type: "agent",
        label: "Reviewer",
        data: { name: agentName, rootId: PERSONAL.id },
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

describe("imported artifacts are catalogued under the name Claude Code invokes", () => {
  const catalog = buildCatalog([PERSONAL], pluginScanReport());

  it("given_pluginArtifacts_whenCatalogued_thenEveryNameKeepsItsNamespace", () => {
    expect(catalog.problems).toEqual([]);
    expect(catalog.artifacts.map((a) => a.name)).toEqual([
      "coding:tdd",
      "coding:pr-reviewer",
      "coding:implementer",
      "swift:implementer",
    ]);
  });

  it("given_twoPluginAgentsSharingALeafName_whenCatalogued_thenNeitherShadowsTheOther", () => {
    expect(catalog.collisions).toEqual([]);
    expect(catalog.artifacts.filter((a) => a.kind === "agent")).toHaveLength(3);
  });

  it("given_namespacedNames_whenLookedUp_thenTheBoundArtifactIsFound", () => {
    expect(findCatalogArtifact(catalog, "agent", "coding:pr-reviewer")?.path).toContain(
      "skills/coding/agents/pr-reviewer.md",
    );
    expect(findCatalogArtifact(catalog, "agent", "pr-reviewer")).toBeUndefined();
  });
});

describe("compiling a document bound to catalogued plugin artifacts", () => {
  const catalog = buildCatalog([PERSONAL], pluginScanReport());
  const skill = catalog.artifacts.find((a) => a.kind === "skill")!;
  const agent = findCatalogArtifact(catalog, "agent", "coding:pr-reviewer")!;
  const doc = documentBoundTo(skill.name, agent.name);

  it("given_documentBoundToPluginArtifacts_whenValidated_thenItIsAValidGraph", () => {
    expect(validateGraph(doc)).toEqual({ ok: true });
  });

  it("given_documentBoundToANamespacedAgent_whenCompiled_thenTheUmbrellaReferencesTheResolvableName", () => {
    const umbrella = compile(doc).files[0].contents;

    expect(umbrella).toContain("- subagent `coding:pr-reviewer`");
    expect(umbrella).toContain(
      "2. Delegate to the `coding:pr-reviewer` subagent with the Task tool",
    );
    expect(umbrella).not.toContain("`pr-reviewer`");
  });

  it("given_documentBoundToANamespacedSkill_whenCompiled_thenTheUmbrellaReferencesTheResolvableName", () => {
    const umbrella = compile(doc).files[0].contents;

    expect(umbrella).toContain("- skill `coding:tdd`");
    expect(umbrella).toContain("1. Invoke the `coding:tdd` skill with the Skill tool");
    expect(umbrella).not.toContain("`tdd`");
  });

  it("given_documentBoundToPluginArtifacts_whenCompiled_thenNothingIsCopiedIntoTheBundle", () => {
    const tree = compile(doc);

    expect(tree.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(tree.files[0].contents).not.toContain("Red-green-refactor.");
  });
});
