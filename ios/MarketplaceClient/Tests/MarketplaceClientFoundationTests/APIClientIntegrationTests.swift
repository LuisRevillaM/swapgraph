import Foundation
import XCTest
@testable import MarketplaceClientFoundation

final class APIClientIntegrationTests: XCTestCase {
    func testAppliesActorHeadersAndDecodesResponse() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "swap-intents"),
            body: "{\"correlation_id\":\"corr_1\",\"intents\":[]}"
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1",
                authScopes: ["swap:intents:read"]
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        _ = try await client.listIntents()
        let requests = await transport.capturedRequests()

        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "x-actor-type"), "user")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "x-actor-id"), "u1")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "x-auth-scopes"), "swap:intents:read")
    }

    func testRetriesRetryableStatusThenSucceeds() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 503,
            url: baseURL.appending(path: "cycle-proposals"),
            body: "{\"correlation_id\":\"corr_err\",\"error\":{\"code\":\"INTERNAL\",\"message\":\"temporary\"}}"
        )
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals"),
            body: "{\"correlation_id\":\"corr_ok\",\"proposals\":[]}"
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1",
                retryConfiguration: RetryConfiguration(
                    maxAttempts: 2,
                    initialBackoffMilliseconds: 1,
                    retryableStatusCodes: [503]
                )
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let proposals = try await client.listProposals()
        XCTAssertEqual(proposals.proposals.count, 0)

        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 2)
    }

    func testReusesIdempotencyKeyAcrossReplayAttempts() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        let acceptBody = "{\"correlation_id\":\"corr_cycle_456\",\"commit\":{\"id\":\"commit_cycle_456\",\"cycle_id\":\"cycle_456\",\"phase\":\"accept\"}}"

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals/cycle_456/accept"),
            body: acceptBody
        )
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals/cycle_456/accept"),
            body: acceptBody
        )

        let idempotencyStore = IdempotencyKeyStore()
        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: idempotencyStore
        )

        _ = try await client.acceptProposal(proposalID: "cycle_456", occurredAt: "2026-02-24T08:00:00Z")
        _ = try await client.acceptProposal(proposalID: "cycle_456", occurredAt: "2026-02-24T08:00:00Z")

        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 2)

        let firstKey = requests[0].value(forHTTPHeaderField: "Idempotency-Key")
        let secondKey = requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        XCTAssertNotNil(firstKey)
        XCTAssertEqual(firstKey, secondKey)
    }

    func testCreateIntentRetriesRetryableStatusThenSucceeds() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()
        let intent = sampleIntent(id: "intent_retry")

        await transport.enqueue(
            statusCode: 503,
            url: baseURL.appending(path: "swap-intents"),
            body: "{\"correlation_id\":\"corr_err\",\"error\":{\"code\":\"INTERNAL\",\"message\":\"temporary\"}}"
        )
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "swap-intents"),
            body: """
            {
              "correlation_id":"corr_ok",
              "intent":{
                "id":"intent_retry",
                "actor":{"type":"user","id":"u1"},
                "offer":[{"platform":"steam","asset_id":"asset_a"}],
                "status":"active"
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1",
                retryConfiguration: RetryConfiguration(
                    maxAttempts: 2,
                    initialBackoffMilliseconds: 1,
                    retryableStatusCodes: [503]
                )
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let created = try await client.createIntent(intent: intent)
        XCTAssertEqual(created.intent.id, "intent_retry")

        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Idempotency-Key"), requests[1].value(forHTTPHeaderField: "Idempotency-Key"))
    }

    func testInventoryProjectionIncludesLimitQuery() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "product-projections/inventory-awakening"),
            body: """
            {
              "correlation_id":"corr_projection",
              "projection":{
                "swappability_summary":{
                  "intents_total":1,
                  "active_intents":1,
                  "cycle_opportunities":1,
                  "average_confidence_bps":7800
                },
                "recommended_first_intents":[]
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let projection = try await client.inventoryAwakeningProjection(limit: 12)
        XCTAssertEqual(projection.projection.swappabilitySummary.cycleOpportunities, 1)

        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].url?.query, "limit=12")
    }

    func testGetsProposalByID() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals/cycle_777"),
            body: """
            {
              "correlation_id":"corr_777",
              "proposal":{
                "id":"cycle_777",
                "expires_at":"2026-02-24T12:00:00Z",
                "participants":[
                  {
                    "intent_id":"intent_a",
                    "actor":{"type":"user","id":"u1"},
                    "give":[{"platform":"steam","asset_id":"asset_a"}],
                    "get":[{"platform":"steam","asset_id":"asset_b"}]
                  },
                  {
                    "intent_id":"intent_b",
                    "actor":{"type":"user","id":"u2"},
                    "give":[{"platform":"steam","asset_id":"asset_b"}],
                    "get":[{"platform":"steam","asset_id":"asset_a"}]
                  }
                ],
                "confidence_score":0.85,
                "value_spread":0.07,
                "explainability":["Constraint fit confirmed"]
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let response = try await client.getProposal(id: "cycle_777")
        XCTAssertEqual(response.proposal.id, "cycle_777")
        XCTAssertEqual(response.proposal.participants.count, 2)
    }

    func testReusesDeclineIdempotencyKeyAcrossReplayAttempts() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()
        let declineBody = "{\"correlation_id\":\"corr_cycle_456\",\"commit\":{\"id\":\"commit_decline_456\",\"cycle_id\":\"cycle_456\",\"phase\":\"cancelled\"}}"

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals/cycle_456/decline"),
            body: declineBody
        )
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "cycle-proposals/cycle_456/decline"),
            body: declineBody
        )

        let idempotencyStore = IdempotencyKeyStore()
        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: idempotencyStore
        )

        _ = try await client.declineProposal(proposalID: "cycle_456", occurredAt: "2026-02-24T08:00:00Z")
        _ = try await client.declineProposal(proposalID: "cycle_456", occurredAt: "2026-02-24T08:00:00Z")

        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requests[1].value(forHTTPHeaderField: "Idempotency-Key")
        )
    }

    func testConfirmDepositAndCompleteSettlementDecodeExpectedResponses() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "settlement/cycle_900/deposit-confirmed"),
            body: """
            {
              "correlation_id": "corr_cycle_900",
              "timeline": {
                "cycle_id": "cycle_900",
                "state": "escrow.ready",
                "legs": [
                  {
                    "leg_id": "leg_1",
                    "intent_id": "intent_1",
                    "from_actor": { "type": "user", "id": "u1" },
                    "to_actor": { "type": "user", "id": "u2" },
                    "assets": [{ "platform": "steam", "asset_id": "asset_a" }],
                    "status": "deposited",
                    "deposit_deadline_at": "2026-02-25T08:00:00Z",
                    "deposit_ref": "dep_1",
                    "deposited_at": "2026-02-24T08:10:00Z"
                  }
                ],
                "updated_at": "2026-02-24T08:10:00Z"
              }
            }
            """
        )
        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "settlement/cycle_900/complete"),
            body: """
            {
              "correlation_id": "corr_cycle_900",
              "timeline": {
                "cycle_id": "cycle_900",
                "state": "completed",
                "legs": [
                  {
                    "leg_id": "leg_1",
                    "intent_id": "intent_1",
                    "from_actor": { "type": "user", "id": "u1" },
                    "to_actor": { "type": "user", "id": "u2" },
                    "assets": [{ "platform": "steam", "asset_id": "asset_a" }],
                    "status": "released",
                    "deposit_deadline_at": "2026-02-25T08:00:00Z",
                    "deposit_ref": "dep_1",
                    "deposited_at": "2026-02-24T08:10:00Z",
                    "release_ref": "rel_1",
                    "released_at": "2026-02-24T08:30:00Z"
                  }
                ],
                "updated_at": "2026-02-24T08:30:00Z"
              },
              "receipt": {
                "id": "receipt_cycle_900",
                "cycle_id": "cycle_900",
                "final_state": "completed",
                "intent_ids": ["intent_1"],
                "asset_ids": ["asset_a"],
                "created_at": "2026-02-24T08:30:00Z",
                "signature": {
                  "key_id": "receipt_signing_dev_k1",
                  "alg": "ed25519",
                  "sig": "abcdef123456"
                }
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let deposit = try await client.confirmDeposit(cycleID: "cycle_900", depositRef: "dep_1")
        XCTAssertEqual(deposit.timeline.state, "escrow.ready")
        XCTAssertEqual(deposit.timeline.legs.first?.depositedAt, "2026-02-24T08:10:00Z")

        let completed = try await client.completeSettlement(cycleID: "cycle_900")
        XCTAssertEqual(completed.timeline.state, "completed")
        XCTAssertEqual(completed.receipt.id, "receipt_cycle_900")
        XCTAssertEqual(completed.receipt.signature.keyID, "receipt_signing_dev_k1")
    }

    func testBeginExecutionMapsConflictErrorEnvelope() async {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 409,
            url: baseURL.appending(path: "settlement/cycle_901/begin-execution"),
            body: """
            {
              "correlation_id": "corr_cycle_901",
              "error": {
                "code": "CONFLICT",
                "message": "cycle is not escrow.ready",
                "details": {
                  "cycle_id": "cycle_901",
                  "state": "escrow.pending"
                }
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "partner",
                actorID: "partner_demo"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        do {
            _ = try await client.beginExecution(cycleID: "cycle_901")
            XCTFail("Expected conflict error")
        } catch let error as MarketplaceClientError {
            guard case .conflict(let envelope) = error else {
                XCTFail("Expected conflict mapping")
                return
            }
            XCTAssertEqual(envelope.error.code, "CONFLICT")
            XCTAssertEqual(envelope.error.message, "cycle is not escrow.ready")
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testReceiptShareProjectionDecodesProofMetadata() async throws {
        let baseURL = URL(string: "http://localhost:3005")!
        let transport = MockHTTPTransport()

        await transport.enqueue(
            statusCode: 200,
            url: baseURL.appending(path: "product-projections/receipt-share/receipt_cycle_900"),
            body: """
            {
              "correlation_id": "corr_receipt_share_900",
              "receipt_share": {
                "receipt_id": "receipt_cycle_900",
                "cycle_id": "cycle_900",
                "final_state": "completed",
                "created_at": "2026-02-24T08:30:00Z",
                "public_summary": {
                  "asset_count": 2,
                  "intent_count": 2,
                  "final_state": "completed"
                },
                "share_payload": {
                  "title": "Swap cycle cycle_900",
                  "subtitle": "Final state: completed",
                  "badge": "completed"
                },
                "privacy": {
                  "default_mode": "public_safe",
                  "modes": ["public_safe", "private"],
                  "redacted_fields": ["intent_ids", "asset_ids"],
                  "toggle_allowed": true
                }
              }
            }
            """
        )

        let client = MarketplaceAPIClient(
            configuration: APIClientConfiguration(
                baseURL: baseURL,
                actorType: "user",
                actorID: "u1"
            ),
            transport: transport,
            idempotencyKeyProvider: IdempotencyKeyStore()
        )

        let response = try await client.receiptShareProjection(receiptID: "receipt_cycle_900")
        XCTAssertEqual(response.receiptShare.receiptID, "receipt_cycle_900")
        XCTAssertEqual(response.receiptShare.publicSummary.assetCount, 2)
        XCTAssertEqual(response.receiptShare.privacy.defaultMode, "public_safe")
    }

    private func sampleIntent(id: String) -> SwapIntent {
        SwapIntent(
            id: id,
            actor: ActorRef(type: "user", id: "u1"),
            offer: [
                AssetRef(platform: "steam", assetID: "asset_a")
            ],
            wantSpec: WantSpec(
                type: "set",
                anyOf: [
                    CategoryConstraint(
                        type: "category",
                        platform: "steam",
                        appID: 730,
                        category: "knife",
                        constraints: [
                            "acceptable_wear": .array([.string("MW"), .string("FT")])
                        ]
                    )
                ]
            ),
            valueBand: ValueBand(minUSD: 0, maxUSD: 50, pricingSource: "market_median"),
            trustConstraints: TrustConstraints(maxCycleLength: 3, minCounterpartyReliability: 0),
            timeConstraints: TimeConstraints(expiresAt: "2026-03-01T00:00:00Z", urgency: "normal"),
            settlementPreferences: SettlementPreferences(requireEscrow: true),
            status: "active"
        )
    }
}
