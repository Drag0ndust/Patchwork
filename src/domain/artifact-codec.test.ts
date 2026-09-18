import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactRelativePath,
  composeArtifact,
  declaredNameConflict,
  emitArtifact,
  isValidArtifactName,
  parseArtifact,
  parseArtifactLocation,
  type ArtifactKind,
} from "./artifact-codec";

/**
 * Read an emitted artifact's frontmatter back with **PyYAML** — a YAML 1.1 parser this
 * repo did not write — so that "valid by construction" is checked against the reader
 * that actually consumes these files rather than against the one that wrote them.
 */
function pyYamlFrontmatter(source: string): unknown {
  const text = source.split("---\n")[1] ?? "";
  return JSON.parse(
    execFileSync(
      "python3",
      ["-c", "import sys, json, yaml; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)"],
      { input: text, encoding: "utf8" },
    ),
  );
}

/** Whether this machine has PyYAML at all; the cross-parser check is skipped if not. */
const PY_YAML_AVAILABLE = (() => {
  try {
    pyYamlFrontmatter("---\nname: probe\n---\n");
    return true;
  } catch {
    return false;
  }
})();

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

describe("composeArtifact — an artifact authored in the graph, not read off disk", () => {
  it("given_theMinimalSkillFields_whenComposed_thenItEmitsAsAValidSkillFile", () => {
    const artifact = composeArtifact({
      kind: "skill",
      name: "triage",
      description: "Triage an incoming bug report.",
      body: "# Triage\n\nRead the report.\n",
    });

    expect(emitArtifact(artifact)).toBe(
      "---\nname: triage\ndescription: Triage an incoming bug report.\n---\n\n# Triage\n\nRead the report.\n",
    );
  });

  it("given_theMinimalAgentFields_whenComposed_thenItEmitsAsAValidAgentFile", () => {
    const artifact = composeArtifact({
      kind: "agent",
      name: "summarizer",
      description: "Summarizes a long document.",
      body: "You summarize documents.\n",
    });

    expect(emitArtifact(artifact)).toBe(
      "---\nname: summarizer\ndescription: Summarizes a long document.\n---\n\nYou summarize documents.\n",
    );
  });

  it("given_theAdvancedFields_whenComposed_thenEachOneIsEmittedInTheOrderTheRealArtifactsUse", () => {
    const artifact = composeArtifact({
      kind: "agent",
      name: "reviewer",
      description: "Reviews a diff.",
      tools: "Read, Grep, Glob",
      model: "opus",
      effort: "high",
      body: "You review diffs.\n",
    });

    expect(emitArtifact(artifact)).toBe(
      "---\nname: reviewer\ndescription: Reviews a diff.\ntools: Read, Grep, Glob\nmodel: opus\neffort: high\n---\n\nYou review diffs.\n",
    );
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
  ])(
    "given_an_%s_advancedField_whenComposed_thenTheKeyIsOmittedRatherThanEmittedEmpty",
    (_case, tools) => {
      // A `tools:` with nothing after it is not "no restriction" to a loader reading
      // the file — it is a declared key with a null value. An unset field must not
      // become a claim the author never made.
      const artifact = composeArtifact({
        kind: "agent",
        name: "reviewer",
        description: "Reviews a diff.",
        tools,
        body: "You review diffs.\n",
      });

      expect(emitArtifact(artifact)).not.toContain("tools");
    },
  );

  it.each([
    ["a plain body", "# Triage\n\nRead the report.\n"],
    ["a body with no trailing newline", "# Triage"],
    ["a body already separated by blank lines", "\n\n# Triage\n\n\n"],
    ["a body containing a frontmatter delimiter", "# Triage\n\n---\n\nRead it.\n"],
    ["an empty body", ""],
  ])(
    "given_%s_whenComposedAndReparsed_thenTheArtifactRoundTrips",
    (_case, body) => {
      // The one emit path, asserted the way a vendored artifact's is: what the codec
      // writes is what the codec reads back, or a bundle can hold a file Claude Code
      // parses differently from the document that produced it.
      const composed = composeArtifact({
        kind: "skill",
        name: "triage",
        description: "Triage an incoming bug report.",
        body,
      });
      const source = emitArtifact(composed);

      const reparsed = parseArtifact("skill", source, "triage");
      expect(emitArtifact(reparsed)).toBe(source);
      expect(reparsed.name).toBe("triage");
      expect(reparsed.description).toBe("Triage an incoming bug report.");
      expect(reparsed.body.trim()).toBe(body.trim());
    },
  );

  it.each([
    ["a colon and a hash", "Use it: #1, always."],
    ["a leading indicator", "- not a list item"],
    ["a line break", "Two lines.\nThe second one."],
    ["a frontmatter delimiter of its own", "Before\n---\nAfter"],
    ["a quote", 'She said "now".'],
  ])(
    "given_aDescriptionContaining_%s_whenComposed_thenTheFrontmatterStaysValidYaml",
    (_case, description) => {
      const source = emitArtifact(
        composeArtifact({
          kind: "skill",
          name: "triage",
          description,
          body: "Body.\n",
        }),
      );

      expect(parseArtifact("skill", source, "triage").description).toBe(
        description.trim(),
      );
    },
  );

  it("given_anAuthoredArtifact_whenComposed_thenItsLocationIsTheCanonicalOneForItsKind", () => {
    // What the compiler writes into the bundle, and the reason the round trip above
    // matters: the file has to be discoverable under the name it declares.
    const skill = composeArtifact({
      kind: "skill",
      name: "triage",
      description: "Triage.",
      body: "Body.\n",
    });
    const agent = composeArtifact({
      kind: "agent",
      name: "summarizer",
      description: "Summarize.",
      body: "Body.\n",
    });

    expect(artifactRelativePath(skill.kind, skill.name)).toBe("skills/triage/SKILL.md");
    expect(artifactRelativePath(agent.kind, agent.name)).toBe("agents/summarizer.md");
  });

  it.each([
    ["yes", "yes"],
    ["no", "no"],
    ["on", "on"],
    ["off", "off"],
    ["y", "y"],
    ["a sexagesimal pair", "1:30"],
    ["a sexagesimal triple", "12:30:45"],
    ["a binary literal", "0b101"],
    ["an underscored integer", "1_000"],
    ["a date", "2024-01-01"],
    ["the value indicator", "="],
    ["the merge key", "<<"],
  ])(
    "given_aDescriptionOf_%s_whenComposed_thenTheEmittedTextQuotesIt",
    (_case, description) => {
      // Asserted on the **bytes**, not by re-reading with the library that wrote them:
      // the reader that matters is a YAML 1.1 one (PyYAML, and every loader built on
      // it), which reads a bare `yes` as `True`, `1:30` as `90` and `=` as a tag it
      // cannot construct. A same-parser round trip cannot see any of that.
      const source = emitArtifact(
        composeArtifact({ kind: "skill", name: "probe", description, body: "Body.\n" }),
      );

      expect(source).toContain(`description: "${description}"`);
    },
  );

  it.each([["tools"], ["model"], ["effort"]])(
    "given_an_%s_thatAYaml11ReaderWouldNotReadAsText_whenComposed_thenTheEmittedTextQuotesIt",
    (field) => {
      // `tools: no` and `model: off` are not implausible, and each becomes a boolean.
      const source = emitArtifact(
        composeArtifact({
          kind: "agent",
          name: "probe",
          description: "Probes.",
          [field]: "no",
          body: "Body.\n",
        } as Parameters<typeof composeArtifact>[0]),
      );

      expect(source).toContain(`${field}: "no"`);
    },
  );

  it("given_anOrdinaryDescription_whenComposed_thenItIsStillEmittedPlain", () => {
    // Quoting is decided per value, not applied to everything: the emitted file is a
    // file the author reads and edits, and blanket quotes would make every one of them
    // read like generated output.
    const source = emitArtifact(
      composeArtifact({
        kind: "skill",
        name: "triage",
        description: "Triage an incoming bug report into one of three buckets.",
        body: "Body.\n",
      }),
    );

    expect(source).toContain(
      "description: Triage an incoming bug report into one of three buckets.\n",
    );
  });

  it.each([
    ["name", 7],
    ["description", { text: "x" }],
    ["body", ["a"]],
    ["tools", 3],
    ["model", []],
    ["effort", 1],
  ])(
    "given_an_%s_thatIsNotAStringAtAll_whenComposed_thenItStillProducesAnArtifactRatherThanThrowing",
    (field, value) => {
      // Reached from `compile`, which is asked of in-memory node data a hand edit may
      // have made nonsense of and may never throw (issue #27).
      const spec = {
        kind: "skill",
        name: "probe",
        description: "Probes.",
        body: "Body.\n",
        [field]: value,
      } as unknown as Parameters<typeof composeArtifact>[0];

      expect(() => emitArtifact(composeArtifact(spec))).not.toThrow();
    },
  );

  it.skipIf(!PY_YAML_AVAILABLE)(
    "given_everyAmbiguousValue_whenReadByAGenuinelyDifferentYamlParser_thenItComesBackAsTheTextItWas",
    () => {
      // The strongest evidence available for the claim above, and the only one that is
      // not this library grading its own homework: PyYAML is a YAML 1.1 reader written
      // by someone else. Skipped where it is not installed — the byte assertions above
      // are what CI relies on.
      // Two families, and the second is not a variation of the first: the values above
      // are the 1.1 *scalar-resolution* traps (a bare word a 1.1 reader retypes), while
      // the ones below are the 1.1 *line-break* class (a character a 1.1 reader treats
      // as the end of the line, wherever in a value it sits).
      for (const value of [
        "yes",
        "no",
        "on",
        "off",
        "1:30",
        "12:30:45",
        "0b101",
        "=",
        "<<",
        "a\u0085b",
        "a\u2028b",
        "a\u2029b",
        // `U+0085` is not JS whitespace, so unlike `U+2028`/`U+2029` it survives the
        // `.trim()` `composeArtifact` applies and can sit at either end of the value.
        "\u0085leading",
        "trailing\u0085",
        "mixed \u0085 \u2028 \u2029 run",
        // The C1 controls and DEL are not line breaks, but a raw one fails the same
        // way: both parsers refuse the whole block as a "special"/control character.
        "a\u007fb",
        "a\u0080b",
        "a\u009fb",
        "\u0080leading",
        "trailing\u009f",
        "mixed \u007f \u0080 \u009f run",
      ]) {
        const source = emitArtifact(
          composeArtifact({ kind: "skill", name: "probe", description: value, body: "Body.\n" }),
        );

        expect(pyYamlFrontmatter(source)).toEqual({ name: "probe", description: value });
      }
    },
  );

  it.each([
    ["NEL", "\u0085", "\\u0085"],
    ["LINE SEPARATOR", "\u2028", "\\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029", "\\u2029"],
    ["DEL", "\u007f", "\\u007f"],
    ["the first C1 control", "\u0080", "\\u0080"],
    ["the last C1 control", "\u009f", "\\u009f"],
  ])(
    "given_aDescriptionContaining_%s_whenComposed_thenTheEmittedTextEscapesItRatherThanWritingItRaw",
    (_case, character, escape) => {
      // A YAML 1.1 reader counts these three as **line breaks**, and the `yaml` package
      // writes them raw even inside double quotes: raw `U+2028` ends the line mid-key
      // and PyYAML/Psych refuse the whole block, raw `U+0085` parses and is folded to a
      // space, quietly rewriting the author's description. Escaped, every reader gets
      // the character back.
      const source = emitArtifact(
        composeArtifact({
          kind: "skill",
          name: "probe",
          description: `Use this${character}when triaging.`,
          body: "Body.\n",
        }),
      );

      expect(source).toContain(`description: "Use this${escape}when triaging."`);
      expect(source).not.toContain(character);
    },
  );

  it("given_aDescriptionContainingALineBreakCharacter_whenEmittedAndParsedBack_thenTheCharacterSurvives", () => {
    const description = "Use this\u2028when\u2029triaging\u0085properly\u007f\u0080\u009f.";

    const source = emitArtifact(
      composeArtifact({ kind: "skill", name: "probe", description, body: "Body.\n" }),
    );

    expect(parseArtifact("skill", source, "probe").description).toBe(description);
  });

  it("given_fieldsThatAreNotUsableAtAll_whenComposed_thenItStillProducesAnArtifactRatherThanThrowing", () => {
    // Composition is on the compile path, which is total: a document with a
    // half-finished authored node is refused by `validateGraph`, never by a throw
    // from the emitter. See the note on `composeArtifact`.
    const artifact = composeArtifact({
      kind: "skill",
      name: "",
      description: "",
      body: "",
    });

    expect(artifact.name).toBe("");
    expect(typeof emitArtifact(artifact)).toBe("string");
  });
})

/**
 * Read a batch of emitted frontmatter blocks with **PyYAML** in one interpreter run.
 *
 * Batched because the sweep below needs ~1,500 parses and a `python3` start-up costs
 * more than all of them together. One entry per input, in order, so a failure names the
 * codepoint that caused it rather than aborting the batch.
 */
function pyYamlBatch(texts: string[]): { ok: boolean; value: unknown }[] {
  const program = [
    "import sys, json, yaml",
    "out = []",
    "for t in json.load(sys.stdin):",
    "    try:",
    '        out.append({"ok": True, "value": yaml.safe_load(t)})',
    "    except Exception as e:",
    '        out.append({"ok": False, "value": type(e).__name__ + ": " + str(e).split("\\n")[0]})',
    "json.dump(out, sys.stdout)",
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", program], {
      input: JSON.stringify(texts),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    }),
  );
}

/**
 * The same batch through **Psych** (Ruby/libyaml) — a second reader, of a different
 * lineage, so "every reader" is not one implementation's opinion.
 *
 * Psych is the *lenient* one of the two: it accepts a tab in a plain scalar that PyYAML
 * refuses, which is why PyYAML is the one the sweep cannot run without.
 */
function psychBatch(texts: string[]): { ok: boolean; value: unknown }[] {
  const program = [
    "require 'json'; require 'yaml'",
    "out = JSON.parse(STDIN.read).map do |t|",
    "  begin",
    "    { 'ok' => true, 'value' => Psych.safe_load(t) }",
    "  rescue => e",
    "    { 'ok' => false, 'value' => \"#{e.class}: #{e.message.lines.first.to_s.strip}\" }",
    "  end",
    "end",
    "STDOUT.write(JSON.generate(out))",
  ].join("\n");
  return JSON.parse(
    execFileSync("ruby", ["-e", program], {
      input: JSON.stringify(texts),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    }),
  );
}

/** Whether this machine has Ruby's Psych at all; the second reader is skipped if not. */
const PSYCH_AVAILABLE = (() => {
  try {
    return psychBatch(["name: probe\n"])[0].ok;
  } catch {
    return false;
  }
})();

/** The frontmatter block of an emitted artifact, without its delimiters. */
function frontmatterOf(source: string): string {
  return source.split("---\n")[1] ?? "";
}

function emittedWithDescription(description: string): string {
  return emitArtifact(
    composeArtifact({ kind: "skill", name: "probe", description, body: "Body.\n" }),
  );
}

/**
 * The codepoints the sweep emits, one artifact each.
 *
 * Not a full sweep of the BMP: a full one is ~63,500 PyYAML parses and takes five
 * minutes, which is not a thing to put in front of every commit. The sample is chosen
 * to hit **every boundary `c-printable` names** rather than to be large — the
 * production changes its answer only at those edges, so a value either side of each one
 * is what actually discriminates.
 */
function sweptCodePoints(): number[] {
  const points = new Set<number>();
  // Exhaustive across the whole 8-bit part of the production: the C0 controls, printable
  // ASCII, DEL, the C1 block and NEL inside it, up to and including the `#xA0` edge.
  for (let cp = 0x00; cp <= 0xa0; cp += 1) points.add(cp);
  // Both sides of every remaining edge in the production, plus the characters a reader
  // is entitled to treat specially: the 1.1 line-break separators, the BOM, and the
  // Arabic-block non-characters the readers *do* accept (escaping those would be a
  // regression, so they are swept as positives).
  for (const cp of [
    0xd7fe, 0xd7ff, 0xe000, 0xe001, 0xfffc, 0xfffd, 0xfffe, 0xffff, 0x2028, 0x2029, 0x200b,
    0x200d, 0x2060, 0xfeff, 0xfdd0, 0xfddf, 0xfdef, 0xfff9, 0xfffb,
  ]) {
    points.add(cp);
  }
  // A stride across the rest of the BMP, skipping the surrogate range (see the note on
  // `YAML_RAW_UNSAFE`): a coprime step so the sample lands in every block rather than
  // repeatedly on the same offset within one.
  for (let cp = 0x00a1; cp <= 0xffff; cp += 61) {
    if (cp < 0xd800 || cp > 0xdfff) points.add(cp);
  }
  // Astral: the plane-1 edge, three plane-end non-characters (the `#xFFFE`/`#xFFFF`
  // pattern one plane up, which the production does *not* exclude and neither reader
  // refuses), the last codepoint there is, and an emoji — all as surrogate pairs.
  for (const cp of [0x10000, 0x1f600, 0x1fffe, 0x1ffff, 0x2fffe, 0x10fffe, 0x10ffff]) {
    points.add(cp);
  }
  return [...points];
}

describe("stringifyFrontmatter — the escape class, swept against readers that did not write it", () => {
  it.each([
    ["TAB", "\t"],
    ["the BMP non-character U+FFFE", "\ufffe"],
    ["the BMP non-character U+FFFF", "\uffff"],
  ])(
    "given_aDescriptionContaining_%s_whenComposed_thenNoRawOccurrenceOfItReachesTheFile",
    (_case, character) => {
      // TAB is *in* `c-printable`, but a plain scalar may not contain one
      // (`ns-plain-char` excludes `s-white`), so the `yaml` package emitting it bare
      // writes invalid YAML: PyYAML refuses to scan the block at all. U+FFFE/U+FFFF are
      // outside `c-printable`, which both readers implement as a character-level filter.
      //
      // Raw *absence* is what is pinned, not one spelling of the escape: the character
      // leaves as `\t` when the emitter's own double-quote escaping reaches it first and
      // as `\ufffe` when [`escapeYamlRawUnsafe`] does, and both are the same YAML to a
      // reader. That the escape survives a reader is the sweeps' claim, not this one's.
      const description = `Use this${character}when triaging.`;

      const source = emittedWithDescription(description);

      expect(source).not.toContain(character);
      expect(parseArtifact("skill", source, "probe").description).toBe(description);
    },
  );

  it.each(["tools", "model", "effort"])(
    "given_a_%s_containingATab_whenComposed_thenNoRawTabReachesTheFileThere_either",
    (field) => {
      // The dock collects four single-line values, not one: an escape class that only
      // covers `description` leaves three ways to write an unreadable SKILL.md.
      const source = emitArtifact(
        composeArtifact({
          kind: "agent",
          name: "probe",
          description: "Probes.",
          [field]: "a\tb",
          body: "Body.\n",
        } as Parameters<typeof composeArtifact>[0]),
      );

      expect(source).not.toContain("\t");
      expect(parseArtifact("agent", source, "probe").fields[field]).toBe("a\tb");
    },
  );

  it("given_aDescriptionThatIsAnEmojiSequence_whenComposed_thenItIsLeftExactlyAsTheAuthorTypedIt", () => {
    // JS strings are UTF-16, so a naive codepoint range written over code *units* would
    // catch the halves of a surrogate pair. Every astral codepoint is inside
    // `c-printable`, so nothing up there is ever escaped.
    const description = "Use this for \u{1F468}‍\u{1F469}‍\u{1F466} families.";

    const source = emittedWithDescription(description);

    expect(source).toContain(`description: ${description}`);
    expect(parseArtifact("skill", source, "probe").description).toBe(description);
  });

  it.skipIf(!PY_YAML_AVAILABLE)(
    "given_everyCodepointTheProductionDrawsALineAt_whenReadBackByPyYaml_thenTheValueIsExactlyWhatWasComposed",
    () => {
      // The claim this test exists to stop asserting: that the escape class is *complete*.
      // Three earlier rounds each closed one member of it by name and the next round
      // found another, because the set was being enumerated from what happened to break.
      // A sweep through the real emitter, cross-parsed by a reader this repo did not
      // write, is the only form of that claim that can fail when it is wrong.
      const points = sweptCodePoints();
      const values = points.map((cp) => `a${String.fromCodePoint(cp)}b`);
      const results = pyYamlBatch(values.map((v) => frontmatterOf(emittedWithDescription(v))));

      const broken = results.flatMap((result, i) => {
        const expected = { name: "probe", description: values[i] };
        const label = `U+${points[i].toString(16).toUpperCase().padStart(4, "0")}`;
        if (!result.ok) return [`${label}: ${result.value}`];
        return JSON.stringify(result.value) === JSON.stringify(expected)
          ? []
          : [`${label}: read back as ${JSON.stringify(result.value)}`];
      });

      expect(broken).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!PSYCH_AVAILABLE)(
    "given_thatSameSweep_whenReadBackByPsych_thenTheValueIsExactlyWhatWasComposed",
    () => {
      const points = sweptCodePoints();
      const values = points.map((cp) => `a${String.fromCodePoint(cp)}b`);
      const results = psychBatch(values.map((v) => frontmatterOf(emittedWithDescription(v))));

      const broken = results.flatMap((result, i) => {
        const expected = { name: "probe", description: values[i] };
        const label = `U+${points[i].toString(16).toUpperCase().padStart(4, "0")}`;
        if (!result.ok) return [`${label}: ${result.value}`];
        return JSON.stringify(result.value) === JSON.stringify(expected)
          ? []
          : [`${label}: read back as ${JSON.stringify(result.value)}`];
      });

      expect(broken).toEqual([]);
    },
    60_000,
  );
})
