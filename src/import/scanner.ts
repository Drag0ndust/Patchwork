/**
 * The Import Scanner: a thin shell that pairs the privileged Rust walk with the
 * pure catalog build. Everything decidable lives in `buildCatalog`; the only
 * thing here is the trip across the command boundary.
 */

import { scanRoots } from "../bridge/tauri";
import { buildCatalog, type ImportCatalog } from "./catalog";
import type { SourceRoot } from "./source-roots";

/** Scan the configured roots and resolve them into a pickable catalog. */
export async function scanSourceRoots(
  roots: readonly SourceRoot[],
): Promise<ImportCatalog> {
  const report = await scanRoots(roots.map((r) => ({ id: r.id, path: r.path })));
  return buildCatalog(roots, report);
}
