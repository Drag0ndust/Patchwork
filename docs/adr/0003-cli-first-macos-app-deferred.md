# CLI-first; macOS app deferred to v2.0

Patchwork ships the CLI before the macOS app. The app is planned for v2.0, after the CLI has validated the core loop in real use.

Although the README describes both a CLI and a macOS app, and both share `PatchworkCore`, building them in parallel would split focus before the domain model is proven. The CLI covers all platforms, exercises the full install/uninstall/status loop, and can ship with far less surface area. The macOS app adds a GUI for non-technical users and iCloud sync — valuable, but not needed to validate whether Patchwork solves the core problem.

The main trade-off: users on macOS get no native app experience until v2.0. We accept this because the target audience for v1.0 is developers comfortable with a CLI, and shipping a well-designed CLI first avoids building a GUI on top of an unstable domain model.

## Considered options

- **CLI and app in parallel**: maximises feature coverage at launch. Rejected because it doubles the surface area before the core loop is validated, and SwiftUI UI work would need to be redone if the domain model changes.
- **App first, CLI later**: rejected. The app requires `PatchworkCore` to be stable, and building the app first would couple GUI decisions to an immature core.
- **CLI first, app at v2.0**: chosen. Ships faster, validates the domain model, and gives the app a stable foundation to build on.
