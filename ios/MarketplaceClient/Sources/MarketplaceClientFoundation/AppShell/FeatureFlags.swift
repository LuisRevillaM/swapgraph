import Foundation

public struct MarketplaceFeatureFlags: Sendable, Equatable {
    public var itemsEnabled: Bool
    public var intentsEnabled: Bool
    public var inboxEnabled: Bool
    public var activeEnabled: Bool
    public var receiptsEnabled: Bool

    public init(
        itemsEnabled: Bool = true,
        intentsEnabled: Bool = true,
        inboxEnabled: Bool = true,
        activeEnabled: Bool = true,
        receiptsEnabled: Bool = true
    ) {
        self.itemsEnabled = itemsEnabled
        self.intentsEnabled = intentsEnabled
        self.inboxEnabled = inboxEnabled
        self.activeEnabled = activeEnabled
        self.receiptsEnabled = receiptsEnabled
    }

    public static let allEnabled = MarketplaceFeatureFlags()

    public var enabledTabs: [MarketplaceTab] {
        var tabs: [MarketplaceTab] = []
        if itemsEnabled { tabs.append(.items) }
        if intentsEnabled { tabs.append(.intents) }
        if inboxEnabled { tabs.append(.inbox) }
        if activeEnabled { tabs.append(.active) }
        if receiptsEnabled { tabs.append(.receipts) }
        return tabs
    }
}
