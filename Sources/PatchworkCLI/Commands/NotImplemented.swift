import ArgumentParser
import Foundation

func notYetImplemented(_ name: String) throws -> Never {
    Stderr.write("error: '\(name)' is not yet implemented in this build")
    throw ExitCode(1)
}
