import XCTest
@testable import PatchworkCore

final class LibraryRootTests: XCTestCase {
    private var tempRoot: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("patchwork-LibraryRootTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root = tempRoot, FileManager.default.fileExists(atPath: root.path) {
            try? FileManager.default.removeItem(at: root)
        }
        tempRoot = nil
        try super.tearDownWithError()
    }

    func testEnvUnsetReturnsDefaultUnderHomeDirectory() throws {
        let fakeHome = tempRoot.appendingPathComponent("fake-home", isDirectory: true)
        try FileManager.default.createDirectory(at: fakeHome, withIntermediateDirectories: true)

        let resolved = try LibraryRoot.resolve(
            environment: [:],
            homeDirectory: fakeHome
        )

        XCTAssertEqual(resolved.url.path, fakeHome.appendingPathComponent(".claude").path)
    }

    func testEnvUnsetDoesNotRequireDefaultPathToExist() throws {
        let nonexistentHome = tempRoot.appendingPathComponent("nope", isDirectory: true)

        let resolved = try LibraryRoot.resolve(
            environment: [:],
            homeDirectory: nonexistentHome
        )

        XCTAssertEqual(resolved.url.path, nonexistentHome.appendingPathComponent(".claude").path)
    }

    func testEnvAbsoluteExistingDirectoryIsReturned() throws {
        let custom = tempRoot.appendingPathComponent("my-library", isDirectory: true)
        try FileManager.default.createDirectory(at: custom, withIntermediateDirectories: true)

        let resolved = try LibraryRoot.resolve(
            environment: ["PATCHWORK_LIBRARY_ROOT": custom.path],
            homeDirectory: tempRoot
        )

        XCTAssertEqual(resolved.url.path, custom.path)
    }

    func testEnvRelativeIsRejected() {
        let result = Result {
            try LibraryRoot.resolve(
                environment: ["PATCHWORK_LIBRARY_ROOT": "relative/path"],
                homeDirectory: tempRoot
            )
        }
        switch result {
        case .success:
            XCTFail("expected relative path to be rejected")
        case .failure(let error):
            guard case LibraryRoot.ResolutionError.envVarRelative(let raw) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(raw, "relative/path")
        }
    }

    func testEnvAbsoluteMissingIsRejected() {
        let missing = tempRoot.appendingPathComponent("does-not-exist")

        let result = Result {
            try LibraryRoot.resolve(
                environment: ["PATCHWORK_LIBRARY_ROOT": missing.path],
                homeDirectory: tempRoot
            )
        }
        switch result {
        case .success:
            XCTFail("expected missing path to be rejected")
        case .failure(let error):
            guard case LibraryRoot.ResolutionError.envVarMissing = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testEnvAbsoluteFileIsRejectedAsNotDirectory() throws {
        let file = tempRoot.appendingPathComponent("not-a-dir.txt")
        try Data("hello".utf8).write(to: file)

        let result = Result {
            try LibraryRoot.resolve(
                environment: ["PATCHWORK_LIBRARY_ROOT": file.path],
                homeDirectory: tempRoot
            )
        }
        switch result {
        case .success:
            XCTFail("expected non-directory path to be rejected")
        case .failure(let error):
            guard case LibraryRoot.ResolutionError.envVarNotDirectory = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testEnvEmptyStringFallsBackToDefault() throws {
        let fakeHome = tempRoot.appendingPathComponent("fake-home", isDirectory: true)
        try FileManager.default.createDirectory(at: fakeHome, withIntermediateDirectories: true)

        let resolved = try LibraryRoot.resolve(
            environment: ["PATCHWORK_LIBRARY_ROOT": ""],
            homeDirectory: fakeHome
        )

        XCTAssertEqual(resolved.url.path, fakeHome.appendingPathComponent(".claude").path)
    }

    func testEnvWithTildeIsExpandedAndAccepted() throws {
        // Using the real home so tilde expansion has somewhere to go.
        let realHome = FileManager.default.homeDirectoryForCurrentUser
        let resolved = try LibraryRoot.resolve(
            environment: ["PATCHWORK_LIBRARY_ROOT": "~"],
            homeDirectory: tempRoot
        )
        XCTAssertEqual(resolved.url.path, realHome.path)
    }

    func testSkillsDirectoryIsRootSlashSkills() throws {
        let resolved = try LibraryRoot.resolve(
            environment: [:],
            homeDirectory: tempRoot
        )
        XCTAssertEqual(
            resolved.skillsDirectory.path,
            resolved.url.appendingPathComponent("skills").path
        )
    }

    func testResolutionErrorDescriptionsAreInformative() {
        let relative = LibraryRoot.ResolutionError.envVarRelative(rawValue: "foo")
        XCTAssertTrue(relative.description.contains("PATCHWORK_LIBRARY_ROOT"))
        XCTAssertTrue(relative.description.contains("foo"))

        let missing = LibraryRoot.ResolutionError.envVarMissing(rawValue: "/x", expandedPath: "/x")
        XCTAssertTrue(missing.description.contains("does not exist"))

        let notDir = LibraryRoot.ResolutionError.envVarNotDirectory(rawValue: "/x", expandedPath: "/x")
        XCTAssertTrue(notDir.description.contains("not a directory"))
    }
}
