import ArgumentParser

struct Status: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "status",
        abstract: "list Skills installed in the current directory"
    )

    func run() throws {
        try notYetImplemented("status")
    }
}
