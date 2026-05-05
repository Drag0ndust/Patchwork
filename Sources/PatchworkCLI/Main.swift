import ArgumentParser
import Foundation

@main
struct PatchworkMain {
    static func main() {
        if FileManager.default.currentDirectoryPath.isEmpty {
            Stderr.write("error: cannot read the current working directory. Switch to an existing directory and try again.")
            Foundation.exit(1)
        }

        let parsedCommand: ParsableCommand
        do {
            parsedCommand = try Patchwork.parseAsRoot()
        } catch {
            terminate(parsePhaseError: error)
        }

        var command = parsedCommand
        do {
            try command.run()
            Foundation.exit(0)
        } catch {
            terminate(runPhaseError: error)
        }
    }

    private static func terminate(parsePhaseError error: Error) -> Never {
        let exitCode = Patchwork.exitCode(for: error)
        let message = Patchwork.fullMessage(for: error)
        if exitCode == .success {
            if !message.isEmpty {
                print(message)
            }
            Foundation.exit(0)
        }
        if !message.isEmpty {
            Stderr.write(message)
        }
        Foundation.exit(2)
    }

    private static func terminate(runPhaseError error: Error) -> Never {
        if let exitCode = error as? ExitCode {
            Foundation.exit(exitCode.rawValue)
        }
        let exitCode = Patchwork.exitCode(for: error)
        let message = Patchwork.fullMessage(for: error)
        if exitCode == .success {
            if !message.isEmpty {
                print(message)
            }
            Foundation.exit(0)
        }
        if !message.isEmpty {
            Stderr.write(message)
        }
        Foundation.exit(1)
    }
}
