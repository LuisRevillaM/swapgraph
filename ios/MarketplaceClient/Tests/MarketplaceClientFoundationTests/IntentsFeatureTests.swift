import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class IntentComposerValidationTests: XCTestCase {
    func testValidatorRequiresOfferingWantAndWear() {
        let draft = IntentComposerDraft(
            offeringAssetID: " ",
            wantQuery: " ",
            acceptableWear: []
        )

        let issues = IntentComposerValidator.validate(draft)
        XCTAssertEqual(
            issues,
            [.missingOfferingAsset, .missingWantQuery, .missingWearSelection]
        )
    }
}

@MainActor
final class IntentsViewModelFeatureTests: XCTestCase {
    func testRefreshUsesPersistedWatchSnapshotWhenNoLiveMatches() async throws {
        let intent = sampleIntent(id: "intent_watch")
        let repository = StubIntentsRepository(intents: [intent], proposals: [])
        let store = InMemoryIntentWatchSnapshotStore(
            snapshot: IntentWatchSnapshot(nearMatchesByIntentID: [intent.id: 2])
        )

        let viewModel = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: store,
            analyticsClient: nil,
            actorID: "u1"
        )

        await viewModel.refresh()

        XCTAssertEqual(viewModel.rows.count, 1)
        guard case .matched(let nearMatchCount) = viewModel.rows[0].watchState else {
            XCTFail("Expected matched watch state")
            return
        }
        XCTAssertEqual(nearMatchCount, 2)
    }

    func testCreateIntentRollsBackOptimisticRowWhenMutationFails() async throws {
        let repository = StubIntentsRepository(
            intents: [],
            proposals: [],
            createError: .server(statusCode: 503, envelope: nil)
        )
        let viewModel = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: InMemoryIntentWatchSnapshotStore(),
            analyticsClient: nil,
            actorID: "u1"
        )

        viewModel.openComposer()
        viewModel.composerDraft = IntentComposerDraft(
            offeringAssetID: "asset_a",
            wantQuery: "knife",
            acceptableWear: [.mw, .ft],
            valueTolerance: .usd50,
            cycleLength: .threeWay,
            urgency: "normal"
        )

        let ok = await viewModel.submitComposer()
        XCTAssertFalse(ok)
        XCTAssertTrue(viewModel.rows.isEmpty)
        XCTAssertEqual(
            viewModel.fallbackState,
            .retryable(title: "Temporary issue", message: "The server is unavailable. Try again shortly.")
        )
    }

    func testCancelIntentRollsBackWhenMutationFails() async throws {
        let activeIntent = sampleIntent(id: "intent_cancel")
        let repository = StubIntentsRepository(
            intents: [activeIntent],
            proposals: [],
            cancelError: .transport(description: "offline")
        )

        let viewModel = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: InMemoryIntentWatchSnapshotStore(),
            analyticsClient: nil,
            actorID: "u1"
        )

        await viewModel.refresh()
        let ok = await viewModel.cancelIntent(id: activeIntent.id)

        XCTAssertFalse(ok)
        XCTAssertEqual(viewModel.rows.count, 1)
        XCTAssertEqual(viewModel.rows[0].id, activeIntent.id)
        XCTAssertEqual(viewModel.rows[0].watchState, .watchingNoMatches)
        XCTAssertEqual(
            viewModel.fallbackState,
            .retryable(title: "Connection issue", message: "Check your network and retry.")
        )
    }

    func testJourneyTraceCapturesFirstIntentAndMedianUnderSixtySeconds() async throws {
        let repository = StubIntentsRepository(intents: [], proposals: [])
        let watchStore = InMemoryIntentWatchSnapshotStore()
        let clock = SequenceClock(dates: [
            date(0),
            date(1),
            date(2),
            date(3),
            date(4),
            date(5),
            date(6),
            date(45),
            date(45),
            date(45)
        ])

        let viewModel = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: watchStore,
            analyticsClient: nil,
            actorID: "u1",
            now: clock.now
        )

        viewModel.openComposer()
        viewModel.composerDraft = IntentComposerDraft(
            offeringAssetID: "asset_journey",
            wantQuery: "gloves",
            acceptableWear: [.fn, .mw],
            valueTolerance: .usd100,
            cycleLength: .threeWay,
            urgency: "normal"
        )

        let ok = await viewModel.submitComposer()
        XCTAssertTrue(ok)

        XCTAssertEqual(viewModel.journeyTraces.count, 1)
        let trace = try XCTUnwrap(viewModel.journeyTraces.first)
        XCTAssertEqual(
            trace.events.map(\.name),
            [
                "intent_composer_opened",
                "intent_create_submitted",
                "intent_create_succeeded",
                "intents_watching_visible"
            ]
        )
        XCTAssertLessThan(trace.elapsedSeconds, 60)
        XCTAssertEqual(try XCTUnwrap(viewModel.medianFirstIntentSeconds), trace.elapsedSeconds, accuracy: 0.001)
    }

    private func sampleIntent(id: String) -> SwapIntent {
        IntentComposerDraft(
            offeringAssetID: "asset_a",
            wantQuery: "knife",
            acceptableWear: [.mw, .ft],
            valueTolerance: .usd50,
            cycleLength: .threeWay,
            urgency: "normal"
        ).makeSwapIntent(actorID: "u1", now: date(0), existingID: id)
    }

    private static func date(_ seconds: TimeInterval) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    private func date(_ seconds: TimeInterval) -> Date {
        Self.date(seconds)
    }
}

final class IntentWatchSnapshotStoreTests: XCTestCase {
    func testPersistsAndLoadsWatchSnapshotWithTTL() throws {
        let tempDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-intent-watch-\(UUID().uuidString)")

        let persistence = MarketplacePersistence(
            secureStore: InMemorySecureStore(),
            cacheStore: try FileCacheStore(directoryURL: tempDirectory)
        )

        let store = IntentWatchSnapshotStore(
            persistence: persistence,
            cacheKey: "intents.watch.snapshot.test",
            ttlSeconds: 20
        )

        let snapshot = IntentWatchSnapshot(nearMatchesByIntentID: ["intent_a": 3])
        try store.save(snapshot, nowEpochSeconds: 100)

        let hydrated = try store.load(nowEpochSeconds: 110)
        XCTAssertEqual(hydrated, snapshot)

        let expired = try store.load(nowEpochSeconds: 121)
        XCTAssertNil(expired)
    }
}

private actor StubIntentsRepository: MarketplaceIntentsRepositoryProtocol {
    private var intents: [SwapIntent]
    private let proposals: [CycleProposal]
    private let createError: MarketplaceClientError?
    private let updateError: MarketplaceClientError?
    private let cancelError: MarketplaceClientError?

    init(
        intents: [SwapIntent],
        proposals: [CycleProposal],
        createError: MarketplaceClientError? = nil,
        updateError: MarketplaceClientError? = nil,
        cancelError: MarketplaceClientError? = nil
    ) {
        self.intents = intents
        self.proposals = proposals
        self.createError = createError
        self.updateError = updateError
        self.cancelError = cancelError
    }

    func listIntents() async throws -> [SwapIntent] {
        intents
    }

    func listProposals() async throws -> [CycleProposal] {
        proposals
    }

    func createIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        if let createError {
            throw createError
        }
        intents.append(intent)
        return intent
    }

    func updateIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        if let updateError {
            throw updateError
        }
        if let index = intents.firstIndex(where: { $0.id == intent.id }) {
            intents[index] = intent
        } else {
            intents.append(intent)
        }
        return intent
    }

    func cancelIntent(id: String, idempotencyKey: String?) async throws -> SwapIntentCancelResponse {
        if let cancelError {
            throw cancelError
        }

        if let index = intents.firstIndex(where: { $0.id == id }) {
            let existing = intents[index]
            intents[index] = SwapIntent(
                id: existing.id,
                actor: existing.actor,
                offer: existing.offer,
                wantSpec: existing.wantSpec,
                valueBand: existing.valueBand,
                trustConstraints: existing.trustConstraints,
                timeConstraints: existing.timeConstraints,
                settlementPreferences: existing.settlementPreferences,
                status: "cancelled"
            )
        }

        return SwapIntentCancelResponse(
            correlationID: "corr_\(id)",
            id: id,
            status: "cancelled"
        )
    }
}

private final class SequenceClock {
    private let dates: [Date]
    private var index = 0

    init(dates: [Date]) {
        self.dates = dates
    }

    func now() -> Date {
        guard !dates.isEmpty else { return Date(timeIntervalSince1970: 0) }
        let value = dates[min(index, dates.count - 1)]
        index += 1
        return value
    }
}
