import Foundation

public struct AnalyticsEvent: Sendable, Equatable {
    public let name: String
    public let correlationID: String
    public let occurredAt: String
    public let payload: [String: JSONValue]

    public init(name: String, correlationID: String, occurredAt: String, payload: [String: JSONValue]) {
        self.name = name
        self.correlationID = correlationID
        self.occurredAt = occurredAt
        self.payload = payload
    }
}

public enum AnalyticsValueType: String, Sendable {
    case string
    case number
    case bool
    case array
    case object
}

public struct AnalyticsEventSchema: Sendable {
    public let requiredFields: [String: AnalyticsValueType]
    public let optionalFields: [String: AnalyticsValueType]

    public init(
        requiredFields: [String: AnalyticsValueType],
        optionalFields: [String: AnalyticsValueType] = [:]
    ) {
        self.requiredFields = requiredFields
        self.optionalFields = optionalFields
    }
}

public enum AnalyticsValidationError: Error, Sendable, Equatable {
    case unknownEvent(String)
    case missingField(event: String, field: String)
    case invalidFieldType(event: String, field: String, expected: AnalyticsValueType)
}

public protocol AnalyticsSink: Sendable {
    func emit(event: AnalyticsEvent) async
}

public actor InMemoryAnalyticsSink: AnalyticsSink {
    private(set) var events: [AnalyticsEvent] = []

    public init() {}

    public func emit(event: AnalyticsEvent) async {
        events.append(event)
    }

    public func allEvents() -> [AnalyticsEvent] {
        events
    }
}

public actor AnalyticsClient {
    private let schemas: [String: AnalyticsEventSchema]
    private let sink: AnalyticsSink

    public init(
        schemas: [String: AnalyticsEventSchema] = .marketplaceDefault,
        sink: AnalyticsSink
    ) {
        self.schemas = schemas
        self.sink = sink
    }

    public func validate(_ event: AnalyticsEvent) throws {
        guard let schema = schemas[event.name] else {
            throw AnalyticsValidationError.unknownEvent(event.name)
        }

        for (field, type) in schema.requiredFields {
            guard let value = event.payload[field] else {
                throw AnalyticsValidationError.missingField(event: event.name, field: field)
            }
            guard matches(value: value, expected: type) else {
                throw AnalyticsValidationError.invalidFieldType(event: event.name, field: field, expected: type)
            }
        }

        for (field, value) in event.payload {
            guard let expectedType = schema.requiredFields[field] ?? schema.optionalFields[field] else {
                continue
            }
            guard matches(value: value, expected: expectedType) else {
                throw AnalyticsValidationError.invalidFieldType(event: event.name, field: field, expected: expectedType)
            }
        }
    }

    public func track(_ event: AnalyticsEvent) async throws {
        try validate(event)
        await sink.emit(event: event)
    }

    private func matches(value: JSONValue, expected: AnalyticsValueType) -> Bool {
        switch (value, expected) {
        case (.string, .string),
             (.number, .number),
             (.bool, .bool),
             (.array, .array),
             (.object, .object):
            return true
        default:
            return false
        }
    }
}

public extension Dictionary where Key == String, Value == AnalyticsEventSchema {
    static let marketplaceDefault: [String: AnalyticsEventSchema] = [
        "marketplace.items.viewed": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "cycle_opportunities": .number,
                "section_count": .number
            ]
        ),
        "marketplace.items.demand_banner_tapped": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "opportunity_count": .number
            ]
        ),
        "marketplace.intents.viewed": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "intent_count": .number
            ]
        ),
        "marketplace.inbox.viewed": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "proposal_count": .number
            ]
        ),
        "marketplace.intent.composer.opened": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "prefilled_offering": .bool
            ]
        ),
        "marketplace.intent.edit.opened": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "intent_id": .string
            ]
        ),
        "marketplace.intent.composer.validated": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "issue_count": .number,
                "valid": .bool
            ]
        ),
        "marketplace.intent.created": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "intent_id": .string
            ]
        ),
        "marketplace.intent.updated": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "intent_id": .string
            ]
        ),
        "marketplace.intent.cancelled": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "intent_id": .string
            ]
        ),
        "marketplace.intent.started": AnalyticsEventSchema(
            requiredFields: [
                "intent_id": .string,
                "actor_id": .string
            ],
            optionalFields: [
                "source_tab": .string
            ]
        ),
        "marketplace.proposal.opened": AnalyticsEventSchema(
            requiredFields: [
                "proposal_id": .string,
                "actor_id": .string
            ],
            optionalFields: [
                "confidence_score": .number
            ]
        ),
        "marketplace.proposal.detail.viewed": AnalyticsEventSchema(
            requiredFields: [
                "proposal_id": .string,
                "actor_id": .string
            ]
        ),
        "marketplace.proposal.accepted": AnalyticsEventSchema(
            requiredFields: [
                "proposal_id": .string,
                "actor_id": .string,
                "idempotency_key": .string
            ]
        ),
        "marketplace.proposal.declined": AnalyticsEventSchema(
            requiredFields: [
                "proposal_id": .string,
                "actor_id": .string,
                "idempotency_key": .string
            ]
        ),
        "marketplace.timeline.viewed": AnalyticsEventSchema(
            requiredFields: [
                "cycle_id": .string,
                "actor_id": .string
            ],
            optionalFields: [
                "state": .string
            ]
        ),
        "marketplace.timeline.deposit_confirmed": AnalyticsEventSchema(
            requiredFields: [
                "cycle_id": .string,
                "actor_id": .string,
                "leg_id": .string
            ]
        ),
        "marketplace.timeline.action_blocked": AnalyticsEventSchema(
            requiredFields: [
                "cycle_id": .string,
                "actor_id": .string,
                "action": .string,
                "reason": .string
            ]
        ),
        "marketplace.notification.received": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "category": .string,
                "urgency": .string,
                "route_kind": .string,
                "entity_id": .string
            ]
        ),
        "marketplace.notification.opened": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "category": .string,
                "urgency": .string,
                "route_kind": .string,
                "entity_id": .string
            ]
        ),
        "marketplace.notification.filtered": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "category": .string,
                "urgency": .string,
                "minimum_urgency": .string
            ]
        ),
        "marketplace.notification.preferences.updated": AnalyticsEventSchema(
            requiredFields: [
                "actor_id": .string,
                "minimum_urgency": .string,
                "enabled_categories": .array
            ]
        ),
        "marketplace.receipt.viewed": AnalyticsEventSchema(
            requiredFields: [
                "receipt_id": .string,
                "actor_id": .string
            ]
        )
    ]
}
