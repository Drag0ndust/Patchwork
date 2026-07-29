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
const DEST_DIR = "/Users/e2e/Desktop";

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
