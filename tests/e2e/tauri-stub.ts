/**
 * The one seam that makes Patchwork drivable in a browser.
 *
 * Everything privileged the app does — the file pickers, the source-root scan,
 * reading and writing a document, emitting a bundle — leaves the frontend through
 * `window.__TAURI_INTERNALS__.invoke`. The dialog and path plugins are no
 * exception; they are `invoke` calls with a `plugin:<name>|<command>` name. So a
 * fake for that single property stands in for the entire Rust half, and the app
 * under test is the *real* app: real React Flow canvas, real validation, real
 * compiler, real bridge module.
 *
 * The fake lives here rather than in `src/` deliberately. A dev-mode fake bridge
 * inside the app would be a second implementation of the backend contract that
 * drifts silently; here, drift shows up as a failing test — and nothing fake can
 * reach a release build.
 */

import type { Page } from "@playwright/test";
import type { ScanReport } from "../../src/import/catalog";
import type { BundleTree } from "../../src/domain/compiler";

/** What the fake Rust half answers with. Must be JSON-serializable. */
export interface FakeBackend {
  /** The report `scan_roots` returns, whatever roots it is asked about. */
  scan: ScanReport;
  /** Document contents by path, for `read_document` and the open dialog. */
  documents?: Record<string, string>;
  /** What the *file* picker returns — a `.patchwork` path, or null to cancel. */
  openDocument?: string | null;
  /** What the *directory* picker returns — an export destination, or null. */
  openDirectory?: string | null;
  /** What the save-as dialog returns. */
  savePath?: string | null;
  /** The home directory `homeDir()` resolves to (used to tildeify picked roots). */
  homeDir?: string;
}

/** One recorded call through the bridge, in the order the app made it. */
export interface Invocation {
  cmd: string;
  args: Record<string, unknown>;
}

/**
 * Install the fake before any app code runs.
 *
 * `addInitScript` is what makes this honest: it lands on `window` before the
 * bundle's first module executes, so the app never observes a moment where the
 * shell is missing and takes a different path than it does on the desktop.
 */
export async function installTauriStub(
  page: Page,
  backend: FakeBackend,
): Promise<void> {
  await page.addInitScript((fake: FakeBackend) => {
    const calls: Invocation[] = [];
    // Read back by the assertions; the app never sees it.
    (window as unknown as { __E2E_CALLS__: Invocation[] }).__E2E_CALLS__ = calls;

    const documents = fake.documents ?? {};

    async function invoke(cmd: string, args: Record<string, unknown> = {}) {
      calls.push({ cmd, args });
      switch (cmd) {
        case "scan_roots":
          return fake.scan;
        case "read_document": {
          const path = args.path as string;
          if (!(path in documents)) throw new Error(`No such file: ${path}`);
          return documents[path];
        }
        case "write_document":
          documents[args.path as string] = args.contents as string;
          return null;
        case "export_bundle": {
          // The emitter returns the directory it wrote; the app puts it in the
          // status line, so the shape of the answer matters as much as the fact.
          const tree = args.tree as BundleTree;
          return `${args.destDir as string}/${tree.dirName}`;
        }
        // Both pickers are the same command; the options say which one it is.
        case "plugin:dialog|open": {
          const options = (args.options ?? {}) as { directory?: boolean };
          return options.directory
            ? (fake.openDirectory ?? null)
            : (fake.openDocument ?? null);
        }
        case "plugin:dialog|save":
          return fake.savePath ?? null;
        case "plugin:path|resolve_directory":
          return fake.homeDir ?? "/Users/e2e";
        default:
          // Loud on purpose: a new command reaching the bridge is a new piece of
          // the contract, and a stub that quietly answered `undefined` would turn
          // that into a puzzling assertion failure somewhere else.
          throw new Error(`e2e stub has no fake for '${cmd}'`);
      }
    }

    (
      window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }
    ).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback: unknown) => callback,
      convertFileSrc: (filePath: string) => filePath,
    };
  }, backend);
}

/** Every call the app made through the bridge, in order. */
export async function invocations(page: Page): Promise<Invocation[]> {
  return page.evaluate(
    () => (window as unknown as { __E2E_CALLS__: Invocation[] }).__E2E_CALLS__,
  );
}

/** The arguments of each call to one command. */
export async function callsTo(
  page: Page,
  cmd: string,
): Promise<Array<Record<string, unknown>>> {
  return (await invocations(page))
    .filter((call) => call.cmd === cmd)
    .map((call) => call.args);
}
