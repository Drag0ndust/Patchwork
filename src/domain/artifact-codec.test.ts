import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactRelativePath,
  declaredNameConflict,
  emitArtifact,
  isValidArtifactName,
  parseArtifact,
  parseArtifactLocation,
  type ArtifactKind,
} from "./artifact-codec";

function readFixture(relativePath: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`./__fixtures__/artifacts/${relativePath}`, import.meta.url),
    ),
    "utf8",
  );
}


describe("parseArtifact — skills are directories containing SKILL.md", () => {
  it("given_skillFixture_whenParsed_thenNameAndDescriptionComeFromTheArtifact", () => {
    const artifact = parseArtifact("skill", readFixture("skills/tdd/SKILL.md"), "tdd");

    expect(artifact.kind).toBe("skill");
    expect(artifact.name).toBe("tdd");
    expect(artifact.description).toContain("red-green-refactor loop");
    expect(artifact.body).toContain("# TDD");
  });

  it("given_skillWithoutNameField_whenParsed_thenDirectoryNameIsAuthoritative", () => {
    const artifact = parseArtifact(
      "skill",
      readFixture("skills/conventions/SKILL.md"),
      "conventions",
    );

    expect(artifact.name).toBe("conventions");
  });

  it("given_skillWhoseFrontmatterNameDiffersFromDirectory_whenParsed_thenDirectoryNameWins", () => {
    const source = "---\nname: stale-name\ndescription: A skill.\n---\n\nBody.\n";

    const artifact = parseArtifact("skill", source, "real-name");

    expect(artifact.name).toBe("real-name");
  });
});

describe("parseArtifact — agents are single files", () => {
  it("given_agentFixture_whenParsed_thenItsLocationNamesIt", () => {
    const artifact = parseArtifact(
      "agent",
      readFixture("agents/pr-reviewer.md"),
      "pr-reviewer",
    );

    expect(artifact.kind).toBe("agent");
    expect(artifact.name).toBe("pr-reviewer");
    expect(artifact.description).toContain("structured digest");
  });

  it("given_agentWithoutNameField_whenParsed_thenFileNameIsUsed", () => {
    const source = "---\ndescription: An agent.\n---\n\nBody.\n";

    const artifact = parseArtifact("agent", source, "from-file-name");

    expect(artifact.name).toBe("from-file-name");
    expect(declaredNameConflict(artifact)).toBeUndefined();
  });

  it("given_pluginAgentDeclaringABareName_whenParsed_thenTheNamespaceFromItsLocationSurvives", () => {
    const artifact = parseArtifact(
      "agent",
      readFixture("skills/coding/agents/pr-reviewer.md"),
      "coding:pr-reviewer",
    );

    expect(artifact.name).toBe("coding:pr-reviewer");
  });

  it("given_agentWhoseDeclaredNameDiffersFromItsStem_whenParsed_thenTheLocationWinsAndTheConflictIsSurfaced", () => {
    const source = "---\nname: code-reviewer\ndescription: An agent.\n---\n\nB.\n";

    const artifact = parseArtifact("agent", source, "reviewer");

    expect(artifact.name).toBe("reviewer");
    expect(declaredNameConflict(artifact)).toBe("code-reviewer");
  });

  it("given_pluginAgentDeclaringAnotherNamespacedName_whenParsed_thenItCannotRenameItselfIntoIt", () => {
    const source = "---\nname: other:evil\ndescription: An agent.\n---\n\nB.\n";

    const artifact = parseArtifact("agent", source, "coding:rev");

    expect(artifact.name).toBe("coding:rev");
    expect(declaredNameConflict(artifact)).toBe("other:evil");
  });

  it("given_pluginAgentDeclaringItsBareLeaf_whenParsed_thenThatIsNotTreatedAsAConflict", () => {
    const artifact = parseArtifact(
      "agent",
      readFixture("skills/coding/agents/pr-reviewer.md"),
      "coding:pr-reviewer",
    );

    expect(declaredNameConflict(artifact)).toBeUndefined();
  });

  it("given_agentWhoseDeclaredNameMatchesItsLocation_whenParsed_thenThereIsNoConflict", () => {
    const source = "---\nname: coding:pr-reviewer\ndescription: An agent.\n---\n\nB.\n";

    const artifact = parseArtifact("agent", source, "coding:pr-reviewer");

    expect(artifact.name).toBe("coding:pr-reviewer");
    expect(declaredNameConflict(artifact)).toBeUndefined();
  });

  it("given_twoPluginAgentsSharingALeafName_whenParsed_thenTheirNamesStayDistinct", () => {
    const source = "---\nname: implementer\ndescription: An agent.\n---\n\nB.\n";

    expect(parseArtifact("agent", source, "coding:implementer").name).toBe(
      "coding:implementer",
    );
    expect(parseArtifact("agent", source, "swift:implementer").name).toBe(
      "swift:implementer",
    );
  });

  it("given_agentWithOptionalFrontmatterFields_whenParsed_thenTheyAreKept", () => {
    const artifact = parseArtifact(
      "agent",
      readFixture("agents/pr-reviewer.md"),
      "pr-reviewer",
    );

    expect(artifact.fields.tools).toBe("Read, Grep, Glob, Bash");
    expect(artifact.fields.model).toBe("opus");
    expect(artifact.fields.effort).toBe("high");
  });
});

describe("parseArtifact/emitArtifact — round trip", () => {
  it.each([
    ["skill", "skills/tdd/SKILL.md", "tdd"],
    ["skill", "skills/conventions/SKILL.md", "conventions"],
    ["agent", "agents/pr-reviewer.md", "pr-reviewer"],
    ["agent", "skills/coding/agents/pr-reviewer.md", "coding:pr-reviewer"],
  ] as const)(
    "given_%s_fixture_%s_whenParsedAndEmitted_thenBytesAreUnchanged",
    (kind, fixture, name) => {
      const source = readFixture(fixture);

      expect(emitArtifact(parseArtifact(kind, source, name))).toBe(source);
    },
  );

  it.each([
    ["skill", "skills/tdd/SKILL.md", "tdd"],
    ["skill", "skills/conventions/SKILL.md", "conventions"],
    ["agent", "agents/pr-reviewer.md", "pr-reviewer"],
    ["agent", "skills/coding/agents/pr-reviewer.md", "coding:pr-reviewer"],
  ] as const)(
    "given_%s_fixture_%s_whenEmittedAndReparsed_thenEveryFrontmatterFieldSurvives",
    (kind, fixture, name) => {
      // Vendor-copy re-emits what it parsed, so the fields Claude Code reads
      // (`tools`, `model`, `effort`, ...) have to come back out of the copy —
      // dropping one would silently change how the artifact runs.
      const artifact = parseArtifact(kind, readFixture(fixture), name);

      const reparsed = parseArtifact(kind, emitArtifact(artifact), name);

      expect(reparsed.fields).toEqual(artifact.fields);
      expect(reparsed.description).toBe(artifact.description);
      expect(reparsed.body).toBe(artifact.body);
    },
  );

  it("given_agentWithOptionalFields_whenEmitted_thenToolsModelAndEffortAreStillInTheFrontmatter", () => {
    const artifact = parseArtifact(
      "agent",
      readFixture("agents/pr-reviewer.md"),
      "pr-reviewer",
    );

    const emitted = emitArtifact(artifact);

    expect(emitted).toContain("tools: Read, Grep, Glob, Bash");
    expect(emitted).toContain("model: opus");
    expect(emitted).toContain("effort: high");
  });

  it("given_crlfArtifact_whenParsedAndEmitted_thenLineEndingsSurvive", () => {
    const source = "---\r\nname: crlf\r\ndescription: Windows file.\r\n---\r\n\r\nBody.\r\n";

    const artifact = parseArtifact("agent", source, "crlf");

    expect(artifact.description).toBe("Windows file.");
    expect(emitArtifact(artifact)).toBe(source);
  });

  it("given_artifactWithoutTrailingNewline_whenParsedAndEmitted_thenBytesAreUnchanged", () => {
    const source = "---\nname: terse\ndescription: No trailing newline.\n---";

    expect(emitArtifact(parseArtifact("agent", source, "terse"))).toBe(source);
  });
});

describe("parseArtifact — malformed input is reported, not dropped", () => {
  it("given_sourceWithoutFrontmatter_whenParsed_thenThrowsActionableError", () => {
    expect(() => parseArtifact("skill", "# Just a heading\n", "tdd")).toThrow(
      /skill 'tdd': it is missing its YAML frontmatter block/,
    );
  });

  it("given_unterminatedFrontmatter_whenParsed_thenThrowsActionableError", () => {
    expect(() =>
      parseArtifact("agent", "---\nname: x\ndescription: y\n", "x"),
    ).toThrow(/frontmatter block is never closed/);
  });

  it("given_invalidYamlFrontmatter_whenParsed_thenThrowsActionableError", () => {
    expect(() =>
      parseArtifact("skill", "---\ndescription: [unclosed\n---\n\nBody.\n", "tdd"),
    ).toThrow(/malformed YAML frontmatter/);
  });

  it("given_frontmatterThatIsNotAMapping_whenParsed_thenThrowsActionableError", () => {
    expect(() =>
      parseArtifact("skill", "---\n- one\n- two\n---\n\nBody.\n", "tdd"),
    ).toThrow(/frontmatter must be a mapping/);
  });

  it("given_missingDescription_whenParsed_thenThrowsActionableError", () => {
    expect(() =>
      parseArtifact("skill", "---\nname: tdd\n---\n\nBody.\n", "tdd"),
    ).toThrow(/must declare a non-empty 'description'/);
  });

  it("given_unusableLocationName_whenParsed_thenThrowsActionableError", () => {
    expect(() =>
      parseArtifact("agent", "---\ndescription: y\n---\n\nB.\n", "bad name!"),
    ).toThrow(/is not a usable artifact name/);
  });

  it("given_bomPrefixedArtifact_whenParsed_thenItImportsAndRoundTripsByteFaithfully", () => {
    const source = "\uFEFF---\nname: windows\ndescription: Authored on Windows.\n---\n\nBody.\n";

    const artifact = parseArtifact("skill", source, "windows");

    expect(artifact.description).toBe("Authored on Windows.");
    expect(emitArtifact(artifact)).toBe(source);
  });
});

/** Name <-> location pairs, covering the flat and the plugin layouts. */
const LOCATIONS: Array<[ArtifactKind, string, string]> = [
  ["skill", "tdd", "skills/tdd/SKILL.md"],
  ["skill", "coding:tdd", "skills/coding/skills/tdd/SKILL.md"],

  ["agent", "pr-reviewer", "agents/pr-reviewer.md"],
  ["agent", "coding:pr-reviewer", "skills/coding/agents/pr-reviewer.md"],

];

describe("artifactRelativePath — encodes the skill/agent asymmetry", () => {
  it("given_skillName_whenAskedForPath_thenPointsAtSkillMdInsideItsDirectory", () => {
    expect(artifactRelativePath("skill", "tdd")).toBe("skills/tdd/SKILL.md");
  });

  it("given_agentName_whenAskedForPath_thenPointsAtASingleFile", () => {
    expect(artifactRelativePath("agent", "pr-reviewer")).toBe(
      "agents/pr-reviewer.md",
    );
  });

  it.each(LOCATIONS)(
    "given_%s_named_%s_whenAskedForPath_thenItIsTheClaudeCodeLayout",
    (kind, name, path) => {
      expect(artifactRelativePath(kind, name)).toBe(path);
    },
  );
});

describe("parseArtifactLocation — container segments never become part of a name", () => {
  it.each(LOCATIONS)(
    "given_pathOfThe_%s_named_%s_whenParsed_thenKindAndNameAreRecovered",
    (kind, name, path) => {
      expect(parseArtifactLocation(path)).toEqual({ kind, name });
    },
  );

  it.each(LOCATIONS)(
    "given_%s_named_%s_whenPathIsRoundTripped_thenTheNameSurvives",
    (kind, name) => {
      expect(parseArtifactLocation(artifactRelativePath(kind, name))).toEqual({
        kind,
        name,
      });
    },
  );

  it.each([
    ["a plugin's reference material", "skills/coding/references/guide.md"],
    ["a vendored SKILL.md below a plugin", "skills/coding/references/vendored/SKILL.md"],
    ["nesting deeper than one namespace", "skills/coding/skills/tdd/references/x/SKILL.md"],
    ["a loose file beside the skills", "skills/notes.md"],
    ["an unnamed skill", "skills/SKILL.md"],
    ["an unnamed plugin skill", "skills/coding/skills/SKILL.md"],
    ["a SKILL.md inside agents/", "skills/coding/agents/SKILL.md"],
    ["a bare file name", "SKILL.md"],
    ["a nested personal agent", "agents/nested/reviewer.md"],
    ["something outside skills/ and agents/", "docs/coding/guide.md"],
  ])("given_%s_whenParsed_thenItIsNotAnArtifact", (_case, path) => {
    expect(parseArtifactLocation(path)).toBeNull();
  });
});

describe("isValidArtifactName", () => {
  it.each(["tdd", "pr-reviewer", "coding:tdd", "a.b_c", "x1"])(
    "given_usableName_%s_thenAccepted",
    (name) => {
      expect(isValidArtifactName(name)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["blank", " "],
    ["a space", "has space"],
    ["a backtick", "back`tick"],
    ["a slash", "slash/es"],
    ["dots only", ".."],
    ["a leading hyphen", "-lead"],
    ["a trailing hyphen", "trail-"],
    ["a namespaced leading hyphen", "coding:-lead"],
    ["a namespaced trailing hyphen", "coding:trail-"],
    ["an empty namespace", ":tdd"],
    ["an empty leaf", "coding:"],
    ["a forged extra namespace level", "coding:pr:reviewer"],
    ["a space inside a segment", "coding:pr reviewer"],
  ])("given_unusableName_with_%s_thenRejected", (_case, name) => {
    expect(isValidArtifactName(name)).toBe(false);
  });
});

/**
 * The shared naming table, also driven from the Rust side
 * (`given_the_shared_location_table_when_scanned_then_discovery_matches_it_exactly`).
 * One table, both languages: the rule cannot drift on one side unnoticed.
 */
interface LocationCase {
  path: string;
  artifact: { kind: ArtifactKind; name: string } | null;
  why: string;
}

const SHARED_TABLE: LocationCase[] = (
  JSON.parse(readFixture("../artifact-locations.json")) as { files: LocationCase[] }
).files;

describe("parseArtifactLocation — the shared cross-language table", () => {
  it("given_theSharedTable_whenRead_thenItCoversBothArtifactsAndNonArtifacts", () => {
    expect(SHARED_TABLE.filter((c) => c.artifact !== null).length).toBeGreaterThan(3);
    expect(SHARED_TABLE.filter((c) => c.artifact === null).length).toBeGreaterThan(5);
  });

  it.each(SHARED_TABLE.map((c) => [c.path, c.why, c.artifact] as const))(
    "given_%s_thenItIs_%s",
    (path, _why, artifact) => {
      expect(parseArtifactLocation(path)).toEqual(artifact);
    },
  );
});

describe("isValidArtifactName — length is bounded", () => {
  it("given_aNameAtTheSegmentLimit_thenAccepted", () => {
    expect(isValidArtifactName("a".repeat(64))).toBe(true);
    expect(isValidArtifactName(`${"a".repeat(64)}:${"b".repeat(63)}`)).toBe(true);
  });

  it.each([
    ["a segment one character too long", "a".repeat(65)],
    ["a namespaced segment too long", `coding:${"a".repeat(65)}`],
    ["a name too long overall", `${"a".repeat(64)}:${"b".repeat(64)}`],
    ["a wildly long directory name", "a".repeat(500)],
  ])("given_%s_thenRejected", (_case, name) => {
    expect(isValidArtifactName(name)).toBe(false);
  });

  it("given_anOverLongName_whenImported_thenItIsReportedRatherThanEmittedIntoTheUmbrella", () => {
    const source = "---\ndescription: An artifact.\n---\n\nBody.\n";

    expect(() => parseArtifact("skill", source, "a".repeat(500))).toThrow(
      /is not a usable artifact name.*at most 64 characters per segment/,
    );
  });
})
