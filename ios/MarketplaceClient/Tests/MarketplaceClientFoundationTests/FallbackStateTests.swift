import XCTest
@testable import MarketplaceClientFoundation

final class FallbackStateTests: XCTestCase {
    func testMapsTransportErrorToRetryableState() {
        let state = FallbackState.from(error: .transport(description: "offline"))
        XCTAssertEqual(state, .retryable(title: "Connection issue", message: "Check your network and retry."))
    }

    func testMapsConflictToRetryableState() {
        let envelope = MarketplaceAPIErrorEnvelope(
            correlationID: "corr_1",
            error: MarketplaceAPIErrorBody(code: "IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH", message: "mismatch")
        )

        let state = FallbackState.from(error: .conflict(envelope))
        XCTAssertEqual(state, .retryable(title: "Already processed", message: "This action was already applied. Refresh to continue."))
    }
}
