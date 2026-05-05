// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Patchwork",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "PatchworkCore", targets: ["PatchworkCore"]),
        .executable(name: "patchwork", targets: ["PatchworkCLI"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0")
    ],
    targets: [
        .target(
            name: "PatchworkCore",
            path: "Sources/PatchworkCore"
        ),
        .executableTarget(
            name: "PatchworkCLI",
            dependencies: [
                "PatchworkCore",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            path: "Sources/PatchworkCLI"
        ),
        .testTarget(
            name: "PatchworkCoreTests",
            dependencies: ["PatchworkCore"],
            path: "Tests/PatchworkCoreTests"
        )
    ]
)
