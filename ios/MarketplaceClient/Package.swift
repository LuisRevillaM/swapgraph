// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MarketplaceClient",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "MarketplaceClientFoundation",
            targets: ["MarketplaceClientFoundation"]
        )
    ],
    targets: [
        .target(
            name: "MarketplaceClientFoundation",
            resources: [
                .copy("Resources/marketplace_design_tokens.json")
            ]
        ),
        .testTarget(
            name: "MarketplaceClientFoundationTests",
            dependencies: ["MarketplaceClientFoundation"],
            resources: [
                .copy("Snapshots/theme_snapshot.json")
            ]
        )
    ]
)
