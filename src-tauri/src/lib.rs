//! Patchwork Tauri backend.
//!
//! This is the Rust side of the Rust <-> TS command boundary. The privileged
//! filesystem work lives here:
//!
//! - [`export_bundle`] is the **Bundle Emitter**: it writes a compiled
//!   [`BundleTree`] to disk with a clean-overwrite guarantee.
//! - [`read_document`] / [`write_document`] persist the `.patchwork` file.
//! - [`scan_roots`] is the **Import Scanner**'s privileged half: it walks the
//!   user's configured source roots and hands raw artifact bytes to the TS side,
//!   which parses them with the (pure) Artifact Codec and Root Resolver.
//!
//! File pickers are driven from the TS side via the dialog plugin; these
//! commands take already-resolved absolute paths.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

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
/// Length bounds on an artifact name, mirroring `MAX_NAME_SEGMENT_LENGTH` and
/// `MAX_NAME_LENGTH` in `src/domain/artifact-codec.ts` — the Artifact Codec
/// rejects an over-long name, and enforcing it here too means the walk does not
/// read the file or charge the artifact and byte budgets for something the catalog
/// will discard. `given_the_name_length_bounds_then_they_agree_across_the_language_boundary`
/// fails if the two sides drift.
const MAX_NAME_SEGMENT_LENGTH: usize = 64;
const MAX_NAME_LENGTH: usize = 128;

/// The marker directory that makes a directory below `skills/` a **plugin**.
/// Its presence is the only thing that licenses a namespace segment, which is
/// what keeps arbitrary nested directories (a plugin's `references/`, a vendored
/// dependency tree) from being fabricated into importable artifact names.
const PLUGIN_MARKER: &str = ".claude-plugin";

/// Artifacts are Markdown; anything larger is not one, and reading it would
/// only bloat the payload sent to the renderer.
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024;

/// Aggregate backstops per root, so a pathological tree cannot flood the
/// renderer with artifacts, bytes, or notice lines. Each collapses into a single
/// summarizing problem.
const MAX_ARTIFACTS_PER_ROOT: usize = 512;
const MAX_BYTES_PER_ROOT: u64 = 8 * 1024 * 1024;
const MAX_PROBLEMS_PER_ROOT: usize = 20;

/// How many entries of a single directory are examined. Comfortably above the
/// artifact cap, so it only ever trips on a pathological directory — listing
/// canonicalizes every entry, so it should not run over an unbounded set.
const MAX_ENTRIES_PER_DIR: usize = 4096;

/// Backstops for a whole scan. Per-root caps alone leave the payload unbounded,
/// because the number of configured roots is not: 300 roots on one big tree would
/// ship the same tree 300 times.
///
/// `MAX_ROOTS_PER_SCAN` must stay equal to `MAX_SOURCE_ROOTS` in
/// `src/import/source-roots.ts`, which caps the configuration on the renderer
/// side. If the renderer allowed more roots than a scan reads, the extra ones
/// would be configurable but silently never scanned;
/// `given_the_two_root_caps_then_they_agree_across_the_language_boundary` fails if
/// they drift.
const MAX_ROOTS_PER_SCAN: usize = 16;

/// How many roots may be *offered* in one scan, valid or not. Rejected roots are
/// deliberately free of the scanned-root budget, so this is what keeps the loop
/// bounded against a renderer that offers thousands of duplicates or bad paths.
const MAX_ROOT_ATTEMPTS: usize = MAX_ROOTS_PER_SCAN * 4;
const MAX_ARTIFACTS_PER_SCAN: usize = 2048;
const MAX_BYTES_PER_SCAN: u64 = 16 * 1024 * 1024;

/// Every ceiling a scan enforces, as a value rather than a set of constants —
/// so a test can exercise a ceiling with a handful of files instead of thousands,
/// and so no ceiling can exist without being reachable. The defaults are the
/// shipped limits; `given_default_limits_then_they_are_the_documented_ceilings`
/// pins them.
#[derive(Debug, Clone)]
pub struct ScanLimits {
    pub max_roots_per_scan: usize,
    pub max_root_attempts: usize,
    pub max_artifacts_per_scan: usize,
    pub max_bytes_per_scan: u64,
    pub max_artifacts_per_root: usize,
    pub max_bytes_per_root: u64,
    pub max_problems_per_root: usize,
    pub max_entries_per_dir: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_roots_per_scan: MAX_ROOTS_PER_SCAN,
            max_root_attempts: MAX_ROOT_ATTEMPTS,
            max_artifacts_per_scan: MAX_ARTIFACTS_PER_SCAN,
            max_bytes_per_scan: MAX_BYTES_PER_SCAN,
            max_artifacts_per_root: MAX_ARTIFACTS_PER_ROOT,
            max_bytes_per_root: MAX_BYTES_PER_ROOT,
            max_problems_per_root: MAX_PROBLEMS_PER_ROOT,
            max_entries_per_dir: MAX_ENTRIES_PER_DIR,
        }
    }
}

/// A configured source root, as the renderer configured it. The **id** travels
/// with every artifact: a root's identity is role + path, so attributing by path
/// alone would erase the role and break `skills personal > project`.
#[derive(Debug, Deserialize)]
pub struct SourceRootInput {
    pub id: String,
    pub path: String,
}

/// A raw artifact found in a source root. Parsing is the Artifact Codec's job
/// on the TS side, so this carries bytes plus where they came from.
#[derive(Debug, Serialize)]
pub struct ScannedArtifact {
    /// The id of the configured root this came from, echoed back verbatim.
    #[serde(rename = "rootId")]
    pub root_id: String,
    /// `"skill"` or `"agent"`.
    pub kind: String,
    /// The name Claude Code invokes the artifact by, derived from its location:
    /// the skill's directory name or the agent's file stem, prefixed with the
    /// plugin directory as a single `:` namespace segment when there is one.
    pub name: String,
    pub path: String,
    pub contents: String,
}

/// The outcome of a scan: what was found, plus what went wrong. A scan never
/// fails as a whole — an unreadable root or file becomes a reported problem so
/// the rest of the import still works.
#[derive(Debug, Default, Serialize)]
pub struct ScanReport {
    pub artifacts: Vec<ScannedArtifact>,
    pub problems: Vec<String>,
}

/// Expand a leading `~` against `home`. Other paths are returned unchanged.
fn expand_home_with(path: &str, home: Option<&str>) -> Result<PathBuf, String> {
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
    };
    let Some(rest) = rest else {
        return Ok(PathBuf::from(path));
    };
    let home = home.filter(|h| !h.is_empty()).ok_or_else(|| {
        format!("Cannot expand '{path}': no home directory is set for this user")
    })?;
    Ok(if rest.is_empty() {
        PathBuf::from(home)
    } else {
        Path::new(home).join(rest)
    })
}

fn expand_home(path: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    expand_home_with(path, home.as_deref())
}

/// Accumulator for one root's scan: collects artifacts, enforces the aggregate
/// caps, and keeps problems bounded.
struct RootScan<'a> {
    root_id: &'a str,
    root_path: &'a str,
    limits: &'a ScanLimits,
    /// Artifacts and bytes already taken by earlier roots in this scan.
    spent: &'a ScanBudget,
    found: Vec<ScannedArtifact>,
    /// Where each (kind, name) was first claimed, so an alias is reported rather
    /// than silently dropped.
    claimed: HashMap<(String, String), String>,
    problems: Vec<String>,
    /// Notices whose entire job is to say "you are not seeing everything".
    /// They get their own budget, because the ordinary problem cap suppressing
    /// them is the one loss that must never be silent.
    reserved_problems: Vec<String>,
    suppressed_problems: usize,
    bytes: u64,
    capped: Option<String>,
}

impl<'a> RootScan<'a> {
    fn new(
        root_id: &'a str,
        root_path: &'a str,
        limits: &'a ScanLimits,
        spent: &'a ScanBudget,
    ) -> Self {
        Self {
            root_id,
            root_path,
            limits,
            spent,
            found: Vec::new(),
            claimed: HashMap::new(),
            problems: Vec::new(),
            reserved_problems: Vec::new(),
            suppressed_problems: 0,
            bytes: 0,
            capped: None,
        }
    }

    fn problem(&mut self, message: String) {
        if self.problems.len() < self.limits.max_problems_per_root {
            self.problems.push(message);
        } else {
            self.suppressed_problems += 1;
        }
    }

    /// Report that artifacts were skipped without being examined. Unlike an
    /// ordinary problem this cannot be crowded out: 25 escaping symlinks used to
    /// exhaust the cap and then hide the fact that ten skills were dropped.
    fn truncation_problem(&mut self, message: String) {
        if self.reserved_problems.len() < self.limits.max_problems_per_root {
            self.reserved_problems.push(message);
        } else {
            self.suppressed_problems += 1;
        }
    }

    /// True once a cap has tripped: the rest of this root is skipped.
    fn is_capped(&self) -> bool {
        self.capped.is_some()
    }

    /// Record that a cap stopped the scan of this root. First one wins.
    fn cap(&mut self, message: String) {
        if self.capped.is_none() {
            self.capped = Some(message);
        }
    }

    /// Take one artifact leaf: a `SKILL.md` or an `agents/<name>.md`.
    ///
    /// **Every** leaf of either kind arrives here, so the containment decision is
    /// made in exactly one place and cannot drift between the two shapes.
    ///
    /// A leaf that resolves outside `base` is imported, not refused: dotfiles
    /// users legitimately symlink an individual `SKILL.md` into
    /// `~/.claude/skills/<name>/`, and the name comes from the containing
    /// directory, which *is* inside the tree. What matters is that a **symlinked**
    /// escape is visible rather than invisible, so it is reported and the
    /// canonical path is what travels to the UI — the picker and the collision
    /// notices then show where the bytes really are, not the symlink that pointed
    /// at them. A *hardlink* to a file outside the tree is indistinguishable from
    /// an ordinary file (there is nothing to resolve, and `st_nlink > 1` is true
    /// of plenty of legitimate files), so that case is not detected.
    ///
    /// (A symlinked *directory* is refused instead — see `contained_children` —
    /// because a foreign directory tree can mint names and namespaces, which is a
    /// different and larger problem than one file living elsewhere.)
    fn add(&mut self, kind: &str, name: String, link_path: &Path, base: &Path) {
        if self.is_capped() {
            return;
        }
        if self.found.len() >= self.limits.max_artifacts_per_root {
            let (root_path, per_root) = (self.root_path, self.limits.max_artifacts_per_root);
            self.cap(format!(
                "Stopped importing from '{root_path}': it holds more than the {per_root} artifacts Patchwork imports from one source root"
            ));
            return;
        }
        if self.spent.artifacts + self.found.len() >= self.limits.max_artifacts_per_scan {
            let (root_path, per_scan) = (self.root_path, self.limits.max_artifacts_per_scan);
            self.cap(format!(
                "Stopped importing from '{root_path}': the {per_scan}-artifact limit across all source roots was reached"
            ));
            return;
        }

        let path = match link_path.canonicalize() {
            Ok(canonical) => canonical,
            Err(e) => {
                self.problem(format!("Skipped {}: {e}", link_path.display()));
                return;
            }
        };
        if !path.starts_with(base) {
            self.problem(format!(
                "{kind} '{name}' is a link to {}, outside {} — importing it, but its real location is elsewhere",
                path.display(),
                base.display()
            ));
        }

        if let Some(reason) = over_long_name(&name) {
            self.problem(format!(
                "Skipped {}: {kind} name {reason}",
                link_path.display()
            ));
            return;
        }

        let key = (kind.to_string(), name.clone());
        if let Some(first) = self.claimed.get(&key) {
            self.problem(format!(
                "Skipped {}: {kind} '{name}' was already imported from {first} (two locations resolve to the same name)",
                path.display()
            ));
            return;
        }

        match read_artifact(&path) {
            Ok(contents) => {
                // Counted only once the artifact is actually kept, so a rejected
                // one cannot spend a budget that is shared across roots.
                let with_this = self.bytes + contents.len() as u64;
                if with_this > self.limits.max_bytes_per_root {
                    let (root_path, per_root) =
                        (self.root_path, self.limits.max_bytes_per_root);
                    self.cap(format!(
                        "Stopped importing from '{root_path}': it holds more than the {per_root} bytes of artifacts Patchwork imports from one source root"
                    ));
                    return;
                }
                if self.spent.bytes + with_this > self.limits.max_bytes_per_scan {
                    let (root_path, per_scan) = (self.root_path, self.limits.max_bytes_per_scan);
                    self.cap(format!(
                        "Stopped importing from '{root_path}': the {per_scan}-byte limit across all source roots was reached"
                    ));
                    return;
                }
                self.bytes = with_this;
                self.claimed.insert(key, path.display().to_string());
                self.found.push(ScannedArtifact {
                    root_id: self.root_id.to_string(),
                    kind: kind.to_string(),
                    name,
                    path: path.to_string_lossy().into_owned(),
                    contents,
                });
            }
            Err(problem) => self.problem(problem),
        }
    }

    fn finish(mut self, report: &mut ScanReport, spent: &mut ScanBudget) {
        spent.artifacts += self.found.len();
        spent.bytes += self.bytes;
        // Directory order is arbitrary; a total order (kind, name, path) keeps
        // the picker and precedence tie-breaking stable across scans.
        let kind_rank = |a: &ScannedArtifact| u8::from(a.kind == "agent");
        self.found.sort_by(|a, b| {
            (kind_rank(a), &a.name, &a.path).cmp(&(kind_rank(b), &b.name, &b.path))
        });
        report.artifacts.extend(self.found);
        report.problems.append(&mut self.problems);
        report.problems.append(&mut self.reserved_problems);
        if self.suppressed_problems > 0 {
            report.problems.push(format!(
                "…and {} more problem(s) in '{}' (suppressed)",
                self.suppressed_problems, self.root_path
            ));
        }
        if let Some(capped) = self.capped {
            report.problems.push(capped);
        }
    }
}

/// One entry of a scanned directory.
struct Child {
    name: String,
    /// The path as listed (possibly a symlink). Leaves are canonicalized by
    /// `RootScan::add`, which is the single place that decides on containment.
    path: PathBuf,
    is_dir: bool,
}

/// The containment boundary, in its own module so the invariant is enforced by
/// the compiler rather than by everyone remembering it.
///
/// [`ContainedDir`]'s field is private to this module, and this module contains
/// nothing but its two constructors — so no walk function can forge one from an
/// arbitrary path. That matters because the walk is what forgot last time:
/// containment used to be checked on a directory's *entries* while the directory
/// handed in was an unchecked `join`. That held for the skill shapes by luck
/// (their entries are directories, which are refused when they escape) and failed
/// for a plugin's `agents/`, whose entries are files — so a symlinked `agents/`
/// imported a foreign tree one file at a time, under the local plugin's
/// namespace. `ContainedDir(PathBuf::from("/etc"))` does not compile outside this
/// module; that is the whole point of it.
mod contained {
    use std::path::{Path, PathBuf};

    use super::{is_present, is_symlink, RootScan};

    /// A directory that has been canonicalized and proven to sit inside the tree
    /// base — the only thing [`super::contained_children`] can list.
    pub struct ContainedDir(PathBuf);

    impl ContainedDir {
        /// The base of a tree (`<root>/skills`, `<root>/agents`). It defines its
        /// own containment, because it is legitimately a symlink out of the root
        /// for anyone keeping their artifacts in a dotfiles repo.
        pub fn open_tree(scan: &mut RootScan, dir: &Path) -> Option<Self> {
            canonical_dir(scan, dir).map(Self)
        }

        /// A directory *inside* an already-established tree: it must resolve
        /// within `base`, or it is refused and reported. This is what stops a
        /// plugin's `skills/` or `agents/` from pointing at someone else's files.
        pub fn open_within(scan: &mut RootScan, dir: &Path, base: &Path) -> Option<Self> {
            let canonical = canonical_dir(scan, dir)?;
            if !canonical.starts_with(base) {
                scan.problem(format!(
                    "Skipped directory {}: it resolves to {}, outside {}",
                    dir.display(),
                    canonical.display(),
                    base.display()
                ));
                return None;
            }
            Some(Self(canonical))
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    /// Canonicalize a directory.
    ///
    /// A missing directory is normal and silent. Anything that is *there* but
    /// unusable is reported: a dangling symlink (a moved dotfiles repo makes every
    /// artifact below it vanish, and "0 agents" with no explanation is the worst
    /// possible way to learn that) or a plain file where a directory belongs.
    fn canonical_dir(scan: &mut RootScan, dir: &Path) -> Option<PathBuf> {
        match dir.canonicalize() {
            Ok(canonical) if canonical.is_dir() => Some(canonical),
            Ok(canonical) => {
                scan.problem(format!(
                    "Ignored {}: it is a file, not a directory ({})",
                    dir.display(),
                    canonical.display()
                ));
                None
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !is_present(dir) => None,
            Err(e) => {
                scan.problem(format!(
                    "Ignored {}: {e} — nothing was imported from it{}",
                    dir.display(),
                    if is_symlink(dir) {
                        " (the symlink's target is missing)"
                    } else {
                        ""
                    }
                ));
                None
            }
        }
    }
}

use contained::ContainedDir;

/// The children of `dir`, sorted by name for determinism.
///
/// Skips, with a reported problem, anything that cannot safely be part of an
/// artifact name: a non-UTF-8 name, a `:` in a path segment (reserved for
/// namespacing), or an entry that cannot be resolved at all.
///
/// Child **directories** that resolve outside `base` are refused here, because a
/// foreign directory tree would let names and namespaces be minted from someone
/// else's files. Child *files* are not judged here — they go to `RootScan::add`,
/// which imports them but reports the escape and records their canonical
/// location. Since `dir` is a [`ContainedDir`], the directory being listed is
/// itself already known to be inside `base`.
fn contained_children(scan: &mut RootScan, dir: &ContainedDir, base: &Path) -> Vec<Child> {
    let dir = dir.path();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            scan.problem(format!("Could not read {}: {e}", dir.display()));
            return Vec::new();
        }
    };

    // Names are collected first and sorted BEFORE the entry cap truncates, so the
    // kept subset is the predictable, alphabetical one rather than an arbitrary
    // slice of whatever order the filesystem returned. Only names are held at this
    // stage — the expensive part (canonicalizing, stat-ing) happens after the cut.
    let mut names: Vec<String> = Vec::new();
    let mut unusable = 0usize;
    for entry in entries.flatten() {
        match entry.path().file_name().and_then(|n| n.to_str()) {
            Some(name) if name.starts_with('.') => {} // Dotfiles and the marker.
            Some(name) => names.push(name.to_string()),
            None => unusable += 1,
        }
    }
    if unusable > 0 {
        scan.problem(format!(
            "Skipped {unusable} entr{} in {}: the name is not valid UTF-8",
            if unusable == 1 { "y" } else { "ies" },
            dir.display()
        ));
    }
    names.sort();
    if names.len() > scan.limits.max_entries_per_dir {
        let dropped = names.len() - scan.limits.max_entries_per_dir;
        let max = scan.limits.max_entries_per_dir;
        names.truncate(max);
        scan.truncation_problem(format!(
            "Examined only the first {max} of {} entries in {} (alphabetically); {dropped} were skipped and any artifacts among them were not imported",
            names.len() + dropped,
            dir.display()
        ));
    }

    let mut children: Vec<Child> = Vec::new();
    for name in names {
        if scan.is_capped() {
            break;
        }
        let path = dir.join(&name);
        if name.contains(':') {
            scan.problem(format!(
                "Skipped {}: ':' is reserved for namespacing artifact names",
                path.display()
            ));
            continue;
        }
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(e) => {
                scan.problem(format!("Skipped {}: {e}", path.display()));
                continue;
            }
        };
        let is_dir = canonical.is_dir();
        if is_dir && !canonical.starts_with(base) {
            scan.problem(format!(
                "Skipped directory {}: it resolves to {}, outside {}",
                path.display(),
                canonical.display(),
                base.display()
            ));
            continue;
        }
        children.push(Child {
            name,
            path,
            is_dir,
        });
    }

    children
}

/// Why a name is too long to be usable, if it is.
///
/// Names end up in an inline code span in the emitted `SKILL.md`, so the bound
/// exists for the same reason on both sides of the command boundary.
fn over_long_name(name: &str) -> Option<String> {
    if name.chars().count() > MAX_NAME_LENGTH {
        return Some(format!(
            "is longer than {MAX_NAME_LENGTH} characters ({})",
            name.chars().count()
        ));
    }
    name.split(':')
        .find(|segment| segment.chars().count() > MAX_NAME_SEGMENT_LENGTH)
        .map(|segment| {
            format!(
                "has a segment longer than {MAX_NAME_SEGMENT_LENGTH} characters ({})",
                segment.chars().count()
            )
        })
}

/// Read an artifact's bytes.
///
/// Two things are deliberately not trusted: the file *type* (a FIFO would block
/// `read_to_string` forever, wedging this privileged command with no way to
/// cancel) and the advertised *length* (a symlink to a character device such as
/// `/dev/zero` reports 0 bytes and then streams for ever). So this requires a
/// regular file and reads through a hard byte ceiling.
fn read_artifact(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("Could not stat {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "Skipped {}: not a regular file (it resolves to a device, socket, or pipe)",
            path.display()
        ));
    }
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "Skipped {}: {} bytes exceeds the {MAX_ARTIFACT_BYTES}-byte artifact limit",
            path.display(),
            metadata.len()
        ));
    }

    let file = fs::File::open(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_ARTIFACT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "Skipped {}: it kept producing bytes past the {MAX_ARTIFACT_BYTES}-byte artifact limit",
            path.display()
        ));
    }
    String::from_utf8(bytes).map_err(|_| format!("Skipped {}: not valid UTF-8", path.display()))
}

/// True if something exists at `path` without following symlinks — so a dangling
/// symlink counts as present.
fn is_present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Decide whether `dir` is a plugin, i.e. may mint a namespace segment.
///
/// The marker is a trust boundary — it is the single thing that licenses a name
/// like `coding:tdd` — so it is checked like one: it must be a real directory
/// *inside* the tree. A marker symlinked out of the tree must not license a
/// namespace, and a marker that is a regular file (a common mistake) silently
/// disabled the whole plugin before, so that is reported.
fn is_plugin(scan: &mut RootScan, dir: &Path, base: &Path) -> bool {
    let marker = dir.join(PLUGIN_MARKER);
    match marker.canonicalize() {
        Ok(canonical) if canonical.is_dir() => {
            if canonical.starts_with(base) {
                return true;
            }
            scan.problem(format!(
                "Ignored the {PLUGIN_MARKER} marker in {}: it resolves to {}, outside {}, so this directory does not provide a namespace",
                dir.display(),
                canonical.display(),
                base.display()
            ));
            false
        }
        Ok(_) => {
            scan.problem(format!(
                "{}/{PLUGIN_MARKER} is a file, not a directory, so {} is not treated as a plugin and its skills and agents are not imported",
                dir.display(),
                dir.display()
            ));
            false
        }
        Err(_) => false, // No marker: an ordinary skill directory.
    }
}

/// Walk `<root>/skills`: flat skills, plus the plugin directories inside it.
fn scan_skills_dir(scan: &mut RootScan, skills_dir: &Path) {
    let Some(tree) = ContainedDir::open_tree(scan, skills_dir) else {
        return;
    };
    let base = tree.path().to_path_buf();

    for child in contained_children(scan, &tree, &base) {
        if scan.is_capped() {
            return;
        }
        if !child.is_dir {
            continue; // A loose Markdown file beside the skills is not an artifact.
        }
        // `<root>/skills/<name>/SKILL.md` — also the shape of a plugin whose
        // SKILL.md sits at its root, which is invoked by the plugin name alone.
        let skill_md = child.path.join("SKILL.md");
        if is_present(&skill_md) {
            scan.add("skill", child.name.clone(), &skill_md, &base);
        }
        if is_plugin(scan, &child.path, &base) {
            scan_plugin(scan, &child.path, &child.name, &base);
        }
    }
}

/// Walk one plugin directory: `<plugin>/skills/<name>/SKILL.md` and
/// `<plugin>/agents/<name>.md`, and nothing deeper.
fn scan_plugin(scan: &mut RootScan, plugin_dir: &Path, plugin: &str, base: &Path) {
    // Both plugin subtrees must resolve inside the tree, or a symlinked
    // `skills/`/`agents/` would mint names in this plugin's namespace from
    // someone else's files.
    if let Some(plugin_skills) = ContainedDir::open_within(scan, &plugin_dir.join("skills"), base) {
        for child in contained_children(scan, &plugin_skills, base) {
            if scan.is_capped() {
                return;
            }
            if !child.is_dir {
                continue;
            }
            let skill_md = child.path.join("SKILL.md");
            if is_present(&skill_md) {
                scan.add("skill", format!("{plugin}:{}", child.name), &skill_md, base);
            }
        }
    }
    if let Some(plugin_agents) = ContainedDir::open_within(scan, &plugin_dir.join("agents"), base) {
        scan_agents_dir(scan, &plugin_agents, Some(plugin), base);
    }
}

/// Walk an `agents` directory: single `.md` files, no nesting.
fn scan_agents_dir(
    scan: &mut RootScan,
    agents_dir: &ContainedDir,
    plugin: Option<&str>,
    base: &Path,
) {
    for child in contained_children(scan, agents_dir, base) {
        if scan.is_capped() {
            return;
        }
        if child.is_dir {
            continue; // The agents directory is flat.
        }
        if child.name == "SKILL.md" {
            continue; // A skill file misplaced here must not claim a name.
        }
        let Some(stem) = child.name.strip_suffix(".md") else {
            continue;
        };
        let full_name = match plugin {
            Some(plugin) => format!("{plugin}:{stem}"),
            None => stem.to_string(),
        };
        scan.add("agent", full_name, &child.path, base);
    }
}

/// A scan across one or more configured roots.
///
/// This is the ONLY entry point, deliberately: the per-scan ceilings and the
/// resolved-directory dedupe live on the scan, so every caller — the Tauri
/// command, a test, a future caller — gets the same safety properties. A
/// per-root free function used to exist alongside it, which meant N calls got N
/// fresh budgets and no ceiling at all.
///
/// The layout each root is read with is bounded — at most one namespace segment,
/// and only from a plugin directory (marked by `.claude-plugin/`):
///
/// - `<root>/skills/<name>/SKILL.md` → skill `<name>`
/// - `<root>/agents/<name>.md` → agent `<name>`
/// - `<root>/skills/<plugin>/SKILL.md` → skill `<plugin>`
/// - `<root>/skills/<plugin>/skills/<name>/SKILL.md` → skill `<plugin>:<name>`
/// - `<root>/skills/<plugin>/agents/<name>.md` → agent `<plugin>:<name>`
///
/// Nothing else is importable. `parseArtifactLocation` in the Artifact Codec is
/// the pure statement of the same rule, and both are driven by the shared table
/// in `src/domain/__fixtures__/artifact-locations.json`.
pub struct Scan {
    limits: ScanLimits,
    report: ScanReport,
    spent: ScanBudget,
    /// Canonical directory -> the id of the root that claimed it first.
    seen_dirs: HashMap<PathBuf, String>,
    /// How many roots were actually scanned. A rejected root does not spend one,
    /// so a duplicate can never cost a later valid root its scan.
    roots: usize,
    /// How many roots were *offered*, rejected ones included. This is what bounds
    /// the work: rejections are free by design, so without a separate count an
    /// untrusted renderer could offer millions of bad roots and each would push a
    /// problem. `scan_roots` is the privileged side of the command boundary — a
    /// bound that holds only because the current renderer is well-behaved is not a
    /// bound.
    attempts: usize,
    root_cap_reported: bool,
    attempt_cap_reported: bool,
}

/// What a scan has already spent, so per-root caps compose into per-scan ones.
#[derive(Debug, Default)]
pub struct ScanBudget {
    pub artifacts: usize,
    pub bytes: u64,
}

impl Default for Scan {
    fn default() -> Self {
        Self::with_limits(ScanLimits::default())
    }
}

impl Scan {
    pub fn with_limits(limits: ScanLimits) -> Self {
        // The two root bounds mean different things and are independently
        // settable, but only one ordering is coherent: attempts must leave room
        // for the roots that may be scanned, or valid roots are dropped with only
        // the attempt-cap line to explain it — which reads as if the caller had
        // offered junk.
        debug_assert!(
            limits.max_root_attempts >= limits.max_roots_per_scan,
            "max_root_attempts ({}) must leave room for max_roots_per_scan ({})",
            limits.max_root_attempts,
            limits.max_roots_per_scan
        );
        Self {
            limits,
            report: ScanReport::default(),
            spent: ScanBudget::default(),
            seen_dirs: HashMap::new(),
            roots: 0,
            attempts: 0,
            root_cap_reported: false,
            attempt_cap_reported: false,
        }
    }

    /// Add one configured root to this scan.
    ///
    /// A root slot is spent only when a root is actually **scanned**: a duplicate
    /// or a missing directory must not consume the budget and push a later, valid
    /// root past the ceiling, which would drop it with only the ceiling's own
    /// message to explain the loss.
    pub fn root(&mut self, root_id: &str, root_path: &str) -> &mut Self {
        self.attempts += 1;
        if self.attempts > self.limits.max_root_attempts {
            if !self.attempt_cap_reported {
                self.attempt_cap_reported = true;
                let attempts = self.limits.max_root_attempts;
                self.report.problems.push(format!(
                    "Stopped after {attempts} source-root attempts; the remaining entries were ignored"
                ));
            }
            return self;
        }
        if self.roots >= self.limits.max_roots_per_scan {
            if !self.root_cap_reported {
                self.root_cap_reported = true;
                let max = self.limits.max_roots_per_scan;
                self.report.problems.push(format!(
                    "Only the first {max} configured source roots were scanned"
                ));
            }
            return self;
        }

        let dir = match expand_home(root_path) {
            Ok(dir) => dir,
            Err(e) => {
                self.report.problems.push(e);
                return self;
            }
        };
        let dir = match dir.canonicalize() {
            Ok(canonical) if canonical.is_dir() => canonical,
            _ => {
                self.report.problems.push(format!(
                    "Source root '{root_path}' is not a directory; nothing was imported from it"
                ));
                return self;
            }
        };

        // Two configured roots can name the same directory (`~/.claude` and its
        // absolute form, or a symlink to it). Scanning it twice would ship the
        // whole tree twice and report every artifact as shadowing itself.
        if let Some(first) = self.seen_dirs.get(&dir) {
            self.report.problems.push(format!(
                "Source root '{root_path}' resolves to the same directory as root '{first}'; scanned once"
            ));
            return self;
        }
        self.seen_dirs.insert(dir.clone(), root_id.to_string());
        self.roots += 1;

        let mut root_scan = RootScan::new(root_id, root_path, &self.limits, &self.spent);
        scan_skills_dir(&mut root_scan, &dir.join("skills"));
        if let Some(agents) = ContainedDir::open_tree(&mut root_scan, &dir.join("agents")) {
            let base = agents.path().to_path_buf();
            scan_agents_dir(&mut root_scan, &agents, None, &base);
        }
        let mut used = ScanBudget::default();
        root_scan.finish(&mut self.report, &mut used);
        self.spent.artifacts += used.artifacts;
        self.spent.bytes += used.bytes;
        self
    }

    pub fn finish(self) -> ScanReport {
        self.report
    }
}

/// Import Scanner command: walk every configured root in order.
///
/// Root order is preserved in the report, because the Root Resolver breaks
/// same-role ties by which root the user configured first.
#[tauri::command]
fn scan_roots(roots: Vec<SourceRootInput>) -> ScanReport {
    let mut scan = Scan::default();
    for root in &roots {
        scan.root(&root.id, &root.path);
    }
    scan.finish()
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
            write_document,
            scan_roots
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
        );    }

    // --- Import Scanner ----------------------------------------------------

    const ARTIFACT: &str = "---\ndescription: An artifact.\n---\n\nBody.\n";

    fn write_file(path: PathBuf, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    /// Mark `dir` as a plugin the way Claude Code does.
    fn mark_plugin(dir: &Path) {
        write_file(dir.join(".claude-plugin/plugin.json"), "{}");
    }

    /// A root with one flat skill and one flat agent.
    fn populated_root(dir: &Path) {
        write_file(dir.join("skills/tdd/SKILL.md"), ARTIFACT);
        write_file(dir.join("agents/pr-reviewer.md"), ARTIFACT);
    }

    /// A root with one plugin holding a skill, an agent, and reference material.
    fn plugin_root(dir: &Path) {
        mark_plugin(&dir.join("skills/coding"));
        write_file(dir.join("skills/coding/skills/tdd/SKILL.md"), ARTIFACT);
        write_file(dir.join("skills/coding/agents/pr-reviewer.md"), ARTIFACT);
        write_file(dir.join("skills/coding/references/guide.md"), "not an artifact");
    }

    fn scan_one(root: &Path) -> ScanReport {
        let mut scan = Scan::default();
        scan.root("personal:test", &root.to_string_lossy());
        scan.finish()
    }

    fn scan_all(roots: &[(&str, &Path)]) -> ScanReport {
        let mut scan = Scan::default();
        for (id, path) in roots {
            scan.root(id, &path.to_string_lossy());
        }
        scan.finish()
    }

    fn discovered(report: &ScanReport) -> Vec<(&str, &str)> {
        report
            .artifacts
            .iter()
            .map(|a| (a.kind.as_str(), a.name.as_str()))
            .collect()
    }

    #[test]
    fn given_flat_root_when_scanned_then_skill_and_agent_are_discovered() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());

        let report = scan_one(root.path());

        assert_eq!(report.problems, Vec::<String>::new());
        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert!(report.artifacts[0].contents.contains("An artifact."));
        assert!(report.artifacts[0].path.ends_with("skills/tdd/SKILL.md"));
        assert_eq!(report.artifacts[0].root_id, "personal:test");
    }

    #[test]
    fn given_plugin_root_when_scanned_then_the_plugin_is_the_only_namespace_segment() {
        let root = tempfile::tempdir().unwrap();
        plugin_root(root.path());

        let report = scan_one(root.path());

        assert_eq!(report.problems, Vec::<String>::new());
        assert_eq!(
            discovered(&report),
            vec![("skill", "coding:tdd"), ("agent", "coding:pr-reviewer")]
        );
    }

    #[test]
    fn given_plugin_with_skill_md_at_its_root_when_scanned_then_it_is_invoked_by_the_plugin_name() {
        // The real `graphify` shape: a single-skill plugin.
        let root = tempfile::tempdir().unwrap();
        mark_plugin(&root.path().join("skills/graphify"));
        write_file(root.path().join("skills/graphify/SKILL.md"), ARTIFACT);
        write_file(root.path().join("skills/graphify/references/x.md"), "no");

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "graphify")]);
    }

    #[test]
    fn given_vendored_skill_md_below_a_plugin_when_scanned_then_it_is_not_importable() {
        // The break: a vendored dependency tree must not be fabricated into a
        // namespaced skill (`writing:excalidraw:references:vendored`).
        let root = tempfile::tempdir().unwrap();
        plugin_root(root.path());
        write_file(
            root.path()
                .join("skills/coding/references/vendored/playwright/SKILL.md"),
            ARTIFACT,
        );
        write_file(
            root.path()
                .join("skills/coding/skills/tdd/references/nested/SKILL.md"),
            ARTIFACT,
        );

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "coding:tdd"), ("agent", "coding:pr-reviewer")]
        );
        assert!(
            !report
                .artifacts
                .iter()
                .any(|a| a.name.contains("references") || a.name.contains("vendored")),
            "no name may be fabricated from a non-plugin directory: {:?}",
            report.artifacts.iter().map(|a| &a.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn given_nested_skills_without_the_plugin_marker_when_scanned_then_nothing_is_importable() {
        let root = tempfile::tempdir().unwrap();
        write_file(
            root.path().join("skills/not-a-plugin/skills/tdd/SKILL.md"),
            ARTIFACT,
        );
        write_file(
            root.path().join("skills/not-a-plugin/agents/reviewer.md"),
            ARTIFACT,
        );

        let report = scan_one(root.path());

        assert!(
            report.artifacts.is_empty(),
            "without a {PLUGIN_MARKER} marker there is no plugin and no namespace: {:?}",
            discovered(&report)
        );
    }

    #[test]
    fn given_skill_md_inside_a_plugins_agents_dir_when_scanned_then_it_claims_no_name() {
        let root = tempfile::tempdir().unwrap();
        plugin_root(root.path());
        write_file(root.path().join("skills/coding/agents/SKILL.md"), ARTIFACT);

        let report = scan_one(root.path());

        assert!(!report.artifacts.iter().any(|a| a.name == "coding"));
        assert!(!report.artifacts.iter().any(|a| a.name == "coding:SKILL"));
    }

    #[test]
    fn given_colon_in_a_path_segment_when_scanned_then_it_is_reported_and_skipped() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/pr:reviewer/SKILL.md"), ARTIFACT);

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert!(report.problems[0].contains("reserved for namespacing"));
    }

    #[test]
    fn given_directory_without_skill_md_when_scanned_then_it_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("skills/not-a-skill")).unwrap();
        write_file(root.path().join("skills/notes.md"), "loose file");

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[test]
    fn given_root_without_skills_or_agents_dirs_when_scanned_then_no_problem_is_reported() {
        let root = tempfile::tempdir().unwrap();

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[test]
    fn given_hidden_directory_when_scanned_then_it_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/.git/tdd/SKILL.md"), ARTIFACT);

        assert!(scan_one(root.path()).artifacts.is_empty());
    }

    #[test]
    fn given_missing_root_when_scanned_then_problem_is_reported_without_panicking() {
        let mut scan = Scan::default();
        scan.root("personal:x", "/definitely/not/a/real/root");
        let report = scan.finish();

        assert!(report.artifacts.is_empty());
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("is not a directory"));
    }

    #[test]
    fn given_oversized_artifact_when_scanned_then_it_is_skipped_with_a_problem() {
        let root = tempfile::tempdir().unwrap();
        let big = "x".repeat((MAX_ARTIFACT_BYTES + 1) as usize);
        write_file(root.path().join("skills/huge/SKILL.md"), &big);

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert!(report.problems[0].contains("exceeds the"));
    }

    #[test]
    fn given_more_artifacts_than_the_cap_when_scanned_then_one_summarizing_problem_is_reported() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..(MAX_ARTIFACTS_PER_ROOT + 10) {
            write_file(
                root.path().join(format!("skills/skill-{i:04}/SKILL.md")),
                ARTIFACT,
            );
        }

        let report = scan_one(root.path());

        assert_eq!(report.artifacts.len(), MAX_ARTIFACTS_PER_ROOT);
        assert_eq!(report.problems.len(), 1);
        assert!(
            report.problems[0].contains("Stopped importing"),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_many_broken_artifacts_when_scanned_then_problems_are_capped_and_summarized() {
        let root = tempfile::tempdir().unwrap();
        let big = "x".repeat((MAX_ARTIFACT_BYTES + 1) as usize);
        for i in 0..(MAX_PROBLEMS_PER_ROOT + 15) {
            write_file(root.path().join(format!("skills/huge-{i:04}/SKILL.md")), &big);
        }

        let report = scan_one(root.path());

        assert_eq!(report.problems.len(), MAX_PROBLEMS_PER_ROOT + 1);
        assert!(report.problems.last().unwrap().contains("more problem(s)"));
    }

    #[cfg(unix)]
    #[test]
    fn given_fifo_named_skill_md_when_scanned_then_it_is_reported_instead_of_blocking() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());
        let fifo = root.path().join("skills/evil");
        fs::create_dir_all(&fifo).unwrap();
        let status = std::process::Command::new("mkfifo")
            .arg(fifo.join("SKILL.md"))
            .status()
            .unwrap();
        assert!(status.success(), "mkfifo must be available for this test");

        // If this ever regresses, the test hangs rather than fails — which is
        // exactly the user-facing symptom (the scan promise never settles).
        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert!(report.problems[0].contains("not a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn given_skill_md_symlinked_to_a_character_device_when_scanned_then_it_is_reported() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());
        let evil = root.path().join("skills/evil");
        fs::create_dir_all(&evil).unwrap();
        // /dev/zero reports len() == 0 and then streams NUL bytes for ever, so
        // the advertised length can never be the only guard.
        std::os::unix::fs::symlink("/dev/zero", evil.join("SKILL.md")).unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert!(
            report.problems.iter().any(|p| p.contains("not a regular file")),
            "{:?}",
            report.problems
        );
    }

    #[cfg(unix)]
    #[test]
    fn given_symlink_escaping_the_tree_when_scanned_then_it_is_reported_and_nothing_outside_is_imported()
    {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        populated_root(root.path());
        write_file(outside.path().join("stranger/SKILL.md"), ARTIFACT);
        std::os::unix::fs::symlink(outside.path(), root.path().join("skills/escape")).unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert!(report.problems[0].contains("outside"));
        assert!(
            !report
                .artifacts
                .iter()
                .any(|a| a.path.contains(outside.path().to_str().unwrap())),
            "nothing outside the tree may be attributed to this root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn given_skill_md_symlinked_out_of_the_tree_when_scanned_then_the_canonical_path_is_reported() {
        // The break: a skill leaf bypassed the containment check that agent
        // leaves got, so a root could present a stranger's file as its own with
        // the symlink shown as the location.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let stolen = outside.path().join("stolen.md");
        write_file(stolen.clone(), ARTIFACT);
        fs::create_dir_all(root.path().join("skills/pwn")).unwrap();
        std::os::unix::fs::symlink(&stolen, root.path().join("skills/pwn/SKILL.md")).unwrap();

        let report = scan_one(root.path());

        // Imported (dotfiles users do this deliberately) but never misattributed.
        assert_eq!(discovered(&report), vec![("skill", "pwn")]);
        assert_eq!(
            report.artifacts[0].path,
            stolen.canonicalize().unwrap().to_string_lossy(),
            "the reported path must be where the bytes are, not the symlink"
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("outside"), "{:?}", report.problems);
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_skill_md_symlinked_out_of_the_tree_when_scanned_then_it_is_reported_too() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_file(outside.path().join("stolen.md"), ARTIFACT);
        mark_plugin(&root.path().join("skills/coding"));
        fs::create_dir_all(root.path().join("skills/coding/skills/pwn")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("stolen.md"),
            root.path().join("skills/coding/skills/pwn/SKILL.md"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "coding:pwn")]);
        assert!(report.problems[0].contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn given_agent_symlinked_out_of_the_tree_when_scanned_then_it_is_treated_like_a_skill_leaf() {
        // Both kinds must reach the same check by the same route.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_file(outside.path().join("stolen.md"), ARTIFACT);
        fs::create_dir_all(root.path().join("agents")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("stolen.md"),
            root.path().join("agents/pwn.md"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("agent", "pwn")]);
        assert_eq!(
            report.artifacts[0].path,
            outside
                .path()
                .join("stolen.md")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn given_skill_md_symlinked_within_the_tree_when_scanned_then_nothing_is_reported() {
        // The dotfiles case that must keep working quietly: the link target is
        // inside the same tree.
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/source/SKILL.md"), ARTIFACT);
        fs::create_dir_all(root.path().join("skills/linked")).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("skills/source/SKILL.md"),
            root.path().join("skills/linked/SKILL.md"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "linked"), ("skill", "source")]
        );
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_agents_symlinked_out_of_the_tree_when_scanned_then_nothing_foreign_is_imported() {
        // The break: a plugin's `agents/` is a directory of *files*, and the
        // containment refusal only judged child directories — so a symlinked
        // agents dir imported a foreign tree one file at a time, each name minted
        // inside the local plugin's namespace.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        for name in ["alpha", "beta", "gamma"] {
            write_file(outside.path().join(format!("{name}.md")), ARTIFACT);
        }
        mark_plugin(&root.path().join("skills/plug"));
        write_file(root.path().join("skills/plug/skills/local/SKILL.md"), ARTIFACT);
        std::os::unix::fs::symlink(outside.path(), root.path().join("skills/plug/agents")).unwrap();

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "plug:local")]);
        assert!(
            !report.artifacts.iter().any(|a| a.name.contains("alpha")),
            "no foreign file may mint a name in the plugin's namespace: {:?}",
            discovered(&report)
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("outside"), "{:?}", report.problems);
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_skills_symlinked_out_of_the_tree_when_scanned_then_it_is_refused_too() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_file(outside.path().join("foreign/SKILL.md"), ARTIFACT);
        mark_plugin(&root.path().join("skills/plug"));
        std::os::unix::fs::symlink(outside.path(), root.path().join("skills/plug/skills")).unwrap();

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty(), "{:?}", discovered(&report));
        assert!(report.problems[0].contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_skills_pointing_at_names_chosen_elsewhere_when_scanned_then_none_is_minted() {
        // The `skills/` mirror of the plugin-containment fix, and deliberately the
        // hard shape: the foreign directory's entries resolve back INSIDE the tree,
        // so the entry-level refusal in `contained_children` cannot catch it. Only
        // checking the plugin's `skills/` directory itself does.
        //
        // Without that check an attacker who can write next to the tree chooses
        // which names appear under a namespace the local plugin owns.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/realskill/SKILL.md"), ARTIFACT);
        write_file(root.path().join("skills/second/SKILL.md"), ARTIFACT);
        mark_plugin(&root.path().join("skills/plug"));

        let attacker = outside.path().join("attacker");
        fs::create_dir_all(&attacker).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("skills/realskill"),
            attacker.join("innocuous"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            root.path().join("skills/second"),
            attacker.join("audit-bypass"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&attacker, root.path().join("skills/plug/skills")).unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "realskill"), ("skill", "second")],
            "no name may be minted from a directory outside the tree"
        );
        assert!(
            !report.artifacts.iter().any(|a| a.name.starts_with("plug:")),
            "the plugin's namespace must stay under local control: {:?}",
            discovered(&report)
        );
        assert_eq!(report.problems.len(), 1);
        assert!(
            report.problems[0].contains("outside"),
            "{:?}",
            report.problems
        );
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_agents_symlinked_within_the_tree_when_scanned_then_it_still_imports() {
        // The in-base case must keep working: a plugin whose agents live
        // elsewhere *inside* the same tree is a normal dotfiles arrangement.
        let root = tempfile::tempdir().unwrap();
        mark_plugin(&root.path().join("skills/plug"));
        write_file(root.path().join("skills/shared-agents/reviewer.md"), ARTIFACT);
        std::os::unix::fs::symlink(
            root.path().join("skills/shared-agents"),
            root.path().join("skills/plug/agents"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("agent", "plug:reviewer")]);
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[cfg(unix)]
    #[test]
    fn given_plugin_marker_symlinked_out_of_the_tree_when_scanned_then_it_mints_no_namespace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join(".claude-plugin")).unwrap();
        write_file(
            root.path().join("skills/fake/skills/tdd/SKILL.md"),
            ARTIFACT,
        );
        std::os::unix::fs::symlink(
            outside.path().join(".claude-plugin"),
            root.path().join("skills/fake/.claude-plugin"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty(), "{:?}", discovered(&report));
        assert!(report.problems[0].contains("does not provide a namespace"));
    }

    #[test]
    fn given_plugin_marker_that_is_a_file_when_scanned_then_the_disabled_plugin_is_reported() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/coding/.claude-plugin"), "oops");
        write_file(root.path().join("skills/coding/skills/tdd/SKILL.md"), ARTIFACT);

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert!(report.problems[0].contains("is a file, not a directory"));
    }

    #[test]
    fn given_two_roots_resolving_to_one_directory_when_scanned_then_it_is_scanned_once() {
        let dir = tempfile::tempdir().unwrap();
        populated_root(dir.path());
        let path = dir.path().to_string_lossy().into_owned();

        let mut scan = Scan::default();
        scan.root("personal:~/.claude", &path);
        scan.root("personal:/abs/.claude", &format!("{path}/"));
        let report = scan.finish();

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("same directory"));
    }

    #[cfg(unix)]
    #[test]
    fn given_aliased_skill_directories_when_scanned_then_the_duplicate_is_reported_not_dropped() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("skills/zz-tdd/SKILL.md"), ARTIFACT);
        // Same canonical directory reached under a second name.
        std::os::unix::fs::symlink(
            root.path().join("skills/zz-tdd"),
            root.path().join("skills/aa-tdd"),
        )
        .unwrap();

        let report = scan_one(root.path());

        // Two names, both invocable, neither silently lost.
        assert_eq!(
            discovered(&report),
            vec![("skill", "aa-tdd"), ("skill", "zz-tdd")]
        );
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[test]
    fn given_two_locations_claiming_one_name_when_added_then_the_loser_is_reported_not_dropped() {
        // The bounded walk makes a same-name clash within one root very hard to
        // provoke through the filesystem; this pins the accumulator's backstop
        // directly, so a future layout change cannot make it silent.
        let root = tempfile::tempdir().unwrap();
        write_file(root.path().join("first/SKILL.md"), ARTIFACT);
        write_file(root.path().join("second/SKILL.md"), ARTIFACT);
        let path = root.path().to_string_lossy().into_owned();

        let base = root.path().canonicalize().unwrap();
        let spent = ScanBudget::default();
        let limits = ScanLimits::default();
        let mut scan = RootScan::new("personal:test", &path, &limits, &spent);
        scan.add("skill", "tdd".to_string(), &root.path().join("first/SKILL.md"), &base);
        scan.add("skill", "tdd".to_string(), &root.path().join("second/SKILL.md"), &base);
        let mut report = ScanReport::default();
        scan.finish(&mut report, &mut ScanBudget::default());

        assert_eq!(discovered(&report), vec![("skill", "tdd")]);
        assert!(report.artifacts[0].path.ends_with("first/SKILL.md"));
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("was already imported from"));
        assert!(report.problems[0].contains("second/SKILL.md"));
    }

    #[test]
    fn given_the_same_root_scanned_twice_when_compared_then_results_are_identical() {
        let root = tempfile::tempdir().unwrap();
        plugin_root(root.path());
        populated_root(root.path());
        for i in 0..20 {
            write_file(
                root.path().join(format!("skills/skill-{i:02}/SKILL.md")),
                ARTIFACT,
            );
        }

        let first = discovered(&scan_one(root.path()))
            .iter()
            .map(|(k, n)| format!("{k} {n}"))
            .collect::<Vec<_>>();
        let second = discovered(&scan_one(root.path()))
            .iter()
            .map(|(k, n)| format!("{k} {n}"))
            .collect::<Vec<_>>();

        assert_eq!(first, second);
        let mut sorted = first.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), first.len(), "no duplicate (kind, name)");
    }

    #[cfg(unix)]
    #[test]
    fn given_symlink_loop_when_scanned_then_the_scan_terminates() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());
        std::os::unix::fs::symlink(
            root.path().join("skills"),
            root.path().join("skills/tdd/loop"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn given_symlinked_skills_directory_when_scanned_then_artifacts_are_still_found() {
        // A dotfiles-repo setup: ~/.claude/skills is itself a symlink.
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        write_file(elsewhere.path().join("tdd/SKILL.md"), ARTIFACT);
        std::os::unix::fs::symlink(elsewhere.path(), root.path().join("skills")).unwrap();

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "tdd")]);
    }

    #[cfg(unix)]
    #[test]
    fn given_dangling_agents_symlink_when_scanned_then_plugin_artifacts_are_still_found() {
        let root = tempfile::tempdir().unwrap();
        plugin_root(root.path());
        std::os::unix::fs::symlink(root.path().join("nowhere"), root.path().join("agents"))
            .unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "coding:tdd"), ("agent", "coding:pr-reviewer")]
        );
        // A dangling tree makes artifacts vanish; the user is told why rather
        // than being left with an unexplained "0 agent(s)".
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("the symlink's target is missing"));
    }

    #[cfg(unix)]
    #[test]
    fn given_a_file_where_the_agents_directory_belongs_when_scanned_then_it_is_reported() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());
        fs::remove_dir_all(root.path().join("agents")).unwrap();
        write_file(root.path().join("agents"), "not a directory");

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "tdd")]);
        assert!(report.problems[0].contains("is a file, not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn given_dangling_symlink_root_when_scanned_then_problem_is_reported_without_panicking() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("gone-root");
        std::os::unix::fs::symlink(parent.path().join("nowhere"), &root).unwrap();

        let report = scan_one(&root);

        assert!(report.artifacts.is_empty());
        assert!(report.problems[0].contains("is not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn given_dangling_artifact_symlink_when_scanned_then_it_is_reported_and_the_rest_import() {
        let root = tempfile::tempdir().unwrap();
        populated_root(root.path());
        std::os::unix::fs::symlink(
            root.path().join("nowhere.md"),
            root.path().join("agents/broken.md"),
        )
        .unwrap();

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("broken.md"));
    }

    #[test]
    fn given_several_roots_when_scanned_then_each_artifact_carries_its_own_root_id() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        write_file(first.path().join("skills/tdd/SKILL.md"), ARTIFACT);
        write_file(second.path().join("skills/tdd/SKILL.md"), ARTIFACT);

        let report = scan_all(&[("personal:one", first.path()), ("project:two", second.path())]);

        assert_eq!(
            report
                .artifacts
                .iter()
                .map(|a| a.root_id.as_str())
                .collect::<Vec<_>>(),
            vec!["personal:one", "project:two"]
        );
    }

    #[test]
    fn given_the_same_path_configured_under_two_roles_when_scanned_then_it_is_read_once() {
        // One directory is one place, whatever role it is configured under:
        // reading it twice would report every artifact as shadowing itself.
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path().join("skills/tdd/SKILL.md"), ARTIFACT);
        let path = dir.path().to_string_lossy().into_owned();

        let mut scan = Scan::default();
        scan.root("personal:same", &path);
        scan.root("project:same", &path);
        let report = scan.finish();

        assert_eq!(
            report
                .artifacts
                .iter()
                .map(|a| a.root_id.as_str())
                .collect::<Vec<_>>(),
            vec!["personal:same"],
            "the first configured root claims the directory"
        );
        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].contains("same directory as root 'personal:same'"));
    }

    /// The shared naming table, also read by the TS Artifact Codec tests. One
    /// tempdir is materialized from every listed path, so the walk's discovered
    /// set must equal exactly the table's non-null entries.
    #[test]
    fn given_the_shared_location_table_when_scanned_then_discovery_matches_it_exactly() {
        let table = fs::read_to_string("../src/domain/__fixtures__/artifact-locations.json")
            .expect("shared location table must exist");
        let table: serde_json::Value = serde_json::from_str(&table).unwrap();
        let files = table["files"].as_array().unwrap();

        let root = tempfile::tempdir().unwrap();
        let mut expected: Vec<String> = Vec::new();
        for file in files {
            let path = file["path"].as_str().unwrap();
            let contents = if path.ends_with(".json") { "{}" } else { ARTIFACT };
            write_file(root.path().join(path), contents);
            if let Some(artifact) = file["artifact"].as_object() {
                expected.push(format!(
                    "{} {}",
                    artifact["kind"].as_str().unwrap(),
                    artifact["name"].as_str().unwrap()
                ));
            }
        }
        expected.sort();

        let report = scan_one(root.path());
        let mut actual: Vec<String> = report
            .artifacts
            .iter()
            .map(|a| format!("{} {}", a.kind, a.name))
            .collect();
        actual.sort();

        assert_eq!(actual, expected, "problems: {:?}", report.problems);
    }

    #[test]
    fn given_thousands_of_rejected_roots_when_scanned_then_the_problems_stay_bounded() {
        // The regression: rejected roots are deliberately free of the scanned-root
        // budget, so without a separate attempt counter an untrusted renderer could
        // offer any number of bad roots and each would push a problem.
        let dir = tempfile::tempdir().unwrap();
        populated_root(dir.path());
        let path = dir.path().to_string_lossy().into_owned();

        let mut scan = Scan::default();
        for i in 0..5000 {
            // Every one after the first resolves to the same directory: rejected.
            scan.root(&format!("personal:{i}"), &path);
        }
        let report = scan.finish();

        assert_eq!(
            discovered(&report),
            vec![("skill", "tdd"), ("agent", "pr-reviewer")]
        );
        assert!(
            report.problems.len() <= MAX_ROOT_ATTEMPTS + 1,
            "{} problems from 5000 rejected roots",
            report.problems.len()
        );
        assert!(
            report
                .problems
                .last()
                .unwrap()
                .contains(&format!("Stopped after {MAX_ROOT_ATTEMPTS} source-root attempts")),
            "{:?}",
            report.problems.last()
        );
    }

    #[test]
    fn given_thousands_of_missing_roots_when_scanned_then_the_problems_stay_bounded() {
        let mut scan = Scan::default();
        for i in 0..5000 {
            scan.root(&format!("personal:{i}"), &format!("/nope/{i}"));
        }
        let report = scan.finish();

        assert!(report.artifacts.is_empty());
        assert!(
            report.problems.len() <= MAX_ROOT_ATTEMPTS + 1,
            "{} problems from 5000 missing roots",
            report.problems.len()
        );
    }

    #[test]
    fn given_the_attempt_ceiling_when_reached_then_earlier_rejections_still_cost_no_scan() {
        // Both bounds must hold at once: the attempt ceiling bounds the work, and a
        // rejection must still not consume a scanned-root slot.
        let valid = tempfile::tempdir().unwrap();
        write_file(valid.path().join("skills/kept/SKILL.md"), ARTIFACT);

        let mut scan = Scan::with_limits(ScanLimits {
            max_roots_per_scan: 1,
            max_root_attempts: 8,
            ..ScanLimits::default()
        });
        for i in 0..5 {
            scan.root(&format!("personal:gone{i}"), &format!("/nope/{i}"));
        }
        scan.root("personal:kept", &valid.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(discovered(&report), vec![("skill", "kept")]);
    }

    #[test]
    fn given_the_problem_cap_exhausted_when_a_directory_is_truncated_then_the_notice_survives() {
        // The one notice class whose job is to say "you are not seeing everything"
        // must not be the thing that gets suppressed.
        //
        // The shape matters: within a *single* directory the truncation notice is
        // emitted before that directory's per-entry problems, so it could never be
        // crowded out and a one-directory fixture cannot fail. The budget has to be
        // exhausted by an EARLIER directory — hence two plugins, walked in
        // alphabetical order: `aaa` burns the problem budget with escaping
        // directories, then `zzz` is truncated.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join("elsewhere")).unwrap();

        mark_plugin(&root.path().join("skills/aaa"));
        fs::create_dir_all(root.path().join("skills/aaa/skills")).unwrap();
        for i in 0..25 {
            std::os::unix::fs::symlink(
                outside.path().join("elsewhere"),
                root.path().join(format!("skills/aaa/skills/escape{i:02}")),
            )
            .unwrap();
        }

        mark_plugin(&root.path().join("skills/zzz"));
        for i in 0..40 {
            write_file(
                root.path()
                    .join(format!("skills/zzz/skills/s{i:02}/SKILL.md")),
                ARTIFACT,
            );
        }

        let mut scan = Scan::with_limits(ScanLimits {
            max_problems_per_root: 20,
            max_entries_per_dir: 30,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(report.artifacts.len(), 30, "zzz was truncated 40 -> 30");
        assert!(
            report
                .problems
                .iter()
                .any(|p| p.contains("were not imported")),
            "the truncation notice must survive an exhausted problem cap: {:?}",
            report.problems
        );
    }

    #[test]
    fn given_an_over_long_name_when_scanned_then_it_is_reported_and_not_read() {
        let root = tempfile::tempdir().unwrap();
        write_file(
            root.path()
                .join(format!("skills/{}/SKILL.md", "a".repeat(65))),
            ARTIFACT,
        );
        write_file(root.path().join("skills/fine/SKILL.md"), ARTIFACT);

        let report = scan_one(root.path());

        assert_eq!(discovered(&report), vec![("skill", "fine")]);
        assert_eq!(report.problems.len(), 1);
        assert!(
            report.problems[0].contains("segment longer than 64 characters"),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_a_name_at_the_length_bound_when_scanned_then_it_is_imported() {
        let root = tempfile::tempdir().unwrap();
        let segment = "a".repeat(64);
        mark_plugin(&root.path().join(format!("skills/{segment}")));
        // 64 + 1 + 63 = 128 characters: exactly the overall bound.
        let leaf = "b".repeat(63);
        write_file(
            root.path()
                .join(format!("skills/{segment}/skills/{leaf}/SKILL.md")),
            ARTIFACT,
        );

        let report = scan_one(root.path());

        assert_eq!(
            discovered(&report),
            vec![("skill", format!("{segment}:{leaf}").as_str())]
        );
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[test]
    fn given_a_name_one_character_past_the_overall_bound_when_scanned_then_it_is_reported() {
        let root = tempfile::tempdir().unwrap();
        let segment = "a".repeat(64);
        mark_plugin(&root.path().join(format!("skills/{segment}")));
        write_file(
            root.path()
                .join(format!("skills/{segment}/skills/{}/SKILL.md", "b".repeat(64))),
            ARTIFACT,
        );

        let report = scan_one(root.path());

        assert!(report.artifacts.is_empty());
        assert!(
            report.problems[0].contains("longer than 128 characters"),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_the_name_length_bounds_then_they_agree_across_the_language_boundary() {
        let source = fs::read_to_string("../src/domain/artifact-codec.ts")
            .expect("the Artifact Codec must exist");
        let declared = |name: &str| -> usize {
            source
                .lines()
                .find_map(|line| {
                    line.trim()
                        .strip_prefix(&format!("const {name} = "))
                        .and_then(|rest| rest.trim_end_matches(';').parse::<usize>().ok())
                })
                .unwrap_or_else(|| panic!("{name} must be declared as a literal"))
        };

        assert_eq!(declared("MAX_NAME_SEGMENT_LENGTH"), MAX_NAME_SEGMENT_LENGTH);
        assert_eq!(declared("MAX_NAME_LENGTH"), MAX_NAME_LENGTH);
    }

    #[test]
    fn given_the_scan_limits_then_attempts_leave_room_for_every_scannable_root() {
        // `ScanLimits` is public with public fields, so the relationship between
        // the two root bounds is pinned rather than assumed: if attempts were the
        // smaller of the two, valid roots would be dropped silently and the only
        // notice would blame the caller for offering too many.
        for (name, limits) in [
            ("shipped defaults", ScanLimits::default()),
            ("test limits", tiny_limits()),
        ] {
            assert!(
                limits.max_root_attempts >= limits.max_roots_per_scan,
                "{name}: max_root_attempts ({}) must be at least max_roots_per_scan ({})",
                limits.max_root_attempts,
                limits.max_roots_per_scan
            );
        }
    }

    #[test]
    fn given_limits_that_allow_every_root_when_scanned_then_none_is_lost_to_the_attempt_cap() {
        // The behavioural half: with the relationship respected, every distinct
        // valid root up to `max_roots_per_scan` is scanned.
        let parent = tempfile::tempdir().unwrap();
        let limits = ScanLimits {
            max_roots_per_scan: 4,
            max_root_attempts: 4,
            ..ScanLimits::default()
        };
        let mut scan = Scan::with_limits(limits.clone());
        for i in 0..limits.max_roots_per_scan {
            let root = parent.path().join(format!("root{i}"));
            write_file(root.join(format!("skills/s{i}/SKILL.md")), ARTIFACT);
            scan.root(&format!("project:{i}"), &root.to_string_lossy());
        }
        let report = scan.finish();

        assert_eq!(report.artifacts.len(), limits.max_roots_per_scan);
        assert_eq!(report.problems, Vec::<String>::new());
    }

    #[test]
    fn given_the_two_root_caps_then_they_agree_across_the_language_boundary() {
        // The renderer caps how many roots can be configured; this scan caps how
        // many are read. If the first exceeds the second, roots are configurable
        // but silently never scanned — so the two constants are asserted equal
        // here rather than trusted to stay in step.
        let source = fs::read_to_string("../src/import/source-roots.ts")
            .expect("the renderer's source-roots module must exist");
        let declared = source
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("export const MAX_SOURCE_ROOTS = ")
                    .and_then(|rest| rest.trim_end_matches(';').parse::<usize>().ok())
            })
            .expect("MAX_SOURCE_ROOTS must be declared as a literal");

        assert_eq!(
            declared, MAX_ROOTS_PER_SCAN,
            "MAX_SOURCE_ROOTS (TS) and MAX_ROOTS_PER_SCAN (Rust) must stay equal"
        );
    }

    #[test]
    fn given_rejected_roots_when_scanned_then_they_do_not_consume_a_root_slot() {
        // A duplicate or missing root used to spend a slot, pushing a later valid
        // root past the ceiling and dropping it silently.
        let first = tempfile::tempdir().unwrap();
        let last = tempfile::tempdir().unwrap();
        write_file(first.path().join("skills/a/SKILL.md"), ARTIFACT);
        write_file(last.path().join("skills/d/SKILL.md"), ARTIFACT);
        let first_path = first.path().to_string_lossy().into_owned();

        let mut scan = Scan::with_limits(ScanLimits {
            max_roots_per_scan: 2,
            ..ScanLimits::default()
        });
        scan.root("personal:a", &first_path);
        scan.root("personal:dup", &first_path); // Same directory: rejected.
        scan.root("personal:gone", "/definitely/not/a/real/root"); // Rejected.
        scan.root("project:d", &last.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(
            discovered(&report),
            vec![("skill", "a"), ("skill", "d")],
            "the last valid root must still be scanned"
        );
        assert!(
            !report.problems.iter().any(|p| p.contains("Only the first")),
            "the root ceiling was not reached: {:?}",
            report.problems
        );
    }

    #[test]
    fn given_the_per_scan_artifact_ceiling_when_it_trips_then_the_message_names_that_ceiling() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        write_file(first.path().join("skills/a/SKILL.md"), ARTIFACT);
        write_file(second.path().join("skills/b/SKILL.md"), ARTIFACT);

        let mut scan = Scan::with_limits(ScanLimits {
            max_artifacts_per_scan: 1,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &first.path().to_string_lossy());
        scan.root("project:two", &second.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(discovered(&report), vec![("skill", "a")]);
        let message = report.problems.last().unwrap();
        assert!(
            message.contains("across all source roots"),
            "the per-scan ceiling must not be reported as the root's own: {message}"
        );
    }

    #[test]
    fn given_the_per_root_artifact_ceiling_when_it_trips_then_the_message_names_that_ceiling() {
        let root = tempfile::tempdir().unwrap();
        for name in ["a", "b", "c"] {
            write_file(root.path().join(format!("skills/{name}/SKILL.md")), ARTIFACT);
        }

        let mut scan = Scan::with_limits(ScanLimits {
            max_artifacts_per_root: 2,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(report.artifacts.len(), 2);
        assert!(
            report
                .problems
                .last()
                .unwrap()
                .contains("from one source root"),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_more_entries_than_the_listing_cap_when_scanned_then_the_kept_set_is_alphabetical() {
        // Truncation used to happen in filesystem order, so which artifacts a user
        // got was arbitrary. Sorting first makes the kept subset predictable.
        //
        // The directories are created in reverse-alphabetical order so the fixture
        // does not rely on this machine's directory hashing to differ from sorted
        // order. The assertion below checks that the raw order really does differ
        // from the sorted one — on a filesystem that returned entries already
        // sorted, truncate-before-sort and truncate-after-sort would be
        // indistinguishable, and this test would be vacuous rather than wrong. It
        // fails loudly in that case instead of passing quietly.
        let root = tempfile::tempdir().unwrap();
        for i in (0..6).rev() {
            write_file(root.path().join(format!("skills/s{i}/SKILL.md")), ARTIFACT);
        }

        let raw: Vec<String> = fs::read_dir(root.path().join("skills"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let mut sorted = raw.clone();
        sorted.sort();
        assert_ne!(
            raw[..3],
            sorted[..3],
            "fixture cannot discriminate: this filesystem lists entries in sorted order"
        );

        let mut scan = Scan::with_limits(ScanLimits {
            max_entries_per_dir: 3,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(
            discovered(&report),
            vec![("skill", "s0"), ("skill", "s1"), ("skill", "s2")],
            "the kept set must be the sorted prefix, not whatever the filesystem \
             returned first (raw order was {raw:?})"
        );
        let message = report
            .problems
            .iter()
            .find(|p| p.contains("Examined only the first"))
            .expect("the loss must be reported");
        assert!(
            message.contains("of 6 entries") && message.contains("3 were skipped"),
            "the notice must say how much was lost: {message}"
        );
    }

    #[test]
    fn given_default_limits_then_they_are_the_documented_ceilings() {
        let limits = ScanLimits::default();

        assert_eq!(limits.max_roots_per_scan, MAX_ROOTS_PER_SCAN);
        assert_eq!(limits.max_root_attempts, MAX_ROOT_ATTEMPTS);
        assert_eq!(limits.max_artifacts_per_scan, MAX_ARTIFACTS_PER_SCAN);
        assert_eq!(limits.max_bytes_per_scan, MAX_BYTES_PER_SCAN);
        assert_eq!(limits.max_artifacts_per_root, MAX_ARTIFACTS_PER_ROOT);
        assert_eq!(limits.max_bytes_per_root, MAX_BYTES_PER_ROOT);
        assert_eq!(limits.max_problems_per_root, MAX_PROBLEMS_PER_ROOT);
        assert_eq!(limits.max_entries_per_dir, MAX_ENTRIES_PER_DIR);
    }

    /// Limits small enough to exercise a ceiling with a handful of files.
    fn tiny_limits() -> ScanLimits {
        ScanLimits {
            max_roots_per_scan: 4,
            max_artifacts_per_scan: 3,
            max_bytes_per_scan: 200,
            max_artifacts_per_root: 2,
            max_bytes_per_root: 150,
            max_problems_per_root: 2,
            max_entries_per_dir: 3,
            max_root_attempts: 8,
        }
    }

    #[test]
    fn given_more_artifacts_than_the_per_scan_ceiling_when_scanned_then_the_scan_stops() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        for i in 0..2 {
            write_file(first.path().join(format!("skills/a{i}/SKILL.md")), ARTIFACT);
            write_file(second.path().join(format!("skills/b{i}/SKILL.md")), ARTIFACT);
        }

        let mut scan = Scan::with_limits(ScanLimits {
            max_artifacts_per_root: 100,
            max_bytes_per_root: u64::MAX,
            max_bytes_per_scan: u64::MAX,
            max_artifacts_per_scan: 3,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &first.path().to_string_lossy());
        scan.root("project:two", &second.path().to_string_lossy());
        let report = scan.finish();

        // The per-scan ceiling stops the second root once the first spent its share.
        assert_eq!(report.artifacts.len(), 3);
        assert!(
            report
                .problems
                .iter()
                .any(|p| p.contains("3-artifact limit across all source roots")),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_more_bytes_than_the_per_scan_ceiling_when_scanned_then_the_scan_stops() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        write_file(first.path().join("skills/a/SKILL.md"), ARTIFACT);
        write_file(second.path().join("skills/b/SKILL.md"), ARTIFACT);
        let budget = ARTIFACT.len() as u64 + 1; // Room for the first only.

        let mut scan = Scan::with_limits(ScanLimits {
            max_bytes_per_scan: budget,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &first.path().to_string_lossy());
        scan.root("project:two", &second.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(discovered(&report), vec![("skill", "a")]);
        assert!(
            report
                .problems
                .iter()
                .any(|p| p.contains(&format!("{budget}-byte limit across all source roots"))),
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn given_the_per_root_byte_ceiling_when_it_trips_then_the_message_names_that_ceiling() {
        // The per-scan ceiling is set well clear, so only the per-root byte branch
        // can fire — with one root the two are otherwise indistinguishable.
        let root = tempfile::tempdir().unwrap();
        for i in 0..8 {
            write_file(root.path().join(format!("skills/s{i}/SKILL.md")), ARTIFACT);
        }

        let mut scan = Scan::with_limits(ScanLimits {
            max_bytes_per_root: ARTIFACT.len() as u64 + 1,
            max_bytes_per_scan: 1_000_000,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        assert_eq!(report.artifacts.len(), 1, "{:?}", discovered(&report));
        let message = report.problems.last().unwrap();
        assert!(
            message.contains("bytes of artifacts Patchwork imports from one source root"),
            "the per-root byte ceiling must be named as such: {message}"
        );
    }

    #[test]
    fn given_a_rejected_artifact_when_scanned_then_it_does_not_spend_the_byte_budget() {
        let root = tempfile::tempdir().unwrap();
        let big = "x".repeat((MAX_ARTIFACT_BYTES + 1) as usize);
        write_file(root.path().join("skills/huge/SKILL.md"), &big);
        write_file(root.path().join("skills/small/SKILL.md"), ARTIFACT);

        let mut scan = Scan::with_limits(ScanLimits {
            max_bytes_per_scan: ARTIFACT.len() as u64,
            ..ScanLimits::default()
        });
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        // The oversized artifact was refused, so its bytes must not have been
        // charged against the budget the small one needs.
        assert_eq!(discovered(&report), vec![("skill", "small")]);
    }

    #[test]
    fn given_tiny_limits_when_scanned_then_every_ceiling_is_reachable() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..6 {
            write_file(root.path().join(format!("skills/s{i}/SKILL.md")), ARTIFACT);
        }

        let mut scan = Scan::with_limits(tiny_limits());
        scan.root("personal:one", &root.path().to_string_lossy());
        let report = scan.finish();

        assert!(report.artifacts.len() <= 2, "{:?}", discovered(&report));
        assert!(report
            .problems
            .iter()
            .any(|p| p.contains("Stopped listing") || p.contains("Stopped importing")));
    }

    #[test]
    fn given_more_roots_than_the_root_ceiling_when_scanned_then_the_rest_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path().join("skills/tdd/SKILL.md"), ARTIFACT);

        let mut scan = Scan::with_limits(ScanLimits {
            max_roots_per_scan: 2,
            ..ScanLimits::default()
        });
        // Distinct paths, so the same-directory dedupe is not what stops them.
        for i in 0..5 {
            let other = dir.path().join(format!("copy{i}"));
            write_file(other.join("skills/tdd/SKILL.md"), ARTIFACT);
            scan.root(&format!("project:{i}"), &other.to_string_lossy());
        }
        let report = scan.finish();

        assert_eq!(report.artifacts.len(), 2);
        assert_eq!(
            report
                .problems
                .iter()
                .filter(|p| p.contains("Only the first 2"))
                .count(),
            1
        );
    }

    #[test]
    fn given_tilde_path_when_expanded_then_home_is_substituted() {
        assert_eq!(
            expand_home_with("~/.claude", Some("/Users/me")).unwrap(),
            PathBuf::from("/Users/me/.claude")
        );
        assert_eq!(
            expand_home_with("~", Some("/Users/me")).unwrap(),
            PathBuf::from("/Users/me")
        );
    }

    #[test]
    fn given_plain_path_when_expanded_then_it_is_unchanged() {
        assert_eq!(
            expand_home_with("/opt/project/.claude", Some("/Users/me")).unwrap(),
            PathBuf::from("/opt/project/.claude")
        );
        assert_eq!(
            expand_home_with("~project/.claude", Some("/Users/me")).unwrap(),
            PathBuf::from("~project/.claude")
        );
    }

    #[test]
    fn given_tilde_path_without_home_when_expanded_then_errors() {
        let result = expand_home_with("~/.claude", None);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no home directory"));
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
