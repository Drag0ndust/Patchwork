import ArgumentParser

struct Uninstall: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "uninstall",
        abstract: "remove Skill symlinks from the current directory"
    )

    @Argument(help: "one or more Skill names to uninstall")
    var names: [String] = []

    func run() throws {
        try notYetImplemented("uninstall")
    }
}
