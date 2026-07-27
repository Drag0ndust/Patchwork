import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { BundleTree } from "../domain/compiler";

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
