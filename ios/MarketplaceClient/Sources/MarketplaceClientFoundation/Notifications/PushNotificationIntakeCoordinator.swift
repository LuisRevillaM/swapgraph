import Foundation

public struct MarketplacePushNotification: Sendable, Equatable {
    public let category: MarketplaceNotificationCategory
    public let urgency: MarketplaceNotificationUrgency
    public let route: AppRoute
    public let entityID: String

    public init(
        category: MarketplaceNotificationCategory,
        urgency: MarketplaceNotificationUrgency,
        route: AppRoute,
        entityID: String
    ) {
        self.category = category
        self.urgency = urgency
        self.route = route
        self.entityID = entityID
    }
}

public enum MarketplacePushNotificationParser {
    public static func parse(userInfo: [AnyHashable: Any]) -> MarketplacePushNotification? {
        let payload = normalizedPayload(userInfo)
        guard !payload.isEmpty else { return nil }

        let urgency = parseUrgency(payload["urgency"])

        if let route = parseDeepLinkRoute(payload),
           let category = category(for: route),
           let entityID = entityID(for: route) {
            return MarketplacePushNotification(
                category: category,
                urgency: urgency,
                route: route,
                entityID: entityID
            )
        }

        guard let routeKind = payload["route_kind"] ?? payload["category"] else {
            return nil
        }

        switch routeKind.lowercased() {
        case "proposal", "inbox":
            guard let proposalID = payload["proposal_id"] ?? payload["entity_id"] else {
                return nil
            }
            return MarketplacePushNotification(
                category: .proposal,
                urgency: urgency,
                route: .proposal(id: proposalID),
                entityID: proposalID
            )
        case "active", "active_swap", "timeline", "settlement":
            guard let cycleID = payload["cycle_id"] ?? payload["entity_id"] else {
                return nil
            }
            return MarketplacePushNotification(
                category: .activeSwap,
                urgency: urgency,
                route: .activeSwap(cycleID: cycleID),
                entityID: cycleID
            )
        case "receipt", "settlement_receipt":
            guard let cycleID = payload["cycle_id"] ?? payload["entity_id"] else {
                return nil
            }
            return MarketplacePushNotification(
                category: .receipt,
                urgency: urgency,
                route: .receipt(cycleID: cycleID),
                entityID: cycleID
            )
        default:
            return nil
        }
    }

    private static func parseDeepLinkRoute(_ payload: [String: String]) -> AppRoute? {
        guard let raw = payload["deep_link"] ?? payload["url"] ?? payload["link"] else {
            return nil
        }
        guard let url = URL(string: raw) else {
            return nil
        }
        return DeepLinkParser.parse(url: url)
    }

    private static func parseUrgency(_ raw: String?) -> MarketplaceNotificationUrgency {
        guard let raw else { return .normal }
        return MarketplaceNotificationUrgency(rawValue: raw.lowercased()) ?? .normal
    }

    private static func category(for route: AppRoute) -> MarketplaceNotificationCategory? {
        switch route {
        case .proposal:
            return .proposal
        case .activeSwap:
            return .activeSwap
        case .receipt:
            return .receipt
        case .tab:
            return nil
        }
    }

    private static func entityID(for route: AppRoute) -> String? {
        switch route {
        case .proposal(let id):
            return id
        case .activeSwap(let cycleID):
            return cycleID
        case .receipt(let cycleID):
            return cycleID
        case .tab:
            return nil
        }
    }

    private static func normalizedPayload(_ payload: [AnyHashable: Any]) -> [String: String] {
        var normalized: [String: String] = [:]

        for (key, value) in payload {
            guard let keyString = key as? String else { continue }
            let normalizedKey = keyString.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalizedKey.isEmpty else { continue }

            switch value {
            case let string as String:
                let cleaned = string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleaned.isEmpty {
                    normalized[normalizedKey] = cleaned
                }
            case let int as Int:
                normalized[normalizedKey] = String(int)
            case let number as NSNumber:
                normalized[normalizedKey] = number.stringValue
            default:
                continue
            }
        }

        return normalized
    }
}

@MainActor
public final class PushNotificationIntakeCoordinator {
    private unowned let appShell: AppShellViewModel
    private let preferencesStore: MarketplaceNotificationPreferencesStoreProtocol
    private let analyticsClient: AnalyticsClient?
    private let actorID: String
    private let now: () -> Date

    public init(
        appShell: AppShellViewModel,
        preferencesStore: MarketplaceNotificationPreferencesStoreProtocol,
        analyticsClient: AnalyticsClient? = nil,
        actorID: String = "u1",
        now: @escaping () -> Date = Date.init
    ) {
        self.appShell = appShell
        self.preferencesStore = preferencesStore
        self.analyticsClient = analyticsClient
        self.actorID = actorID
        self.now = now
    }

    @discardableResult
    public func handle(userInfo: [AnyHashable: Any]) -> Bool {
        guard let payload = MarketplacePushNotificationParser.parse(userInfo: userInfo) else {
            return false
        }

        let preferences = (try? preferencesStore.load(nowEpochSeconds: nowEpochSeconds())) ?? .default
        track(
            name: "marketplace.notification.received",
            payload: [
                "actor_id": .string(actorID),
                "category": .string(payload.category.rawValue),
                "urgency": .string(payload.urgency.rawValue),
                "route_kind": .string(routeKind(payload.route)),
                "entity_id": .string(payload.entityID)
            ]
        )

        guard preferences.allows(category: payload.category, urgency: payload.urgency) else {
            track(
                name: "marketplace.notification.filtered",
                payload: [
                    "actor_id": .string(actorID),
                    "category": .string(payload.category.rawValue),
                    "urgency": .string(payload.urgency.rawValue),
                    "minimum_urgency": .string(preferences.minimumUrgency.rawValue)
                ]
            )
            return false
        }

        appShell.open(payload.route)
        track(
            name: "marketplace.notification.opened",
            payload: [
                "actor_id": .string(actorID),
                "category": .string(payload.category.rawValue),
                "urgency": .string(payload.urgency.rawValue),
                "route_kind": .string(routeKind(payload.route)),
                "entity_id": .string(payload.entityID)
            ]
        )
        return true
    }

    private func track(name: String, payload: [String: JSONValue]) {
        guard let analyticsClient else { return }
        let event = AnalyticsEvent(
            name: name,
            correlationID: UUID().uuidString.lowercased(),
            occurredAt: ISO8601DateFormatter().string(from: now()),
            payload: payload
        )

        Task {
            try? await analyticsClient.track(event)
        }
    }

    private func routeKind(_ route: AppRoute) -> String {
        switch route {
        case .proposal:
            return "proposal"
        case .activeSwap:
            return "active_swap"
        case .receipt:
            return "receipt"
        case .tab:
            return "tab"
        }
    }

    private func nowEpochSeconds() -> Int {
        Int(now().timeIntervalSince1970)
    }
}
