import ArgumentParser

struct Help: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "help",
        abstract: "show help, optionally for a specific command"
    )

    @Argument(help: "the command to show help for")
    var subcommand: String?

    func run() throws {
        guard let name = subcommand else {
            print(Patchwork.helpMessage())
            return
        }

        switch name {
        case "add":
            print(Add.helpMessage())
        case "install":
            print(Install.helpMessage())
        case "uninstall":
            print(Uninstall.helpMessage())
        case "list":
            print(List.helpMessage())
        case "status":
            print(Status.helpMessage())
        case "help":
            print(Help.helpMessage())
        default:
            Stderr.write("error: unknown command '\(name)'. Run 'patchwork help' for usage.")
            throw ExitCode(2)
        }
    }
}
