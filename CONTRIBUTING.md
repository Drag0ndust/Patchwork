# Contributing to Patchwork

Thanks for your interest in contributing. Here's everything you need to get started.

## Reporting a bug

Open a [bug report issue](https://github.com/Drag0ndust/Patchwork/issues/new?template=bug_report.md). Include steps to reproduce, expected behaviour, and actual behaviour. Check existing issues first to avoid duplicates.

## Suggesting a feature

Open a [feature request issue](https://github.com/Drag0ndust/Patchwork/issues/new?template=feature_request.md). Describe the problem you're trying to solve, not just the solution.

## Development setup

**Requirements:**
- Xcode 16+ (for the macOS app)
- Swift 6+ toolchain (for the CLI on Linux/Windows)

**Clone and build:**

```sh
git clone https://github.com/Drag0ndust/Patchwork.git
cd Patchwork
swift build
```

Open `Patchwork.xcodeproj` (or `.xcworkspace`) in Xcode for the macOS app.

## Pull request process

1. Fork the repo and create a branch from `main`
2. Make your changes, with tests where applicable
3. Ensure `swift build` and `swift test` pass
4. Open a PR against `main` — fill in the PR template
5. A maintainer will review and merge

Keep PRs focused. One concern per PR makes reviewing faster.

## Conventions

### Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

feat(cli): add install command
fix(library): resolve broken symlink on Library Root change
docs: update CONTRIBUTING.md
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

### Versioning

Releases follow [Semantic Versioning](https://semver.org/):

- **MAJOR** — breaking changes to the CLI interface or Library file format
- **MINOR** — new features, backwards-compatible
- **PATCH** — bug fixes, backwards-compatible

### Swift style

Follow standard Swift API design guidelines. No linter is enforced yet — use your judgement and match the surrounding code.
