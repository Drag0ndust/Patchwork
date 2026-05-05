import Foundation

public struct LibraryRoot: Sendable, Equatable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public enum ResolutionError: Error, Equatable, Sendable, CustomStringConvertible {
        case envVarRelative(rawValue: String)
        case envVarMissing(rawValue: String, expandedPath: String)
        case envVarNotDirectory(rawValue: String, expandedPath: String)

        public var description: String {
            switch self {
            case .envVarRelative(let raw):
                return "PATCHWORK_LIBRARY_ROOT must be an absolute path, got '\(raw)'"
            case .envVarMissing(let raw, let expanded):
                return "PATCHWORK_LIBRARY_ROOT '\(raw)' does not exist (resolved to '\(expanded)')"
            case .envVarNotDirectory(let raw, let expanded):
                return "PATCHWORK_LIBRARY_ROOT '\(raw)' is not a directory (resolved to '\(expanded)')"
            }
        }
    }

    public static let environmentVariableName = "PATCHWORK_LIBRARY_ROOT"

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) throws -> LibraryRoot {
        if let raw = environment[environmentVariableName], !raw.isEmpty {
            let expanded = (raw as NSString).expandingTildeInPath
            guard expanded.hasPrefix("/") else {
                throw ResolutionError.envVarRelative(rawValue: raw)
            }
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: expanded, isDirectory: &isDir) else {
                throw ResolutionError.envVarMissing(rawValue: raw, expandedPath: expanded)
            }
            guard isDir.boolValue else {
                throw ResolutionError.envVarNotDirectory(rawValue: raw, expandedPath: expanded)
            }
            return LibraryRoot(url: URL(fileURLWithPath: expanded, isDirectory: true))
        }

        let defaultURL = homeDirectory.appendingPathComponent(".claude", isDirectory: true)
        return LibraryRoot(url: defaultURL)
    }

    public var skillsDirectory: URL {
        url.appendingPathComponent("skills", isDirectory: true)
    }
}
