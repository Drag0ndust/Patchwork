import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tildeify } from "../import/source-roots";
import type { BundleTree } from "../domain/compiler";
import type { ScanReport } from "../import/catalog";

/** Prompt for a `.patchwork` file to open; returns null if cancelled. */
export async function pickDocumentToOpen(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Patchwork", extensions: ["patchwork"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Prompt for a `.patchwork` save location; returns null if cancelled. */
export async function pickDocumentToSave(
  defaultName: string,
): Promise<string | null> {
  return save({
    defaultPath: `${defaultName}.patchwork`,
    filters: [{ name: "Patchwork", extensions: ["patchwork"] }],
  });
}

/** Prompt for a directory to drop an exported bundle into. */
export async function pickExportDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/**
 * Prompt for a directory to add as a source root.
 *
 * The picker returns an absolute path; it is rewritten to its `~`-relative form
 * here — the one place that knows the home directory — so picking your own
 * `~/.claude` resolves to the same identity as the default root instead of
 * configuring the same directory twice.
 */
export async function pickSourceRoot(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected !== "string") return null;
  try {
    return tildeify(selected, await homeDir());
  } catch {
    return selected; // Without a home directory the raw path is still usable.
  }
}

/**
 * Walk the given source roots for skills and agents. Each root is passed as
 * `{id, path}` so every discovered artifact comes back attributed to the exact
 * configured root (role included), not merely to a path. Never rejects for a bad
 * root — unreadable roots come back in `problems`.
 */
export async function scanRoots(
  roots: Array<{ id: string; path: string }>,
): Promise<ScanReport> {
  return invoke<ScanReport>("scan_roots", { roots });
}

export async function readDocument(path: string): Promise<string> {
  return invoke<string>("read_document", { path });
}

export async function writeDocument(
  path: string,
  contents: string,
): Promise<void> {
  await invoke("write_document", { path, contents });
}

/** Emit a compiled bundle tree; returns the written bundle directory path. */
export async function exportBundle(
  tree: BundleTree,
  destDir: string,
): Promise<string> {
  return invoke<string>("export_bundle", { tree, destDir });
}
