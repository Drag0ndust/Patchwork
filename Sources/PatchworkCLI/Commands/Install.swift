import ArgumentParser

struct Install: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "install",
        abstract: "symlink Skills into the current directory"
    )

    @Argument(help: "one or more Skill names to install")
    var names: [String] = []

    func run() throws {
        try notYetImplemented("install")
    }
}
