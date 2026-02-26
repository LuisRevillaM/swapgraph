import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class AccessibilityFeatureTests: XCTestCase {
    func testInformationalTypographyAcrossCoreViewsMeetsReadabilityFloor() throws {
        let files = [
            "Sources/MarketplaceClientFoundation/Items/ItemsView.swift",
            "Sources/MarketplaceClientFoundation/Intents/IntentsView.swift",
            "Sources/MarketplaceClientFoundation/Inbox/InboxView.swift",
            "Sources/MarketplaceClientFoundation/ProposalDetail/ProposalDetailView.swift",
            "Sources/MarketplaceClientFoundation/Active/ActiveView.swift",
            "Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift",
            "Sources/MarketplaceClientFoundation/UI/StaleDataBannerView.swift"
        ]

        let regex = try NSRegularExpression(pattern: #"font\(\.system\(size:\s*([0-9]+(?:\.[0-9]+)?)"#)

        for relativePath in files {
            let source = try loadSource(relativePath)
            let matches = regex.matches(in: source, range: NSRange(source.startIndex..<source.endIndex, in: source))
            for match in matches {
                guard match.numberOfRanges > 1 else { continue }
                guard let range = Range(match.range(at: 1), in: source) else { continue }
                guard let size = Double(source[range]) else { continue }
                XCTAssertGreaterThanOrEqual(
                    size,
                    Double(MarketplaceAccessibility.informationalReadabilityFloor),
                    "Found \(size)px below floor in \(relativePath)"
                )
            }
        }
    }

    func testAppShellDeclaresDynamicTypeSupport() throws {
        let source = try loadSource("Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift")
        XCTAssertTrue(source.contains(".dynamicTypeSize(.xSmall ... .accessibility3)"))
    }

    func testCriticalInteractiveControlsExposeAccessibilitySemantics() throws {
        let requiredSnippets: [(String, [String])] = [
            (
                "Sources/MarketplaceClientFoundation/Intents/IntentsView.swift",
                [
                    "accessibilityIdentifier(\"intents.postButton\")",
                    "accessibilityIdentifier(\"intents.alertPreferencesButton\")",
                    "accessibilityIdentifier(\"intents.composer.submit\")",
                    "accessibilityLabel(\"Post intent\")",
                    "accessibilityLabel(\"Alert preferences\")"
                ]
            ),
            (
                "Sources/MarketplaceClientFoundation/Inbox/InboxView.swift",
                [
                    "accessibilityIdentifier(\"inbox.proposal.",
                    "accessibilityHint(\"Open detailed rationale and accept or decline controls\")"
                ]
            ),
            (
                "Sources/MarketplaceClientFoundation/ProposalDetail/ProposalDetailView.swift",
                [
                    "accessibilityIdentifier(\"proposal.accept\")",
                    "accessibilityIdentifier(\"proposal.decline\")",
                    "accessibilityLabel(\"Accept swap proposal\")",
                    "accessibilityLabel(\"Decline swap proposal\")"
                ]
            ),
            (
                "Sources/MarketplaceClientFoundation/Active/ActiveView.swift",
                [
                    "accessibilityIdentifier(\"active.primaryAction.",
                    "accessibilityHint(action.subtitle)"
                ]
            ),
            (
                "Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift",
                [
                    "accessibilityIdentifier(\"receipts.row.",
                    "accessibilityIdentifier(\"receipts.detail.",
                    "accessibilityHint(\"Shows verification and settlement metadata\")"
                ]
            )
        ]

        for row in requiredSnippets {
            let source = try loadSource(row.0)
            for snippet in row.1 {
                XCTAssertTrue(
                    source.contains(snippet),
                    "Missing accessibility snippet '\(snippet)' in \(row.0)"
                )
            }
        }
    }

    func testProposalAndActiveViewsDeclareFocusOrderPriorities() throws {
        let proposalSource = try loadSource("Sources/MarketplaceClientFoundation/ProposalDetail/ProposalDetailView.swift")
        XCTAssertTrue(proposalSource.contains(".accessibilitySortPriority(5)"))
        XCTAssertTrue(proposalSource.contains(".accessibilitySortPriority(1)"))

        let activeSource = try loadSource("Sources/MarketplaceClientFoundation/Active/ActiveView.swift")
        XCTAssertTrue(activeSource.contains(".accessibilitySortPriority(5)"))
        XCTAssertTrue(activeSource.contains(".accessibilitySortPriority(1)"))
    }

    func testTouchTargetBaselineIsFortyFourPoints() {
        XCTAssertEqual(MarketplaceAccessibility.minimumTouchTarget, 44)
    }

    func testSmallControlsPromotedToMinimumTouchTarget() throws {
        let source = try loadSource("Sources/MarketplaceClientFoundation/Intents/IntentsView.swift")
        let controlCount = source.components(separatedBy: ".controlSize(.small)").count - 1
        XCTAssertGreaterThan(controlCount, 0)

        let regex = try NSRegularExpression(
            pattern: #"\.controlSize\(\.small\)[\s\S]{0,400}\.marketplaceTouchTarget\(\)"#
        )
        let pairedCount = regex.matches(
            in: source,
            range: NSRange(source.startIndex..<source.endIndex, in: source)
        ).count

        XCTAssertEqual(
            pairedCount,
            controlCount,
            "Each small control should be followed by marketplaceTouchTarget."
        )
    }

    private func loadSource(_ relativePathFromPackage: String) throws -> String {
        let path = packageRootURL()
            .appendingPathComponent(relativePathFromPackage)
            .path
        return try String(contentsOfFile: path, encoding: .utf8)
    }

    private func packageRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}
