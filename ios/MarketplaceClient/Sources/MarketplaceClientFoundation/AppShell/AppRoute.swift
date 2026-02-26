import Foundation

public enum AppRoute: Equatable, Sendable {
    case tab(MarketplaceTab)
    case proposal(id: String)
    case activeSwap(cycleID: String)
    case receipt(cycleID: String)

    public var tab: MarketplaceTab {
        switch self {
        case let .tab(tab):
            return tab
        case .proposal:
            return .inbox
        case .activeSwap:
            return .active
        case .receipt:
            return .receipts
        }
    }
}
