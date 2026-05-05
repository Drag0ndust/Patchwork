import Foundation

enum Stderr {
    static func write(_ message: String) {
        guard let data = (message + "\n").data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}
