import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class OfflineResilienceFeatureTests: XCTestCase {
    func testItemsRefreshFallsBackToCachedSnapshotWhenOffline() async throws {
        let snapshot = ItemsScreenSnapshot(
            demandBannerCount: 2,
            sections: [
                ItemsSectionModel(
                    id: "highest-demand",
                    title: "Highest demand",
                    items: [
                        MarketplaceItemCardModel(
                            id: "asset_a",
                            assetID: "asset_a",
                            displayName: "M9 Bayonet",
                            demandCount: 3
                        )
                    ]
                )
            ],
            emptyMessage: "No items"
        )

        let persistence = try makePersistence("offline-items")
        let offlineStore = OfflineSnapshotStore<ItemsScreenSnapshot>(
            persistence: persistence,
            cacheKey: "test.items.offline"
        )
        let repository = ToggleItemsRepository(snapshot: snapshot)
        let viewModel = ItemsViewModel(
            repository: repository,
            offlineStore: offlineStore,
            now: { Date(timeIntervalSince1970: 1_000) }
        )

        await viewModel.refresh()
        await repository.setFailReads(true)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.snapshot, snapshot)
        XCTAssertNotNil(viewModel.staleDataState)
        XCTAssertNil(viewModel.fallbackState)
    }

    func testIntentsRefreshFallsBackToCachedSnapshotWhenOffline() async throws {
        let intent = sampleIntent(id: "intent_offline")
        let persistence = try makePersistence("offline-intents")
        let offlineStore = OfflineSnapshotStore<IntentsOfflineSnapshot>(
            persistence: persistence,
            cacheKey: "test.intents.offline"
        )
        let repository = ToggleIntentsRepository(intents: [intent], proposals: [])
        let viewModel = IntentsViewModel(
            repository: repository,
            watchSnapshotStore: InMemoryIntentWatchSnapshotStore(),
            offlineStore: offlineStore,
            now: { Date(timeIntervalSince1970: 1_000) }
        )

        await viewModel.refresh()
        await repository.setFailReads(true)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.rows.count, 1)
        XCTAssertEqual(viewModel.rows.first?.id, intent.id)
        XCTAssertNotNil(viewModel.staleDataState)
        XCTAssertNil(viewModel.fallbackState)
    }

    func testInboxRefreshFallsBackToCachedSnapshotWhenOffline() async throws {
        let proposal = sampleProposal(id: "cycle_offline")
        let persistence = try makePersistence("offline-inbox")
        let offlineStore = OfflineSnapshotStore<[CycleProposal]>(
            persistence: persistence,
            cacheKey: "test.inbox.offline"
        )
        let repository = ToggleProposalRepository(proposals: [proposal])
        let viewModel = InboxViewModel(
            repository: repository,
            offlineStore: offlineStore,
            now: { Date(timeIntervalSince1970: 1_000) }
        )

        await viewModel.refresh()
        await repository.setFailList(true)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.snapshot?.sections.first?.rows.first?.id, proposal.id)
        XCTAssertNotNil(viewModel.staleDataState)
        XCTAssertNil(viewModel.fallbackState)
    }

    func testActiveRefreshFallsBackToCachedSnapshotWhenOffline() async throws {
        let timeline = ActivePreviewFixtures.sampleTimeline(cycleID: "cycle_active_offline")
        let persistence = try makePersistence("offline-active")
        let offlineStore = OfflineSnapshotStore<[String: SettlementTimeline]>(
            persistence: persistence,
            cacheKey: "test.active.offline"
        )
        let repository = ToggleActiveRepository(timeline: timeline)
        let viewModel = ActiveViewModel(
            repository: repository,
            offlineStore: offlineStore,
            actorType: "user",
            actorID: "u1",
            defaultCycleID: timeline.cycleID,
            now: { Date(timeIntervalSince1970: 1_000) }
        )

        await viewModel.refresh()
        await repository.setFailStatus(true)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.snapshot?.cycleID, timeline.cycleID)
        XCTAssertNotNil(viewModel.staleDataState)
        XCTAssertNil(viewModel.fallbackState)
    }

    func testReceiptsRefreshFallsBackToCachedSnapshotWhenOffline() async throws {
        let receipt = ReceiptsPreviewFixtures.sampleReceipts()[0]
        let persistence = try makePersistence("offline-receipts")
        let offlineStore = OfflineSnapshotStore<[SwapReceipt]>(
            persistence: persistence,
            cacheKey: "test.receipts.offline"
        )
        let repository = ToggleReceiptsRepository(receipts: [receipt], shares: [])
        let viewModel = ReceiptsViewModel(
            repository: repository,
            offlineStore: offlineStore,
            knownCycleIDs: [receipt.cycleID],
            now: { Date(timeIntervalSince1970: 1_000) }
        )

        await viewModel.refresh()
        await repository.setFailList(true)
        await viewModel.refresh()

        XCTAssertEqual(viewModel.snapshot?.rows.first?.cycleID, receipt.cycleID)
        XCTAssertNotNil(viewModel.staleDataState)
        XCTAssertNil(viewModel.fallbackState)
    }

    private func makePersistence(_ name: String) throws -> MarketplacePersistence {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("marketplace-\(name)-\(UUID().uuidString)")
        let cacheStore = try FileCacheStore(directoryURL: directory)
        return MarketplacePersistence(
            secureStore: InMemorySecureStore(),
            cacheStore: cacheStore
        )
    }

    private func sampleIntent(id: String) -> SwapIntent {
        IntentComposerDraft(
            offeringAssetID: "asset_a",
            wantQuery: "knife",
            acceptableWear: [.mw, .ft],
            valueTolerance: .usd50,
            cycleLength: .threeWay,
            urgency: "normal"
        ).makeSwapIntent(
            actorID: "u1",
            now: Date(timeIntervalSince1970: 100),
            existingID: id
        )
    }

    private func sampleProposal(id: String) -> CycleProposal {
        CycleProposal(
            id: id,
            expiresAt: "2026-02-24T10:00:00Z",
            participants: [
                ProposalParticipant(
                    intentID: "intent_\(id)",
                    actor: ActorRef(type: "user", id: "u1"),
                    give: [AssetRef(platform: "steam", assetID: "asset_a")],
                    get: [AssetRef(platform: "steam", assetID: "asset_b")]
                )
            ],
            confidenceScore: 0.9,
            valueSpread: 0.04,
            explainability: ["Constraint fit"]
        )
    }
}

private actor ToggleItemsRepository: MarketplaceItemsRepositoryProtocol {
    private let snapshot: ItemsScreenSnapshot
    private var failReads = false

    init(snapshot: ItemsScreenSnapshot) {
        self.snapshot = snapshot
    }

    func setFailReads(_ value: Bool) {
        failReads = value
    }

    func loadItems() async throws -> ItemsScreenSnapshot {
        if failReads {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return snapshot
    }
}

private actor ToggleIntentsRepository: MarketplaceIntentsRepositoryProtocol {
    private let intents: [SwapIntent]
    private let proposals: [CycleProposal]
    private var failReads = false

    init(intents: [SwapIntent], proposals: [CycleProposal]) {
        self.intents = intents
        self.proposals = proposals
    }

    func setFailReads(_ value: Bool) {
        failReads = value
    }

    func listIntents() async throws -> [SwapIntent] {
        if failReads {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return intents
    }

    func listProposals() async throws -> [CycleProposal] {
        if failReads {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return proposals
    }

    func createIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        _ = idempotencyKey
        return intent
    }

    func updateIntent(_ intent: SwapIntent, idempotencyKey: String?) async throws -> SwapIntent {
        _ = idempotencyKey
        return intent
    }

    func cancelIntent(id: String, idempotencyKey: String?) async throws -> SwapIntentCancelResponse {
        _ = idempotencyKey
        return SwapIntentCancelResponse(correlationID: "corr_\(id)", id: id, status: "cancelled")
    }
}

private actor ToggleProposalRepository: MarketplaceProposalRepositoryProtocol {
    private let proposals: [CycleProposal]
    private var failList = false

    init(proposals: [CycleProposal]) {
        self.proposals = proposals
    }

    func setFailList(_ value: Bool) {
        failList = value
    }

    func listProposals() async throws -> [CycleProposal] {
        if failList {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return proposals
    }

    func getProposal(id: String) async throws -> CycleProposal {
        guard let proposal = proposals.first(where: { $0.id == id }) else {
            throw MarketplaceClientError.notFound(
                MarketplaceAPIErrorEnvelope(
                    correlationID: "corr_\(id)",
                    error: MarketplaceAPIErrorBody(code: "NOT_FOUND", message: "proposal not found")
                )
            )
        }
        return proposal
    }

    func acceptProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        _ = occurredAt
        _ = idempotencyKey
        return CommitView(id: "commit_accept_\(id)", cycleID: id, phase: "accept")
    }

    func declineProposal(id: String, occurredAt: String, idempotencyKey: String?) async throws -> CommitView {
        _ = occurredAt
        _ = idempotencyKey
        return CommitView(id: "commit_decline_\(id)", cycleID: id, phase: "cancelled")
    }
}

private actor ToggleActiveRepository: MarketplaceActiveRepositoryProtocol {
    private let timeline: SettlementTimeline
    private var failStatus = false

    init(timeline: SettlementTimeline) {
        self.timeline = timeline
    }

    func setFailStatus(_ value: Bool) {
        failStatus = value
    }

    func settlementStatus(cycleID: String) async throws -> SettlementTimeline {
        _ = cycleID
        if failStatus {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return timeline
    }

    func confirmDeposit(cycleID: String, legID: String, depositRef: String, idempotencyKey: String?) async throws -> SettlementTimeline {
        _ = cycleID
        _ = legID
        _ = depositRef
        _ = idempotencyKey
        return timeline
    }

    func beginExecution(cycleID: String, idempotencyKey: String?) async throws -> SettlementTimeline {
        _ = cycleID
        _ = idempotencyKey
        return timeline
    }

    func completeSettlement(cycleID: String, idempotencyKey: String?) async throws -> ActiveSettlementCompletion {
        _ = idempotencyKey
        return ActiveSettlementCompletion(
            timeline: timeline,
            receipt: ActivePreviewFixtures.sampleReceipt(cycleID: cycleID)
        )
    }

    func receipt(cycleID: String) async throws -> SwapReceipt {
        ActivePreviewFixtures.sampleReceipt(cycleID: cycleID)
    }
}

private actor ToggleReceiptsRepository: MarketplaceReceiptsRepositoryProtocol {
    private let receipts: [SwapReceipt]
    private let shares: [ReceiptShareProjection]
    private var failList = false

    init(receipts: [SwapReceipt], shares: [ReceiptShareProjection]) {
        self.receipts = receipts
        self.shares = shares
    }

    func setFailList(_ value: Bool) {
        failList = value
    }

    func loadReceipts(candidateCycleIDs: [String]) async throws -> [SwapReceipt] {
        _ = candidateCycleIDs
        if failList {
            throw MarketplaceClientError.transport(description: "offline")
        }
        return receipts
    }

    func receipt(cycleID: String) async throws -> SwapReceipt {
        if let receipt = receipts.first(where: { $0.cycleID == cycleID }) {
            return receipt
        }
        throw MarketplaceClientError.notFound(
            MarketplaceAPIErrorEnvelope(
                correlationID: "corr_\(cycleID)",
                error: MarketplaceAPIErrorBody(code: "NOT_FOUND", message: "receipt not found")
            )
        )
    }

    func receiptShare(receiptID: String) async throws -> ReceiptShareProjection? {
        shares.first(where: { $0.receiptID == receiptID })
    }
}
