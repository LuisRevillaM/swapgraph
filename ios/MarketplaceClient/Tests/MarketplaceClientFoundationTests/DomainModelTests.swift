import XCTest
@testable import MarketplaceClientFoundation

final class DomainModelTests: XCTestCase {
    func testDecodesIntentListResponse() throws {
        let json = """
        {
          "correlation_id": "corr_swap_intents_list_user_u1",
          "intents": [
            {
              "id": "intent_123",
              "actor": { "type": "user", "id": "u1" },
              "offer": [{ "platform": "steam", "asset_id": "assetA" }],
              "status": "active"
            }
          ]
        }
        """

        let data = Data(json.utf8)
        let decoded = try JSONDecoder().decode(SwapIntentListResponse.self, from: data)

        XCTAssertEqual(decoded.intents.count, 1)
        XCTAssertEqual(decoded.intents.first?.id, "intent_123")
        XCTAssertEqual(decoded.intents.first?.actor.id, "u1")
    }

    func testDecodesProposalTimelineAndReceipt() throws {
        let proposalsJSON = """
        {
          "correlation_id": "corr_cycle_proposals_list_user_u1",
          "proposals": [
            {
              "id": "cycle_456",
              "participants": [
                {
                  "intent_id": "intent_a",
                  "actor": { "type": "user", "id": "u1" },
                  "give": [{ "platform": "steam", "asset_id": "assetA" }],
                  "get": [{ "platform": "steam", "asset_id": "assetB" }]
                }
              ]
            }
          ]
        }
        """

        let statusJSON = """
        {
          "correlation_id": "corr_cycle_456",
          "timeline": {
            "cycle_id": "cycle_456",
            "state": "escrow.pending",
            "legs": [
              {
                "leg_id": "leg_1",
                "intent_id": "intent_a",
                "from_actor": { "type": "user", "id": "u1" },
                "to_actor": { "type": "user", "id": "u2" },
                "assets": [{ "platform": "steam", "asset_id": "assetA" }],
                "status": "pending",
                "deposit_deadline_at": "2026-02-24T08:00:00Z"
              }
            ],
            "updated_at": "2026-02-24T07:00:00Z"
          }
        }
        """

        let receiptJSON = """
        {
          "correlation_id": "corr_cycle_456",
          "receipt": {
            "id": "receipt_1",
            "cycle_id": "cycle_456",
            "final_state": "completed",
            "intent_ids": ["intent_a"],
            "asset_ids": ["assetA"],
            "created_at": "2026-02-24T09:00:00Z",
            "signature": {
              "key_id": "receipt_signing_dev_k1",
              "alg": "ed25519",
              "sig": "abcdef123456"
            }
          }
        }
        """

        let proposals = try JSONDecoder().decode(CycleProposalListResponse.self, from: Data(proposalsJSON.utf8))
        let status = try JSONDecoder().decode(SettlementStatusResponse.self, from: Data(statusJSON.utf8))
        let receipt = try JSONDecoder().decode(ReceiptGetResponse.self, from: Data(receiptJSON.utf8))

        XCTAssertEqual(proposals.proposals.first?.id, "cycle_456")
        XCTAssertEqual(status.timeline.cycleID, "cycle_456")
        XCTAssertEqual(receipt.receipt.cycleID, "cycle_456")
        XCTAssertEqual(receipt.receipt.signature.keyID, "receipt_signing_dev_k1")
    }

    func testDecodesProposalGetAndDeclineCommitResponse() throws {
        let proposalGetJSON = """
        {
          "correlation_id": "corr_cycle_777",
          "proposal": {
            "id": "cycle_777",
            "expires_at": "2026-02-24T12:00:00Z",
            "participants": [
              {
                "intent_id": "intent_a",
                "actor": { "type": "user", "id": "u1" },
                "give": [{ "platform": "steam", "asset_id": "asset_a" }],
                "get": [{ "platform": "steam", "asset_id": "asset_b" }]
              },
              {
                "intent_id": "intent_b",
                "actor": { "type": "user", "id": "u2" },
                "give": [{ "platform": "steam", "asset_id": "asset_b" }],
                "get": [{ "platform": "steam", "asset_id": "asset_a" }]
              }
            ],
            "confidence_score": 0.85,
            "value_spread": 0.07,
            "explainability": ["Constraint fit confirmed"]
          }
        }
        """

        let declineJSON = """
        {
          "correlation_id": "corr_cycle_777",
          "commit": {
            "id": "commit_777",
            "cycle_id": "cycle_777",
            "phase": "cancelled"
          }
        }
        """

        let proposal = try JSONDecoder().decode(CycleProposalGetResponse.self, from: Data(proposalGetJSON.utf8))
        let decline = try JSONDecoder().decode(CommitDeclineResponse.self, from: Data(declineJSON.utf8))

        XCTAssertEqual(proposal.proposal.id, "cycle_777")
        XCTAssertEqual(decline.commit.phase, "cancelled")
    }

    func testDecodesSettlementMutationResponses() throws {
        let depositJSON = """
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

        let completeJSON = """
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
              "sig": "123456abcdef"
            }
          }
        }
        """

        let deposit = try JSONDecoder().decode(SettlementDepositConfirmedResponse.self, from: Data(depositJSON.utf8))
        let complete = try JSONDecoder().decode(SettlementCompleteResponse.self, from: Data(completeJSON.utf8))

        XCTAssertEqual(deposit.timeline.legs.first?.depositRef, "dep_1")
        XCTAssertEqual(complete.timeline.legs.first?.releaseRef, "rel_1")
        XCTAssertEqual(complete.receipt.id, "receipt_cycle_900")
    }
}
