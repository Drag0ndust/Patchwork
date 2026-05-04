# Swift for the CLI

The Patchwork CLI is written in Swift, sharing a core library (`PatchworkCore`) with the macOS app. Most cross-platform CLI tools are written in Go or Rust, which offer simpler static binary distribution and a larger ecosystem of CLI primitives.

We chose Swift because the macOS app is already SwiftUI-native, and the domain logic (Library management, symlink installation, Tool preset resolution, Project registry) is non-trivial. Duplicating it in a second language would create a permanent maintenance burden and a risk of behavioural divergence between the GUI and CLI. The shared Swift Package approach keeps a single source of truth for all domain behaviour.

## Consequences

- Distribution requires building separate binaries per platform (macOS arm64/x86_64, Linux x86_64) via Swift's cross-compilation toolchain. CI handles this via GitHub Actions.
- Windows support is possible but requires additional effort (Swift on Windows is less mature). Direct binary download covers this case without a Homebrew formula.
