import ArgumentParser

struct List: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "list Skills in the Library"
    )

    func run() throws {
        try notYetImplemented("list")
    }
}
