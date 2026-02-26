import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class PerformanceBudgetTests: XCTestCase {
    func testStartupBudgetForAppShellInitialization() {
        let start = CFAbsoluteTimeGetCurrent()
        for _ in 0..<400 {
            _ = AppShellViewModel(featureFlags: .allEnabled)
        }
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - start) * 1_000

        let result = PerformanceCheckResult(
            name: "startup",
            measuredMilliseconds: elapsedMs,
            budgetMilliseconds: MarketplacePerformanceBudgets.startupBudgetMilliseconds
        )
        XCTAssertTrue(result.passes, "Startup budget exceeded: \(result)")
    }

    func testInteractionLatencyBudgetForProposalDecision() async {
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        let viewModel = ProposalDetailViewModel(
            proposalID: proposal.id,
            repository: StaticProposalRepository(proposals: [proposal])
        )

        let start = CFAbsoluteTimeGetCurrent()
        await viewModel.refresh()
        let accepted = await viewModel.acceptProposal()
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - start) * 1_000

        XCTAssertTrue(accepted)
        let result = PerformanceCheckResult(
            name: "proposal_decision_interaction",
            measuredMilliseconds: elapsedMs,
            budgetMilliseconds: MarketplacePerformanceBudgets.interactionBudgetMilliseconds
        )
        XCTAssertTrue(result.passes, "Interaction latency budget exceeded: \(result)")
    }

    func testLongListRefreshBudgetForInbox() async {
        let proposals = (0..<1200).map { index in
            makeProposal(id: "cycle_perf_\(index)", offsetMinutes: index)
        }

        let viewModel = InboxViewModel(
            repository: StaticProposalRepository(proposals: proposals),
            now: Date.init
        )

        let start = CFAbsoluteTimeGetCurrent()
        await viewModel.refresh()
        let elapsedMs = (CFAbsoluteTimeGetCurrent() - start) * 1_000

        XCTAssertEqual(viewModel.snapshot?.sections.flatMap(\.rows).count, 1200)
        let result = PerformanceCheckResult(
            name: "long_list_refresh",
            measuredMilliseconds: elapsedMs,
            budgetMilliseconds: MarketplacePerformanceBudgets.longListBudgetMilliseconds
        )
        XCTAssertTrue(result.passes, "Long-list budget exceeded: \(result)")
    }

    func testLongListSurfacesUseLazyContainers() throws {
        let filesAndTokens: [(String, [String])] = [
            ("Sources/MarketplaceClientFoundation/Items/ItemsView.swift", ["LazyVStack", "LazyVGrid"]),
            ("Sources/MarketplaceClientFoundation/Intents/IntentsView.swift", ["LazyVStack"]),
            ("Sources/MarketplaceClientFoundation/Inbox/InboxView.swift", ["LazyVStack"]),
            ("Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift", ["LazyVStack"])
        ]

        for entry in filesAndTokens {
            let source = try loadSource(entry.0)
            for token in entry.1 {
                XCTAssertTrue(source.contains(token), "Missing \(token) in \(entry.0)")
            }
        }
    }

    private func makeProposal(id: String, offsetMinutes: Int) -> CycleProposal {
        let expiresAt = Date().addingTimeInterval(Double(offsetMinutes + 60) * 60)
        return CycleProposal(
            id: id,
            expiresAt: ISO8601DateFormatter().string(from: expiresAt),
            participants: [
                ProposalParticipant(
                    intentID: "intent_\(id)",
                    actor: ActorRef(type: "user", id: "u1"),
                    give: [AssetRef(platform: "steam", assetID: "asset_a_\(id)")],
                    get: [AssetRef(platform: "steam", assetID: "asset_b_\(id)")]
                )
            ],
            confidenceScore: Double((offsetMinutes % 40) + 60) / 100.0,
            valueSpread: Double(offsetMinutes % 20) / 100.0,
            explainability: ["Constraint fit"]
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
