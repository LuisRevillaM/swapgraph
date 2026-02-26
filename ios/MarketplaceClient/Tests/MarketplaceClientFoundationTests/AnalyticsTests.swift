import XCTest
@testable import MarketplaceClientFoundation

final class AnalyticsTests: XCTestCase {
    func testTracksValidEvent() async throws {
        let sink = InMemoryAnalyticsSink()
        let client = AnalyticsClient(sink: sink)

        let event = AnalyticsEvent(
            name: "marketplace.proposal.accepted",
            correlationID: "corr_1",
            occurredAt: "2026-02-24T08:00:00Z",
            payload: [
                "proposal_id": .string("cycle_456"),
                "actor_id": .string("u1"),
                "idempotency_key": .string("idem_1")
            ]
        )

        try await client.track(event)
        let tracked = await sink.allEvents()

        XCTAssertEqual(tracked.count, 1)
        XCTAssertEqual(tracked.first?.name, "marketplace.proposal.accepted")
    }

    func testRejectsInvalidPayload() async {
        let sink = InMemoryAnalyticsSink()
        let client = AnalyticsClient(sink: sink)

        let invalid = AnalyticsEvent(
            name: "marketplace.proposal.accepted",
            correlationID: "corr_1",
            occurredAt: "2026-02-24T08:00:00Z",
            payload: [
                "proposal_id": .string("cycle_456"),
                "actor_id": .string("u1")
            ]
        )

        do {
            try await client.track(invalid)
            XCTFail("Expected validation error")
        } catch {
            XCTAssertTrue(error is AnalyticsValidationError)
        }
    }

    func testMarketplaceEventTaxonomyCoverageForItemsAndIntents() async throws {
        let sink = InMemoryAnalyticsSink()
        let client = AnalyticsClient(sink: sink)
        let occurredAt = "2026-02-24T08:00:00Z"

        let events: [AnalyticsEvent] = [
            AnalyticsEvent(
                name: "marketplace.items.viewed",
                correlationID: "corr_items_viewed",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "cycle_opportunities": .number(4),
                    "section_count": .number(2)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.items.demand_banner_tapped",
                correlationID: "corr_items_banner",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "opportunity_count": .number(4)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intents.viewed",
                correlationID: "corr_intents_viewed",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "intent_count": .number(3)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.inbox.viewed",
                correlationID: "corr_inbox_viewed",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "proposal_count": .number(2)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.proposal.opened",
                correlationID: "corr_proposal_opened",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "proposal_id": .string("cycle_1"),
                    "confidence_score": .number(0.88)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.proposal.detail.viewed",
                correlationID: "corr_proposal_detail",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "proposal_id": .string("cycle_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.composer.opened",
                correlationID: "corr_intent_open",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "prefilled_offering": .bool(true)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.edit.opened",
                correlationID: "corr_intent_edit",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "intent_id": .string("intent_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.composer.validated",
                correlationID: "corr_intent_validate",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "issue_count": .number(0),
                    "valid": .bool(true)
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.created",
                correlationID: "corr_intent_created",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "intent_id": .string("intent_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.updated",
                correlationID: "corr_intent_updated",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "intent_id": .string("intent_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.intent.cancelled",
                correlationID: "corr_intent_cancelled",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "intent_id": .string("intent_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.proposal.accepted",
                correlationID: "corr_proposal_accepted",
                occurredAt: occurredAt,
                payload: [
                    "proposal_id": .string("cycle_1"),
                    "actor_id": .string("u1"),
                    "idempotency_key": .string("idem_accept")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.proposal.declined",
                correlationID: "corr_proposal_declined",
                occurredAt: occurredAt,
                payload: [
                    "proposal_id": .string("cycle_1"),
                    "actor_id": .string("u1"),
                    "idempotency_key": .string("idem_decline")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.timeline.viewed",
                correlationID: "corr_timeline_view",
                occurredAt: occurredAt,
                payload: [
                    "cycle_id": .string("cycle_1"),
                    "actor_id": .string("u1"),
                    "state": .string("escrow.pending")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.timeline.deposit_confirmed",
                correlationID: "corr_timeline_deposit",
                occurredAt: occurredAt,
                payload: [
                    "cycle_id": .string("cycle_1"),
                    "actor_id": .string("u1"),
                    "leg_id": .string("leg_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.timeline.action_blocked",
                correlationID: "corr_timeline_blocked",
                occurredAt: occurredAt,
                payload: [
                    "cycle_id": .string("cycle_1"),
                    "actor_id": .string("u1"),
                    "action": .string("begin_execution"),
                    "reason": .string("Only partner accounts can begin execution.")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.notification.received",
                correlationID: "corr_notification_received",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "category": .string("proposal"),
                    "urgency": .string("high"),
                    "route_kind": .string("proposal"),
                    "entity_id": .string("cycle_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.notification.opened",
                correlationID: "corr_notification_opened",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "category": .string("proposal"),
                    "urgency": .string("high"),
                    "route_kind": .string("proposal"),
                    "entity_id": .string("cycle_1")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.notification.filtered",
                correlationID: "corr_notification_filtered",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "category": .string("active_swap"),
                    "urgency": .string("normal"),
                    "minimum_urgency": .string("high")
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.notification.preferences.updated",
                correlationID: "corr_notification_preferences",
                occurredAt: occurredAt,
                payload: [
                    "actor_id": .string("u1"),
                    "minimum_urgency": .string("normal"),
                    "enabled_categories": .array([
                        .string("proposal"),
                        .string("active_swap")
                    ])
                ]
            ),
            AnalyticsEvent(
                name: "marketplace.receipt.viewed",
                correlationID: "corr_receipt_viewed",
                occurredAt: occurredAt,
                payload: [
                    "receipt_id": .string("receipt_cycle_1"),
                    "actor_id": .string("u1")
                ]
            )
        ]

        for event in events {
            try await client.track(event)
        }

        let trackedNames = Set(await sink.allEvents().map(\.name))
        XCTAssertEqual(trackedNames, Set(events.map(\.name)))
    }
}
