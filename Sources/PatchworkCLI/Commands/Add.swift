import ArgumentParser

struct Add: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "add",
        abstract: "add a Skill to the Library"
    )

    @Argument(help: "path to a Skill directory containing SKILL.md")
    var path: String

    func run() throws {
        try notYetImplemented("add")
    }
}
