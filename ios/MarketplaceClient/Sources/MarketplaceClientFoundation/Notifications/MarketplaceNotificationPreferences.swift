import Foundation

public enum MarketplaceNotificationCategory: String, CaseIterable, Codable, Sendable {
    case proposal
    case activeSwap = "active_swap"
    case receipt

    public var title: String {
        switch self {
        case .proposal:
            return "Proposal alerts"
        case .activeSwap:
            return "Active swap alerts"
        case .receipt:
            return "Receipt alerts"
        }
    }
}

public enum MarketplaceNotificationUrgency: String, CaseIterable, Codable, Sendable {
    case low
    case normal
    case high
    case critical

    public var title: String {
        switch self {
        case .low:
            return "Low and above"
        case .normal:
            return "Normal and above"
        case .high:
            return "High and above"
        case .critical:
            return "Critical only"
        }
    }

    var rank: Int {
        switch self {
        case .low:
            return 0
        case .normal:
            return 1
        case .high:
            return 2
        case .critical:
            return 3
        }
    }
}

public struct MarketplaceNotificationPreferences: Codable, Sendable, Equatable {
    public var enabledCategories: Set<MarketplaceNotificationCategory>
    public var minimumUrgency: MarketplaceNotificationUrgency

    public init(
        enabledCategories: Set<MarketplaceNotificationCategory> = Set(MarketplaceNotificationCategory.allCases),
        minimumUrgency: MarketplaceNotificationUrgency = .normal
    ) {
        self.enabledCategories = enabledCategories
        self.minimumUrgency = minimumUrgency
    }

    public static let `default` = MarketplaceNotificationPreferences()

    public func allows(
        category: MarketplaceNotificationCategory,
        urgency: MarketplaceNotificationUrgency
    ) -> Bool {
        enabledCategories.contains(category) && urgency.rank >= minimumUrgency.rank
    }
}
