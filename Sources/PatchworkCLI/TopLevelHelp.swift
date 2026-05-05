import Foundation
import PatchworkCore

enum TopLevelHelp {
    static func discussion() -> String {
        return """
        Environment:
          PATCHWORK_LIBRARY_ROOT  override the Library Root path (must be absolute)

        \(libraryRootLine())
        """
    }

    static func libraryRootLine() -> String {
        do {
            let root = try LibraryRoot.resolve()
            return "Library Root: \(root.url.path)"
        } catch let error as LibraryRoot.ResolutionError {
            return "Library Root: <unset — \(error.description)>"
        } catch {
            return "Library Root: <unset — \(error)>"
        }
    }
}
