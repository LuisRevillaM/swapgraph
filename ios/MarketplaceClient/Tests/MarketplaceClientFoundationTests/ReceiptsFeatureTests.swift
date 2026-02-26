import Foundation
import XCTest
@testable import MarketplaceClientFoundation

@MainActor
final class ReceiptsViewModelFeatureTests: XCTestCase {
    func testBuildsReceiptRowsWithStatusMetadataAndValueDelta() async throws {
        let receipts = ReceiptsPreviewFixtures.sampleReceipts()
        let repository = StaticReceiptsRepository(
            receipts: receipts,
            shares: ReceiptsPreviewFixtures.sampleShares()
        )
        let viewModel = ReceiptsViewModel(
            repository: repository,
            knownCycleIDs: receipts.map(\.cycleID)
        )

        await viewModel.refresh()
        let snapshot = try XCTUnwrap(viewModel.snapshot)

        XCTAssertEqual(snapshot.rows.count, 2)
        XCTAssertEqual(snapshot.rows[0].cycleID, "cycle_completed")
        XCTAssertEqual(snapshot.rows[0].typeLabel, "Completed")
        XCTAssertTrue(snapshot.rows[0].verificationLabel.contains("Signed"))
        XCTAssertEqual(snapshot.rows[0].valueDeltaLabel, "+6.2%")

        XCTAssertEqual(snapshot.rows[1].cycleID, "cycle_unwound")
        XCTAssertEqual(snapshot.rows[1].typeLabel, "Unwound")
        XCTAssertEqual(snapshot.rows[1].valueDeltaLabel, "Refunded")
    }

    func testOpenIfNeededPresentsDetailForSelectedCycle() async throws {
        let receipts = ReceiptsPreviewFixtures.sampleReceipts()
        let repository = StaticReceiptsRepository(
            receipts: receipts,
            shares: ReceiptsPreviewFixtures.sampleShares()
        )
        let viewModel = ReceiptsViewModel(repository: repository)

        await viewModel.openIfNeeded(cycleID: "cycle_completed")

        let presentation = try XCTUnwrap(viewModel.detailPresentation)
        XCTAssertEqual(presentation.id, "cycle_completed")
        XCTAssertEqual(presentation.snapshot.receiptID, "receipt_cycle_completed")
        XCTAssertEqual(presentation.snapshot.signatureKeyID, "receipt_signing_dev_k1")
        XCTAssertEqual(presentation.snapshot.signatureAlgorithm, "ed25519")
        XCTAssertEqual(presentation.snapshot.shareContext?.badge, "COMPLETED")
    }

    func testReceiptDetailIncludesVerificationMetadataAndProofContext() async throws {
        let receipts = ReceiptsPreviewFixtures.sampleReceipts()
        let repository = StaticReceiptsRepository(
            receipts: receipts,
            shares: ReceiptsPreviewFixtures.sampleShares()
        )
        let viewModel = ReceiptsViewModel(repository: repository)

        await viewModel.openReceipt(cycleID: "cycle_unwound")

        let detail = try XCTUnwrap(viewModel.detailPresentation?.snapshot)
        XCTAssertEqual(detail.typeLabel, "Unwound")
        XCTAssertEqual(detail.verificationLabel, "Signed (ed25519)")
        XCTAssertEqual(detail.intentCountLabel, "2 intents")
        XCTAssertEqual(detail.assetCountLabel, "2 assets")
        XCTAssertEqual(detail.shareContext?.privacyMode, "Mode: public safe")
        XCTAssertTrue(detail.shareContext?.redactionSummary.contains("intent_ids") ?? false)
    }
}

@MainActor
final class ReceiptsAnalyticsTests: XCTestCase {
    func testEventSequenceForReceiptDetailOpen() async throws {
        let sink = InMemoryAnalyticsSink()
        let analytics = AnalyticsClient(sink: sink)
        let repository = StaticReceiptsRepository(
            receipts: ReceiptsPreviewFixtures.sampleReceipts(),
            shares: ReceiptsPreviewFixtures.sampleShares()
        )
        let viewModel = ReceiptsViewModel(
            repository: repository,
            analyticsClient: analytics,
            actorID: "u1"
        )

        await viewModel.openIfNeeded(cycleID: "cycle_completed")
        let names = await sink.allEvents().map(\.name)

        XCTAssertEqual(names, ["marketplace.receipt.viewed"])
    }
}
