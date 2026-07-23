//! Patchwork Tauri backend.
//!
//! This is the Rust side of the Rust <-> TS command boundary. The privileged
//! filesystem work lives here:
//!
//! - [`export_bundle`] is the **Bundle Emitter**: it writes a compiled
//!   [`BundleTree`] to disk with a clean-overwrite guarantee.
//! - [`read_document`] / [`write_document`] persist the `.patchwork` file.
//!
//! File pickers are driven from the TS side via the dialog plugin; these
//! commands take already-resolved absolute paths.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// A single file within a bundle, with a path relative to the bundle root.
#[derive(Debug, Deserialize)]
pub struct BundleFile {
    pub path: String,
    pub contents: String,
}

/// The in-memory bundle tree produced by the Graph Compiler on the TS side.
#[derive(Debug, Deserialize)]
pub struct BundleTree {
    #[serde(rename = "dirName")]
    pub dir_name: String,
    pub files: Vec<BundleFile>,
}

/// A safe bundle directory name: a single non-empty *normal* path component
/// (no separators, no `.`/`..`, not absolute). This guarantees the bundle
/// stays inside `dest_dir` and can never escape via the renderer-supplied name.
fn is_safe_dir_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// A safe relative file path: non-empty, not absolute, every component normal
/// (subdirectories are allowed, but `..` and root/prefix components are not).
fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let p = Path::new(path);
    !p.is_absolute() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Reject any tree whose paths could escape `dest_dir` before touching disk.
fn validate_bundle_paths(tree: &BundleTree) -> Result<(), String> {
    if !is_safe_dir_name(&tree.dir_name) {
        return Err(format!(
            "Refusing to write bundle: dirName {:?} must be a single relative path component \
             (no separators, no '..', not absolute)",
            tree.dir_name
        ));
    }
    for file in &tree.files {
        if !is_safe_relative_path(&file.path) {
            return Err(format!(
                "Refusing to write bundle: file path {:?} must be relative and contain no '..' \
                 or absolute components",
                file.path
            ));
        }
    }
    Ok(())
}

/// Write a bundle tree under `dest_dir`, replacing any existing bundle dir.
///
/// The clean-overwrite contract: if `dest_dir/<dirName>` already exists it is
/// removed entirely before writing, so stale files from a previous export can
/// never linger. Returns the absolute path of the written bundle directory.
///
/// Paths are validated *before* any filesystem mutation so a malicious or
/// buggy renderer cannot direct the recursive delete/write outside `dest_dir`.
pub fn write_bundle(tree: &BundleTree, dest_dir: &Path) -> Result<PathBuf, String> {
    validate_bundle_paths(tree)?;

    let bundle_dir = dest_dir.join(&tree.dir_name);

    if bundle_dir.exists() {
        fs::remove_dir_all(&bundle_dir)
            .map_err(|e| format!("Failed to clear existing bundle at {bundle_dir:?}: {e}"))?;
    }
    fs::create_dir_all(&bundle_dir)
        .map_err(|e| format!("Failed to create bundle directory {bundle_dir:?}: {e}"))?;

    for file in &tree.files {
        let target = bundle_dir.join(&file.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {parent:?}: {e}"))?;
        }
        fs::write(&target, &file.contents)
            .map_err(|e| format!("Failed to write {target:?}: {e}"))?;
    }

    Ok(bundle_dir)
}

/// Bundle Emitter command: write the compiled tree to the chosen drop location.
#[tauri::command]
fn export_bundle(tree: BundleTree, dest_dir: String) -> Result<String, String> {
    let written = write_bundle(&tree, Path::new(&dest_dir))?;
    Ok(written.to_string_lossy().into_owned())
}

/// Read a `.patchwork` document from disk.
#[tauri::command]
fn read_document(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Write a `.patchwork` document to disk.
#[tauri::command]
fn write_document(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("Failed to write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            export_bundle,
            read_document,
            write_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(dir: &str, files: &[(&str, &str)]) -> BundleTree {
        BundleTree {
            dir_name: dir.to_string(),
            files: files
                .iter()
                .map(|(p, c)| BundleFile {
                    path: p.to_string(),
                    contents: c.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn given_bundle_tree_when_written_then_files_exist_with_contents() {
        let dest = tempfile::tempdir().unwrap();
        let t = tree(
            "patchwork-demo",
            &[("SKILL.md", "hello"), ("skills/inner.md", "nested")],
        );

        let path = write_bundle(&t, dest.path()).unwrap();

        assert_eq!(path, dest.path().join("patchwork-demo"));
        assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), "hello");
        assert_eq!(
            fs::read_to_string(path.join("skills/inner.md")).unwrap(),
            "nested"
        );
    }

    #[test]
    fn given_absolute_dir_name_when_written_then_errors_and_leaves_siblings_untouched() {
        let dest = tempfile::tempdir().unwrap();
        let sentinel = dest.path().join("keep.txt");
        fs::write(&sentinel, "important").unwrap();

        let t = tree("/tmp", &[("SKILL.md", "x")]);
        let result = write_bundle(&t, dest.path());

        assert!(result.is_err());
        assert!(sentinel.exists(), "unrelated files must never be deleted");
    }

    #[test]
    fn given_parent_escape_in_dir_name_when_written_then_errors() {
        let dest = tempfile::tempdir().unwrap();
        let t = tree("../escape", &[("SKILL.md", "x")]);
        assert!(write_bundle(&t, dest.path()).is_err());
    }

    #[test]
    fn given_empty_dir_name_when_written_then_errors() {
        let dest = tempfile::tempdir().unwrap();
        let t = tree("", &[("SKILL.md", "x")]);
        assert!(write_bundle(&t, dest.path()).is_err());
    }

    #[test]
    fn given_parent_escape_in_file_path_when_written_then_errors_before_any_write() {
        let dest = tempfile::tempdir().unwrap();
        let t = tree("patchwork-demo", &[("../escape.md", "x")]);

        let result = write_bundle(&t, dest.path());

        assert!(result.is_err());
        assert!(
            !dest.path().join("patchwork-demo").exists(),
            "validation must reject before creating the bundle dir"
        );
    }

    #[test]
    fn given_existing_bundle_when_reexported_then_stale_files_are_removed() {
        let dest = tempfile::tempdir().unwrap();
        let first = tree(
            "patchwork-demo",
            &[("SKILL.md", "v1"), ("stale.md", "remove me")],
        );
        write_bundle(&first, dest.path()).unwrap();

        let second = tree("patchwork-demo", &[("SKILL.md", "v2")]);
        let path = write_bundle(&second, dest.path()).unwrap();

        assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), "v2");
        assert!(
            !path.join("stale.md").exists(),
            "stale file from previous export should be gone"
        );
    }
}
