import { describe, expect, it } from "vitest";
import { composeArtifact, emitArtifact, parseArtifact } from "./artifact-codec";
import { artifactScaffold } from "./artifact-scaffold";

describe("artifactScaffold — a starting point, not a blank slate", () => {
  it.each([
    ["skill", "Triage"],
    ["agent", "Reviewer"],
  ] as const)(
    "given_a_%s_node_whenScaffolded_thenTheAuthorGetsAStructuredBodyTitledAfterTheNode",
    (kind, title) => {
      const body = artifactScaffold(kind, title);

      expect(body.startsWith(`# ${title}\n`)).toBe(true);
      // Sections to fill in, not a placeholder comment: the point of the scaffold is
      // that the author edits prose rather than inventing a shape.
      expect(body.match(/^## /gm)?.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("given_theTwoKinds_whenScaffolded_thenEachGetsTheShapeItsFormatIsReadIn", () => {
    // A skill is instructions Claude Code follows; an agent is a role it delegates
    // to and a report it comes back with. One scaffold for both would be a shape
    // that fits neither.
    const skill = artifactScaffold("skill", "Triage");
    const agent = artifactScaffold("agent", "Triage");

    expect(skill).not.toBe(agent);
    expect(skill).toContain("## Process");
    expect(agent).toContain("## Report");
  });

  it.each([
    ["an empty label", "", "skill"],
    ["a whitespace-only label", "   ", "agent"],
  ] as const)(
    "given_%s_whenScaffolded_thenTheTitleFallsBackToTheKindRatherThanBeingEmpty",
    (_case, title, kind) => {
      // A heading of `# ` is not a heading anyone can read, and the scaffold is seeded
      // the moment a node is switched to authored — before it has been named.
      const body = artifactScaffold(kind, title);

      expect(body.startsWith(kind === "skill" ? "# New skill\n" : "# New agent\n")).toBe(
        true,
      );
    },
  );

  it("given_aLabelThatWouldLookLikeMarkup_whenScaffolded_thenTheHeadingIsStillOneLine", () => {
    // The label is free text from the canvas, and it lands in a heading. A newline in
    // it would silently turn the rest into body prose under an empty heading.
    const body = artifactScaffold("skill", "  Triage\nthe report  ");

    expect(body.startsWith("# Triage the report\n")).toBe(true);
  });

  it.each(["skill", "agent"] as const)(
    "given_the_%s_scaffold_whenComposedAndParsed_thenItIsAlreadyAFormatCompliantArtifact",
    (kind) => {
      // The seeded body must be exportable as it stands: an author who fills in the
      // description and exports immediately gets a file Claude Code can load.
      const source = emitArtifact(
        composeArtifact({
          kind,
          name: "triage",
          description: "Triage an incoming bug report.",
          body: artifactScaffold(kind, "Triage"),
        }),
      );

      const parsed = parseArtifact(kind, source, "triage");
      expect(parsed.description).toBe("Triage an incoming bug report.");
      expect(parsed.body).toContain("# Triage");
    },
  );

  it.each(["skill", "agent"] as const)(
    "given_the_%s_scaffold_thenItCarriesNoFrontmatterOfItsOwn",
    (kind) => {
      // The frontmatter is derived from the form's fields (ADR-0007), so a scaffold
      // that opened with `---` would emit a second, stale copy of it inside the body.
      expect(artifactScaffold(kind, "Triage").startsWith("---")).toBe(false);
    },
  );
});
