/**
 * The export path, driven the way a user drives it: load a document, press
 * Export, pick a destination.
 *
 * What this adds over the unit tests is the *wiring*. `compile` is already pinned
 * against the golden bundle in `src/domain/compiler.test.ts`; what nothing checked
 * before is that the document the app hands the compiler is the document it loaded,
 * that the artifacts it copies are the ones the scan resolved, and that a refusal
 * reaches the screen instead of the console. Those only break in the app.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { BundleTree } from "../../src/domain/compiler";
import type { ScanReport } from "../../src/import/catalog";
import { callsTo, installTauriStub, type FakeBackend } from "./tauri-stub";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const unitFixtures = join(repoRoot, "src/domain/__fixtures__");
const e2eFixtures = join(repoRoot, "tests/e2e/fixtures");

const DOCUMENT_PATH = "/Users/e2e/workflows/vendor-mix.patchwork";
const CONDITIONAL_PATH = "/Users/e2e/workflows/triage-report.patchwork";
const WIDE_PATH = "/Users/e2e/workflows/wide.patchwork";
const SAVE_PATH = "/Users/e2e/workflows/saved.patchwork";
const DEST_DIR = "/Users/e2e/Desktop";

/** How many branches a conditional may offer before the export refuses it. */
const BRANCH_LIMIT = 64;

/**
 * A workflow whose one conditional has `branches` ways out, all wired to the same next node.
 *
 * Built here rather than committed as a fixture: at 20,000 branches the file is 2.1 MB, and the
 * *number* is the whole point of the test.
 */
function wideDocument(branches: number): string {
  return JSON.stringify({
    schemaVersion: 4,
    workflow: { name: "Wide", description: "A conditional with far too many branches." },
    nodes: [
      { id: "n1", type: "input", label: "In", data: { parameters: [{ name: "topic" }] } },
      {
        id: "c1",
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
      { id: "n2", type: "prompt", label: "Step", data: { instruction: "do it" } },
      { id: "n3", type: "output", label: "Out", data: { description: "the answer" } },
    ],
    edges: [
      { id: "e-in", source: "n1", target: "c1" },
      { id: "e-out", source: "n2", target: "n3" },
      ...Array.from({ length: branches }, (_, at) => ({
        id: `e${at}`,
        source: "c1",
        target: "n2",
        branch: `b${at}`,
      })),
    ],
  });
}

/** Every file under `dir`, path relative and POSIX-separated, sorted. */
function fileSet(dir: string): Array<{ path: string; contents: string }> {
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((entry) => {
      const full = join(at, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return walk(dir)
    .map((full) => ({
      path: relative(dir, full).split(sep).join(posix.sep),
      contents: readFileSync(full, "utf8"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The scan the Rust half would return, built from the same artifact fixtures the
 * compiler's unit tests copy from — so the bytes the app vendors are the bytes the
 * golden bundle was generated from, and a fixture edit cannot make the two agree
 * while both are wrong.
 *
 * Names are the scanner's, not the file's: `skills/tdd/SKILL.md` is served as
 * `coding:tdd` exactly as it would be from a plugin directory on disk.
 */
function scanReport(): ScanReport {
  const artifact = (kind: string, name: string, fixture: string) => ({
    rootId: "personal:~/.claude",
    kind,
    name,
    path: `/Users/e2e/.claude/${fixture}`,
    contents: readFileSync(join(unitFixtures, "artifacts", fixture), "utf8"),
  });
  return {
    artifacts: [
      artifact("skill", "coding:tdd", "skills/tdd/SKILL.md"),
      artifact("skill", "conventions", "skills/conventions/SKILL.md"),
      artifact("agent", "coding:pr-reviewer", "skills/coding/agents/pr-reviewer.md"),
      artifact("agent", "pr-reviewer", "agents/pr-reviewer.md"),
    ],
    problems: [],
  };
}

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    scan: scanReport(),
    documents: {
      [DOCUMENT_PATH]: readFileSync(join(e2eFixtures, "vendor-mix.patchwork"), "utf8"),
      [CONDITIONAL_PATH]: readFileSync(
        join(e2eFixtures, "conditional.patchwork"),
        "utf8",
      ),
    },
    openDocument: DOCUMENT_PATH,
    openDirectory: DEST_DIR,
    homeDir: "/Users/e2e",
    ...overrides,
  };
}

test("given a loaded vendor-mix document when exported then the emitted tree is the golden bundle", async ({
  page,
}) => {
  await installTauriStub(page, backend());
  await page.goto("/");

  // The scan has to have landed before anything is exported: a vendor-copy node's bytes come
  // from the catalog, so a click that beats the scan is refused for a reason that has nothing
  // to do with what the test is about. It used to be implicit in how fast the page was.
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);

  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${DOCUMENT_PATH}`);
  // The document reached the canvas, not just the store.
  await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue(
    "Vendor Mix",
  );

  await page.getByRole("button", { name: "Export" }).click();

  await expect(page.getByRole("contentinfo")).toHaveText(
    `Exported bundle to ${DEST_DIR}/patchwork-vendor-mix`,
  );
  const [exported] = await callsTo(page, "export_bundle");
  expect(exported.destDir).toBe(DEST_DIR);
  const tree = exported.tree as BundleTree;
  expect(tree.dirName).toBe("patchwork-vendor-mix");
  expect([...tree.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
    fileSet(join(unitFixtures, "vendor-mix")),
  );
});

test("given a workflow name too long for the bundle directory when exported then it is refused before the picker", async ({
  page,
}) => {
  await installTauriStub(page, backend());
  await page.goto("/");

  // The scan has to have landed before anything is exported: a vendor-copy node's bytes come
  // from the catalog, so a click that beats the scan is refused for a reason that has nothing
  // to do with what the test is about. It used to be implicit in how fast the page was.
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${DOCUMENT_PATH}`);

  // 55 characters: one past what the bundle directory can carry, because the
  // directory is also the name Claude Code discovers the exported skill by.
  await page
    .getByRole("textbox", { name: "Workflow name" })
    .fill("Wildly Overlong Workflow Name For Discoverability Check");
  await page.getByRole("button", { name: "Export" }).click();

  await expect(page.getByRole("list", { name: "Validation errors" })).toContainText(
    "which is also the name Claude Code discovers the exported skill by",
  );
  await expect(page.getByRole("contentinfo")).toHaveText(
    "Cannot export: fix validation errors first.",
  );
  // Refused *before* the picker: no destination was asked for and nothing was
  // written, so a name that cannot be discovered never reaches the disk.
  expect(await callsTo(page, "plugin:dialog|open")).toHaveLength(1); // the load only
  expect(await callsTo(page, "export_bundle")).toHaveLength(0);
});

test("given one character less when exported then the same document exports", async ({
  page,
}) => {
  await installTauriStub(page, backend());
  await page.goto("/");

  // The scan has to have landed before anything is exported: a vendor-copy node's bytes come
  // from the catalog, so a click that beats the scan is refused for a reason that has nothing
  // to do with what the test is about. It used to be implicit in how fast the page was.
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${DOCUMENT_PATH}`);

  await page
    .getByRole("textbox", { name: "Workflow name" })
    .fill("Wildly Overlong Workflow Name For Discoverability Chec");
  await page.getByRole("button", { name: "Export" }).click();

  await expect(page.getByRole("contentinfo")).toContainText("Exported bundle to");
  const [exported] = await callsTo(page, "export_bundle");
  expect((exported.tree as BundleTree).dirName).toHaveLength(64);
});

test("given a loaded branching document when exported then the bundle carries the branch instructions", async ({
  page,
}) => {
  // The branch prose is what makes an exported workflow take one path or the other, so
  // what matters here is that it survives the *round trip through the app*: a branch is
  // stored as an edge field, drawn as a source handle, and read back off that handle —
  // three representations that a wiring mistake would silently flatten into a linear
  // chain the compiler's own tests would never see.
  await installTauriStub(page, backend({ openDocument: CONDITIONAL_PATH }));
  await page.goto("/");

  // The scan has to have landed before anything is exported: a vendor-copy node's bytes come
  // from the catalog, so a click that beats the scan is refused for a reason that has nothing
  // to do with what the test is about. It used to be implicit in how fast the page was.
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);

  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${CONDITIONAL_PATH}`);
  // The branch labels are readable on the canvas, on the edges that carry them.
  await expect(page.locator(".react-flow__edge-text", { hasText: "with trace" })).toHaveCount(1);
  await expect(page.locator(".react-flow__edge-text", { hasText: "no trace" })).toHaveCount(1);

  await page.getByRole("button", { name: "Export" }).click();

  await expect(page.getByRole("contentinfo")).toHaveText(
    `Exported bundle to ${DEST_DIR}/patchwork-triage-report`,
  );
  const [exported] = await callsTo(page, "export_bundle");
  const tree = exported.tree as BundleTree;
  expect(tree.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  expect(tree.files[0].contents).toBe(
    readFileSync(join(unitFixtures, "conditional/SKILL.md"), "utf8"),
  );
});

test("given a document with more branches than the canvas draws when loaded then it opens fast, flagged, and unexportable", async ({
  page,
}) => {
  // The measurement this exists for: 20,000 branches used to take **10.8 s** to load and render
  // in this very browser, because the node drew a handle per branch and React Flow was handed
  // an edge per branch — and then the export *succeeded*, so the user got a frozen minute and no
  // error. Refusing to open the file closed the freeze and opened a worse hole (a document that
  // could never be repaired in the app), so what is bounded now is what the canvas draws.
  // Its own backend: a 2.1 MB document in the stub every *other* test installs delays their
  // import scan enough to change what they are testing.
  await installTauriStub(
    page,
    backend({ openDocument: WIDE_PATH, documents: { [WIDE_PATH]: wideDocument(20_000) } }),
  );
  await page.goto("/");

  // The scan has to have landed before anything is exported: a vendor-copy node's bytes come
  // from the catalog, so a click that beats the scan is refused for a reason that has nothing
  // to do with what the test is about. It used to be implicit in how fast the page was.
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);

  const started = Date.now();
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${WIDE_PATH}`);
  // Every branch is still in the document; only the drawing is bounded.
  await expect(page.locator(".pw-node__branch")).toHaveCount(BRANCH_LIMIT);
  await expect(
    page.getByText(
      `20000 branches, over the limit of ${BRANCH_LIMIT} — the rest are in the document but not drawn`,
    ),
  ).toBeVisible();
  const elapsed = Date.now() - started;

  // The edges React Flow was given are bounded too: the two plain ones plus the branches drawn.
  // Loose budget, and still an order of magnitude under what this document used to cost.
  expect(await page.locator(".react-flow__edge").count()).toBeLessThanOrEqual(BRANCH_LIMIT + 2);
  expect(elapsed).toBeLessThan(3_000);

  await page.getByRole("button", { name: "Export" }).click();

  await expect(page.getByRole("list", { name: "Validation errors" })).toContainText(
    `Conditional node 'c1' offers 20000 branches; at most ${BRANCH_LIMIT} can be written as a choice`,
  );
  await expect(page.getByRole("contentinfo")).toHaveText(
    "Cannot export: fix validation errors first.",
  );
  expect(await callsTo(page, "export_bundle")).toHaveLength(0);
});

/** Every edge in a saved document whose source or target node is not in it. */
function orphanedEdges(written: string): Array<Record<string, unknown>> {
  const doc = JSON.parse(written) as {
    nodes: Array<{ id: string }>;
    edges: Array<Record<string, unknown>>;
  };
  const ids = new Set(doc.nodes.map((node) => node.id));
  return doc.edges.filter(
    (edge) => !ids.has(edge.source as string) || !ids.has(edge.target as string),
  );
}

test("given an over-wide conditional when it is deleted and saved then no edge is left behind", async ({
  page,
}) => {
  // The keystroke this exists for. React Flow works out which edges a deleted node owns from
  // the `edges` prop it was **given**, and an over-wide conditional withholds the edges of the
  // branches it does not draw — so deleting the node took its 64 drawn edges and left the rest
  // in state with a source that no longer exists. Silent, saved to disk, and unfixable in the
  // app: nothing draws an edge whose source node is gone, so the user cannot select it.
  //
  // The natural sequence, too: the app has just told the user it will not export this node.
  await installTauriStub(
    page,
    backend({
      openDocument: WIDE_PATH,
      documents: { [WIDE_PATH]: wideDocument(70) },
      savePath: SAVE_PATH,
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);

  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${WIDE_PATH}`);
  await expect(page.locator(".pw-node--conditional.is-over-width")).toBeVisible();

  await page.locator(".pw-node--conditional").click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".pw-node--conditional")).toHaveCount(0);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Saved to ${SAVE_PATH}`);

  const [saved] = await callsTo(page, "write_document");
  expect(orphanedEdges(saved.contents as string)).toEqual([]);
});

test("given an ordinary node deleted from a branching workflow then only its own edges go", async ({
  page,
}) => {
  // The neighbouring path the fix must not disturb: React Flow already owned every edge of an
  // ordinary node, because none of them were withheld. Driven on the two-branch fixture rather
  // than the wide one because a 70-row conditional covers half the canvas, and a click that
  // cannot land is not evidence about deletion.
  await installTauriStub(
    page,
    backend({ openDocument: CONDITIONAL_PATH, savePath: SAVE_PATH }),
  );
  await page.goto("/");
  await expect(page.getByRole("contentinfo")).toHaveText(/Imported \d+ skill/);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Loaded ${CONDITIONAL_PATH}`);

  // `Extract frame` sits inside branch `with trace`, between the conditional and the merge.
  await page.locator(".pw-node--prompt", { hasText: "Extract frame" }).click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".pw-node--prompt", { hasText: "Extract frame" })).toHaveCount(0);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("contentinfo")).toHaveText(`Saved to ${SAVE_PATH}`);

  const [saved] = await callsTo(page, "write_document");
  const doc = JSON.parse(saved.contents as string) as {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string }>;
  };
  expect(orphanedEdges(saved.contents as string)).toEqual([]);
  expect(doc.nodes.map((node) => node.id)).toEqual(["n1", "n2", "c1", "n4", "n5", "n6"]);
  // The two edges that touched it, and only those: `c1 -[b1]-> n3` and `n3 -> n5`. The other
  // branch is untouched, and so is the branch *itself* — deleting the step a branch leads to
  // leaves the branch unwired, which is validation's business, not the canvas's.
  expect(doc.edges.map((edge) => edge.id)).toEqual(["e1", "e2", "e4", "e6", "e7"]);
});
