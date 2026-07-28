import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  catalogArtifactsOfKind,
  describeCollision,
  describeCollisions,
  displayValue,
  findCatalogArtifact,
  type ScanReport,
  type ScannedArtifact,
} from "./catalog";
import type { SourceRoot } from "./source-roots";

const PERSONAL: SourceRoot = {
  id: "personal:~/.claude",
  path: "~/.claude",
  role: "personal",
};
const PROJECT: SourceRoot = {
  id: "project:/work/app/.claude",
  path: "/work/app/.claude",
  role: "project",
};

function skillFile(description: string): string {
  return `---\ndescription: ${description}\n---\n\nBody.\n`;
}

function agentFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
}

function scanned(
  root: SourceRoot,
  kind: "skill" | "agent",
  name: string,
  contents: string,
): ScannedArtifact {
  const path =
    kind === "skill"
      ? `${root.path}/skills/${name}/SKILL.md`
      : `${root.path}/agents/${name}.md`;
  return { rootId: root.id, kind, name, path, contents };
}

function report(artifacts: ScannedArtifact[], problems: string[] = []): ScanReport {
  return { artifacts, problems };
}

describe("buildCatalog", () => {
  it("given_skillAndAgentInOneRoot_whenBuilt_thenBothAreImportedWithTheirDescriptions", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        scanned(PERSONAL, "skill", "tdd", skillFile("Red-green-refactor.")),
        scanned(PERSONAL, "agent", "reviewer", agentFile("reviewer", "Reviews PRs.")),
      ]),
    );

    expect(catalog.problems).toEqual([]);
    expect(catalog.artifacts.map((a) => [a.kind, a.name])).toEqual([
      ["skill", "tdd"],
      ["agent", "reviewer"],
    ]);
    expect(catalog.artifacts[0].artifact.description).toBe("Red-green-refactor.");
    expect(catalog.artifacts[0].rootId).toBe(PERSONAL.id);
  });

  it("given_skillInPersonalAndProjectRoots_whenBuilt_thenPersonalWinsAndCollisionIsSurfaced", () => {
    const catalog = buildCatalog(
      [PERSONAL, PROJECT],
      report([
        scanned(PROJECT, "skill", "tdd", skillFile("Project copy.")),
        scanned(PERSONAL, "skill", "tdd", skillFile("Personal copy.")),
      ]),
    );

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0].artifact.description).toBe("Personal copy.");
    expect(catalog.collisions).toHaveLength(1);
    expect(describeCollision(catalog.collisions[0])).toContain(
      "personal wins for a skill",
    );
    expect(describeCollision(catalog.collisions[0])).toContain(
      "/work/app/.claude/skills/tdd/SKILL.md",
    );
  });

  it("given_agentInPersonalAndProjectRoots_whenBuilt_thenProjectWins", () => {
    const catalog = buildCatalog(
      [PERSONAL, PROJECT],
      report([
        scanned(PERSONAL, "agent", "reviewer", agentFile("reviewer", "Personal copy.")),
        scanned(PROJECT, "agent", "reviewer", agentFile("reviewer", "Project copy.")),
      ]),
    );

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0].artifact.description).toBe("Project copy.");
    expect(catalog.artifacts[0].rootId).toBe(PROJECT.id);
  });

  it("given_agentWhoseFrontmatterNameDiffersFromItsFile_whenBuilt_thenTheLocationNameWinsAndTheConflictIsReported", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        scanned(PERSONAL, "agent", "file-name", agentFile("real-name", "An agent.")),
      ]),
    );

    expect(catalog.artifacts[0].name).toBe("file-name");
    expect(catalog.problems[0]).toContain("declares the name 'real-name'");
  });

  it("given_artifactsFromTwoRootsSharingOnePath_whenBuilt_thenEachIsAttributedToItsOwnRoot", () => {
    // Same path configured twice under different roles: identity is role + path,
    // so attribution must not collapse onto the path.
    const asProject: SourceRoot = {
      id: "project:~/.claude",
      path: "~/.claude",
      role: "project",
    };
    const catalog = buildCatalog(
      [PERSONAL, asProject],
      report([
        { ...scanned(PERSONAL, "skill", "tdd", skillFile("Personal.")), rootId: asProject.id },
        scanned(PERSONAL, "skill", "tdd", skillFile("Personal.")),
      ]),
    );

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0].rootId).toBe(PERSONAL.id);
    expect(catalog.artifacts[0].role).toBe("personal");
    expect(describeCollision(catalog.collisions[0])).toContain("root project:~/.claude");
  });

  it("given_oneMalformedArtifact_whenBuilt_thenItIsReportedAndTheRestStillImport", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        scanned(PERSONAL, "skill", "broken", "no frontmatter here\n"),
        scanned(PERSONAL, "skill", "tdd", skillFile("Red-green-refactor.")),
      ]),
    );

    expect(catalog.artifacts.map((a) => a.name)).toEqual(["tdd"]);
    expect(catalog.problems).toEqual([
      expect.stringContaining("skill 'broken': it is missing its YAML frontmatter"),
    ]);
  });

  it("given_scanProblems_whenBuilt_thenTheyAreCarriedThrough", () => {
    const catalog = buildCatalog([PERSONAL], report([], ["Source root '~/.x' is not a directory"]));

    expect(catalog.problems).toEqual(["Source root '~/.x' is not a directory"]);
  });

  it("given_artifactFromAnUnconfiguredRoot_whenBuilt_thenItIsReportedAndIgnored", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([scanned(PROJECT, "skill", "tdd", skillFile("d"))]),
    );

    expect(catalog.artifacts).toEqual([]);
    expect(catalog.problems[0]).toContain("not a configured source root");
  });

  it("given_unknownArtifactKind_whenBuilt_thenItIsReportedAndIgnored", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        {
          rootId: PERSONAL.id,
          kind: "plugin",
          name: "weird",
          path: "/x",
          contents: skillFile("d"),
        },
      ]),
    );

    expect(catalog.artifacts).toEqual([]);
    expect(catalog.problems[0]).toContain("unknown artifact kind 'plugin'");
  });
});

describe("catalog lookups", () => {
  const catalog = buildCatalog(
    [PERSONAL],
    report([
      scanned(PERSONAL, "skill", "tdd", skillFile("Red-green-refactor.")),
      scanned(PERSONAL, "agent", "reviewer", agentFile("reviewer", "Reviews PRs.")),
    ]),
  );

  it("given_boundReference_whenLookedUp_thenTheWinningArtifactIsReturned", () => {
    expect(findCatalogArtifact(catalog, "skill", "tdd")?.path).toContain(
      "skills/tdd/SKILL.md",
    );
  });

  it("given_referenceToAnAbsentArtifact_whenLookedUp_thenUndefinedSoTheNodeReadsUnresolved", () => {
    expect(findCatalogArtifact(catalog, "skill", "moved-away")).toBeUndefined();
  });

  it("given_kind_whenFilteringForThePicker_thenOnlyThatKindIsOffered", () => {
    expect(catalogArtifactsOfKind(catalog, "agent").map((a) => a.name)).toEqual([
      "reviewer",
    ]);
  });
});

describe("buildCatalog — problems reaching the UI are bounded and sanitized", () => {
  it("given_hundredsOfUnparseableArtifacts_whenBuilt_thenProblemsAreCappedWithASummarizingTail", () => {
    const artifacts = Array.from({ length: 400 }, (_, i) =>
      scanned(PERSONAL, "skill", `broken-${i}`, "no frontmatter here\n"),
    );

    const catalog = buildCatalog([PERSONAL], report(artifacts));

    expect(catalog.artifacts).toEqual([]);
    expect(catalog.problems.length).toBeLessThanOrEqual(21);
    expect(catalog.problems.at(-1)).toMatch(/more import problem\(s\)/);
  });

  it("given_aVeryLongDeclaredName_whenBuilt_thenTheNoticeStaysShort", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        scanned(PERSONAL, "agent", "rev", agentFile("a".repeat(200_000), "An agent.")),
      ]),
    );

    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0].length).toBeLessThan(600);
    expect(catalog.problems[0]).toContain("…");
  });

  it("given_anUntrustedValueWithNewlines_whenBuilt_thenTheNoticeStaysOneLine", () => {
    const catalog = buildCatalog(
      [PERSONAL],
      report([
        scanned(PERSONAL, "agent", "rev", agentFile('"evil\\nname"', "An agent.")),
      ]),
    );

    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]).not.toContain("\n");
  });

  it("given_manyScanProblems_whenBuilt_thenTheyAreCappedToo", () => {
    const problems = Array.from({ length: 100 }, (_, i) => `scan problem ${i}`);

    const catalog = buildCatalog([PERSONAL], report([], problems));

    expect(catalog.problems.length).toBeLessThanOrEqual(21);
  });
});

describe("collision notices are bounded too", () => {
  /** Two roots, each holding `count` identically-named skills. */
  function overlappingRoots(count: number): ScanReport {
    const artifacts = [];
    for (const root of [PERSONAL, PROJECT]) {
      for (let i = 0; i < count; i += 1) {
        artifacts.push(scanned(root, "skill", `skill-${i}`, skillFile("Overlap.")));
      }
    }
    return report(artifacts);
  }

  it("given_hundredsOfCollisions_whenDescribed_thenTheNoticeListIsBounded", () => {
    const catalog = buildCatalog([PERSONAL, PROJECT], overlappingRoots(512));

    expect(catalog.collisions).toHaveLength(512);
    const notices = describeCollisions(catalog.collisions);
    expect(notices.length).toBeLessThanOrEqual(21);
    expect(notices.at(-1)).toMatch(/more shadowed artifact\(s\)/);
    expect(notices.join("").length).toBeLessThan(10_000);
  });

  it("given_manyShadowersOfOneName_whenDescribed_thenThePerLineListIsBounded", () => {
    const roots = Array.from({ length: 16 }, (_, i) => ({
      id: `project:/work/${i}/.claude`,
      path: `/work/${i}/.claude`,
      role: "project" as const,
    }));
    const artifacts = roots.map((root) =>
      scanned(root, "skill", "tdd", skillFile("Overlap.")),
    );

    const catalog = buildCatalog(roots, report(artifacts));
    const [notice] = describeCollisions(catalog.collisions);

    expect(catalog.collisions[0].shadowed).toHaveLength(15);
    expect(notice).toMatch(/and 12 more$/);
    expect(notice.length).toBeLessThan(400);
  });

  it("given_aCollisionWithOneShadower_whenDescribed_thenItIsNamedInFull", () => {
    const catalog = buildCatalog([PERSONAL, PROJECT], overlappingRoots(1));

    expect(describeCollisions(catalog.collisions)[0]).toContain(
      "/work/app/.claude/skills/skill-0/SKILL.md",
    );
  });
});

describe("displayValue", () => {
  it("given_aLongValueEndingInASurrogatePair_whenTruncated_thenNoLoneHalfIsLeft", () => {
    const value = `${"a".repeat(119)}😀tail`;

    const shown = displayValue(value);

    expect(shown.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(shown.slice(0, -1))).toBe(false);
  });

  it("given_aValueWithNewlinesAndTabs_whenShown_thenItIsOneLine", () => {
    expect(displayValue("a\n\tb  c")).toBe("a b c");
  });
});
