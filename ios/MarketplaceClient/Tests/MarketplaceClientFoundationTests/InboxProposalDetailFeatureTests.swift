import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class InboxViewModelFeatureTests: XCTestCase {
    func testBuildsRankingSectionsAndStatusCues() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let proposals = [
            makeProposal(id: "cycle_act_now", expiresAt: now.addingTimeInterval(30 * 60), confidence: 0.45),
            makeProposal(id: "cycle_high_conf", expiresAt: now.addingTimeInterval(4 * 60 * 60), confidence: 0.91),
            makeProposal(id: "cycle_standard", expiresAt: now.addingTimeInterval(5 * 60 * 60), confidence: 0.55)
        ]

        let viewModel = InboxViewModel(
            repository: StaticProposalRepository(proposals: proposals),
            now: { now }
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        XCTAssertEqual(snapshot.sections.count, 3)
        XCTAssertEqual(snapshot.sections[0].id, ProposalUrgencyBand.actNow.rawValue)
        XCTAssertEqual(snapshot.sections[0].rows.first?.id, "cycle_act_now")
        XCTAssertTrue(snapshot.sections[0].rows.first?.statusCue.contains("Expires in") ?? false)

        XCTAssertEqual(snapshot.sections[1].id, ProposalUrgencyBand.highConfidence.rawValue)
        XCTAssertEqual(snapshot.sections[1].rows.first?.id, "cycle_high_conf")

        XCTAssertEqual(snapshot.sections[2].id, ProposalUrgencyBand.standard.rawValue)
        XCTAssertEqual(snapshot.sections[2].rows.first?.id, "cycle_standard")
    }

    func testOpenIfNeededCreatesDetailPresentation() async {
        let proposal = makeProposal(
            id: "cycle_route_open",
            expiresAt: Date(timeIntervalSince1970: 1_700_000_000).addingTimeInterval(3600),
            confidence: 0.82
        )

        let viewModel = InboxViewModel(
            repository: StaticProposalRepository(proposals: [proposal])
        )

        await viewModel.refresh()
        await viewModel.openIfNeeded(proposalID: proposal.id)

        XCTAssertEqual(viewModel.detailPresentation?.id, proposal.id)
        XCTAssertEqual(viewModel.detailPresentation?.viewModel.proposalID, proposal.id)
        XCTAssertNotNil(viewModel.detailPresentation?.viewModel.snapshot)
    }

    private func makeProposal(id: String, expiresAt: Date, confidence: Double) -> CycleProposal {
        CycleProposal(
            id: id,
            expiresAt: ISO8601DateFormatter().string(from: expiresAt),
            participants: [
                ProposalParticipant(
                    intentID: "intent_\(id)",
                    actor: ActorRef(type: "user", id: "u1"),
                    give: [AssetRef(platform: "steam", assetID: "m9_bayonet")],
                    get: [AssetRef(platform: "steam", assetID: "ak_vulcan")]
                ),
                ProposalParticipant(
                    intentID: "intent_other_\(id)",
                    actor: ActorRef(type: "user", id: "u2"),
                    give: [AssetRef(platform: "steam", assetID: "ak_vulcan")],
                    get: [AssetRef(platform: "steam", assetID: "m9_bayonet")]
                )
            ],
            confidenceScore: confidence,
            valueSpread: 0.08,
            explainability: ["Constraint fit from both sides"]
        )
    }
}

@MainActor
final class ProposalDetailViewModelFeatureTests: XCTestCase {
    func testExplainabilityPrimitivesAlwaysPresent() async throws {
        let proposal = CycleProposal(
            id: "cycle_explain",
            expiresAt: "2026-02-24T12:00:00Z",
            participants: [
                ProposalParticipant(
                    intentID: "intent_a",
                    actor: ActorRef(type: "user", id: "u1"),
                    give: [AssetRef(platform: "steam", assetID: "knife_a")],
                    get: [AssetRef(platform: "steam", assetID: "glove_b")]
                ),
                ProposalParticipant(
                    intentID: "intent_b",
                    actor: ActorRef(type: "user", id: "u3"),
                    give: [AssetRef(platform: "steam", assetID: "glove_b")],
                    get: [AssetRef(platform: "steam", assetID: "knife_a")]
                )
            ],
            confidenceScore: nil,
            valueSpread: nil,
            explainability: nil
        )

        let repository = StaticProposalRepository(proposals: [proposal])
        let viewModel = ProposalDetailViewModel(
            proposalID: proposal.id,
            repository: repository
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        XCTAssertEqual(snapshot.explainabilityCards.count, 3)
        XCTAssertEqual(
            snapshot.explainabilityCards.map(\.id),
            ["value_delta", "confidence", "constraint_fit"]
        )
    }

    func testAcceptDeclineFeedbackStatesDeterministic() async {
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        let viewModel = ProposalDetailViewModel(
            proposalID: proposal.id,
            repository: StaticProposalRepository(proposals: [proposal])
        )

        await viewModel.refresh()
        let accepted = await viewModel.acceptProposal()
        XCTAssertTrue(accepted)
        guard case .accepted(let commitID) = viewModel.decisionState else {
            XCTFail("Expected accepted decision state")
            return
        }
        XCTAssertEqual(commitID, "commit_accept_\(proposal.id)")
    }

    func testDeclineFailureMapsRetryableFallbackState() async {
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        let repository = StaticProposalRepository(
            proposals: [proposal],
            errors: StaticProposalRepositoryErrors(
                decline: .transport(description: "offline")
            )
        )
        let viewModel = ProposalDetailViewModel(
            proposalID: proposal.id,
            repository: repository
        )

        await viewModel.refresh()
        let declined = await viewModel.declineProposal()

        XCTAssertFalse(declined)
        XCTAssertEqual(viewModel.decisionState, .failed(message: "Decline failed"))
        XCTAssertEqual(
            viewModel.fallbackState,
            .retryable(title: "Connection issue", message: "Check your network and retry.")
        )
    }
}

@MainActor
final class ProposalFunnelAnalyticsTests: XCTestCase {
    func testEventSequenceForOpenAndAccept() async throws {
        let sink = InMemoryAnalyticsSink()
        let analytics = AnalyticsClient(sink: sink)
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        let inboxViewModel = InboxViewModel(
            repository: StaticProposalRepository(proposals: [proposal]),
            analyticsClient: analytics,
            actorID: "u1"
        )

        await inboxViewModel.refresh()
        await inboxViewModel.openProposal(id: proposal.id)
        let detailViewModel = try XCTUnwrap(inboxViewModel.detailPresentation?.viewModel)
        _ = await detailViewModel.acceptProposal()

        let names = await sink.allEvents().map(\.name)
        XCTAssertEqual(
            names,
            [
                "marketplace.inbox.viewed",
                "marketplace.proposal.opened",
                "marketplace.proposal.detail.viewed",
                "marketplace.proposal.accepted"
            ]
        )
    }

    func testEventSequenceForOpenAndDecline() async throws {
        let sink = InMemoryAnalyticsSink()
        let analytics = AnalyticsClient(sink: sink)
        let proposal = ProposalPreviewFixtures.sampleProposals()[0]
        let inboxViewModel = InboxViewModel(
            repository: StaticProposalRepository(proposals: [proposal]),
            analyticsClient: analytics,
            actorID: "u1"
        )

        await inboxViewModel.refresh()
        await inboxViewModel.openProposal(id: proposal.id)
        let detailViewModel = try XCTUnwrap(inboxViewModel.detailPresentation?.viewModel)
        _ = await detailViewModel.declineProposal()

        let names = await sink.allEvents().map(\.name)
        XCTAssertEqual(
            names,
            [
                "marketplace.inbox.viewed",
                "marketplace.proposal.opened",
                "marketplace.proposal.detail.viewed",
                "marketplace.proposal.declined"
            ]
        )
    }
}
