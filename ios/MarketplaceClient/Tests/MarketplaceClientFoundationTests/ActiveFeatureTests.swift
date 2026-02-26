import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class ActiveViewModelFeatureTests: XCTestCase {
    func testBuildsCanonicalHeaderProgressForExecutingState() async throws {
        let timeline = makeTimeline(
            cycleID: "cycle_exec",
            state: "executing",
            legStatuses: [("u1", "deposited"), ("u2", "deposited")]
        )
        let viewModel = ActiveViewModel(
            repository: StaticActiveRepository(timelines: [timeline]),
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        XCTAssertEqual(snapshot.state, .executing)
        XCTAssertEqual(snapshot.header.stateLabel, "Executing")
        XCTAssertEqual(snapshot.header.completedSteps, 4)
        XCTAssertEqual(snapshot.header.totalSteps, 5)
        XCTAssertTrue(snapshot.header.detail.contains("Waiting for partner"))
    }

    func testEveryStateHasActionOrWaitReasonInvariant() async throws {
        let cases: [(state: String, statuses: [(String, String)])] = [
            ("proposed", [("u1", "pending"), ("u2", "pending")]),
            ("accepted", [("u1", "pending"), ("u2", "pending")]),
            ("escrow.pending", [("u1", "pending"), ("u2", "deposited")]),
            ("escrow.ready", [("u1", "deposited"), ("u2", "deposited")]),
            ("executing", [("u1", "deposited"), ("u2", "deposited")]),
            ("completed", [("u1", "released"), ("u2", "released")]),
            ("failed", [("u1", "refunded"), ("u2", "pending")])
        ]

        for (index, testCase) in cases.enumerated() {
            let cycleID = "cycle_state_\(index)"
            let timeline = makeTimeline(
                cycleID: cycleID,
                state: testCase.state,
                legStatuses: testCase.statuses
            )
            let viewModel = ActiveViewModel(
                repository: StaticActiveRepository(timelines: [timeline]),
                actorType: "user",
                actorID: "u1",
                defaultCycleID: cycleID
            )

            await viewModel.refresh()
            let snapshot = try XCTUnwrap(viewModel.snapshot)
            XCTAssertTrue(snapshot.hasActionOrWaitReason, "Missing guidance for state \(testCase.state)")
        }
    }

    func testTimelineEventsSortedByTimestampDescending() async throws {
        let timeline = SettlementTimeline(
            cycleID: "cycle_time_order",
            state: "failed",
            legs: [
                SettlementLeg(
                    legID: "leg_1",
                    intentID: "intent_a",
                    fromActor: ActorRef(type: "user", id: "u1"),
                    toActor: ActorRef(type: "user", id: "u2"),
                    assets: [AssetRef(platform: "steam", assetID: "asset_a")],
                    status: "refunded",
                    depositDeadlineAt: "2026-02-25T09:00:00Z",
                    refundRef: "refund_1",
                    refundedAt: "2026-02-24T10:30:00Z"
                ),
                SettlementLeg(
                    legID: "leg_2",
                    intentID: "intent_b",
                    fromActor: ActorRef(type: "user", id: "u2"),
                    toActor: ActorRef(type: "user", id: "u1"),
                    assets: [AssetRef(platform: "steam", assetID: "asset_b")],
                    status: "deposited",
                    depositDeadlineAt: "2026-02-25T10:00:00Z",
                    depositRef: "dep_2",
                    depositedAt: "2026-02-24T10:20:00Z"
                )
            ],
            updatedAt: "2026-02-24T10:40:00Z"
        )

        let viewModel = ActiveViewModel(
            repository: StaticActiveRepository(timelines: [timeline]),
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        let formatter = ISO8601DateFormatter()
        var lastDate: Date?
        for event in snapshot.timelineEvents {
            guard let iso = event.timestampISO8601, let current = formatter.date(from: iso) else {
                continue
            }

            if let lastDate {
                XCTAssertLessThanOrEqual(current, lastDate, "Timeline is not sorted in descending timestamp order")
            }
            lastDate = current
        }
    }

    func testEscrowPendingWithoutActorLegShowsExplicitWaitReasonAndDisabledAction() async throws {
        let timeline = makeTimeline(
            cycleID: "cycle_wait_reason",
            state: "escrow.pending",
            legStatuses: [("u1", "deposited"), ("u2", "pending")]
        )

        let viewModel = ActiveViewModel(
            repository: StaticActiveRepository(timelines: [timeline]),
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        XCTAssertNotNil(snapshot.waitReason)
        XCTAssertTrue(snapshot.waitReason?.contains("@u2") ?? false)
        XCTAssertEqual(snapshot.primaryAction?.kind, .confirmDeposit)
        XCTAssertEqual(snapshot.primaryAction?.isEnabled, false)
        XCTAssertTrue(snapshot.primaryAction?.disabledReason?.contains("@u2") ?? false)

        let didMutate = await viewModel.performPrimaryAction()
        XCTAssertFalse(didMutate)
        XCTAssertEqual(
            viewModel.fallbackState,
            .blocked(
                title: "Action unavailable",
                message: snapshot.primaryAction?.disabledReason ?? ""
            )
        )
    }

    func testConflictErrorMapsBlockedFallbackWithEnvelopeDetails() async throws {
        let timeline = makeTimeline(
            cycleID: "cycle_conflict",
            state: "escrow.ready",
            legStatuses: [("partner_demo", "deposited"), ("u2", "deposited")]
        )
        let conflict = MarketplaceClientError.conflict(
            MarketplaceAPIErrorEnvelope(
                correlationID: "corr_cycle_conflict",
                error: MarketplaceAPIErrorBody(
                    code: "CONFLICT",
                    message: "cycle is not escrow.ready",
                    details: .object([
                        "state": .string("executing")
                    ])
                )
            )
        )

        let repository = StaticActiveRepository(
            timelines: [timeline],
            errors: StaticActiveRepositoryErrors(beginExecution: conflict)
        )
        let viewModel = ActiveViewModel(
            repository: repository,
            actorType: "partner",
            actorID: "partner_demo",
            defaultCycleID: timeline.cycleID
        )

        await viewModel.refresh()
        let didMutate = await viewModel.performPrimaryAction()

        XCTAssertFalse(didMutate)
        guard case .blocked(let title, let message) = viewModel.fallbackState else {
            XCTFail("Expected blocked fallback state")
            return
        }
        XCTAssertEqual(title, "Action unavailable")
        XCTAssertTrue(message.contains("Current state is executing"))
    }

    private func makeTimeline(
        cycleID: String,
        state: String,
        legStatuses: [(String, String)]
    ) -> SettlementTimeline {
        let now = "2026-02-24T10:00:00Z"
        let deadline = "2026-02-25T08:00:00Z"

        let legs: [SettlementLeg] = legStatuses.enumerated().map { index, row in
            let actor = row.0
            let status = row.1

            return SettlementLeg(
                legID: "leg_\(index)",
                intentID: "intent_\(index)",
                fromActor: ActorRef(type: "user", id: actor),
                toActor: ActorRef(type: "user", id: "u\(index + 20)"),
                assets: [AssetRef(platform: "steam", assetID: "asset_\(index)")],
                status: status,
                depositDeadlineAt: deadline,
                depositRef: status == "deposited" ? "dep_\(index)" : nil,
                depositedAt: status == "deposited" ? now : nil,
                releaseRef: status == "released" ? "rel_\(index)" : nil,
                releasedAt: status == "released" ? now : nil,
                refundRef: status == "refunded" ? "refund_\(index)" : nil,
                refundedAt: status == "refunded" ? now : nil
            )
        }

        return SettlementTimeline(
            cycleID: cycleID,
            state: state,
            legs: legs,
            updatedAt: now
        )
    }
}

@MainActor
final class ActiveTimelineAnalyticsTests: XCTestCase {
    func testEventSequenceForViewAndDepositConfirm() async throws {
        let timeline = SettlementTimeline(
            cycleID: "cycle_analytics_timeline",
            state: "escrow.pending",
            legs: [
                SettlementLeg(
                    legID: "leg_user",
                    intentID: "intent_user",
                    fromActor: ActorRef(type: "user", id: "u1"),
                    toActor: ActorRef(type: "user", id: "u2"),
                    assets: [AssetRef(platform: "steam", assetID: "asset_a")],
                    status: "pending",
                    depositDeadlineAt: "2026-02-25T08:00:00Z"
                ),
                SettlementLeg(
                    legID: "leg_other",
                    intentID: "intent_other",
                    fromActor: ActorRef(type: "user", id: "u2"),
                    toActor: ActorRef(type: "user", id: "u1"),
                    assets: [AssetRef(platform: "steam", assetID: "asset_b")],
                    status: "deposited",
                    depositDeadlineAt: "2026-02-25T08:00:00Z",
                    depositRef: "dep_other",
                    depositedAt: "2026-02-24T08:10:00Z"
                )
            ],
            updatedAt: "2026-02-24T08:12:00Z"
        )

        let sink = InMemoryAnalyticsSink()
        let analytics = AnalyticsClient(sink: sink)
        let viewModel = ActiveViewModel(
            repository: StaticActiveRepository(timelines: [timeline]),
            analyticsClient: analytics,
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID
        )

        await viewModel.refresh()
        let result = await viewModel.performPrimaryAction()

        XCTAssertTrue(result)

        let names = await sink.allEvents().map(\.name)
        XCTAssertEqual(
            names,
            [
                "marketplace.timeline.viewed",
                "marketplace.timeline.deposit_confirmed"
            ]
        )
    }
}
