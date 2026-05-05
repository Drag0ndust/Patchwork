import ArgumentParser
import Foundation
import PatchworkCore

struct Patchwork: ParsableCommand {
    static var configuration: CommandConfiguration {
        CommandConfiguration(
            commandName: "patchwork",
            abstract: "manage local AI Skills",
            discussion: TopLevelHelp.discussion(),
            version: PatchworkVersion.current,
            subcommands: [
                Add.self,
                Install.self,
                Uninstall.self,
                List.self,
                Status.self,
                Help.self
            ]
        )
    }
}
